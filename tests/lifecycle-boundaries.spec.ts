import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import { ArtifactStore } from '../src/app/artifact-store.ts'
import { ReportAcceptance } from '../src/app/report-acceptance.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => {
  vi.useRealTimers()
  for (const agent of h.agents.values()) agent.status = 'idle'
  // Fixture cleanup only: a public stop that timed out is memoized. Release the
  // isolated retained Store after the test has manually made its agents idle.
  try { h.runtime.store.db.prepare('SELECT 1').get(); await (h.runtime as any).shutdown() } catch {}
  await h.stop()
})

function confirmTask(label: string, semantic = false) {
  const c = h.runtime.projectCoordinator
  const project = c.create('owner', { name: label, goal: 'One file' })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: `original-${label}`, text: 'Write one Markdown note.' })
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: `plan-${label}`, plan: {
    goal: label, scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed worker', cost: 'One worker',
    completion: 'A reviewed note', acceptance: { version: 1, mode: semantic ? 'human-review' : 'registered-files' },
  } })
  c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: `confirm-${label}`, intent: 'execute' })
  return { project, plan }
}
async function launch(label: string, semantic = false) {
  const task = confirmTask(label, semantic)
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => h.runtime.projectCoordinator.attempts.all().some(a => a.ticketId === task.plan.ticketId && a.status === 'running'))
  const attempt = h.runtime.projectCoordinator.attempts.all().find(a => a.ticketId === task.plan.ticketId)!
  return { ...task, attempt, agent: h.agents.get(attempt.sessionId)! }
}

it('keeps bindings and Store fenced while the master has not drained', async () => {
  const master = h.agents.get(h.runtime.masterId)!
  master.status = 'running'
  master.cancel.mockImplementation(() => {})
  const disposed = vi.spyOn(h.runtime.sessions, 'dispose')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const shutdown = h.runtime.stop()
  await vi.advanceTimersByTimeAsync(10_001)
  await shutdown
  let storeOpen = true
  try { h.runtime.store.db.prepare('SELECT 1').get() } catch { storeOpen = false }
  expect(master.cancel).toHaveBeenCalled()
  expect(master.status).toBe('running')
  expect(disposed).not.toHaveBeenCalled()
  expect(storeOpen).toBe(true)
})

it('keeps bindings and Store fenced after the worker shutdown bound expires', async () => {
  const { agent } = await launch('shutdown-timeout')
  agent.cancel.mockImplementation(() => {})
  const disposed = vi.spyOn(h.runtime.sessions, 'dispose')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const shutdown = h.runtime.stop()
  await vi.advanceTimersByTimeAsync(10_001)
  await shutdown
  expect(agent.status).toBe('running')
  expect(disposed).not.toHaveBeenCalled()
  expect(() => h.runtime.store.db.prepare('SELECT 1').get()).not.toThrow()
})

it('keeps stopping and the slot until a missing-Session owned job confirms exit', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('missing-native-1', 'Fix the failing build.'))
  const agent = h.agents.get(sessionId)!
  const job = h.jobs.run(sessionId, 'surviving allowed legacy shell job')
  h.jobs.service.kill.mockImplementation(() => 'requested')
  agent.status = 'idle'
  h.agents.delete(sessionId)
  h.controller.resolveAgent.mockImplementation(async id => id === sessionId ? { error: { code: 'session/not-found' } } : h.resolveDefault(id))
  // Recovered durable intent: the old process exited before its afterCommit stop ran.
  const recovered = h.runtime.store.tickets.get(ticket.id)!, at = new Date().toISOString()
  recovered.lifecycle = {
    pause: { intent: 'none', state: 'running', at },
    stop: { intent: 'stop', state: 'stopping', at },
    observed: { state: 'unknown', at },
  }
  h.runtime.store.tickets.save(recovered)
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => h.jobs.service.kill.mock.calls.length > 0)
  expect(h.runtime.store.tickets.get(ticket.id)?.lifecycle?.stop.state).toBe('stopping')
  expect(h.runtime.store.tickets.get(ticket.id)?.ended).toBeUndefined()
  expect(h.jobs.service.list(sessionId)).toContainEqual(expect.objectContaining({ id: job, status: 'running' }))
  expect(h.jobs.service.kill).toHaveBeenCalled()
  expect(h.runtime.executor.activeCount()).toBe(1)
  const next = confirmTask('while-previous-job-still-running')
  for (let i = 0; i < 3; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(resolve => setImmediate(resolve)) }
  const nextAttempts = h.runtime.projectCoordinator.attempts.all().filter(a => a.ticketId === next.plan.ticketId)
  expect(nextAttempts).toHaveLength(0)
  h.jobs.end(job, 'killed')
  await waitUntil(() => h.runtime.store.tickets.get(ticket.id)?.lifecycle?.stop.state === 'exited')
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('stopped')
  expect(h.runtime.executor.activeCount()).toBe(nextAttempts.filter(a => h.agents.get(a.sessionId)?.status === 'running').length)
})

