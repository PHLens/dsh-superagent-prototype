import { describe, expect, it } from 'vitest'
import { MemoryRepositories, Plans, Projects, type AssignmentProposal, type PlanContent } from '../src/core/index.ts'
import { assignmentReady } from '../src/core/dependencies.ts'
const node = (key: string, dependencies: string[] = []): AssignmentProposal => ({ key, dependencies, goal: `Investigate ${key}`, outputs: [`${key}.md`], completion: 'Cited comparison', resources: [], cost: 'One attempt', writeScope: 'isolated-directory', acceptance: { version: 1, mode: 'registered-files' } })
const plan: PlanContent = { goal: 'Two investigations and synthesis', scope: 'Local text files', outputs: ['c.md'], resources: [], environment: 'Managed file worker', cost: 'Three attempts', completion: 'Synthesis consumes both investigations', assignments: [node('a'), node('b'), node('c', ['a', 'b'])] }
function setup() {
  const repo = new MemoryRepositories(), projects = new Projects({ repo })
  const project = projects.create({ name: 'Research', goal: plan.goal }), ticket = projects.createDraft(project.id, { title: plan.goal })
  const plans = new Plans({ repo, resolveConfirmation: request => ({ actor: { source: 'web', id: 'owner' }, message: { id: 'confirm', text: '按这个方案做' }, explicit: true, planRevision: request.planRevision, intent: request.intent }) })
  const scope = { projectId: project.id, ticketId: ticket.id }
  return { repo, plans, scope }
}
describe('confirmed coordinator decomposition', () => {
  it('creates all packages under one authorization and replays without duplicates', () => {
    const { repo, plans, scope } = setup()
    plans.save({ ...scope, expectedRevision: 0, plan })
    const confirmed = plans.confirm({ ...scope, planRevision: 1, operationId: 'confirm', intent: 'execute' })
    const input = { ...scope, planRevision: 1, authorizationId: confirmed.authorization.id, targetId: confirmed.target.id }
    const assignments = plans.registerAssignments(input)
    expect(assignments).toHaveLength(3)
    expect(plans.registerAssignments(input)).toEqual(assignments)
    expect(new Set(assignments.map(item => item.contract?.authorizationId)).size).toBe(1)
    expect(assignments.map(item => item.contract?.plan.outputs)).toEqual([['a.md'], ['b.md'], ['c.md']])
    const ticket = repo.tickets.get(scope.ticketId)!
    expect(assignmentReady(ticket, assignments[0]!)).toMatchObject({ ready: true })
    expect(assignmentReady(ticket, assignments[2]!)).toMatchObject({ ready: false, blockedBy: assignments.slice(0, 2).map(item => item.id) })
    ticket.assignments[1]!.state = 'ended'; ticket.assignments[1]!.endedReason = 'accepted'
    expect(assignmentReady(ticket, assignments[2]!).ready).toBe(false)
    ticket.assignments[0]!.state = 'ended'; ticket.assignments[0]!.endedReason = 'accepted'
    expect(assignmentReady(ticket, assignments[2]!).ready).toBe(true)
    expect(repo.tickets.list()).toHaveLength(1)
  })
  it('rejects graph cycles before saving or authorizing work', () => {
    const { repo, plans, scope } = setup()
    expect(() => plans.save({ ...scope, expectedRevision: 0, plan: { ...plan, assignments: [node('a', ['b']), node('b', ['a'])] } })).toThrow()
    expect(repo.tickets.get(scope.ticketId)?.planRevisions).toBeUndefined()
  })
})
