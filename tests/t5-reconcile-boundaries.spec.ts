/** T5 reconciliation boundaries: intended behavior, with eight gaps exposed on source 8cbf779.
 * Uses real application Runtime/SQLite with the in-memory native host fixture; no real provider claim.
 * Place this file under tests/ when integrating it.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { deferred, waitUntil } from './fixtures/async.ts'

let h: Host
let jobs: { id: string; owner: string }[]
beforeEach(async () => { h = await startRuntime(); jobs = [] })
afterEach(async () => {
  for (const job of jobs) if (h.jobs.service.list(job.owner).some(item => item.id === job.id && ['running', 'stopping'].includes(item.status))) h.jobs.end(job.id, 'killed')
  for (const agent of h.agents.values()) agent.status = 'idle'
  let open = false
  try { h.runtime.store.db.prepare('SELECT 1').get(); open = true } catch {}
  if (open) await (h.runtime as unknown as { shutdown(): Promise<void> }).shutdown()
  await h.stop()
})
function emptyIdle(agent: any) { agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0 }
function job(owner: string) { const id = h.jobs.run(owner, 'registered owner job'); jobs.push({ id, owner }); return id }
async function project(label: string, semantic = false) {
  const c = h.runtime.projectCoordinator
  const p = c.create('owner', { name: label, goal: 'One file' })
  c.conversations.appendUser(p.id, 'owner', { clientRequestKey: `original-${label}`, text: 'Write a Markdown note.' })
  const plan = c.plans.save('owner', p.id, { expectedRevision: 0, operationId: `plan-${label}`, plan: {
    goal: label, scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed file worker', cost: 'One worker',
    completion: 'A note', acceptance: { version: 1, mode: semantic ? 'human-review' : 'registered-files' },
  } })
  c.confirm('owner', p.id, { ticketId: plan.ticketId, planRevision: 1, operationId: `confirm-${label}`, intent: 'execute' })
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => c.attempts.all().some(a => a.ticketId === plan.ticketId && a.status === 'running'))
  const attempt = c.attempts.all().find(a => a.ticketId === plan.ticketId)!, agent = h.agents.get(attempt.sessionId)!
  return { c, p, plan, attempt, agent }
}
async function ready(label: string) {
  const f = await project(label, true)
  const artifact = f.c.artifacts.write(f.attempt.sessionId, { operationId: 'file', output: 'note', name: 'note.md', content: '# Verified note' })
  const report = f.c.reports.submit(f.attempt.sessionId, { operationId: 'ready', state: 'ready', completed: 'Wrote note', evidence: ['Registered and checked file'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
  emptyIdle(f.agent)
  return { ...f, artifact, report }
}
const reconcile = (ticketId: string, operationId: string) => h.api('POST', `tickets/${ticketId}/reconcile`, { operationId })

it.each(['agent', 'inbox', 'jobs'] as const)('does not clear while the actual %s is active', async kind => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu(`reconcile-${kind}-1`, 'Fix the failing build.'))
  const agent = h.agents.get(sessionId)!
  emptyIdle(agent)
  if (kind === 'agent') agent.status = 'running'
  if (kind === 'inbox') agent.inbox.nextTurn.push({ id: 'pending-input', role: 'user', content: [{ type: 'text', text: 'Waiting input' }] } as any)
  if (kind === 'jobs') job(sessionId)
  const response = await reconcile(ticket.id, `active-${kind}`)
  expect(response).toMatchObject({ status: 200, body: { state: 'unknown' } })
  expect(h.runtime.store.tickets.get(ticket.id)?.lifecycle?.observed.state).toBe('unknown')
})

it('rechecks owner jobs after awaiting native Session resolution', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('job-await-1', 'Fix the failing build.'))
  const agent = h.agents.get(sessionId)!
  emptyIdle(agent)
  const gate = deferred<any>(), entered = deferred()
  h.controller.resolveAgent.mockImplementation(id => {
    if (id === sessionId) { entered.resolve(); return gate.promise }
    return h.resolveDefault(id)
  })
  const checking = reconcile(ticket.id, 'job-await')
  await entered.promise
  job(sessionId)
  gate.resolve({ agent })
  const response = await checking
  expect.soft(response).toMatchObject({ status: 200, body: { state: 'unknown' } })
  expect.soft(h.runtime.store.tickets.get(ticket.id)?.lifecycle?.observed.state).not.toBe('idle')
})

it('does not let a first reconciliation overwrite a pause intent changed while awaiting native resolution', async () => {
  const f = await project('pause-await')
  emptyIdle(f.agent)
  expect(h.runtime.store.tickets.get(f.plan.ticketId)?.lifecycle).toBeUndefined()
  const gate = deferred<any>(), entered = deferred()
  h.controller.resolveAgent.mockImplementation(id => {
    if (id === f.attempt.sessionId) { entered.resolve(); return gate.promise }
    return h.resolveDefault(id)
  })
  const checking = reconcile(f.plan.ticketId, 'pause-await')
  await entered.promise
  h.runtime.engine.pauseTicket(f.plan.ticketId)
  const requested = h.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!
  gate.resolve({ agent: f.agent })
  const response = await checking, after = h.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!
  expect.soft(response.body.state).toBe('unknown')
  expect.soft(after.pause).toEqual(requested.pause)
  expect.soft(after.observed).toEqual(requested.observed)
})

it('does not apply an old asynchronous check to a newly allocated lease', async () => {
  const f = await project('lease-await')
  f.c.reports.submit(f.attempt.sessionId, { operationId: 'failed', state: 'failed', completed: 'Known failure', evidence: ['Failed before output'], artifacts: [], unresolved: ['Retry needed'] })
  emptyIdle(f.agent)
  const gate = deferred<any>(), entered = deferred()
  h.controller.resolveAgent.mockImplementation(id => {
    if (id === f.attempt.sessionId) { entered.resolve(); return gate.promise }
    return h.resolveDefault(id)
  })
  const checking = reconcile(f.plan.ticketId, 'lease-await')
  await entered.promise
  expect(await h.api('POST', `tickets/${f.plan.ticketId}/retry`)).toMatchObject({ status: 200 })
  await waitUntil(() => f.c.attempts.bySession(f.attempt.sessionId)?.status === 'ended')
  for (let i = 0; i < 3; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(resolve => setImmediate(resolve)) }
  const fresh = f.c.attempts.all().findLast(a => a.assignmentId === f.attempt.assignmentId)!
  expect(fresh.lease).not.toBe(f.attempt.lease)
  gate.resolve({ agent: f.agent })
  expect(await checking).toMatchObject({ status: 200, body: { state: 'unknown' } })
  expect(h.runtime.store.tickets.get(f.plan.ticketId)?.lifecycle?.reconciliation?.state).not.toBe('clear')
})

it('does not apply a first check to a stop intent received during its await', async () => {
  const f = await project('stop-await')
  emptyIdle(f.agent)
  expect(h.runtime.store.tickets.get(f.plan.ticketId)?.lifecycle).toBeUndefined()
  const gate = deferred<any>(), entered = deferred()
  h.controller.resolveAgent.mockImplementation(id => {
    if (id === f.attempt.sessionId) { entered.resolve(); return gate.promise }
    return h.resolveDefault(id)
  })
  const checking = reconcile(f.plan.ticketId, 'stop-await')
  await entered.promise
  h.runtime.engine.stopTicket(f.plan.ticketId)
  gate.resolve({ agent: f.agent })
  const response = await checking
  expect(response.body.state).toBe('unknown')
})

it('does not let an old operation id replay clear the current lease', async () => {
  const f = await project('old-op-replay')
  f.c.reports.submit(f.attempt.sessionId, { operationId: 'failed', state: 'failed', completed: 'Known failure', evidence: ['Failed before output'], artifacts: [], unresolved: ['Retry needed'] })
  emptyIdle(f.agent)
  expect(await reconcile(f.plan.ticketId, 'old-op')).toMatchObject({ status: 200, body: { state: 'clear' } })
  expect(await h.api('POST', `tickets/${f.plan.ticketId}/retry`)).toMatchObject({ status: 200 })
  await waitUntil(() => f.c.attempts.bySession(f.attempt.sessionId)?.status === 'ended')
  for (let i = 0; i < 3; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(resolve => setImmediate(resolve)) }
  const fresh = f.c.attempts.all().findLast(a => a.assignmentId === f.attempt.assignmentId)!
  emptyIdle(h.agents.get(fresh.sessionId)!)
  const current = h.runtime.store.tickets.get(f.plan.ticketId)!
  current.lifecycle!.reconciliation = { state: 'unknown', operationId: 'new-lease-check', startedAt: new Date().toISOString(), assignmentId: fresh.assignmentId, attemptId: fresh.id, lease: fresh.lease, sessionId: fresh.sessionId, reason: 'new-execution-requires-evidence' }
  h.runtime.store.tickets.save(current)
  const before = current.lifecycle!.reconciliation
  const response = await reconcile(f.plan.ticketId, 'old-op')
  const after = h.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!.reconciliation
  expect(after).toEqual(before)
})

it('makes a verified ready gate usable after clearing attempt reconciliation without rerunning files', async () => {
  const f = await ready('ready-reconcile')
  f.c.attempts.save({ ...f.c.attempts.bySession(f.attempt.sessionId)!, status: 'reconcile', error: 'Recoverable bookkeeping interruption' })
  const before = h.deliveries.mock.calls.filter(([d]) => d.sessionId === f.attempt.sessionId).length
  expect(await reconcile(f.plan.ticketId, 'ready-reconcile')).toMatchObject({ status: 200, body: { state: 'clear' } })
  expect.soft(f.c.attempts.bySession(f.attempt.sessionId)?.status).not.toBe('reconcile')
  expect(await h.api('POST', `tickets/${f.plan.ticketId}/resume`)).toMatchObject({ status: 200 })
  for (let i = 0; i < 3; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(resolve => setImmediate(resolve)) }
  expect(h.deliveries.mock.calls.filter(([d]) => d.sessionId === f.attempt.sessionId)).toHaveLength(before)
  const decision = await h.api('POST', `projects/${f.p.id}/acceptance`, { ticketId: f.plan.ticketId, operationId: 'owner-pass', reportId: f.report.id, conclusion: 'passed', evidence: 'Read and checked current note' })
  expect.soft(decision.status).toBe(200)
  expect.soft(h.runtime.store.tickets.get(f.plan.ticketId)?.ended?.outcome).toBe('completed')
})

it('does not call a ticket clear when a registered artifact no longer matches its immutable version', async () => {
  const f = await ready('artifact-tamper')
  writeFileSync(f.artifact.path, '# Altered outside the application')
  const response = await reconcile(f.plan.ticketId, 'artifact-tamper')
  expect(response).toMatchObject({ status: 200, body: { state: 'unknown' } })
})

it('does not call a ticket clear while a correlated outbound effect has an unknown result', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('outbound-unknown-1', 'Fix the failing build.'))
  emptyIdle(h.agents.get(sessionId)!)
  const message = { id: 'unknown-delivery', kind: 'reply' as const, channel: ticket.channels[0]!, ticketId: ticket.id, text: 'A correlated notification' }
  h.runtime.store.receipts.add(message)
  h.runtime.store.receipts.unknown(message, 'Send returned no reliable receipt')
  const response = await reconcile(ticket.id, 'outbound-unknown')
  expect(response).toMatchObject({ status: 200, body: { state: 'unknown' } })
})

it('releases the in-flight check after a native resolution error so an explicit new check can run', async () => {
  const f = await project('native-read-error')
  emptyIdle(f.agent)
  h.controller.resolveAgent.mockRejectedValueOnce(new Error('Transient native read failed'))
  expect(await reconcile(f.plan.ticketId, 'read-error-1')).toMatchObject({ status: 500 })
  h.controller.resolveAgent.mockImplementation(h.resolveDefault)
  const response = await reconcile(f.plan.ticketId, 'read-error-2')
  expect(response.status).toBe(200)
  expect(response.body.state).not.toBe('checking')
})
