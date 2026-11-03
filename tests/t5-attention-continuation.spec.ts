import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { projectWorkerTools } from '../src/app/tools/executor.ts'
import { DshExecutor } from '../src/executor/dsh.ts'

let h: Host | undefined
afterEach(async () => {
  if (h) {
    for (const agent of h.agents.values()) agent.status = 'idle'
    await h.stop()
    h = undefined
  }
  vi.restoreAllMocks()
})
async function setup() {
  h = await startRuntime()
  const c = h.runtime.projectCoordinator
  const p = c.create('owner', { name: 'Question continuation', goal: 'One note' })
  c.conversations.appendUser(p.id, 'owner', { clientRequestKey: 'original', text: 'Write one note.' })
  const plan = c.plans.save('owner', p.id, { expectedRevision: 0, operationId: 'plan', plan: {
    goal: 'One note', scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed', cost: 'One worker', completion: 'A note', acceptance: { version: 1, mode: 'registered-files' },
  } })
  c.confirm('owner', p.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => c.attempts.all().some(a => a.ticketId === plan.ticketId && a.status === 'running'))
  const attempt = c.attempts.all().find(a => a.ticketId === plan.ticketId)!
  const agent = h.agents.get(attempt.sessionId)!
  agent.status = 'idle'; agent.inbox.nextStep.length = 0; agent.inbox.nextTurn.length = 0
  const ask = (operation_id = 'question', question = 'Which dataset?') => h!.runGuardedTool(attempt.sessionId, 'project_worker_request_question', { operation_id, question }) as Promise<{ question: { id: string; version: number; question: string; binding: object } }>
  const deliveries = () => h!.deliveries.mock.calls.map(([d]) => d).filter(d => d.sessionId === attempt.sessionId && d.text.includes('answered the pending Attention'))
  const answer = (q: { id: string; version: number }, text = 'Persisted dataset B') => h!.runtime.engine.answerAttention(plan.ticketId, q.version, { source: 'web', id: 'owner' }, 'web', text, q.id)
  return { c, p, plan, attempt, agent, ask, answer, deliveries }
}

it('creates bound project questions and durably replays operation receipts after resolution and a new question', async () => {
  const f = await setup(), first = await f.ask()
  expect(first.question.binding).toEqual({ assignmentId: f.attempt.assignmentId, attemptId: f.attempt.id, lease: f.attempt.lease, sessionId: f.attempt.sessionId })
  expect(await f.ask()).toEqual(first)
  await expect(f.ask('question', 'Changed payload')).rejects.toThrow('operation_id')
  const answer = f.answer(first.question)
  expect(await h!.runtime.executor.continueAfterAttention(f.plan.ticketId, answer.answer.id, 'Forged answer')).toBe(true)
  expect(f.deliveries()[0]!.text).toContain('Persisted dataset B')
  expect(f.deliveries()[0]!.text).not.toContain('Forged answer')
  const second = await f.ask('question-2')
  expect(second.question.version).toBe(first.question.version + 1)
  expect(await f.ask()).toEqual(first)
  expect(f.answer(first.question)).toEqual(answer)
  expect(h!.runtime.store.tickets.get(f.plan.ticketId)!.attention!.id).toBe(second.question.id)
  // The legacy four-argument constructor preserves exactly its original four tools.
  const legacy = projectWorkerTools(f.c.attempts, f.c.artifacts, f.c.reports, f.attempt.sessionId)
  expect(legacy.map(t => t.name)).toEqual(['project_worker_context', 'project_read_input', 'project_write_artifact', 'project_worker_report'])
  const tools = projectWorkerTools(f.c.attempts, f.c.artifacts, f.c.reports, h!.runtime.engine, f.attempt.sessionId)
  expect(tools.map(t => t.name)).toEqual(['project_worker_request_question', ...legacy.map(t => t.name)])
  expect(await tools.find(t => t.name === 'project_worker_request_question')!.execute({ operation_id: 'question', question: 'Which dataset?' }, new AbortController().signal)).toEqual(first)
  expect(h!.runtime.store.tickets.get(f.plan.ticketId)!.attentionQuestionOperations).toHaveLength(2)
})

it('permits only durable question receipt replay after execution ends', async () => {
  const f = await setup(), first = await f.ask()
  const attempt = f.c.attempts.bySession(f.attempt.sessionId)!
  attempt.status = 'ended'; f.c.attempts.save(attempt)
  expect(await f.ask()).toEqual(first)
  await expect(f.ask('new-operation', 'Another question?')).rejects.toThrow('Stale or unauthorized')
  expect(h!.runtime.store.tickets.get(f.plan.ticketId)!.attentionQuestionOperations).toHaveLength(1)
})

