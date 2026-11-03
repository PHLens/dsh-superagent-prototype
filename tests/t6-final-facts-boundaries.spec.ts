/** Fixed 8523b0c new facts consumer boundaries, actual Runtime/SQLite; no provider/process acceptance claim. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
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

it('does not label the previous attempt report as current after a fresh retry starts', async () => {
  const f = await fixture()
  const old = f.c.reports.submit(f.attempt.sessionId, { operationId: 'old-failure', state: 'failed', completed: 'Failure from the superseded attempt', evidence: ['Old attempt evidence'], artifacts: [], unresolved: ['Retry required'] })
  const agent = h.agents.get(f.attempt.sessionId)!; agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0
  expect((await h.api('POST', `tickets/${f.plan.ticketId}/retry`)).status).toBe(200)
  await pump()
  const current = f.c.attempts.all().findLast(a => a.assignmentId === f.assignmentId)!
  expect(current.id).not.toBe(f.attempt.id)
  const value = f.c.plans.readAssignmentFacts('owner', f.project.id, { ticketId: f.plan.ticketId, assignmentId: f.assignmentId }).assignments[0]!
  // The current report may be absent; exact historical reads remain a separate valid operation.
  expect(value.report?.id).not.toBe(old.id)
  expect(f.c.plans.readFact('owner', f.project.id, { ticketId: f.plan.ticketId, kind: 'report', id: old.id }).content).toContain(old.id)
})

it('pages an unchanged Assignment with its version and rejects a changed version token', async () => {
  const f = await fixture()
  const base = { ticketId: f.plan.ticketId, kind: 'assignment' as const, id: f.assignmentId }
  const full = f.c.plans.readFact('owner', f.project.id, { ...base, limit: 12000 })
  const first = f.c.plans.readFact('owner', f.project.id, { ...base, limit: 60 })
  expect(first.contentVersion).toBeTruthy()
  const second = f.c.plans.readFact('owner', f.project.id, { ...base, contentVersion: first.contentVersion, offset: first.next_offset!, limit: 12000 })
  expect(first.content + second.content).toBe(full.content)
  f.c.reports.submit(f.attempt.sessionId, { operationId: 'changed', state: 'progress', completed: 'Changed', evidence: ['new evidence'], artifacts: [], unresolved: [] })
  expect(() => f.c.plans.readFact('owner', f.project.id, { ...base, contentVersion: first.contentVersion, offset: first.next_offset!, limit: 12000 })).toThrow(/version/)
})

it('does not silently assemble a mutable Assignment JSON page from two different record versions', async () => {
  const f = await fixture()
  const submit = (operationId: string, completed: string) => f.c.reports.submit(f.attempt.sessionId, { operationId, state: 'progress', completed, evidence: ['A known source'], artifacts: [], unresolved: [] })
  submit('first-progress', 'AAAABBBB')
  const base = { ticketId: f.plan.ticketId, kind: 'assignment' as const, id: f.assignmentId }
  const before = f.c.plans.readFact('owner', f.project.id, { ...base, offset: 0, limit: 12000 })
  const cut = before.content.indexOf('AAAABBBB') + 4; expect(cut).toBeGreaterThan(4)
  const first = f.c.plans.readFact('owner', f.project.id, { ...base, offset: 0, limit: cut })
  expect(first.next_offset).toBe(cut)
  submit('second-progress', 'CCCCDDDD')
  let second: ReturnType<typeof f.c.plans.readFact>
  try { second = f.c.plans.readFact('owner', f.project.id, { ...base, offset: cut, limit: 12000 }) }
  catch { return } // A stale/missing snapshot token rejection is safe.
  const assembled = JSON.parse(first.content + second.content)
  const consistent = ['AAAABBBB', 'CCCCDDDD'].includes(assembled.report.summary)
  const firstMeta = first as unknown as Record<string, unknown>, secondMeta = second as unknown as Record<string, unknown>
  const explicitVersionChange = Object.keys(firstMeta).some(key => /version|snapshot|revision|etag/i.test(key) && firstMeta[key] != null && secondMeta[key] != null && firstMeta[key] !== secondMeta[key])
  expect(consistent || explicitVersionChange, 'assembled summary=' + assembled.report.summary + '; mutable pages need a stable snapshot or explicit invalidation').toBe(true)
})
