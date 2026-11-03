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



it('keeps a second authorization reviewer bound to that run instead of the earlier passed producer with the same key', async () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Two reviewed runs', goal: 'Review each distinct execution' })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original-two-runs', text: 'Write and independently review one note.' })
  const node = (key: string) => ({ key, goal: key, outputs: [key + '.md'], dependencies: [] as string[], resources: [], completion: 'Checked ' + key, cost: 'One attempt', writeScope: 'isolated-directory' as const, acceptance: { version: 1, mode: 'registered-files' as const } })
  const producer = { ...node('producer'), acceptance: { version: 1, mode: 'human-review' as const } }, reviewer = { ...node('reviewer'), dependencies: ['producer'], review: { target: 'producer', conditionsVersion: 1 } }
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'two-runs-plan', plan: { goal: 'Reviewed note', scope: 'Two bounded packages', outputs: ['producer.md'], resources: [], environment: 'Managed', cost: 'Two attempts', completion: 'Each run independently passes', assignments: [producer, reviewer] } })
  const first = c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'first-run', intent: 'execute' })
  const ticket = () => h.runtime.store.tickets.get(plan.ticketId)!
  const byKey = (auth: string, key: string) => ticket().assignments.find(a => a.contract?.authorizationId === auth && a.contract.assignmentKey === key)!
  const attempt = (assignmentId: string) => c.attempts.all().findLast(a => a.assignmentId === assignmentId)!
  const idle = (sessionId: string) => { const a = h.agents.get(sessionId)!; a.status = 'idle'; a.inbox.nextTurn.length = 0; a.inbox.nextStep.length = 0 }
  const ready = (assignmentId: string, key: string, op: string) => {
    const a = attempt(assignmentId), artifact = c.artifacts.write(a.sessionId, { operationId: op, output: key + '.md', name: key + '.md', content: '# Version ' + op })
    const report = c.reports.submit(a.sessionId, { operationId: op, state: 'ready', completed: 'Completed ' + op, evidence: ['Checked ' + op], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
    idle(a.sessionId); return report
  }
  await pump(); const p1 = byKey(first.authorization.id, 'producer'), r1 = byKey(first.authorization.id, 'reviewer')
  const report1 = ready(p1.id, 'producer', 'producer-v1'); await pump()
  c.reports.decideWorker(attempt(r1.id).sessionId, { operationId: 'pass-v1', reportId: report1.id, conclusion: 'passed', evidence: 'Run one passed' })
  ready(r1.id, 'reviewer', 'reviewer-v1'); await pump(); expect(ticket().ended?.outcome).toBe('completed')
  const second = c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'second-run', intent: 'rerun' })
  await pump(); const p2 = byKey(second.authorization.id, 'producer'), r2 = byKey(second.authorization.id, 'reviewer')
  const report2 = ready(p2.id, 'producer', 'producer-v2'); await pump()
  const gate = c.view('owner', project.id).tasks.find(t => t.id === plan.ticketId)!.progress.assignments.find(a => a.assignmentId === r2.id)!.gate!
  expect(gate.targetAssignmentId).toBe(p2.id)
  expect(gate.conclusion).toBeUndefined()
  c.reports.decideWorker(attempt(r2.id).sessionId, { operationId: 'pass-v2', reportId: report2.id, conclusion: 'passed', evidence: 'Run two independently passed' })
  const currentGate = () => c.view('owner', project.id).tasks.find(t => t.id === plan.ticketId)!.progress.assignments.find(a => a.assignmentId === r2.id)!.gate!
  expect(currentGate()).toMatchObject({ targetAssignmentId: p2.id, conclusion: 'passed' })
  const currentAttempt = attempt(p2.id)
  currentAttempt.fenced = true; c.attempts.save(currentAttempt)
  expect(currentGate().conclusion).toBeUndefined()
})

it('reassembles an unchanged current Assignment through its declared contentVersion snapshot', async () => {
  const f = await fixture(), summary = 'A stable current progress summary. '.repeat(500)
  f.c.reports.submit(f.attempt.sessionId, { operationId: 'long-stable-progress', state: 'progress', completed: summary, evidence: ['One stable source'], artifacts: [], unresolved: [] })
  const base = { ticketId: f.plan.ticketId, kind: 'assignment' as const, id: f.assignmentId }
  let offset = 0, text = '', version: string | undefined, pages = 0
  for (;;) {
    const page = f.c.plans.readFact('owner', f.project.id, { ...base, contentVersion: version, offset, limit: 1000 })
    expect(page.content.length).toBeLessThanOrEqual(1000)
    version ??= page.contentVersion; expect(version).toBeTruthy(); expect(page.contentVersion).toBe(version)
    text += page.content; pages++
    if (page.next_offset === null) break
    offset = page.next_offset
  }
  expect(pages).toBeGreaterThan(1); expect(JSON.parse(text).report.summary).toBe(summary)
})
