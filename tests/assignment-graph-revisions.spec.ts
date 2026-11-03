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

it('creates graph v1 atomically on one confirmation and keeps exact confirmation replay inert', () => {
  const f = fixture()
  expect(f.initial.version).toBe(1); expect(f.initial.nodes).toHaveLength(3)
  expect(f.initial.createdBy).toEqual({ kind: 'confirmation', messageId: f.confirmed.message.id })
  f.plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: f.plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  expect(f.ticket().assignmentGraphs).toEqual([f.initial]); expect(f.ticket().authorizations).toHaveLength(1)
})
it('replaces only pending B and its pending dependent while preserving running A and every old contract', () => {
  const f = fixture(), before = f.ticket(), a = before.assignments.find(item => item.contract?.assignmentKey === 'a')!
  a.state = 'running'; a.startedAt = '2026-11-03T12:00:00Z'; store.tickets.save(before)
  const revised = f.change(changed(f.initial.nodes.map(item => item.proposal)))
  const after = f.ticket(), active = activePlanAssignments(after)
  expect(revised.version).toBe(2); expect(after.authorizations).toHaveLength(1); expect(after.planRevisions).toHaveLength(1)
  expect(active.find(item => item.contract?.assignmentKey === 'a')?.id).toBe(a.id)
  for (const key of ['b', 'summary']) {
    const old = before.assignments.find(item => item.contract?.assignmentKey === key)!, next = activeAssignmentByKey(after, revised.authorizationId, key)!
    expect(next.id).not.toBe(old.id); expect(next.contract!.graphVersion).toBe(2)
    expect(after.assignments.find(item => item.id === old.id)).toMatchObject({ state: 'ended', endedReason: 'superseded', contract: old.contract })
  }
  const b = activeAssignmentByKey(after, revised.authorizationId, 'b')!, summary = activeAssignmentByKey(after, revised.authorizationId, 'summary')!
  expect(summary.contract!.inputs).toEqual(expect.arrayContaining([{ kind: 'dependency', ticketId: after.id, assignmentId: b.id }]))
  expect(revised.createdBy).toMatchObject({ kind: 'coordinator', sessionId: f.lease.sessionId, inputId: f.lease.inputId })
})
it('returns an exact historical revision receipt after later graph edits without adding identities or reaggregating events', () => {
  const f = fixture(), proposals = changed(f.initial.nodes.map(item => item.proposal)), second = f.change(proposals)
  f.change(proposals.map(item => item.key === 'summary' ? { ...item, goal: 'Write an evidence-based synthesis' } : item), 'third')
  const before = f.ticket(), events = store.db.prepare('SELECT count(*) AS n FROM project_event').get()!.n
  expect(f.change(proposals, 'revise', f.initial)).toEqual(second)
  expect(f.ticket()).toEqual(before); expect(store.db.prepare('SELECT count(*) AS n FROM project_event').get()!.n).toBe(events)
  expect(() => f.change(proposals.map(item => ({ ...item, goal: 'Changed payload' })), 'revise', f.initial)).toThrow()
  expect(() => f.change(proposals, 'new-operation-on-old-graph', f.initial)).toThrow()
})
it('holds the explicit user pause while adjusting pending work and never grants another authorization', () => {
  const f = fixture(), t = f.ticket(), at = '2026-11-03T12:00:00Z'
  t.lifecycle = { pause: { intent: 'pause', state: 'paused', at }, stop: { intent: 'none', state: 'running', at }, observed: { state: 'idle', at } }; store.tickets.save(t)
  f.change(changed(f.initial.nodes.map(item => item.proposal)))
  expect(f.ticket().lifecycle).toEqual(t.lifecycle); expect(f.ticket().authorizations).toEqual(t.authorizations)
})
it.each(['expired', 'generation', 'owner', 'project', 'stopped', 'revoked'] as const)('rejects %s authority without writing graph or assignments', kind => {
  const f = fixture(), proposals = changed(f.initial.nodes.map(item => item.proposal))
  if (kind === 'expired') f.expire()
  if (kind === 'generation') f.conversations.saveMapping(f.project.id, 'owner', { sessionId: 'replacement', workspaceId: 'next', cwd: directory, expectedGeneration: f.mapping.generation, reason: 'Known old operation has settled', reconciled: true })
  if (kind === 'stopped') { const t = f.ticket(); t.ended = { by: 'human', outcome: 'stopped', at: '2026-11-03T12:00:00Z' }; store.tickets.save(t) }
  if (kind === 'revoked') f.plans.revoke('owner', f.project.id, { projectId: f.project.id, ticketId: f.plan.ticketId, authorizationId: f.initial.authorizationId, operationId: 'revoke' })
  const before = f.ticket()
  expect(() => kind === 'owner' ? f.plans.reviseAssignments('stranger', f.project.id, { ticketId: before.id, graphId: f.initial.id, expectedVersion: 1, operationId: 'change', assignments: proposals }, f.lease)
    : kind === 'project' ? f.plans.reviseAssignments('owner', f.projects.create({ name: 'Other', goal: 'Other scope' }).id, { ticketId: before.id, graphId: f.initial.id, expectedVersion: 1, operationId: 'change', assignments: proposals }, f.lease)
    : f.change(proposals)).toThrow()
  expect(f.ticket()).toEqual(before)
})
it('treats a pending prepared attempt as locked and does not let replacement reset an already-used retry budget', () => {
  const f = fixture(), t = f.ticket(), b = t.assignments.find(item => item.contract?.assignmentKey === 'b')!, attempts = new ExecutionAttempts(store, directory)
  attempts.allocate(t, b)
  const view = f.plans.readAssignmentGraph('owner', f.project.id, { ticketId: t.id })
  expect(view.members.find(item => item.assignmentId === b.id)?.canRevise).toBe(false)
  expect(() => f.change(changed(f.initial.nodes.map(item => item.proposal)))).toThrow()
  expect(f.ticket()).toEqual(t)
})
it('does not replace a finished current member under a new key or drop its consumed input contract', () => {
  const f = fixture(), t = f.ticket(), b = t.assignments.find(item => item.contract?.assignmentKey === 'b')!
  b.state = 'ended'; b.endedReason = 'accepted'; store.tickets.save(t)
  const next = f.initial.nodes.map(item => item.proposal).map(item => item.key === 'b' ? { ...item, key: 'new-b' } : { ...item, dependencies: item.dependencies.map(dep => dep === 'b' ? 'new-b' : dep) })
  expect(() => f.change(next)).toThrow(); expect(f.ticket()).toEqual(t)
})
it.each(['resource', 'output', 'retry', 'cost', 'cycle', 'scope-count'] as const)('rejects an expanded or weakened %s graph', kind => {
  const f = fixture(), original = f.initial.nodes.map(item => item.proposal)
  const next = original.map(item => item.key !== 'b' ? item : kind === 'resource' ? { ...item, resources: ['unapproved-resource'] }
    : kind === 'output' ? { ...item, outputs: ['different.md'] }
    : kind === 'retry' ? { ...item, retry: { on: ['failed' as const], limit: 1 } }
    : kind === 'cost' ? { ...item, cost: 'An unapproved GPU job' }
    : kind === 'cycle' ? { ...item, dependencies: ['summary'] } : item)
  if (kind === 'scope-count') next.push(node('extra'))
  const before = f.ticket(); expect(() => f.change(next)).toThrow(); expect(f.ticket()).toEqual(before)
})
it('can reorganize pending work under a new key and reuse saved budget through a merged work package', () => {
  const f = fixture(), [a, b, summary] = f.initial.nodes.map(item => item.proposal)
  const combined = { ...a!, key: 'combined', goal: 'Investigate both routes', outputs: [...a!.outputs, ...b!.outputs], completion: a!.completion + '\n' + b!.completion }
  const next = f.change([combined, { ...summary!, dependencies: ['combined'] }])
  expect(next.nodes).toHaveLength(2); expect(new Set(next.nodes.map(item => item.budgetSlot)).size).toBe(2)
  expect(activePlanAssignments(f.ticket())).toHaveLength(2); expect(f.ticket().assignments.filter(item => item.endedReason === 'superseded')).toHaveLength(3)
  expect(f.ticket().authorizations).toHaveLength(1)
})
it('retains independent review roles and updates pending conditions without carrying an old pass to the new graph', () => {
  const a = { ...node('a'), acceptance: { version: 1, mode: 'human-review' as const } }, review = { ...node('review', ['a']), review: { target: 'a', conditionsVersion: 1 } }, summary = node('summary', ['a', 'review'])
  const f = fixture([a, review, summary])
  expect(() => f.change([a, { ...review, review: undefined }, summary], 'remove-review')).toThrow()
  const next = f.change([{ ...a, acceptance: { ...a.acceptance, version: 2 } }, { ...review, review: { ...review.review, conditionsVersion: 2 } }, summary])
  const target = activeAssignmentByKey(f.ticket(), next.authorizationId, 'a')!, judge = activeAssignmentByKey(f.ticket(), next.authorizationId, 'review')!
  expect(target.contract!.plan.acceptance!.version).toBe(2)
  expect(judge.contract!.inputs).toContainEqual({ kind: 'dependency', ticketId: f.plan.ticketId, assignmentId: target.id })
  expect(judge.id).not.toBe(f.initial.nodes.find(item => item.proposal.key === 'review')!.assignmentId)
})
it('guards graph history even when a caller attempts a direct Ticket save', () => {
  const f = fixture(); f.change(changed(f.initial.nodes.map(item => item.proposal)))
  const t = f.ticket(); (t.assignmentGraphs![0]!.nodes[0]!.proposal as { goal: string }).goal = 'Rewritten history'
  expect(() => store.tickets.save(t)).toThrow(/history/)
})
it('offers no model mutation endpoint without a real server graph lease', () => {
  const f = fixture(), host = { plans: f.plans, actorId: 'owner', projectId: f.project.id, authorize: () => {} }
  expect(projectTools(host).map(tool => tool.name)).toContain('project_read_assignment_graph')
  expect(projectTools(host).map(tool => tool.name)).not.toContain('project_revise_assignments')
  expect(projectTools({ ...host, graphLease: () => f.lease }).map(tool => tool.name)).toContain('project_revise_assignments')
})

