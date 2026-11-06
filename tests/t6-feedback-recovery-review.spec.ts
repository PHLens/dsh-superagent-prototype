/** Scoped feedback recovery contract. Actual Runtime/SQLite; native reply completion is a controlled stable-receipt adapter, never a provider claim. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ProjectCoordinator } from '../src/app/project-coordinator.ts'
import { Projects } from '../src/core/projects.ts'
import { Prompts } from '../src/app/prompts.ts'
import { ProjectEvents, type ProjectEvent } from '../src/app/events.ts'
import { Store } from '../src/app/store.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => {
  for (const agent of h.agents.values()) { agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0 }
  await h.stop()
})
function scope(label = 'feedback') {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: label, goal: 'Review an unresolved research choice' })
  const original = c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original-' + label, text: 'Write a checked note.' })
  h.runtime.store.db.prepare("UPDATE conversation_message SET status='answered' WHERE id=?").run(original.id)
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'plan-' + label, plan: { goal: 'A checked note', scope: 'A file', outputs: ['note'], resources: [], environment: 'Managed worker', cost: 'One attempt', completion: 'A checked source comparison', acceptance: { version: 1, mode: 'human-review' } } })
  c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm-' + label, intent: 'execute' })
  const ticket = h.runtime.store.tickets.get(plan.ticketId)!, assignment = ticket.assignments[0]!
  assignment.waitingReason = 'needs_judgment'; h.runtime.store.tickets.save(ticket)
  const events = new ProjectEvents(h.runtime.store)
  const append = (id: string, version = 'target-v1', kind: ProjectEvent['kind'] = 'acceptance-changed') => {
    const event: ProjectEvent = { id: label + ':' + id, projectId: project.id, ticketId: ticket.id, assignmentId: assignment.id, kind, version, operationId: id, at: new Date().toISOString() }
    h.runtime.store.atomic(() => events.append(event)); return event
  }
  return { c, project, ticketId: ticket.id, assignmentId: assignment.id, events, append }
}
const sessions = (c: ReturnType<typeof scope>['c']) => (c as unknown as { sessions: import('../src/app/project-session.ts').ProjectSessions }).sessions
async function pump(f: ReturnType<typeof scope>) { f.c.pumpEvents(); await f.c.idle() }
function nativeReceipts(f: ReturnType<typeof scope>) {
  const completed = new Map<string, any>(), bodies: { sessionId: string; requestId: string }[] = []
  const reply = vi.spyOn(sessions(f.c), 'reply').mockImplementation(async (agent: any, requestId: string, _text: string, authorize?: () => void) => {
    authorize?.()
    const key = agent.id + ':' + requestId
    if (!completed.has(key)) {
      bodies.push({ sessionId: agent.id, requestId })
      const turn = bodies.length, text = 'Feedback result #' + turn
      if (!(agent.session instanceof Session)) {
        const seed = Session.create(SessionId(agent.id))
        const native = Session.create(SessionId(agent.id), [], { ...seed.header, cwd: agent.session.header.cwd })
        Object.defineProperty(agent, 'session', { value: native, writable: true, configurable: true })
      }
      agent.session.append('turn/start', { turn })
      agent.session.append('user/message', { id: 'dsh-superagent:' + requestId, role: 'user', content: [{ type: 'text', text: 'Read current feedback facts' }], source: { kind: 'dsh-superagent', form: 'relay' } }, { surfaceOp: 'append' })
      agent.session.append('assistant/message', { turn, message: { id: 'native-receipt-' + turn, role: 'assistant', content: [{ type: 'text', text }] } }, { surfaceOp: 'append' })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      const receipt = sessions(f.c).completed(agent.session.snapshotEvents(), requestId)
      completed.set(key, { ...receipt, sessionId: agent.id })
    }
    return completed.get(key)
  })
  return { reply, bodies, completed }
}
function failFirstFeedbackCommit(nativeCompleted: () => boolean) {
  const store = h.runtime.store, atomic = store.atomic.bind(store)
  let injected = false
  return vi.spyOn(store, 'atomic').mockImplementation(((work: () => unknown) => atomic(() => {
    const result = work()
    if (!injected && nativeCompleted()) { injected = true; throw new Error('Injected application commit interruption after native completion') }
    return result
  })) as any)
}
function makeDue() { const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 600_000) }
function savedFeedback(f: ReturnType<typeof scope>) { return f.c.conversations.listMessages(f.project.id, 'owner').filter(m => m.role === 'assistant' && m.status === 'saved') }

it('reuses a completed native receipt after an application commit interruption with an unchanged event set', async () => {
  const f = scope(), e = f.append('e1'), native = nativeReceipts(f), fault = failFirstFeedbackCommit(() => native.completed.size > 0)
  await pump(f); expect(f.events.pending(f.project.id).map(item => item.id).filter(id => id.startsWith('feedback:'))).toEqual([e.id]); fault.mockRestore()
  makeDue(); await pump(f)
  expect(native.bodies).toHaveLength(1)
  expect(f.events.pending(f.project.id)).toEqual([])
  expect(savedFeedback(f)).toHaveLength(1)
})

it('preserves the completed native judgment receipt when a new event joins after application commit interruption', async () => {
  const f = scope(), first = f.append('e1'), native = nativeReceipts(f), fault = failFirstFeedbackCommit(() => native.completed.size > 0)
  await pump(f); fault.mockRestore(); expect(native.bodies).toHaveLength(1)
  const second = f.append('e2', 'target-v2'); makeDue(); await pump(f)
  expect(f.events.pending(f.project.id)).toEqual([])
  const receipt = [...native.completed.values()][0]!
  // A superseded result may remain in an operation audit record instead of a user-visible message.
  // Require its durable native reference without prescribing the table or UI policy.
  const tables = h.runtime.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  const persisted = tables.flatMap(row => h.runtime.store.db.prepare('SELECT * FROM "' + String(row.name).replaceAll('"', '""') + '"').all()).map(row => JSON.stringify(row)).join('\n')
  expect(persisted).toContain(receipt.dshMessageId)
})

it('reconciles native feedback completion before replacing coordinator generation', async () => {
  const f = scope(), e = f.append('e1'), native = nativeReceipts(f), fault = failFirstFeedbackCommit(() => native.completed.size > 0)
  await pump(f); fault.mockRestore()
  const old = f.c.conversations.currentMapping(f.project.id)!
  await f.c.retry('owner', f.project.id)
  const replacement = f.c.conversations.currentMapping(f.project.id)!
  expect(replacement.generation).toBeGreaterThan(old.generation)
  makeDue(); await pump(f)
  expect(native.bodies).toHaveLength(1)
  expect(f.events.pending(f.project.id)).toEqual([])
})

it('retires the feedback authority after failure even while its coordinator mapping is unchanged', async () => {
  const f = scope(), e = f.append('e1')
  let guard: (() => void) | undefined
  vi.spyOn(sessions(f.c), 'reply').mockImplementation(async (_agent: any, _request: string, _text: string, authorize?: () => void) => {
    guard = authorize; throw new Error('Native send outcome could not be confirmed')
  })
  await pump(f)
  expect(f.events.pending(f.project.id).map(v => v.id)).toContain(e.id)
  expect(guard).toBeTypeOf('function')
  expect(() => guard!()).toThrow()
})

it('rejects feedback state writes from a replaced generation and leaves its events pending', async () => {
  const f = scope(), e = f.append('e1'), entered = deferred<void>(), finish = deferred<any>()
  let guard: (() => void) | undefined
  vi.spyOn(sessions(f.c), 'reply').mockImplementation(async (agent: any, _request: string, _text: string, authorize?: () => void) => { guard = authorize; entered.resolve(); return finish.promise })
  f.c.pumpEvents(); await entered.promise
  const old = f.c.conversations.currentMapping(f.project.id)!
  f.c.conversations.saveMapping(f.project.id, 'owner', { sessionId: 'replacement-session', cwd: old.cwd, workspaceId: old.workspaceId, expectedGeneration: old.generation, reason: 'Controlled recovery generation switch', reconciled: true })
  try { expect(() => guard!()).toThrow(/Stale/) } finally { finish.resolve({ text: 'Late old generation reply', sessionId: old.sessionId, turn: 1, dshMessageId: 'old-late' }) }
  await f.c.idle()
  expect(savedFeedback(f)).toEqual([])
  expect(f.events.pending(f.project.id).map(v => v.id)).toContain(e.id)
})

it('persists failure backoff across a consistent database reopen and consumes only after a later successful turn', async () => {
  const f = scope(), e = f.append('e1'), reply = vi.spyOn(sessions(f.c), 'reply').mockRejectedValue(new Error('Isolated coordinator unavailable'))
  await pump(f); expect(reply).toHaveBeenCalledTimes(1)
  const copy = join(h.directory, 'feedback-reopen.sqlite'); h.runtime.store.db.prepare('VACUUM INTO ?').run(copy)
  const reopened = new Store(copy)
  try { const events = new ProjectEvents(reopened); expect(events.pending(f.project.id).map(v => v.id)).toContain(e.id); expect(events.due(f.project.id)).toEqual([]) } finally { reopened.close() }
  await pump(f); expect(reply).toHaveBeenCalledTimes(1)
  makeDue(); reply.mockImplementation(async (agent: any) => ({ text: 'Handled after recovery', sessionId: agent.id, turn: 2, dshMessageId: 'after-recovery' }))
  await pump(f); expect(f.events.pending(f.project.id)).toEqual([])
})

it('records feedback native Session/turn/message provenance in the saved project conversation', async () => {
  const f = scope(), e = f.append('e1'), native = nativeReceipts(f)
  await pump(f)
  const saved = savedFeedback(f)[0]!, receipt = [...native.completed.values()][0]!
  expect(saved).toMatchObject({ sessionId: receipt.sessionId, turn: String(receipt.turn), dshMessageId: receipt.dshMessageId })
  expect(f.events.pending(f.project.id)).toEqual([])
})

it('does not allow new event arrivals about the same unresolved version to bypass project feedback backoff', async () => {
  const f = scope(), first = f.append('e1'), reply = vi.spyOn(sessions(f.c), 'reply').mockRejectedValue(new Error('Isolated coordinator unavailable'))
  await pump(f); expect(reply).toHaveBeenCalledTimes(1)
  f.append('e2', first.version, 'report-recorded')
  await pump(f)
  expect(reply).toHaveBeenCalledTimes(1)
  expect(f.events.pending(f.project.id).length).toBeGreaterThan(0)
})

it('keeps deterministic report/other-project input persistence available while a feedback model turn waits', async () => {
  const f = scope(), e = f.append('e1'), entered = deferred<void>(), finish = deferred<any>()
  let nativeId = ''
  vi.spyOn(sessions(f.c), 'reply').mockImplementation(async (agent: any) => { nativeId = agent.id; entered.resolve(); return finish.promise })
  f.c.pumpEvents(); await entered.promise
  const other = f.c.create('owner', { name: 'Another project', goal: 'Keep accepting discussion' })
  expect(() => h.runtime.store.atomic(() => f.c.conversations.appendUser(other.id, 'owner', { clientRequestKey: 'other-input', text: 'A separately durable request' }))).not.toThrow()
  const ordinary = f.append('ordinary-during-model', 'progress-v1', 'report-recorded')
  expect(new ProjectEvents(h.runtime.store).pending(f.project.id).map(e => e.id)).toContain(ordinary.id)
  expect(h.runtime.store.db.isTransaction).toBe(false)
  finish.resolve({ text: 'Done', sessionId: nativeId, turn: 1, dshMessageId: 'finished' }); await f.c.idle()
})

it('restores the durable coordinator failure separately from a branch waiting for judgment', async () => {
  const f = scope(), e = f.append('e1')
  vi.spyOn(sessions(f.c), 'reply').mockRejectedValue(new Error('Coordinator model is unavailable'))
  await pump(f)
  expect(f.c.view('owner', f.project.id).coordinator.status).toBe('error')
  const copy = join(h.directory, 'feedback-error-reopen.sqlite'); h.runtime.store.db.prepare('VACUUM INTO ?').run(copy)
  const reopened = new Store(copy)
  const restored = new ProjectCoordinator(h.ctx, reopened, new Projects({ repo: reopened }), h.directory, new AbortController().signal,
    new Prompts(reopened, () => 100_000, () => [], () => false))
  try {
    expect(new ProjectEvents(reopened).pending(f.project.id).map(v => v.id)).toContain(e.id)
    expect(restored.view('owner', f.project.id).coordinator.status).toBe('error')
  } finally { await restored.stop(); reopened.close() }
})
