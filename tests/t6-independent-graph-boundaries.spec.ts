/** Versioned planning contract checks with real Store/SQL; no native model/process acceptance claim. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeAssignmentByKey, activePlanAssignments, currentAssignmentGraph, Projects, type AssignmentProposal, type Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { ConversationStore } from '../src/app/conversation-store.ts'
import { ProjectPlans, type CoordinatorGraphLease } from '../src/app/project-plans.ts'
import { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import { ArtifactStore } from '../src/app/artifact-store.ts'
import { projectTools } from '../src/app/tools/main.ts'

let directory: string, store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'graph-revisions-')); store = new Store(join(directory, 'graph.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const node = (key: string, dependencies: string[] = []): AssignmentProposal => ({ key, dependencies, goal: 'Investigate ' + key, outputs: [key + '.md'],
  resources: [], cost: 'One worker', completion: 'Check ' + key + ' evidence', writeScope: 'isolated-directory', acceptance: { version: 1, mode: 'registered-files' } })
function fixture(proposals = [node('a'), node('b'), node('summary', ['a', 'b'])]) {
  const projects = new Projects({ repo: store }), conversations = new ConversationStore(store), plans = new ProjectPlans(store, projects, conversations)
  const project = projects.create({ name: 'Graph project', goal: 'One research goal' }); conversations.claimProject(project.id, 'owner', { newlyCreated: true })
  const original = conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Investigate the two routes and summarize' })
  store.db.prepare("UPDATE conversation_message SET status='answered' WHERE id=?").run(original.id)
  const plan = plans.save('owner', project.id, { expectedRevision: 0, operationId: 'save', plan: { goal: 'Investigate and summarize', scope: 'One bounded local research scope', outputs: proposals.at(-1)!.outputs,
    resources: [], environment: 'Managed local directories', cost: 'Three bounded work slots', completion: 'All required notes and synthesis', assignments: proposals } })
  conversations.appendUser(project.id, 'owner', { clientRequestKey: 'confirm', text: '按这个方案做' })
  const confirmed = plans.confirm('owner', project.id, { projectId: project.id, ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  const mapping = conversations.saveMapping(project.id, 'owner', { sessionId: `project-${project.id}-test`, workspaceId: 'test-workspace', cwd: directory })
  const message = conversations.appendUser(project.id, 'owner', { clientRequestKey: 'adjust', text: 'Adjust unstarted work within this scope' })
  const input = conversations.claimNext(project.id, 'owner', mapping)!
  let valid = true
  const lease: CoordinatorGraphLease = { sessionId: mapping.sessionId, generation: mapping.generation, inputId: input.input.id, stateVersion: input.stateVersion,
    authorize: () => { if (!valid) throw new Error('Operation lease expired') } }
  const ticket = () => store.tickets.get(plan.ticketId)!
  const graph = () => currentAssignmentGraph(ticket())!
  const initial = graph()
  const change = (assignments: readonly AssignmentProposal[], operationId = 'revise', base = graph()) => plans.reviseAssignments('owner', project.id,
    { ticketId: plan.ticketId, graphId: base.id, expectedVersion: base.version, operationId, assignments }, lease)
  return { projects, conversations, plans, project, plan, confirmed, mapping, message, lease, ticket, graph, initial, change,
    expire: () => { valid = false } }
}
const changed = (proposals: readonly AssignmentProposal[]) => proposals.map(item => item.key === 'b' ? { ...item, goal: 'Compare the maintenance requirements of route B' } : item)


it('permits a new explicitly confirmed rerun after a revised current graph has completed', () => {
  const f = fixture(); f.change(changed(f.initial.nodes.map(n => n.proposal)))
  const done = f.ticket()
  for (const a of activePlanAssignments(done)) { a.state = 'ended'; a.endedReason = 'accepted'; a.report = { state: 'ready', summary: 'Accepted current graph work', at: '2026-11-03T14:00:00Z' } }
  done.ended = { by: 'executor', outcome: 'completed', at: '2026-11-03T14:00:00Z' }; store.tickets.save(done)
  expect(done.assignments.some(a => a.endedReason === 'superseded' && a.report?.state === 'dropped')).toBe(true)
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'rerun-after-revision', text: '再运行一次' })
  const result = f.plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: done.id, planRevision: 1, operationId: 'rerun-after-revision', intent: 'rerun' })
  expect(result.authorization.intent).toBe('rerun')
  expect(result.authorization.id).not.toBe(f.initial.authorizationId)
  expect(result.ticket.ended).toBeUndefined()
  expect(currentAssignmentGraph(result.ticket, result.authorization.id)?.version).toBe(1)
})

it.each(['prepared', 'reconcile', 'ended'] as const)('keeps a pending node with any historical %s attempt locked', status => {
  const f = fixture(), t = f.ticket(), b = t.assignments.find(a => a.contract?.assignmentKey === 'b')!
  const attempts = new ExecutionAttempts(store, directory), attempt = attempts.allocate(t, b)
  attempt.status = status; attempts.save(attempt)
  const before = f.ticket()
  expect(() => f.change(changed(f.initial.nodes.map(n => n.proposal)))).toThrow()
  expect(f.ticket()).toEqual(before)
})

it('does not replace an upstream identity consumed by a locked descendant', () => {
  const f = fixture(), t = f.ticket(), summary = t.assignments.find(a => a.contract?.assignmentKey === 'summary')!
  summary.state = 'running'; summary.startedAt = '2026-11-03T14:00:00Z'; store.tickets.save(t)
  const before = f.ticket()
  expect(() => f.change(changed(f.initial.nodes.map(n => n.proposal)))).toThrow(/consumed/)
  expect(f.ticket()).toEqual(before)
})

it('rechecks the server lease at the final graph write and rolls back superseded states and events if it expires', () => {
  const f = fixture(), before = f.ticket(), count = store.db.prepare('SELECT count(*) AS n FROM project_event').get()!.n
  let checks = 0
  const lease = { ...f.lease, authorize() { if (++checks > 1) throw new Error('Server operation retired before graph commit') } }
  expect(() => f.plans.reviseAssignments('owner', f.project.id, { ticketId: before.id, graphId: f.initial.id, expectedVersion: 1, operationId: 'retired-before-commit', assignments: changed(f.initial.nodes.map(n => n.proposal)) }, lease)).toThrow(/retired/)
  expect(f.ticket()).toEqual(before)
  expect(store.db.prepare('SELECT count(*) AS n FROM project_event').get()!.n).toBe(count)
})

it('keeps another authorization graph untouched when revising the first authorized execution', () => {
  const f = fixture()
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'another-explicit-run', text: '再运行一次' })
  const second = f.plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: f.ticket().id, planRevision: 1, operationId: 'another-explicit-run', intent: 'rerun' })
  const other = currentAssignmentGraph(f.ticket(), second.authorization.id)!, beforeOther = activePlanAssignments(f.ticket(), other.authorizationId)
  f.change(changed(f.initial.nodes.map(n => n.proposal)), 'revise-first-run', f.initial)
  expect(currentAssignmentGraph(f.ticket(), other.authorizationId)).toEqual(other)
  expect(activePlanAssignments(f.ticket(), other.authorizationId)).toEqual(beforeOther)
  expect(activePlanAssignments(f.ticket(), f.initial.authorizationId).every(a => a.contract?.authorizationId === f.initial.authorizationId)).toBe(true)
})

it('selects the current same-key node after multiple pending revisions while retaining all historical identities', () => {
  const f = fixture(), first = f.initial.nodes.find(n => n.proposal.key === 'b')!.assignmentId
  const second = f.change(changed(f.initial.nodes.map(n => n.proposal)))
  const secondB = second.nodes.find(n => n.proposal.key === 'b')!.assignmentId
  const third = f.change(second.nodes.map(n => n.proposal.key === 'b' ? { ...n.proposal, goal: 'Another bounded comparison of route B' } : n.proposal), 'third')
  const thirdB = third.nodes.find(n => n.proposal.key === 'b')!.assignmentId
  expect(new Set([first, secondB, thirdB]).size).toBe(3)
  expect(activeAssignmentByKey(f.ticket(), third.authorizationId, 'b')?.id).toBe(thirdB)
  expect(activePlanAssignments(f.ticket()).map(a => a.id)).not.toContain(first)
  expect(activePlanAssignments(f.ticket()).map(a => a.id)).not.toContain(secondB)
  expect(f.ticket().assignments.some(a => a.id === first)).toBe(true)
})

it('does not use another Ticket graph id as revision authority even inside the same project', () => {
  const f = fixture()
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'other-task-original', text: 'Another task in this project' })
  const p = f.plans.save('owner', f.project.id, { expectedRevision: 0, operationId: 'other-task-plan', plan: { ...f.plan, goal: 'Another bounded task' } })
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'other-task-confirm', text: '按这个方案做' })
  const c = f.plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: p.ticketId, planRevision: 1, operationId: 'other-task-confirm', intent: 'execute' })
  const other = currentAssignmentGraph(c.ticket)!, before = f.ticket()
  expect(() => f.plans.reviseAssignments('owner', f.project.id, { ticketId: before.id, graphId: other.id, expectedVersion: other.version, operationId: 'wrong-graph-owner', assignments: changed(f.initial.nodes.map(n => n.proposal)) }, f.lease)).toThrow()
  expect(f.ticket()).toEqual(before)
})
