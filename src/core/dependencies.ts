/** Deterministic validation and readiness for a coordinator's registered Assignment graph. */
import type { AssignmentProposal, Assignment, PlanContent, Ticket } from './model.ts'

export type DependencyResult = { ready: boolean; blockedBy: string[]; reason?: string }

export function validateAssignmentGraph(proposals: readonly AssignmentProposal[]): void {
  const keys = new Set<string>()
  for (const item of proposals) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(item.key) || keys.has(item.key)) throw new Error('Invalid or duplicate assignment key')
    keys.add(item.key)
    if (!item.goal.trim() || !item.outputs.length || !item.completion.trim() || !item.resources.every(value => value.trim())) throw new Error(`Assignment ${item.key} is incomplete`)
    if (item.writeScope !== 'isolated-directory' || !Number.isSafeInteger(item.acceptance.version) || item.acceptance.version < 1) throw new Error(`Assignment ${item.key} has invalid scope or acceptance`)
    if (item.retry && (!Number.isSafeInteger(item.retry.limit) || item.retry.limit < 0 || item.retry.limit > 5)) throw new Error(`Assignment ${item.key} has invalid retry limit`)
    for (const dep of item.dependencies) if (dep === item.key || !proposals.some(other => other.key === dep)) throw new Error(`Unknown dependency ${dep}`)
    if (item.review && (!item.review.target.trim() || !Number.isSafeInteger(item.review.conditionsVersion) || item.review.conditionsVersion < 1)) throw new Error(`Assignment ${item.key} has invalid review gate`)
    if (item.review) {
      const target = proposals.find(other => other.key === item.review!.target)
      if (!target || target.key === item.key || item.review.conditionsVersion !== target.acceptance.version || !item.dependencies.includes(target.key)) throw new Error(`Assignment ${item.key} has invalid review gate`)
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error('Assignment dependency cycle')
    if (visited.has(key)) return
    visiting.add(key); for (const dep of proposals.find(item => item.key === key)!.dependencies) visit(dep)
    visiting.delete(key); visited.add(key)
  }
  for (const item of proposals) visit(item.key)
}

export function assignmentReady(ticket: Pick<Ticket, 'assignments'>, assignment: Assignment): DependencyResult {
  const inputs = assignment.contract?.inputs ?? []
  const blockedBy: string[] = []
  for (const input of inputs) if (input.kind === 'dependency') {
    const dependency = ticket.assignments.find(item => item.id === input.assignmentId)
    const reviewing = dependency && assignment.contract?.proposal?.review?.target === dependency.contract?.assignmentKey
    if (reviewing ? dependency.report?.state !== 'ready' : !dependency || dependency.state !== 'ended' || dependency.endedReason !== 'accepted') blockedBy.push(input.assignmentId)
  }
  return blockedBy.length ? { ready: false, blockedBy, reason: 'dependency' } : { ready: true, blockedBy: [] }
}

export function planAssignments(plan: PlanContent): readonly AssignmentProposal[] { return plan.assignments ?? [] }