it('retries the same authorized project Assignment in a fresh attempt', async () => {
  const { plan, attempt, agent } = await launch('retry-project')
  h.runtime.projectCoordinator.reports.submit(attempt.sessionId, { operationId: 'failed', state: 'failed', completed: 'Failed before output', evidence: ['Known failure'], artifacts: [], unresolved: ['Needs retry'] })
  agent.status = 'idle'
  const response = await h.api('POST', `tickets/${plan.ticketId}/retry`)
  expect(response).toMatchObject({ status: 200 })
  await waitUntil(() => h.runtime.projectCoordinator.attempts.bySession(attempt.sessionId)?.status === 'ended')
  for (let i = 0; i < 3; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(resolve => setImmediate(resolve)) }
  const attempts = h.runtime.projectCoordinator.attempts.all()
  expect(attempts).toHaveLength(2)
  const fresh = attempts.at(-1)!
  expect(fresh.assignmentId).toBe(attempt.assignmentId)
  expect(fresh.lease).not.toBe(attempt.lease)
  expect(fresh.sessionId).not.toBe(attempt.sessionId)
  expect(fresh.cwd).not.toBe(attempt.cwd)
})

it('resumes a ready semantic gate without submitting completed file execution again', async () => {
  const { plan, attempt, agent } = await launch('ready-pause-resume', true)
  const c = h.runtime.projectCoordinator
  const artifact = c.artifacts.write(attempt.sessionId, { operationId: 'file', output: 'note', name: 'note.md', content: '# Complete note' })
  c.reports.submit(attempt.sessionId, { operationId: 'ready', state: 'ready', completed: 'Note complete; independent review pending', evidence: ['Registered note'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
  agent.status = 'idle'
  expect(h.runtime.store.tickets.get(plan.ticketId)?.assignments[0]?.waitingReason).toBe('semantic-review')
  h.runtime.engine.pauseTicket(plan.ticketId)
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => h.runtime.store.tickets.get(plan.ticketId)?.lifecycle?.pause.state === 'paused')
  const before = h.deliveries.mock.calls.filter(([d]) => d.sessionId === attempt.sessionId).length
  h.runtime.engine.resumeTicket(plan.ticketId)
  h.runtime.executor.dispatchProjects()
  for (let i = 0; i < 3; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(resolve => setImmediate(resolve)) }
  expect(h.deliveries.mock.calls.filter(([d]) => d.sessionId === attempt.sessionId)).toHaveLength(before)
  expect(h.runtime.store.tickets.get(plan.ticketId)?.assignments[0]?.waitingReason).toBe('semantic-review')
  expect(c.reports.reports(plan.ticketId)).toHaveLength(1)
})

it('keeps exact pre-pause receipts historical after a real Store close/reopen while new paused operations stay denied', async () => {
  const { plan, attempt, agent } = await launch('paused-receipts')
  const c = h.runtime.projectCoordinator
  const write = { operationId: 'file', output: 'note', name: 'note.md', content: '# Checkpoint' }
  const artifact = c.artifacts.write(attempt.sessionId, write)
  const input = { operationId: 'progress', state: 'progress' as const, completed: 'Checkpoint saved', evidence: ['Registered file'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: ['Work remains'] }
  const report = c.reports.submit(attempt.sessionId, input)
  agent.status = 'idle'
  h.runtime.engine.pauseTicket(plan.ticketId)
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => h.runtime.store.tickets.get(plan.ticketId)?.lifecycle?.pause.state === 'paused')
  const before = h.runtime.store.tickets.get(plan.ticketId)
  await h.runtime.stop()
  const store = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const attempts = new ExecutionAttempts(store, h.directory), artifacts = new ArtifactStore(store, attempts), reports = new ReportAcceptance(store, attempts, artifacts)
    expect(artifacts.write(attempt.sessionId, write)).toEqual(artifact)
    expect(reports.submit(attempt.sessionId, input)).toEqual(report)
    expect(store.tickets.get(plan.ticketId)).toEqual(before)
    expect(() => artifacts.write(attempt.sessionId, { ...write, operationId: 'new' })).toThrow(/unauthorized/)
    expect(() => reports.submit(attempt.sessionId, { ...input, operationId: 'new' })).toThrow(/unauthorized/)
    expect(attempts.all()).toHaveLength(1)
    expect(reports.reports(plan.ticketId)).toHaveLength(1)
  } finally { store.close() }
})

it('keeps shutdown fenced when background stop returns false after an unconfirmed kill', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('shutdown-job-1', 'Fix the failing build.'))
  const agent = h.agents.get(sessionId)!
  const job = h.jobs.run(sessionId, 'job whose kill has not completed')
  agent.status = 'idle'
  h.jobs.service.kill.mockImplementation(() => 'requested')
  // A real native wait may time out with the job still running. This is not exit.
  h.jobs.service.wait.mockResolvedValue({ id: job, owner: sessionId, status: 'running' })
  const disposed = vi.spyOn(h.runtime.sessions, 'dispose')
  await h.runtime.stop()
  let storeOpen = true
  try { h.runtime.store.db.prepare('SELECT 1').get() } catch { storeOpen = false }
  expect(h.jobs.service.list(sessionId)[0]?.status).toBe('running')
  expect(disposed).not.toHaveBeenCalled()
  expect(storeOpen).toBe(true)
  h.agents.delete(sessionId)
  h.jobs.end(job, 'killed')
})

