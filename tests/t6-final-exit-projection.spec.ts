/** Fixed 8523b0c new facts consumer boundaries, actual Runtime/SQLite; no provider/process acceptance claim. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { for (const a of h.agents.values()) { a.status = 'idle'; a.inbox.nextTurn.length = 0; a.inbox.nextStep.length = 0 }; await h.stop() })
async function fixture() {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Facts boundary', goal: 'One checked note' })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Write one checked note.' })
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'plan', plan: { goal: 'One checked note', scope: 'One file', outputs: ['note'], resources: [], environment: 'Managed worker', cost: 'One worker', completion: 'A checked note', acceptance: { version: 1, mode: 'human-review' } } })
  c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  for (let i = 0; i < 6; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(r => setImmediate(r)) }
  await waitUntil(() => c.attempts.all().some(a => a.ticketId === plan.ticketId && a.status === 'running'))
  const attempt = c.attempts.all().find(a => a.ticketId === plan.ticketId)!, assignmentId = attempt.assignmentId
  return { c, project, plan, attempt, assignmentId }
}
async function pump() { for (let i = 0; i < 8; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(r => setImmediate(r)) } }


it('does not mark a forced terminal job as reconciled when physical producer exit remains unacknowledged', async () => {
  const f = await fixture(), agent = h.agents.get(f.attempt.sessionId)!
  const job = h.jobs.run(f.attempt.sessionId, 'Producer with unknown physical result')
  h.jobs.end(job, 'failed')
  agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0
  vi.spyOn((agent as any).session, 'snapshotEvents').mockReturnValue([
    { seq: 1, type: 'job/registered', data: { jobId: job, owner: f.attempt.sessionId, toolCall: { callId: 'unknown-call' } } },
    { seq: 2, type: 'job/settled', data: { jobId: job, owner: f.attempt.sessionId, status: 'failed', producerReported: false } },
  ])
  await h.runtime.pump()
  expect(f.c.attempts.bySession(f.attempt.sessionId)?.status).toBe('reconcile')
  expect(h.runtime.scheduler.status().some(row => row.ownerId === f.attempt.sessionId && row.kind === 'background' && row.state === 'running')).toBe(true)
  const response = await h.api('POST', `tickets/${f.plan.ticketId}/reconcile`, { operationId: 'check-unacknowledged-producer' })
  expect(response.status).toBe(200)
  expect(response.body.state).toBe('unknown')
  vi.mocked((agent as any).session.snapshotEvents).mockReturnValue([
    { seq: 1, type: 'job/registered', data: { jobId: job, owner: f.attempt.sessionId, toolCall: { callId: 'unknown-call' } } },
    { seq: 2, type: 'job/settled', data: { jobId: job, owner: f.attempt.sessionId, status: 'failed', producerReported: false } },
    { seq: 3, type: 'job/settled', data: { jobId: job, owner: f.attempt.sessionId, status: 'failed', producerReported: true } },
  ] as never)
  const known = await h.api('POST', `tickets/${f.plan.ticketId}/reconcile`, { operationId: 'verified-producer-exit' })
  expect(known.body.state).toBe('clear')
  expect(h.runtime.scheduler.status().some(row => row.ownerId === f.attempt.sessionId && row.kind === 'background')).toBe(false)
})

it('projects a registered reviewer gate onto its producer and the matching current conclusion', async () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Review projection', goal: 'One independently reviewed note' })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original-review', text: 'Write and independently review a note.' })
  const node = (key: string) => ({ key, goal: key, outputs: [key + '.md'], dependencies: [] as string[], resources: [], completion: 'Checked ' + key, cost: 'One attempt', writeScope: 'isolated-directory' as const, acceptance: { version: 1, mode: 'registered-files' as const } })
  const a = { ...node('producer'), acceptance: { version: 1, mode: 'human-review' as const } }, reviewer = { ...node('reviewer'), dependencies: ['producer'], review: { target: 'producer', conditionsVersion: 1 } }
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'save-review', plan: { goal: 'Reviewed note', scope: 'Two bounded packages', outputs: ['producer.md'], resources: [], environment: 'Managed', cost: 'Two attempts', completion: 'Current note independently passes', assignments: [a, reviewer] } })
  c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm-review', intent: 'execute' })
  await pump()
  const ticket = () => h.runtime.store.tickets.get(plan.ticketId)!, producer = ticket().assignments.find(a => a.contract?.assignmentKey === 'producer')!
  const attempt = c.attempts.all().find(a => a.assignmentId === producer.id)!
  const artifact = c.artifacts.write(attempt.sessionId, { operationId: 'producer-file', output: 'producer.md', name: 'producer.md', content: '# Producer finding' })
  const report = c.reports.submit(attempt.sessionId, { operationId: 'ready-producer', state: 'ready', completed: 'Producer note ready', evidence: ['Checked exact bytes'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
  const native = h.agents.get(attempt.sessionId)!; native.status = 'idle'; native.inbox.nextTurn.length = 0; native.inbox.nextStep.length = 0
  await pump()
  const review = ticket().assignments.find(a => a.contract?.assignmentKey === 'reviewer')!, judge = c.attempts.all().find(a => a.assignmentId === review.id)!
  expect(judge).toBeDefined()
  c.reports.decideWorker(judge.sessionId, { operationId: 'pass-current', reportId: report.id, conclusion: 'passed', evidence: 'The registered producer version meets its conditions' })
  const progress = c.view('owner', project.id).tasks.find(t => t.id === plan.ticketId)!.progress.assignments.find(a => a.assignmentId === review.id)!
  expect(progress.gate).toMatchObject({ targetAssignmentId: producer.id, conditionsVersion: 1, conclusion: 'passed' })
})


it('counts a server-managed legacy worker model call against the same instance model budget', async () => {
  const settings = h.runtime.store.settings(); h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const { sessionId } = await h.acceptedTicket(feishu('managed-legacy-budget-1', 'Fix this regression.'))
  const agent = h.agents.get(sessionId)!
  expect(agent).toBeDefined()
  const occupied = await h.runtime.scheduler.acquire({ id: 'existing-managed-model', projectId: 'another-project', kind: 'model' })
  vi.spyOn(h.ctx.agents, 'currentInitiator').mockReturnValue(agent as any)
  const body = vi.fn()
  const stream = h.ctx.waterfall(null, 'llm/stream' as any, {}, async function* () { body(); yield 'managed legacy result' }) as unknown as AsyncIterable<unknown>
  const iterator = stream[Symbol.asyncIterator](), next = iterator.next()
  try {
    await new Promise(resolve => setImmediate(resolve))
    expect(body).not.toHaveBeenCalled()
  } finally { occupied.release(); await next; await iterator.return?.() }
})