it('does not silently opt a legacy authorization into graph mutation when a confirmation receipt is replayed', () => {
  const f = fixture(), legacy = f.ticket()
  delete legacy.assignmentGraphs
  for (const authorization of legacy.authorizations!) delete (authorization as { graphPolicy?: string }).graphPolicy
  // Seed the exact older data shape, as a schema migration would preserve it; application APIs cannot remove this history.
  store.db.prepare('UPDATE ticket SET value=? WHERE id=?').run(JSON.stringify(legacy), legacy.id)
  f.plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: f.plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  expect(f.ticket()).toEqual(legacy)
  expect(f.plans.readAssignmentGraph('owner', f.project.id, { ticketId: legacy.id })).toMatchObject({ editable: false, reason: 'legacy-authorization' })
  expect(activePlanAssignments(f.ticket()).map(item => item.id)).toEqual(legacy.assignments.map(item => item.id))
  expect(() => f.change(changed(f.initial.nodes.map(item => item.proposal)))).toThrow()
})
it('keeps exact approved artifact versions on every replacement instead of silently reading a mutable latest input', () => {
  const f = fixture()
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'source-goal', text: 'Write an input note' })
  const source = f.plans.save('owner', f.project.id, { expectedRevision: 0, operationId: 'source-save', plan: { goal: 'Input note', scope: 'A managed input', outputs: ['input.md'], resources: [], environment: 'Managed', cost: 'One worker', completion: 'One note', acceptance: { version: 1, mode: 'registered-files' } } })
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'source-confirm', text: '按这个方案做' })
  const sourceConfirmed = f.plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: source.ticketId, planRevision: 1, operationId: 'source-confirm', intent: 'execute' })
  const attempts = new ExecutionAttempts(store, directory), artifacts = new ArtifactStore(store, attempts)
  const attempt = attempts.prepare(attempts.allocate(sourceConfirmed.ticket, sourceConfirmed.assignment))
  const input = artifacts.write(attempt.sessionId, { operationId: 'input', output: 'input.md', name: 'input.md', content: '# Immutable source input' })
  const approved = { artifactId: input.id, contentVersion: input.contentVersion }
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'target-goal', text: 'Use exactly this registered input' })
  const target = f.plans.save('owner', f.project.id, { expectedRevision: 0, operationId: 'target-save', plan: { goal: 'Use input', scope: 'One graph', outputs: ['summary.md'], resources: [], environment: 'Managed', cost: 'Three workers', completion: 'A checked synthesis', artifactInputs: [approved], assignments: f.initial.nodes.map(item => item.proposal) } })
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'target-confirm', text: '按这个方案做' })
  f.plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: target.ticketId, planRevision: 1, operationId: 'target-confirm', intent: 'execute' })
  const graph = currentAssignmentGraph(store.tickets.get(target.ticketId)!)!
  const revised = f.plans.reviseAssignments('owner', f.project.id, { ticketId: target.ticketId, graphId: graph.id, expectedVersion: 1, operationId: 'target-revise', assignments: changed(graph.nodes.map(item => item.proposal)) }, f.lease)
  for (const node of revised.nodes) expect(store.tickets.get(target.ticketId)!.assignments.find(item => item.id === node.assignmentId)!.contract!.inputs).toContainEqual({ kind: 'artifact', ...approved })
  expect(artifacts.read(f.project.id, input.id, input.contentVersion).content).toBe('# Immutable source input')
})
it('keeps distinct required reviews when many interchangeable pending reviewers could otherwise be merged', () => {
  const a = node('a'), reviews = Array.from({ length: 31 }, (_, index) => ({ ...node('review-' + index, ['a']), review: { target: 'a', conditionsVersion: 1 } }))
  const f = fixture([a, ...reviews])
  const candidates = reviews.slice(0, 30).map(item => ({ ...item, outputs: reviews.flatMap(review => review.outputs), completion: reviews.map(review => review.completion).join('\n') }))
  expect(() => f.change([a, ...candidates])).toThrow(/independent required review/)
  expect(f.ticket().assignmentGraphs).toEqual([f.initial])
})
it('reruns a completed current graph without treating superseded history as unfinished necessary work', () => {
  const f = fixture(); f.change(changed(f.initial.nodes.map(item => item.proposal)))
  const complete = f.ticket()
  for (const assignment of activePlanAssignments(complete)) { assignment.state = 'ended'; assignment.endedReason = 'accepted'; assignment.report = { state: 'ready', summary: 'Accepted current evidence', at: '2026-11-03T12:00:00Z' } }
  complete.ended = { by: 'executor', outcome: 'completed', at: '2026-11-03T12:00:00Z' }; store.tickets.save(complete)
  const history = structuredClone(complete.assignmentGraphs)
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'rerun', text: '再运行一次' })
  const request = { projectId: f.project.id, ticketId: complete.id, planRevision: 1, operationId: 'rerun', intent: 'rerun' as const }
  const rerun = f.plans.confirm('owner', f.project.id, request)
  expect(rerun.authorization.id).not.toBe(f.initial.authorizationId)
  expect(f.ticket().assignmentGraphs!.slice(0, 2)).toEqual(history)
  expect(currentAssignmentGraph(f.ticket())!.authorizationId).toBe(rerun.authorization.id)
  const count = f.ticket().assignments.length
  f.plans.confirm('owner', f.project.id, request)
  expect(f.ticket().assignments).toHaveLength(count)
})
