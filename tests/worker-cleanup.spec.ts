/** Finished worker Sessions leave the navigation surface without losing files, history or mapping. */
import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerCleanup, type WorkerCleanupHost } from '../src/app/worker-cleanup.ts'
import { workerFixture } from './fixtures/project-worker.ts'

const root = '/var/lib/superagent/projects'
// The production layout is <state>/projects/<projectId>/executions/<attemptId>.
const cwd = join(root, 'project-1', 'executions', 'attempt-1')

function fixture(overrides: { status?: string; agentStatus?: string; inbox?: number; jobs?: number; pinned?: boolean; pause?: string; attention?: boolean; identity?: boolean; fenced?: boolean; assignment?: string; ownerExit?: boolean; stop?: { intent: string; state: string }; wasArchived?: boolean } = {}) {
  const archived: string[] = [], deleted: string[] = [], writes: string[] = []
  const facts = new Map<string, unknown>()
  let archivedFlag = overrides.wasArchived ?? false
  const ticket = {
    assignments: [{ id: 'assignment-1', state: overrides.assignment ?? 'ended', report: { state: 'ready', at: '2026-11-04T00:00:00.000Z' } }],
    inputs: [], lifecycle: { pause: { intent: overrides.pause ?? 'none', state: overrides.pause === 'pause' ? 'paused' : 'running' },
      stop: overrides.stop ?? { intent: 'none', state: 'running' } },
    ...(overrides.attention ? { attention: { id: 'q' } } : {}),
  }
  const sessions = ['session-1'], workspace = { id: 'workspace-1', path: cwd, get sessionIds() { return sessions } }
  const agentState = { status: overrides.agentStatus ?? 'idle' }
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const emit = (event: string, ...args: unknown[]) => { for (const handler of handlers.get(event) ?? []) handler(...args) }
  const ctx = {
    on: (event: string, handler: (...args: unknown[]) => void) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1) } },
    get: (name: string) => name === 'jobs' ? { list: () => Array.from({ length: overrides.jobs ?? 0 }, (_, index) => ({ id: `job-${index}`, owner: 'session-1', status: 'running' })) } : undefined,
    sessionController: { resolveAgent: async (id: string) => overrides.identity === false ? { error: { code: 'session/not-found' } } : { agent: { id, status: agentState.status, inbox: { nextTurn: Array(overrides.inbox ?? 0).fill({}), nextStep: [] } } } },
    workspaceRegistry: {
      get: (id: string) => id === 'workspace-1' && !deleted.includes(id) ? workspace : undefined,
      delete: async (id: string) => { deleted.push(id); return true },
      archiveSession: async (id: string) => { archived.push(id); archivedFlag = true },
      get archivedSessionIds() { return archivedFlag ? ['session-1'] : [] },
      get pinnedSessionIds() { return overrides.pinned ? ['session-1'] : [] },
    },
  }
  const store = {
    tickets: { get: (id: string) => id === 'ticket-1' ? ticket : undefined },
    get: (key: string) => facts.get(key),
    set: (key: string, value: unknown) => { writes.push(key); facts.set(key, value) },
    atomic: <T>(work: () => T): T => work(),
  }
  const host = { ctx, store, root, lifetime: new AbortController().signal, closing: () => false, ownerExitKnown: () => overrides.ownerExit ?? true,
    attempts: { all: () => [{ id: 'attempt-1', projectId: 'project-1', status: overrides.status ?? 'ended', fenced: overrides.fenced ?? false, ticketId: 'ticket-1', assignmentId: 'assignment-1', sessionId: 'session-1', root: join(root, 'project-1'), cwd, workspaceId: 'workspace-1' }] } } as unknown as WorkerCleanupHost
  return { host, archived, deleted, writes, facts, emit, setAgentStatus: (status: string) => { agentState.status = status }, cleanup: new WorkerCleanup(host, () => '2026-11-04T00:00:00.000Z') }
}