it('serializes duplicate deliveries before asynchronous native lookup and rejects invented answer ids', async () => {
  const f = await setup(), q = await f.ask(), a = f.answer(q.question)
  expect(await h!.runtime.executor.continueAfterAttention(f.plan.ticketId, 'invented', 'forged')).toBe(false)
  const gate = Promise.withResolvers<boolean>()
  const holds = vi.spyOn(h!.runtime.sessions, 'holds').mockReturnValueOnce(gate.promise)
  const first = h!.runtime.executor.continueAfterAttention(f.plan.ticketId, a.answer.id, 'forged')
  await waitUntil(() => holds.mock.calls.length > 0)
  const second = h!.runtime.executor.continueAfterAttention(f.plan.ticketId, a.answer.id, a.answer.text)
  gate.resolve(false)
  expect(await Promise.all([first, second])).toEqual([true, true])
  expect(f.deliveries()).toHaveLength(1)
  expect(h!.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!.attentionContinuation!.deliveredAt).toBeTruthy()
})

it('retains failed delivery for a later executor pass and completes a held-message receipt without duplicating delivery', async () => {
  const f = await setup(), q = await f.ask(), a = f.answer(q.question)
  const prompt = vi.spyOn(h!.runtime.sessions, 'prompt').mockRejectedValueOnce(new Error('Transient native delivery failure'))
  expect(await h!.runtime.executor.continueAfterAttention(f.plan.ticketId, a.answer.id, a.answer.text)).toBe(false)
  expect(h!.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!.attentionContinuation!.deliveredAt).toBeUndefined()
  h!.runtime.executor.dispatchProjects()
  await waitUntil(() => !!h!.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!.attentionContinuation!.deliveredAt)
  expect(f.deliveries()).toHaveLength(1)
  const ticket = h!.runtime.store.tickets.get(f.plan.ticketId)!
  delete ticket.lifecycle!.attentionContinuation!.deliveredAt
  h!.runtime.store.tickets.save(ticket)
  // Simulate re-created executor process after the native message was accepted.
  const host = (h!.runtime.executor as unknown as { host: ConstructorParameters<typeof DshExecutor>[0] }).host
  const executor = new DshExecutor({ ...host, effects: { handle: vi.fn() } as unknown as typeof host.effects })
  const held = vi.spyOn(h!.runtime.sessions, 'holds').mockResolvedValueOnce(true)
  expect(await executor.continueAfterAttention(f.plan.ticketId, a.answer.id, 'forged')).toBe(true)
  expect(held).toHaveBeenCalled()
  expect(f.deliveries()).toHaveLength(1)
  expect(prompt).toHaveBeenCalledTimes(2)
})

it('cold prepared recovery delivers the saved answer as the only new execution input', async () => {
  const f = await setup(), q = await f.ask(), a = f.answer(q.question)
  const before = h!.deliveries.mock.calls.length
  const attempt = f.c.attempts.bySession(f.attempt.sessionId)!, ticket = h!.runtime.store.tickets.get(f.plan.ticketId)!
  attempt.status = 'prepared'; f.c.attempts.save(attempt)
  ticket.assignments[0]!.state = 'pending'; ticket.lifecycle!.pause = { intent: 'pause', state: 'paused', at: new Date().toISOString() }; h!.runtime.store.tickets.save(ticket)
  h!.agents.delete(f.attempt.sessionId)
  h!.runtime.engine.resumeTicket(f.plan.ticketId)
  h!.runtime.executor.dispatchProjects(); h!.runtime.executor.dispatchProjects()
  await waitUntil(() => h!.deliveries.mock.calls.length > before)
  const fresh = h!.deliveries.mock.calls.slice(before).filter(([d]) => d.sessionId === f.attempt.sessionId).map(([d]) => d.text)
  expect(fresh).toHaveLength(1)
  expect(fresh[0]).toContain('Persisted dataset B')
  expect(fresh[0]).not.toContain('Execute exactly the confirmed plan')
  expect(h!.runtime.store.tickets.get(f.plan.ticketId)!.assignments[0]!.state).toBe('running')
  expect(h!.runtime.projectCoordinator.attempts.bySession(f.attempt.sessionId)!.status).toBe('running')
})