it('also reconciles shutdown owner jobs whose native Session is not loaded', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('shutdown-unloaded-1', 'Fix the failing build.'))
  const job = h.jobs.run(sessionId, 'surviving unloaded Session job')
  h.agents.get(sessionId)!.status = 'idle'
  h.agents.delete(sessionId)
  h.jobs.service.kill.mockImplementation(() => 'requested')
  h.jobs.service.wait.mockResolvedValue({ id: job, owner: sessionId, status: 'running' })
  const disposed = vi.spyOn(h.runtime.sessions, 'dispose')
  await h.runtime.stop()
  let storeOpen = true
  try { h.runtime.store.db.prepare('SELECT 1').get() } catch { storeOpen = false }
  expect(h.jobs.service.kill).toHaveBeenCalled()
  expect(disposed).not.toHaveBeenCalled()
  expect(storeOpen).toBe(true)
  h.jobs.end(job, 'killed')
})

it('coalesces repeated passes while a single pause is waiting for job exit', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('pause-pass-queue-1', 'Fix the failing build.'))
  const agent = h.agents.get(sessionId)!
  const job = h.jobs.run(sessionId, 'slow job cancellation')
  agent.status = 'idle'
  agent.cancel.mockClear()
  h.jobs.service.kill.mockImplementation(() => 'requested')
  h.runtime.engine.pauseTicket(ticket.id)
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => h.jobs.service.kill.mock.calls.length > 0)
  const cancelsWhileBlocked = agent.cancel.mock.calls.length
  for (let i = 0; i < 20; i++) h.runtime.executor.dispatchProjects()
  expect(h.jobs.service.kill).toHaveBeenCalledTimes(1)
  h.jobs.end(job, 'killed')
  await waitUntil(() => !(h.runtime.executor as any).stopping.has(ticket.id))
  expect(h.runtime.store.tickets.get(ticket.id)?.lifecycle?.pause.state).toBe('paused')
  expect(agent.cancel).toHaveBeenCalledTimes(cancelsWhileBlocked)
})

it('fences the old worker immediately after retry commits while native cancellation has not drained', async () => {
  const { plan, attempt, agent } = await launch('retry-old-worker-fence')
  const c = h.runtime.projectCoordinator
  c.reports.submit(attempt.sessionId, { operationId: 'failed', state: 'failed', completed: 'Known failure', evidence: ['Failed attempt'], artifacts: [], unresolved: ['Needs explicit retry'] })
  agent.cancel.mockImplementation(() => {})
  expect(await h.api('POST', `tickets/${plan.ticketId}/retry`)).toMatchObject({ status: 200 })
  expect(agent.status).toBe('running')
  const late = await h.runGuardedTool(attempt.sessionId, 'project_write_artifact', { operation_id: 'late-file-after-retry', output: 'note', name: 'late.md', content: '# Late old execution output' })
    .then(value => ({ accepted: true, value })).catch(error => ({ accepted: false, value: undefined, error: String(error) }))
  const refs = late.accepted ? [{ id: late.value!.id, contentVersion: late.value!.contentVersion }] : []
  const report = await h.runGuardedTool(attempt.sessionId, 'project_worker_report', { operation_id: 'late-ready-after-retry', state: 'ready', completed: 'Old worker wrote after retry committed', evidence: ['Late old execution'], artifacts: refs, unresolved: [] })
    .then(value => ({ accepted: true, value })).catch(error => ({ accepted: false, error: String(error) }))
  expect(late.accepted).toBe(false)
  expect(report.accepted).toBe(false)
  expect(h.runtime.store.tickets.get(plan.ticketId)?.ended).toBeUndefined()
})

it('does not resume a failed step along its old attempt before an explicit retry', async () => {
  const { plan, attempt, agent } = await launch('failed-step-pause-resume')
  const c = h.runtime.projectCoordinator
  c.reports.submit(attempt.sessionId, { operationId: 'failed', state: 'failed', completed: 'Known failure', evidence: ['Failed attempt'], artifacts: [], unresolved: ['Needs explicit retry'] })
  agent.status = 'idle'
  expect(await h.api('POST', `tickets/${plan.ticketId}/pause`)).toMatchObject({ status: 200 })
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => h.runtime.store.tickets.get(plan.ticketId)?.lifecycle?.pause.state === 'paused')
  const before = h.deliveries.mock.calls.filter(([d]) => d.sessionId === attempt.sessionId).length
  expect(await h.api('POST', `tickets/${plan.ticketId}/resume`)).toMatchObject({ status: 200 })
  for (let i = 0; i < 3; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(resolve => setImmediate(resolve)) }
  const after = h.deliveries.mock.calls.filter(([d]) => d.sessionId === attempt.sessionId).length
  expect(after).toBe(before)
  expect(agent.status).toBe('idle')
  expect(h.runtime.store.tickets.get(plan.ticketId)?.assignments[0]?.waitingReason).toBe('failed')
})