it('archives a terminal worker once and then retires its generated workspace registration', async () => {
  const f = fixture()
  expect(await f.cleanup.consider('attempt-1')).toBe(true)
  expect(f.archived).toEqual(['session-1']); expect(f.deleted).toEqual(['workspace-1'])
  // A repeated pass is idempotent: no second archive, no second delete, mapping preserved.
  expect(await f.cleanup.consider('attempt-1')).toBe(true)
  expect(f.archived).toEqual(['session-1']); expect(f.deleted).toEqual(['workspace-1'])
  expect(f.facts.get('worker-ui-cleanup')).toMatchObject({ 'attempt-1': { sessionId: 'session-1', workspaceId: 'workspace-1' } })
})

it('refuses while the Task is held, awaiting a person, active, pinned or occupied', async () => {
  for (const overrides of [{ pause: 'pause' }, { attention: true }, { agentStatus: 'running' }, { inbox: 1 }, { jobs: 1 }, { pinned: true }, { identity: false }, { status: 'running' }, { fenced: true }, { assignment: 'pending' }, { ownerExit: false }, { stop: { intent: 'stop', state: 'exited' }, ownerExit: false }]) {
    const f = fixture(overrides)
    expect(await f.cleanup.consider('attempt-1'), JSON.stringify(overrides)).toBe(false)
    expect(f.archived).toEqual([]); expect(f.deleted).toEqual([]); expect(f.writes).toEqual([])
  }
})

it('scans again on a bounded schedule when the worker was still busy at the first pass', async () => {
  const f = fixture({ agentStatus: 'running' }), cleanup = new WorkerCleanup(f.host, () => '2026-11-04T00:00:00.000Z', { scanDelayMs: 5 })
  expect(await cleanup.consider('attempt-1')).toBe(false)
  expect(f.archived).toEqual([])
  f.setAgentStatus('idle')
  // No second external trigger: the bounded automatic scan retires the finished branch.
  await vi.waitFor(() => expect(f.archived).toEqual(['session-1']), { timeout: 1_000 })
  expect(f.deleted).toEqual(['workspace-1'])
})


it('recovers a missed onEnded after restart and retriggers when the worker becomes idle', async () => {
  // The attempt is already terminal with no cleanup fact: this is the state a crash leaves behind.
  const f = fixture({ agentStatus: 'running' })
  const recovered = f.cleanup
  recovered.start()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.archived).toEqual([]); expect(f.deleted).toEqual([])
  // The agent finishing its turn retriggers the same pass without waiting for the scan budget.
  f.setAgentStatus('idle')
  f.emit('agent/status', { agent: { id: 'session-1' }, status: 'idle' })
  await vi.waitFor(() => expect((f.facts.get('worker-ui-cleanup') as Record<string, { workspaceDeletedAt?: string }>)['attempt-1']?.workspaceDeletedAt).toBeTruthy(), { timeout: 1_000 })
  expect(f.deleted).toEqual(['workspace-1'])
  // A second restart sees the persisted fact and repeats nothing.
  new WorkerCleanup(f.host, () => '2026-11-04T00:00:00.000Z', { scanDelayMs: 60_000 }).start()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.archived).toEqual(['session-1']); expect(f.deleted).toEqual(['workspace-1'])
})


it('revisits a terminal attempt whose cleanup fact still lacks the workspace retirement', async () => {
  const f = fixture({ wasArchived: true })
  // A crash after the archive commit but before the generated Workspace was retired leaves this fact.
  f.facts.set('worker-ui-cleanup', { 'attempt-1': { sessionId: 'session-1', archivedAt: '2026-11-04T00:00:00.000Z' } })
  f.cleanup.start()
  await vi.waitFor(() => expect(f.deleted).toEqual(['workspace-1']), { timeout: 1_000 })
  expect(f.archived).toEqual([])
  expect(f.facts.get('worker-ui-cleanup')).toMatchObject({ 'attempt-1': { workspaceDeletedAt: expect.any(String) } })
})