it('permits one later explicit pause/resume after an answer was already delivered', async () => {
  const f = await setup(), q = await f.ask(), a = f.answer(q.question)
  expect(await h!.runtime.executor.continueAfterAttention(f.plan.ticketId, a.answer.id, a.answer.text)).toBe(true)
  f.agent.status = 'idle'; f.agent.inbox.nextTurn.length = 0; f.agent.inbox.nextStep.length = 0
  h!.runtime.engine.pauseTicket(f.plan.ticketId)
  h!.runtime.executor.dispatchProjects()
  await waitUntil(() => h!.runtime.store.tickets.get(f.plan.ticketId)?.lifecycle?.pause.state === 'paused')
  const before = h!.deliveries.mock.calls.length
  h!.runtime.engine.resumeTicket(f.plan.ticketId)
  h!.runtime.executor.dispatchProjects()
  await waitUntil(() => h!.deliveries.mock.calls.length > before)
  for (let i = 0; i < 5; i++) { h!.runtime.executor.dispatchProjects(); await new Promise<void>(resolve => setImmediate(resolve)) }
  const fresh = h!.deliveries.mock.calls.slice(before).filter(([d]) => d.sessionId === f.attempt.sessionId).map(([d]) => d.text)
  expect(fresh).toHaveLength(1)
  expect(fresh[0]).toContain('Continue the confirmed project execution')
  expect(fresh[0]).not.toContain('answered the pending Attention')
  expect(fresh[0]).not.toContain('Execute exactly the confirmed plan')
})

it('rechecks pause and exact lease after lookup and never transfers an old answer to a replacement attempt', async () => {
  const f = await setup(), q = await f.ask(), a = f.answer(q.question)
  const gate = Promise.withResolvers<boolean>()
  vi.spyOn(h!.runtime.sessions, 'holds').mockReturnValueOnce(gate.promise)
  const result = h!.runtime.executor.continueAfterAttention(f.plan.ticketId, a.answer.id, a.answer.text)
  await Promise.resolve(); await Promise.resolve()
  h!.runtime.engine.pauseTicket(f.plan.ticketId)
  gate.resolve(false)
  expect(await result).toBe(false)
  expect(f.deliveries()).toHaveLength(0)
  h!.runtime.engine.resumeTicket(f.plan.ticketId)
  const old = f.c.attempts.bySession(f.attempt.sessionId)!
  old.status = 'ended'; f.c.attempts.save(old)
  const ticket = h!.runtime.store.tickets.get(f.plan.ticketId)!
  const replacement = f.c.attempts.prepare(f.c.attempts.allocate(ticket, ticket.assignments[0]!, { fresh: true }))
  replacement.status = 'running'; f.c.attempts.save(replacement)
  expect(await h!.runtime.executor.continueAfterAttention(f.plan.ticketId, a.answer.id, a.answer.text)).toBe(false)
  expect(f.deliveries()).toHaveLength(0)
  expect(h!.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!.attentionContinuation!.attemptId).toBe(old.id)
})

it('deduplicates conflicting historical answers while a newer question remains authoritative', async () => {
  const f = await setup(), q = await f.ask(), a = f.answer(q.question)
  await h!.runtime.executor.continueAfterAttention(f.plan.ticketId, a.answer.id, a.answer.text)
  const next = await f.ask('next', 'Which format?')
  const conflict = f.answer(q.question, 'Conflicting dataset C')
  expect(conflict).toMatchObject({ resolved: false, answer: { conflict: true } })
  expect(f.answer(q.question, 'Conflicting dataset C')).toEqual(conflict)
  const ticket = h!.runtime.store.tickets.get(f.plan.ticketId)!
  expect(ticket.attentionHistory![0]!.answers).toHaveLength(2)
  expect(ticket.attention!.id).toBe(next.question.id)
  expect(ticket.lifecycle!.attentionContinuation!.answerText).toBe('Persisted dataset B')
})

it('restores the exact unloaded session before delivering a pending answer', async () => {
  const f = await setup(), q = await f.ask(), a = f.answer(q.question)
  h!.agents.delete(f.attempt.sessionId)
  const ensure = vi.spyOn(h!.runtime.sessions, 'ensure')
  expect(await h!.runtime.executor.continueAfterAttention(f.plan.ticketId, a.answer.id, a.answer.text)).toBe(true)
  expect(ensure).toHaveBeenCalledWith(f.attempt.sessionId, f.attempt.cwd, expect.any(String), 'worker')
  expect(f.deliveries()).toHaveLength(1)
  expect(f.c.attempts.all()).toHaveLength(1)
})

it('rechecks authority at the final native send boundary', async () => {
  const f = await setup(), q = await f.ask(), a = f.answer(q.question)
  const original = h!.runtime.sessions.prompt.bind(h!.runtime.sessions)
  vi.spyOn(h!.runtime.sessions, 'prompt').mockImplementationOnce(async (...args) => {
    h!.runtime.engine.pauseTicket(f.plan.ticketId)
    return original(...args)
  })
  expect(await h!.runtime.executor.continueAfterAttention(f.plan.ticketId, a.answer.id, a.answer.text)).toBe(false)
  expect(f.deliveries()).toHaveLength(0)
  expect(h!.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!.attentionContinuation!.deliveredAt).toBeUndefined()
})
