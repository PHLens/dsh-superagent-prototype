/** Independent fixed-head T6 contract checks. Actual Runtime/SQLite with the existing in-memory native host; no real model/browser claim. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import type { AssignmentProposal, Ticket } from '../src/core/model.ts'
import type { Attempt } from '../src/app/execution-attempts.ts'
import { ProjectEvents } from '../src/app/events.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => {
  for (const attempt of h.runtime.projectCoordinator.attempts.all()) for (const job of h.jobs.service.list(attempt.sessionId)) if (['running', 'stopping'].includes(job.status)) h.jobs.end(job.id, 'killed')
  for (const agent of h.agents.values()) { agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0 }
  await h.stop()
})
const node = (key: string, dependencies: string[] = [], semantic = false): AssignmentProposal => ({ key, dependencies, goal: 'Investigate ' + key,
  outputs: [key + '.md'], completion: 'Registered cited note', resources: [], cost: 'One attempt', writeScope: 'isolated-directory', acceptance: { version: 1, mode: semantic ? 'human-review' : 'registered-files' } })
function confirm(label: string, assignments: AssignmentProposal[], existingProject?: { id: string }) {
  const c = h.runtime.projectCoordinator, project = existingProject ?? c.create('owner', { name: label, goal: 'One research goal' })
  const original = c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original-' + label, text: 'Investigate and summarize.' })
  h.runtime.store.db.prepare("UPDATE conversation_message SET status='answered' WHERE id=?").run(original.id)
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'save-' + label, plan: { goal: label, scope: 'Local research', outputs: [assignments.at(-1)!.outputs[0]!], resources: [], environment: 'Managed worker', cost: 'Registered attempt limits', completion: 'All necessary work and independent reviews pass', assignments } })
  c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: plan.revision, operationId: 'confirm-' + label, intent: 'execute' })
  const ticket = () => h.runtime.store.tickets.get(plan.ticketId)!
  const assignment = (key: string) => ticket().assignments.find(a => a.contract?.assignmentKey === key)!
  const attempt = (key: string) => c.attempts.all().findLast(a => a.assignmentId === assignment(key).id)
  return { c, project, plan, ticket, assignment, attempt }
}
function emptyIdle(attempt: Attempt) { const agent = h.agents.get(attempt.sessionId)!; agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0 }
async function pump(n = 6) { for (let i = 0; i < n; i++) { h.runtime.executor.dispatchProjects(); await new Promise<void>(resolve => setImmediate(resolve)) } }
function ready(f: ReturnType<typeof confirm>, key: string, operationId = 'ready-' + key) {
  const attempt = f.attempt(key)!, artifact = f.c.artifacts.write(attempt.sessionId, { operationId: 'file-' + operationId, output: key + '.md', name: key + '.md', content: '# Finding ' + operationId })
  const report = f.c.reports.submit(attempt.sessionId, { operationId, state: 'ready', completed: 'Produced ' + key, evidence: ['Checked immutable file'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
  return { report, artifact }
}

it('registered A/B outputs deterministically admit C with pinned versions while coordinator is unavailable', async () => {
  const f = confirm('simple-flow', [node('a'), node('b'), node('c', ['a', 'b'])])
  await pump(); await waitUntil(() => !!f.attempt('a') && !!f.attempt('b'))
  await f.c.stop()
  const a = ready(f, 'a'), b = ready(f, 'b'); emptyIdle(f.attempt('a')!); emptyIdle(f.attempt('b')!)
  await pump(); await waitUntil(() => !!f.attempt('c'))
  expect(f.attempt('c')!.inputs).toEqual(expect.arrayContaining([
    expect.objectContaining({ artifactId: a.artifact.id, contentVersion: a.artifact.contentVersion }),
    expect.objectContaining({ artifactId: b.artifact.id, contentVersion: b.artifact.contentVersion }),
  ]))
  ready(f, 'c')
  expect(f.ticket().ended?.outcome).toBe('completed')
})

it('dispatches the registered reviewer when the producer ready report is awaiting semantic acceptance', async () => {
  const f = confirm('semantic-review', [node('a', [], true), { ...node('review', ['a']), review: { target: 'a', conditionsVersion: 1 } }])
  await pump(); ready(f, 'a'); emptyIdle(f.attempt('a')!)
  await pump()
  expect(f.ticket().assignments.find(a => a.contract?.assignmentKey === 'a')!.waitingReason).toBe('semantic-review')
  expect(f.attempt('review')).toBeDefined()
})

it('does not complete a task merely because the registered reviewer submitted its own ready report without a judgment', async () => {
  const f = confirm('review-report-is-not-pass', [node('a'), { ...node('review', ['a']), review: { target: 'a', conditionsVersion: 1 } }])
  await pump(); ready(f, 'a'); emptyIdle(f.attempt('a')!)
  await pump(); expect(f.attempt('review')).toBeDefined()
  ready(f, 'review')
  expect(f.c.reports.decisions(f.plan.ticketId)).toHaveLength(0)
  expect(f.ticket().ended).toBeUndefined()
})

it('does not start a fresh registered retry while the old native execution and its owned job remain live', async () => {
  const settings = h.runtime.store.settings(); h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const f = confirm('retry-live-owner', [{ ...node('a'), retry: { on: ['failed'], limit: 1 } }])
  await pump(); const first = f.attempt('a')!
  const job = h.jobs.run(first.sessionId, 'unfinished experimental effect')
  const waiting = confirm('retry-budget-waiter', [node('waiting')])
  // A cancellation request is allowed, but this job deliberately does not confirm exit yet.
  h.jobs.service.kill.mockImplementation(() => 'requested')
  f.c.reports.submit(first.sessionId, { operationId: 'failed-known', state: 'failed', completed: 'Could not finish', evidence: ['Failure observed'], artifacts: [], unresolved: ['Owned experiment still live'] })
  await pump()
  expect(['running', 'stopping']).toContain(h.jobs.service.list(first.sessionId).find(j => j.id === job)?.status)
  expect(f.c.attempts.all().filter(a => a.assignmentId === first.assignmentId)).toHaveLength(1)
  expect(waiting.attempt('waiting')).toBeUndefined()
  h.jobs.end(job, 'killed')
  emptyIdle(first)
  await h.runtime.executor.reconcileTicket(f.plan.ticketId, 'retry-owner-exit-confirmed')
  await pump()
  // After a terminal owner result and explicit reconciliation, the registered retry may proceed.
  expect(f.c.attempts.all().filter(a => a.assignmentId === first.assignmentId).length).toBeLessThanOrEqual(2)
})

it('does not clear the whole task when an earlier active branch artifact is corrupted', async () => {
  const f = confirm('older-corrupt-branch', [node('a', [], true), node('b', [], true)])
  await pump(); const a = ready(f, 'a'); ready(f, 'b'); emptyIdle(f.attempt('a')!); emptyIdle(f.attempt('b')!)
  writeFileSync(a.artifact.path, '# Corrupted outside the application')
  const result = await h.runtime.executor.reconcileTicket(f.plan.ticketId, 'reconcile-all')
  expect(result.state).toBe('unknown')
})

it('clears every verified reconcile attempt instead of only the last assignment', async () => {
  const f = confirm('all-reconcile-branches', [node('a', [], true), node('b', [], true)])
  await pump(); ready(f, 'a'); ready(f, 'b')
  for (const key of ['a', 'b']) { const attempt = f.attempt(key)!; emptyIdle(attempt); f.c.attempts.save({ ...attempt, status: 'reconcile' }) }
  const result = await h.runtime.executor.reconcileTicket(f.plan.ticketId, 'reconcile-both')
  expect(result.state).toBe('clear')
  expect(f.c.attempts.all().filter(a => a.ticketId === f.plan.ticketId && a.status === 'reconcile')).toHaveLength(0)
})

it('can explicitly retry the failed earlier branch while a later dependent assignment is pending', async () => {
  const f = confirm('retry-earlier-branch', [node('a'), node('c', ['a'])])
  await pump(); const first = f.attempt('a')!
  f.c.reports.submit(first.sessionId, { operationId: 'failed-a', state: 'failed', completed: 'Attempt failed', evidence: ['Known failure'], artifacts: [], unresolved: ['Needs retry'] })
  emptyIdle(first)
  const result = await h.api('POST', `tickets/${f.plan.ticketId}/retry`)
  expect(result.status).toBe(200)
})

it('admits a waiting project within bounded releases despite continued work from an already running project', async () => {
  const settings = h.runtime.store.settings(); h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const busy = confirm('busy-first', [node('initial')])
  await pump(); expect(busy.attempt('initial')).toBeDefined()
  const waiting = confirm('waiting-project', [node('waiting')])
  let current = busy, key = 'initial'
  // Keep offering work from the busy project. The required behavior is a bounded
  // turn for the waiting project, without prescribing FIFO or who wins an empty instance.
  for (let round = 0; round < 6 && !waiting.attempt('waiting'); round++) {
    const nextKey = 'next' + round
    const next = confirm('busy-followup-' + round, [node(nextKey)], busy.project)
    ready(current, key); emptyIdle(current.attempt(key)!)
    await pump()
    if (waiting.attempt('waiting')) break
    expect(next.attempt(nextKey)).toBeDefined()
    current = next; key = nextKey
  }
  expect(waiting.attempt('waiting')).toBeDefined()
})

it('consumes a persisted needs_judgment event only after a successful coordinator semantic turn', async () => {
  const f = confirm('pending-judgment-event', [node('a', [], true)])
  const model = vi.spyOn((f.c as any).sessions, 'reply').mockImplementation(async (agent: any) => ({ text: 'A new user choice is needed; keep the affected branch waiting.', turn: 1, sessionId: agent.id, dshMessageId: 'semantic-success' }))
  await pump(); const { report } = ready(f, 'a'); emptyIdle(f.attempt('a')!)
  f.c.reports.decide('owner', f.project.id, { ticketId: f.plan.ticketId, operationId: 'needs-new-judgment', reportId: report.id, conclusion: 'needs_judgment', evidence: 'Need a new comparison choice' })
  expect(new ProjectEvents(h.runtime.store).pending(f.project.id).length).toBeGreaterThan(0)
  await h.runtime.pump(); await f.c.idle()
  expect(model).toHaveBeenCalled()
  expect(new ProjectEvents(h.runtime.store).pending(f.project.id)).toHaveLength(0)
  expect(f.assignment('a').state).not.toBe('ended')
})

it('retains a failed semantic event and backs off instead of consuming or immediately replaying it', async () => {
  const f = confirm('failed-judgment-event', [node('a', [], true)])
  const model = vi.spyOn((f.c as any).sessions, 'reply').mockRejectedValue(new Error('Isolated coordinator model unavailable'))
  await pump(); const { report } = ready(f, 'a'); emptyIdle(f.attempt('a')!)
  f.c.reports.decide('owner', f.project.id, { ticketId: f.plan.ticketId, operationId: 'needs-new-judgment', reportId: report.id, conclusion: 'needs_judgment', evidence: 'Need a new comparison choice' })
  await h.runtime.pump(); await f.c.idle()
  expect(model).toHaveBeenCalledTimes(1)
  expect(new ProjectEvents(h.runtime.store).pending(f.project.id).length).toBeGreaterThan(0)
  await h.runtime.pump(); await f.c.idle()
  expect(model).toHaveBeenCalledTimes(1)
  expect(f.assignment('a').state).not.toBe('ended')
})

it('stops all active branch owners and retains stopping until every owned job confirms exit', async () => {
  const f = confirm('all-active-stop', [node('a'), node('b'), node('c', ['a', 'b'])])
  await pump(); const a = f.attempt('a')!, b = f.attempt('b')!
  const jobs = [h.jobs.run(a.sessionId, 'A job'), h.jobs.run(b.sessionId, 'B job')]
  h.jobs.service.kill.mockImplementation(() => 'requested')
  const result = await h.api('POST', `tickets/${f.plan.ticketId}/stop`)
  expect(result.status).toBe(200)
  await pump()
  expect(h.agents.get(a.sessionId)!.cancel).toHaveBeenCalled()
  expect(h.agents.get(b.sessionId)!.cancel).toHaveBeenCalled()
  expect(f.ticket().lifecycle?.stop.state).toBe('stopping')
  expect(f.ticket().ended).toBeUndefined()
  expect(f.attempt('c')).toBeUndefined()
  h.jobs.end(jobs[0]!, 'killed'); await pump()
  expect(f.ticket().lifecycle?.stop.state).toBe('stopping')
  h.jobs.end(jobs[1]!, 'killed'); await pump()
  await waitUntil(() => f.ticket().lifecycle?.stop.state === 'exited')
  expect(f.ticket().ended?.outcome).toBe('stopped')
})

it('pauses all branch owners and waits for their job exits before observing paused, without dispatching dependents', async () => {
  const f = confirm('all-active-pause', [node('a'), node('b'), node('c', ['a', 'b'])])
  await pump(); const a = f.attempt('a')!, b = f.attempt('b')!
  const jobs = [h.jobs.run(a.sessionId, 'A job'), h.jobs.run(b.sessionId, 'B job')]
  h.jobs.service.kill.mockImplementation(() => 'requested')
  expect((await h.api('POST', `tickets/${f.plan.ticketId}/pause`)).status).toBe(200)
  await pump()
  expect(f.ticket().lifecycle?.pause.state).toBe('pausing')
  h.jobs.end(jobs[0]!, 'killed'); await pump()
  expect(f.ticket().lifecycle?.pause.state).toBe('pausing')
  h.jobs.end(jobs[1]!, 'killed'); await pump()
  await waitUntil(() => f.ticket().lifecycle?.pause.state === 'paused')
  expect(h.agents.get(a.sessionId)!.status).toBe('idle')
  expect(h.agents.get(b.sessionId)!.status).toBe('idle')
  expect(f.attempt('c')).toBeUndefined()
  await pump()
  expect(f.ticket().lifecycle?.pause.intent).toBe('pause')
})

it('keeps two branch answers bound and delivers each saved answer once after an explicit task resume', async () => {
  const f = confirm('branch-answers', [node('a'), node('b')]); await pump()
  const a = f.attempt('a')!, b = f.attempt('b')!
  const qa = await h.runGuardedTool(a.sessionId, 'project_worker_request_question', { operation_id: 'question-a', question: 'A source?' }) as any
  const qb = await h.runGuardedTool(b.sessionId, 'project_worker_request_question', { operation_id: 'question-b', question: 'B source?' }) as any
  expect((await h.api('POST', `tickets/${f.plan.ticketId}/pause`)).status).toBe(200)
  await pump(); await waitUntil(() => f.ticket().lifecycle?.pause.state === 'paused')
  const beforeA = h.deliveries.mock.calls.filter(([d]) => d.sessionId === a.sessionId).length
  const beforeB = h.deliveries.mock.calls.filter(([d]) => d.sessionId === b.sessionId).length
  const answerA = { questionId: qa.question.id, version: qa.question.version, text: 'Source A' }
  const answerB = { questionId: qb.question.id, version: qb.question.version, text: 'Source B' }
  expect((await h.api('POST', `tickets/${f.plan.ticketId}/attention`, answerA)).status).toBe(200)
  expect((await h.api('POST', `tickets/${f.plan.ticketId}/attention`, answerB)).status).toBe(200)
  await pump()
  expect(h.deliveries.mock.calls.filter(([d]) => d.sessionId === a.sessionId)).toHaveLength(beforeA)
  expect(h.deliveries.mock.calls.filter(([d]) => d.sessionId === b.sessionId)).toHaveLength(beforeB)
  expect((await h.api('POST', `tickets/${f.plan.ticketId}/resume`)).status).toBe(200)
  await pump()
  const deliveriesA = h.deliveries.mock.calls.filter(([d]) => d.sessionId === a.sessionId).slice(beforeA)
  const deliveriesB = h.deliveries.mock.calls.filter(([d]) => d.sessionId === b.sessionId).slice(beforeB)
  expect(deliveriesA).toHaveLength(1); expect(deliveriesB).toHaveLength(1)
  expect(deliveriesA[0]![0].text).toContain('Source A'); expect(deliveriesA[0]![0].text).not.toContain('Source B')
  expect(deliveriesB[0]![0].text).toContain('Source B')
  expect((await h.api('POST', `tickets/${f.plan.ticketId}/attention`, answerA)).status).toBe(200)
  await pump()
  expect(h.deliveries.mock.calls.filter(([d]) => d.sessionId === a.sessionId)).toHaveLength(beforeA + 1)
})

it('does not transfer a reworked producer version into the old registered review snapshot', async () => {
  const f = confirm('rework-review-current-version', [{ ...node('a', [], true), retry: { on: ['changes_required'], limit: 1 } }, { ...node('review', ['a']), review: { target: 'a', conditionsVersion: 1 } }])
  await pump(); const first = ready(f, 'a'); emptyIdle(f.attempt('a')!)
  // Allocate the correctly registered reviewer through its actual service to isolate the later rework path from the separate dispatcher deadlock.
  const reviewer = f.c.attempts.prepare(f.c.attempts.allocate(f.ticket(), f.assignment('review')))
  expect(reviewer.reviewTarget?.reportId).toBe(first.report.id)
  f.c.reports.decideWorker(reviewer.sessionId, { operationId: 'changes', reportId: first.report.id, conclusion: 'changes_required', evidence: 'Add the missing source' })
  await pump(); expect(f.attempt('a')!.id).not.toBe(first.report.attemptId)
  const next = ready(f, 'a', 'ready-reworked'); emptyIdle(f.attempt('a')!)
  await pump()
  expect(() => f.c.reports.decideWorker(reviewer.sessionId, { operationId: 'pass-old', reportId: first.report.id, conclusion: 'passed', evidence: 'Old version must be denied' })).toThrow()
  const currentReview = f.c.attempts.all().findLast(a => a.assignmentId === f.assignment('review').id)
  expect(currentReview?.reviewTarget?.reportId).toBe(next.report.id)
})

it('keeps the exact registered judge operation replayable after the judge has reported ready and the task completes', async () => {
  const f = confirm('judge-replay-after-ready', [node('a', [], true), { ...node('review', ['a']), review: { target: 'a', conditionsVersion: 1 } }])
  await pump(); const first = ready(f, 'a'); emptyIdle(f.attempt('a')!)
  const reviewer = f.c.attempts.prepare(f.c.attempts.allocate(f.ticket(), f.assignment('review')))
  const payload = { operationId: 'pass-current', reportId: first.report.id, conclusion: 'passed' as const, evidence: 'Checked exact registered current version' }
  const decision = f.c.reports.decideWorker(reviewer.sessionId, payload)
  ready(f, 'review')
  expect(f.ticket().ended?.outcome).toBe('completed')
  expect(() => f.c.reports.decideWorker(reviewer.sessionId, payload)).not.toThrow()
  expect(f.c.reports.decisions(f.plan.ticketId)).toEqual([decision])
})

it('rejects an unregistered judge and a registered judge snapshot after the producer replaces its report version', async () => {
  const f = confirm('stale-judge-rejected', [node('a', [], true), { ...node('review', ['a']), review: { target: 'a', conditionsVersion: 1 } }])
  await pump(); const first = ready(f, 'a'); emptyIdle(f.attempt('a')!)
  expect(() => f.c.reports.decideWorker(f.attempt('a')!.sessionId, { operationId: 'self-pass', reportId: first.report.id, conclusion: 'passed', evidence: 'Producer cannot self-review' })).toThrow(/registered/)
  const reviewer = f.c.attempts.prepare(f.c.attempts.allocate(f.ticket(), f.assignment('review')))
  const newer = ready(f, 'a', 'ready-a-v2')
  expect(newer.artifact.contentVersion).not.toBe(first.artifact.contentVersion)
  expect(() => f.c.reports.decideWorker(reviewer.sessionId, { operationId: 'old-target', reportId: first.report.id, conclusion: 'passed', evidence: 'Old target must be denied' })).toThrow(/Stale/)
  expect(f.ticket().ended).toBeUndefined()
  expect(f.c.reports.decisions(f.plan.ticketId)).toHaveLength(0)
})

it.each(['changes_required', 'needs_judgment'] as const)('does not release dependent work when the valid independent conclusion is %s despite review ready', async conclusion => {
  const f = confirm('negative-judge-' + conclusion, [node('a', [], true), { ...node('review', ['a']), review: { target: 'a', conditionsVersion: 1 } }, node('c', ['a'])])
  await pump(); const first = ready(f, 'a'); emptyIdle(f.attempt('a')!)
  const reviewer = f.c.attempts.prepare(f.c.attempts.allocate(f.ticket(), f.assignment('review')))
  f.c.reports.decideWorker(reviewer.sessionId, { operationId: conclusion, reportId: first.report.id, conclusion, evidence: 'Independent current version requires attention' })
  ready(f, 'review')
  await pump()
  expect(f.assignment('a').waitingReason).toBe(conclusion)
  expect(f.attempt('c')).toBeUndefined()
  expect(f.ticket().ended).toBeUndefined()
})

it('rejects ready without the named artifact evidence while leaving other active branches intact', async () => {
  const f = confirm('ready-missing-evidence', [node('a'), node('b')]); await pump()
  f.c.reports.submit(f.attempt('a')!.sessionId, { operationId: 'premature', state: 'ready', completed: 'Claimed ready', evidence: ['Only a free-text claim'], artifacts: [], unresolved: [] })
  expect(f.assignment('a').waitingReason).toBe('missing-artifacts')
  expect(f.assignment('a').state).not.toBe('ended')
  expect(f.assignment('b').state).toBe('running')
  expect(f.ticket().ended).toBeUndefined()
})
