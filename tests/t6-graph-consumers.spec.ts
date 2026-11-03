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
import { ReportAcceptance } from '../src/app/report-acceptance.ts'
import { projectProgress } from '../src/app/project-progress.ts'

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

it('completes the current graph through real registered file receipts despite superseded historical nodes', () => {
  const f = fixture()
  f.change(f.initial.nodes.map(n => n.proposal.key === 'b' ? { ...n.proposal, goal: 'Compare route B maintenance evidence' } : n.proposal))
  const attempts = new ExecutionAttempts(store, directory), artifacts = new ArtifactStore(store, attempts), reports = new ReportAcceptance(store, attempts, artifacts)
  for (const node of f.graph().nodes) {
    const ticket = f.ticket(), assignment = ticket.assignments.find(a => a.id === node.assignmentId)!
    const attempt = attempts.prepare(attempts.allocate(ticket, assignment))
    const artifact = artifacts.write(attempt.sessionId, { operationId: 'file', output: node.proposal.outputs[0]!, name: node.proposal.outputs[0]!, content: 'Verified finding and its evidence' })
    const input = { operationId: 'report', state: 'ready' as const, completed: 'Finished bounded work', evidence: ['Checked registered file'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] }
    const receipt = reports.submit(attempt.sessionId, input)
    const beforeReplay = f.ticket()
    expect(reports.submit(attempt.sessionId, input)).toEqual(receipt)
    expect(f.ticket()).toEqual(beforeReplay)
  }
  expect(f.ticket().assignments.some(a => a.endedReason === 'superseded')).toBe(true)
  expect(f.ticket().ended?.outcome).toBe('completed')
})

it('registers a reviewer against the current same-key target and its exact ready receipt', () => {
  const f = fixture([node('b'), { ...node('summary', ['b']), review: { target: 'b', conditionsVersion: 1 } }])
  const oldId = f.initial.nodes[0]!.assignmentId
  f.change(f.initial.nodes.map(n => n.proposal.key === 'b' ? { ...n.proposal, goal: 'Compare route B maintenance evidence' } : n.proposal))
  const attempts = new ExecutionAttempts(store, directory), artifacts = new ArtifactStore(store, attempts), reports = new ReportAcceptance(store, attempts, artifacts)
  const ticket = f.ticket(), target = activeAssignmentByKey(ticket, f.initial.authorizationId, 'b')!
  const attempt = attempts.prepare(attempts.allocate(ticket, target))
  const artifact = artifacts.write(attempt.sessionId, { operationId: 'file', output: 'b.md', name: 'b.md', content: 'Research evidence to review' })
  const report = reports.submit(attempt.sessionId, { operationId: 'report', state: 'ready', completed: 'Ready for review', evidence: ['Registered note'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
  const current = f.ticket(), reviewer = activeAssignmentByKey(current, f.initial.authorizationId, 'summary')!
  const judge = attempts.allocate(current, reviewer)
  expect(judge.reviewTarget?.assignmentId).toBe(target.id)
  expect(judge.reviewTarget?.assignmentId).not.toBe(oldId)
  expect(judge.reviewTarget?.reportId).toBe(report.id)
  expect(judge.inputs).toContainEqual({ artifactId: artifact.id, contentVersion: artifact.contentVersion, assignmentId: target.id, reportId: report.id })
})

it('projects only current graph work and refuses allocation of a stale pre-revision assignment object', () => {
  const f = fixture(), old = activeAssignmentByKey(f.ticket(), f.initial.authorizationId, 'b')!
  f.change(f.initial.nodes.map(n => n.proposal.key === 'b' ? { ...n.proposal, goal: 'Compare route B maintenance evidence' } : n.proposal))
  const ticket = f.ticket(), attempts = new ExecutionAttempts(store, directory)
  expect(old.state).toBe('pending')
  expect(() => attempts.allocate(ticket, old)).toThrow(/authorized/)
  expect(attempts.all()).toHaveLength(0)
  const progress = projectProgress(ticket, { attempts: [], reports: [], decisions: [], artifacts: [] })
  expect(progress.assignments.map(a => a.assignmentId)).toEqual(activePlanAssignments(ticket).map(a => a.id))
  expect(progress.assignments.some(a => a.assignmentId === old.id)).toBe(false)
})