it('retires a reviewed stop once the latest Attempt has physically exited', async () => {
  const f = fixture({ stop: { intent: 'stop', state: 'exited' }, ownerExit: true })
  expect(await f.cleanup.consider('attempt-1')).toBe(true)
  expect(f.archived).toEqual(['session-1'])
})

it('leaves a Workspace registration alone when its path is not this project\'s generated execution directory', async () => {
  const f = fixture(), registry = f.host.ctx.workspaceRegistry as unknown as { get: (id: string) => { path: string } }
  registry.get('workspace-1')!.path = join(root, 'elsewhere', 'attempt-1')
  expect(await f.cleanup.consider('attempt-1')).toBe(true)
  expect(f.archived).toEqual(['session-1']); expect(f.deleted).toEqual([])
})

it('archives the worker but keeps a mixed workspace registration until every Session is archived', async () => {
  const f = fixture(), registry = f.host.ctx.workspaceRegistry as unknown as { get: (id: string) => { sessionIds: string[] } | undefined }
  registry.get('workspace-1')!.sessionIds.push('session-unrelated')
  expect(await f.cleanup.consider('attempt-1')).toBe(true)
  expect(f.archived).toEqual(['session-1']); expect(f.deleted).toEqual([])
})

it('retires an accepted Attempt exactly once, whichever path ended it', () => {
  const root = mkdtempSync(join(tmpdir(), 't7-cleanup-trigger-'))
  try {
    const f = workerFixture(root, { version: 1, mode: 'registered-files' })
    f.prepare()
    const ended: string[] = []
    f.attempts.onEnded(id => ended.push(id))
    const written = f.write()
    f.reports.submit(f.attempt.sessionId, f.report([{ id: written.id, contentVersion: written.contentVersion }]))
    // Report acceptance ends the Attempt directly, without passing through the Executor.
    expect(f.attempts.all().find(item => item.id === f.attempt.id)?.status).toBe('ended')
    expect(ended).toEqual([f.attempt.id])
    // A later write of the same ended Attempt is not another ending.
    const current = f.attempts.all().find(item => item.id === f.attempt.id)!
    f.attempts.save(current)
    expect(ended).toEqual([f.attempt.id])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('holds only the branch named by an unanswered question, not an accepted idle sibling branch', async () => {
  const f = fixture()
  const ticket = f.host.store.tickets.get('ticket-1')!
  ticket.assignments.push({ id: 'assignment-2', state: 'ended', report: { state: 'ready', at: '2026-11-04T00:00:00.000Z' } } as never)
  ticket.attentionQuestions = [{ id: 'question-b', question: 'Which branch?', binding: { assignmentId: 'assignment-2', attemptId: 'attempt-2', lease: 'lease-2', sessionId: 'session-2' } }]
  expect(await f.cleanup.consider('attempt-1')).toBe(true)
  expect(f.archived).toEqual(['session-1'])
  const held = fixture()
  const other = held.host.store.tickets.get('ticket-1')!
  other.assignments.push({ id: 'assignment-2', state: 'ended', report: { state: 'ready', at: '2026-11-04T00:00:00.000Z' } } as never)
  other.attentionQuestions = [{ id: 'question-a', question: 'Which branch?', binding: { assignmentId: 'assignment-1', attemptId: 'attempt-1', lease: 'lease-1', sessionId: 'session-1' } }]
  expect(await held.cleanup.consider('attempt-1')).toBe(false)
  expect(held.archived).toEqual([])
})

it('rearms a fresh bounded scan cycle on start after an exhausted one', async () => {
  const f = fixture({ agentStatus: 'running' })
  const cleanup = new WorkerCleanup(f.host, () => '2026-11-04T00:00:00.000Z', { scanDelayMs: 60_000, scanLimit: 1 })
  cleanup.start()
  await new Promise(resolve => setTimeout(resolve, 30))
  // The first cycle spent its only scan while the Session was busy and stopped.
  f.setAgentStatus('idle')
  cleanup.start()
  await vi.waitFor(() => expect(f.archived).toEqual(['session-1']), { timeout: 1_000 })
})
