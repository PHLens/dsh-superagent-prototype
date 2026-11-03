/** Versioned decomposition data in the existing Ticket; dispatch and receipts stay with the existing engine. */
import type { Assignment, AssignmentGraphNode, AssignmentGraphRevision, AssignmentProposal, PlanAssignmentInput, PlanContent, Ticket } from './model.ts'
import { validateAssignmentGraph } from './dependencies.ts'
import { key } from './ids.ts'

export function graphCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(graphCanonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => `${JSON.stringify(name)}:${graphCanonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const same = (a: unknown, b: unknown) => graphCanonical(a) === graphCanonical(b)
const requireGraph = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const unique = <T>(values: readonly T[]) => [...new Set(values)]

/** Copy declared fields only; arbitrary model fields never become graph authority. */
export function normalizeGraphProposals(input: readonly AssignmentProposal[]): AssignmentProposal[] {
  requireGraph(Array.isArray(input) && input.length > 0 && input.length <= 32, 'Assignment graph must contain 1–32 work packages')
  requireGraph(JSON.stringify(input).length <= 131072, 'Assignment graph is too large')
  const rows = input.map(item => {
    requireGraph(item && [item.key, item.goal, item.completion, item.cost].every(nonempty), 'Assignment proposal text is incomplete')
    for (const list of [item.outputs, item.resources, item.dependencies]) requireGraph(Array.isArray(list) && list.every(nonempty), 'Assignment proposal list is invalid')
    requireGraph(item.outputs.length > 0 && unique(item.outputs).length === item.outputs.length && unique(item.dependencies).length === item.dependencies.length, 'Assignment outputs and dependencies must be distinct')
    requireGraph(item.acceptance && ['registered-files', 'human-review'].includes(item.acceptance.mode) && Number.isSafeInteger(item.acceptance.version) && item.acceptance.version > 0, 'Assignment acceptance is invalid')
    if (item.retry) requireGraph(Array.isArray(item.retry.on) && item.retry.on.every(reason => ['failed', 'changes_required'].includes(reason)) && unique(item.retry.on).length === item.retry.on.length, 'Registered retry conditions are invalid')
    return { key: item.key, goal: item.goal, outputs: [...item.outputs], completion: item.completion, resources: unique(item.resources), cost: item.cost,
      dependencies: [...item.dependencies], writeScope: item.writeScope, acceptance: { ...item.acceptance },
      ...(item.review ? { review: { target: item.review.target, conditionsVersion: item.review.conditionsVersion } } : {}),
      ...(item.retry ? { retry: { on: [...item.retry.on], limit: item.retry.limit } } : {}) } satisfies AssignmentProposal
  })
  validateAssignmentGraph(rows)
  return rows
}
export function graphIdentity(ticketId: string, authorizationId: string, version: number): string { return key('assignment-graph', ticketId, authorizationId, String(version)) }
export function initialGraphProposals(plan: PlanContent, revision: number): AssignmentProposal[] {
  return normalizeGraphProposals(plan.assignments?.length ? plan.assignments : [{ key: 'work', goal: plan.goal, outputs: plan.outputs, completion: plan.completion,
    resources: plan.resources, cost: plan.cost, dependencies: [], writeScope: 'isolated-directory', acceptance: plan.acceptance ?? { version: revision, mode: 'human-review' } }])
}
/** Parent deliverables and resource grants remain binding even when the coordinator reorganizes steps. */
export function validateDecomposition(plan: PlanContent, proposals: readonly AssignmentProposal[]): void {
  const rows = normalizeGraphProposals(proposals)
  const diagnostics: string[] = []
  for (const item of rows) for (const [index, resource] of item.resources.entries()) if (!plan.resources.includes(resource)) {
    diagnostics.push(`assignment ${item.key}.resources[${index}]: undeclared resource ${JSON.stringify(resource.slice(0, 100))}; copy an exact top-level resources entry, not a paraphrase`)
  }
  for (const output of plan.outputs) {
    const producers = rows.filter(item => item.outputs.includes(output))
    if (!producers.length) diagnostics.push(`required output ${JSON.stringify(output.slice(0, 100))} has no assignment producer`)
    if (plan.acceptance?.mode === 'human-review') for (const producer of producers) {
      const covered = producer.acceptance.version >= plan.acceptance.version && (producer.acceptance.mode === 'human-review'
        || rows.some(item => item.review?.target === producer.key && item.review.conditionsVersion === producer.acceptance.version))
      if (!covered) diagnostics.push(`output ${JSON.stringify(output.slice(0, 100))} from assignment ${producer.key} needs acceptance.version >= ${plan.acceptance.version} and either semantic human-review acceptance or a dependent review targeting ${producer.key} at matching conditionsVersion (current producer version ${producer.acceptance.version})`)
    }
  }
  requireGraph(!diagnostics.length, diagnostics.slice(0, 12).join('; ') + (diagnostics.length > 12 ? `; ${diagnostics.length - 12} additional issues; fix these and validate again` : ''))
}
export function currentAssignmentGraph(ticket: Ticket, authorizationId?: string): AssignmentGraphRevision | undefined {
  const id = authorizationId ?? ticket.authorizations?.findLast(item => !item.revokedAt)?.id
  return ticket.assignmentGraphs?.findLast(item => item.authorizationId === id)
}
/** Current necessary work, including already accepted members; historical receipts are looked up separately. */
export function activePlanAssignments(ticket: Ticket, authorizationId?: string): Assignment[] {
  const result: Assignment[] = []
  for (const authorization of ticket.authorizations ?? []) {
    if (authorization.revokedAt || authorizationId && authorization.id !== authorizationId) continue
    const graph = currentAssignmentGraph(ticket, authorization.id)
    const candidates = ticket.assignments.filter(item => item.contract?.authorizationId === authorization.id)
    if (!graph) { result.push(...candidates); continue }
    for (const node of graph.nodes) {
      const assignment = candidates.find(item => item.id === node.assignmentId)
      requireGraph(assignment, 'Current graph references a missing Assignment')
      result.push(assignment!)
    }
  }
  return result
}
export function isActivePlanAssignment(ticket: Ticket, assignmentId: string): boolean { return activePlanAssignments(ticket).some(item => item.id === assignmentId) }
export function activeAssignmentByKey(ticket: Ticket, authorizationId: string, name: string): Assignment | undefined {
  const graph = currentAssignmentGraph(ticket, authorizationId)
  const node = graph?.nodes.find(item => item.proposal.key === name)
  return node ? activePlanAssignments(ticket, authorizationId).find(item => item.id === node.assignmentId)
    : activePlanAssignments(ticket, authorizationId).find(item => item.contract?.assignmentKey === name)
}
const retryWithin = (candidate: AssignmentProposal, original: AssignmentProposal) => (candidate.retry?.limit ?? 0) <= (original.retry?.limit ?? 0)
  && (candidate.retry?.on ?? []).every(reason => original.retry?.on.includes(reason))
const acceptanceWithin = (candidate: AssignmentProposal, original: AssignmentProposal) => candidate.acceptance.version >= original.acceptance.version
  && (original.acceptance.mode !== 'human-review' || candidate.acceptance.mode === 'human-review')
/** A required outcome may move only with its checks, cost class, retry bounds and review role intact. */
export function retainsOutcome(candidate: AssignmentProposal, original: AssignmentProposal): boolean {
  return original.outputs.every(output => candidate.outputs.includes(output)) && candidate.completion.includes(original.completion)
    && candidate.cost === original.cost && !!candidate.review === !!original.review && retryWithin(candidate, original) && acceptanceWithin(candidate, original)
}
export function validateRevisedGraphScope(plan: PlanContent, initial: AssignmentGraphRevision, proposed: readonly AssignmentProposal[]): void {
  validateDecomposition(plan, proposed)
  requireGraph(proposed.length <= initial.nodes.length, 'Assignment graph exceeds the confirmed work budget')
  for (const original of initial.nodes) requireGraph(proposed.some(item => retainsOutcome(item, original.proposal)), 'Assignment graph omits or weakens a required outcome')
  // Separate original producers of the same named output still require separate registered evidence.
  const counts = new Map<string, number>()
  for (const original of initial.nodes) for (const output of original.proposal.outputs) counts.set(output, (counts.get(output) ?? 0) + 1)
  for (const [output, count] of counts) requireGraph(proposed.filter(item => item.outputs.includes(output)).length >= count, 'Assignment graph merges independently required output evidence')
  const reviews = initial.nodes.filter(item => item.proposal.review)
  const matched = new Map<string, number>()
  const match = (index: number, seen: Set<string>): boolean => {
    const original = reviews[index]!.proposal, target = initial.nodes.find(item => item.proposal.key === original.review!.target)!.proposal
    for (const candidate of proposed) {
      const producer = proposed.find(item => item.key === candidate.review?.target)
      if (seen.has(candidate.key) || !retainsOutcome(candidate, original) || !producer || !retainsOutcome(producer, target)) continue
      seen.add(candidate.key)
      const previous = matched.get(candidate.key)
      if (previous !== undefined && !match(previous, seen)) continue
      matched.set(candidate.key, index); return true
    }
    return false
  }
  for (let index = 0; index < reviews.length; index++) requireGraph(match(index, new Set()), 'Assignment graph removes an independent required review gate')
}
/** Match original cost/retry slots, reserving any slot whose execution has ever begun. */
export function assignGraphBudgetSlots(initial: AssignmentGraphRevision, current: AssignmentGraphRevision, proposed: readonly AssignmentProposal[], locked: ReadonlySet<string>): Map<string, string> {
  const slots = new Map(initial.nodes.map(node => [node.budgetSlot, node.proposal]))
  const assignments = new Map<string, string>(), occupied = new Map<string, string>()
  for (const node of current.nodes) if (locked.has(node.assignmentId)) {
    const proposal = proposed.find(item => item.key === node.proposal.key)
    requireGraph(proposal && same(proposal, node.proposal), 'An execution or consumed contract cannot be revised')
    assignments.set(node.proposal.key, node.budgetSlot); occupied.set(node.budgetSlot, node.proposal.key)
  }
  const lockedKeys = new Set(assignments.keys())
  const visit = (proposal: AssignmentProposal, seen: Set<string>): boolean => {
    const preferred = current.nodes.find(item => item.proposal.key === proposal.key)?.budgetSlot
    const names = [...slots.keys()].sort((a, b) => a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b))
    for (const slot of names) {
      const original = slots.get(slot)!, previous = occupied.get(slot)
      if (seen.has(slot) || original.cost !== proposal.cost || !retryWithin(proposal, original) || previous && lockedKeys.has(previous)) continue
      seen.add(slot)
      if (previous && !visit(proposed.find(item => item.key === previous)!, seen)) continue
      occupied.set(slot, proposal.key); assignments.set(proposal.key, slot); return true
    }
    return false
  }
  for (const proposal of proposed) if (!lockedKeys.has(proposal.key)) requireGraph(visit(proposal, new Set()), 'Assignment cost or retry budget exceeds its authorization')
  return assignments
}
/** Keep explicit artifact versions/external inputs; only unconsumed intra-graph dependencies may be reorganized. */
export function graphNodeInputs(ticket: Ticket, graph: AssignmentGraphRevision, node: AssignmentGraphNode, initial: AssignmentGraphRevision, plan: PlanContent): PlanAssignmentInput[] {
  const initialIds = new Set(initial.nodes.map(item => item.assignmentId))
  const inherited: PlanAssignmentInput[] = (plan.artifactInputs ?? []).map(ref => ({ kind: 'artifact', ...ref }))
  const covered = initial.nodes.filter(item => retainsOutcome(node.proposal, item.proposal))
  for (const original of covered) {
    const assignment = ticket.assignments.find(item => item.id === original.assignmentId)!
    inherited.push(...(assignment?.contract?.inputs ?? []).filter(ref => ref.kind === 'artifact' || !initialIds.has(ref.assignmentId)))
  }
  for (const dependency of node.proposal.dependencies) {
    const target = graph.nodes.find(item => item.proposal.key === dependency)
    requireGraph(target, 'Assignment graph dependency is missing')
    inherited.push({ kind: 'dependency', ticketId: ticket.id, assignmentId: target!.assignmentId })
  }
  return [...new Map(inherited.map(ref => [graphCanonical(ref), ref])).values()]
}
/** Storage guard: graph records and old contracts remain immutable, scoped and internally consistent. */
export function assertAssignmentGraphs(ticket: Ticket, previous?: Ticket): void {
  for (const old of previous?.assignmentGraphs ?? []) requireGraph(same(old, ticket.assignmentGraphs?.find(item => item.id === old.id)), 'Assignment graph history is immutable')
  const ids = new Set<string>(), histories = new Map<string, AssignmentGraphRevision[]>(), origins = new Map<string, AssignmentGraphNode>()
  for (const graph of ticket.assignmentGraphs ?? []) {
    const authorization = ticket.authorizations?.find(item => item.id === graph.authorizationId)
    const plan = ticket.planRevisions?.find(item => item.revision === graph.planRevision)
    requireGraph(authorization?.graphPolicy === 'bounded-revisions' && authorization.targetId === graph.targetId && authorization.planRevision === graph.planRevision
      && graph.projectId === ticket.projectId && graph.ticketId === ticket.id && plan, 'Assignment graph ownership or policy does not match')
    requireGraph(!ids.has(graph.id) && nonempty(graph.operationId) && nonempty(graph.createdAt), 'Assignment graph identity is invalid'); ids.add(graph.id)
    const history = histories.get(graph.authorizationId) ?? [], before = history.at(-1), version = history.length + 1
    requireGraph(graph.version === version && graph.id === graphIdentity(ticket.id, graph.authorizationId, version) && graph.previousId === before?.id, 'Assignment graph version chain is invalid')
    const proposals = normalizeGraphProposals(graph.nodes.map(node => node.proposal))
    validateDecomposition(plan!, proposals)
    const initial = history[0] ?? graph
    if (version === 1) {
      const expected = initialGraphProposals(plan!, graph.planRevision)
      requireGraph(same(expected, proposals) && graph.createdBy.kind === 'confirmation' && graph.createdBy.messageId === authorization!.message.id, 'Initial graph differs from the confirmed scope')
    } else {
      validateRevisedGraphScope(plan!, initial, proposals)
      requireGraph(graph.createdBy.kind === 'coordinator' && nonempty(graph.createdBy.sessionId) && nonempty(graph.createdBy.inputId)
        && Number.isSafeInteger(graph.createdBy.generation) && graph.createdBy.generation > 0 && Number.isSafeInteger(graph.createdBy.stateVersion) && graph.createdBy.stateVersion >= 0, 'Graph revision lacks coordinator provenance')
      requireGraph(ticket.planOperations?.some(operation => operation.id === graph.operationId && operation.kind === 'revise-assignments' && operation.graphId === graph.id), 'Graph revision operation receipt is missing')
    }
    const nodeIds = new Set<string>(), budgetSlots = new Set<string>()
    for (const node of graph.nodes) {
      const assignment = ticket.assignments.find(item => item.id === node.assignmentId), contract = assignment?.contract
      const slot = initial.nodes.find(item => item.budgetSlot === node.budgetSlot)
      requireGraph(!nodeIds.has(node.assignmentId) && !budgetSlots.has(node.budgetSlot) && slot && slot.proposal.cost === node.proposal.cost && retryWithin(node.proposal, slot.proposal), 'Assignment graph budget slot is invalid')
      nodeIds.add(node.assignmentId); budgetSlots.add(node.budgetSlot)
      requireGraph(contract && contract.authorizationId === graph.authorizationId && contract.targetId === graph.targetId && contract.planRevision === graph.planRevision, 'Assignment graph member ownership is invalid')
      const actual = contract?.proposal ?? initialGraphProposals(contract!.plan, contract!.planRevision)[0]
      requireGraph(same(actual, node.proposal), 'Graph member differs from its immutable contract')
      const old = origins.get(node.assignmentId)
      if (old) requireGraph(same(old, node), 'Graph cannot change an existing Assignment identity')
      else origins.set(node.assignmentId, node)
      // On v1 the original dependency references already define this graph; later versions must keep every fixed input.
      requireGraph(same(contract!.inputs, graphNodeInputs(ticket, graph, node, initial, plan!)), 'Graph cannot replace a consumed dependency or artifact version')
    }
    history.push(graph); histories.set(graph.authorizationId, history)
  }
}
