/** Reviewed plan revisions and explicit authorizations, stored atomically in the project Ticket aggregate. */
import { UserError } from './errors.ts'
import { validateAssignmentGraph } from './dependencies.ts'
import { activePlanAssignments, assignGraphBudgetSlots, currentAssignmentGraph, graphCanonical, graphIdentity, graphNodeInputs, initialGraphProposals, normalizeGraphProposals, validateDecomposition, validateRevisedGraphScope } from './assignment-graphs.ts'
import { key } from './ids.ts'
import type { Assignment, AssignmentGraphRevision, AssignmentProposal, CoordinatorGraphAuthority, PlanAssignmentInput, PlanAuthorization, PlanContent, PlanExecutionTarget, PlanIntent, PlanOperation, PlanRevision, Ticket, TrustedPlanConfirmation } from './model.ts'
import type { ProjectRepositories } from './ports.ts'

export interface ConfirmPlan {
  projectId: string
  ticketId: string
  planRevision: number
  operationId: string
  intent: PlanIntent
}
export interface PlanServiceOptions {
  repo: ProjectRepositories
  /** Host resolves identity and original user intent from its trusted request/session context. */
  resolveConfirmation: (request: Readonly<ConfirmPlan>) => TrustedPlanConfirmation | undefined
  validateArtifact?: (projectId: string, artifactId: string, contentVersion: string) => boolean
  canReviseAssignment?: (assignmentId: string) => boolean
  /** Resolves the current trusted coordinator operation; model arguments never provide this authority. */
  resolveGraphAuthority?: (request: Readonly<ReviseAssignments>) => CoordinatorGraphAuthority | undefined
  now?: () => string
  id?: () => string
}
export interface SavePlan {
  projectId: string
  ticketId: string
  expectedRevision: number
  plan: PlanContent
  operationId?: string
}
export interface RevokePlan { projectId: string; ticketId: string; authorizationId: string; operationId?: string }
export interface RegisterPlanAssignment {
  projectId: string
  ticketId: string
  authorizationId: string
  targetId: string
  planRevision: number
  inputs?: readonly PlanAssignmentInput[]
  /** Key in the already confirmed decomposition; never a new scope supplied by the caller. */
  assignmentKey?: string
}
export interface PlanConfirmationResult { authorization: PlanAuthorization; target: PlanExecutionTarget; ticket: Ticket }
export interface ReviseAssignments {
  projectId: string; ticketId: string; graphId: string; expectedVersion: number; operationId: string; assignments: readonly AssignmentProposal[]
}
export interface AssignmentGraphView {
  ticketId: string; graph?: AssignmentGraphRevision; editable: boolean; reason?: string
  members: { assignmentId: string; state: Assignment['state']; canRevise: boolean }[]
}

const copy = <T>(value: T): T => structuredClone(value)
/** Deterministic keys make object property order irrelevant to operation identity. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function content(plan: PlanContent): PlanContent {
  const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  if (!plan || ![plan.goal, plan.scope, plan.environment, plan.cost, plan.completion].every(text)
    || !Array.isArray(plan.outputs) || !plan.outputs.length || !plan.outputs.every(text)
    || !Array.isArray(plan.resources) || !plan.resources.every(text)) throw new UserError('invalidPlan')
  if (plan.assignments !== undefined) {
    if (!Array.isArray(plan.assignments) || !plan.assignments.length) throw new UserError('invalidPlan')
    try { validateDecomposition(plan, normalizeGraphProposals(plan.assignments)) } catch (error) {
      const details = error instanceof Error ? error.message.slice(0, 4000) + (error.message.length > 4000 ? '; additional issues omitted; repair and validate again' : '') : 'Assignment graph violates the confirmed resource or acceptance contract'
      const repair = details.includes('invalid review gate')
        ? ' Review must target a different registered assignment key, include that target in dependencies, and match its acceptance.version in conditionsVersion.' : ''
      throw new UserError('invalidPlan', { details: details + repair })
    }
  }
  // Explicitly copy the contract fields; unknown model-supplied fields grant no authority.
  if (plan.acceptance && (!Number.isSafeInteger(plan.acceptance.version) || plan.acceptance.version < 1 || !['registered-files', 'human-review'].includes(plan.acceptance.mode))) throw new UserError('invalidPlan')
  if (plan.artifactInputs !== undefined && (!Array.isArray(plan.artifactInputs) || !plan.artifactInputs.every(item => item && text(item.artifactId) && text(item.contentVersion)))) throw new UserError('invalidPlanInput')
  return copy({ goal: plan.goal, scope: plan.scope, outputs: plan.outputs, resources: plan.resources, environment: plan.environment, cost: plan.cost, completion: plan.completion,
    ...(plan.acceptance ? { acceptance: { version: plan.acceptance.version, mode: plan.acceptance.mode } } : {}),
    ...(plan.artifactInputs ? { artifactInputs: plan.artifactInputs.map(item => ({ artifactId: item.artifactId, contentVersion: item.contentVersion })) } : {}),
    ...(plan.assignments ? { assignments: normalizeGraphProposals(plan.assignments) } : {}) })
}

/** Plan authorization and immutable Assignment contracts; runtime dispatch is owned by the executor. */
export class Plans {
  private readonly now: () => string
  private readonly makeId: () => string
  constructor(private readonly options: PlanServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.makeId = options.id ?? (() => crypto.randomUUID?.() ?? key('plan', Date.now().toString(36), Math.random().toString(36)))
  }
  private ticket(projectId: string, ticketId: string, historical = false): Ticket {
    if (!this.options.repo.projects.get(projectId)) throw new UserError('unknownProject')
    const ticket = this.options.repo.tickets.get(ticketId)
    if (!ticket || ticket.projectId !== projectId) throw new UserError('projectOwnership')
    if (ticket.ended && !historical) throw new UserError('ticketEnded')
    return ticket
  }
  private operation(ticket: Ticket, id: string | undefined, payload: string): PlanOperation | undefined {
    if (id !== undefined && !id.trim()) throw new UserError('planOperationConflict')
    const old = ticket.planOperations?.find(item => item.id === id)
    if (old && old.payload !== payload) throw new UserError('planOperationConflict')
    return old
  }
  private record(ticket: Ticket, operation: PlanOperation): void {
    (ticket.planOperations ??= []).push(operation)
  }
  get(projectId: string, ticketId: string, revision?: number): PlanRevision {
    const ticket = this.ticket(projectId, ticketId, true)
    const plan = revision === undefined ? ticket.planRevisions?.at(-1) : ticket.planRevisions?.find(item => item.revision === revision)
    if (!plan) throw new UserError('unknownPlanRevision')
    return copy(plan)
  }
  save(input: SavePlan): PlanRevision {
    return this.options.repo.atomic(() => {
      const ticket = this.ticket(input.projectId, input.ticketId), plan = content(input.plan)
      const payload = canonical({ kind: 'save', projectId: input.projectId, ticketId: input.ticketId, expectedRevision: input.expectedRevision, plan })
      const old = this.operation(ticket, input.operationId, payload)
      if (old) return copy(ticket.planRevisions!.find(item => item.revision === old.planRevision)!)
      for (const ref of plan.artifactInputs ?? []) if (!this.options.validateArtifact?.(input.projectId, ref.artifactId, ref.contentVersion)) throw new UserError('invalidPlanInput')
      const current = ticket.planRevisions?.at(-1)?.revision ?? 0
      if (input.expectedRevision !== current) throw new UserError('stalePlanRevision')
      const at = this.now(), revision: PlanRevision = { ...plan, projectId: ticket.projectId!, ticketId: ticket.id, revision: current + 1, createdAt: at }
      ;(ticket.planRevisions ??= []).push(revision)
      ticket.projectStage = 'awaiting-confirmation'
      ticket.updatedAt = at
      if (input.operationId !== undefined) this.record(ticket, { id: input.operationId, kind: 'save', payload, planRevision: revision.revision })
      this.options.repo.tickets.save(ticket)
      return copy(revision)
    })
  }
  confirm(input: ConfirmPlan): PlanConfirmationResult {
    return this.options.repo.atomic(() => {
      const ticket = this.ticket(input.projectId, input.ticketId, true)
      // Rebuild this request so model-supplied actor/message/explicit fields cannot reach the trusted port.
      const request: ConfirmPlan = { projectId: input.projectId, ticketId: input.ticketId, planRevision: input.planRevision, operationId: input.operationId, intent: input.intent }
      const trusted = this.options.resolveConfirmation(Object.freeze(request))
      if (!trusted || trusted.explicit !== true || !trusted.actor?.source?.trim() || !trusted.actor?.id?.trim()
        || !trusted.message?.id?.trim() || !trusted.message?.text?.trim()
        || (trusted.originalMessage !== undefined && (!trusted.originalMessage?.id?.trim() || !trusted.originalMessage?.text?.trim()))
        || trusted.planRevision !== input.planRevision
        || trusted.intent !== input.intent || !['execute', 'rerun'].includes(input.intent)) throw new UserError('planConfirmationRequired')
      if (!input.operationId?.trim()) throw new UserError('planOperationConflict')
      const payload = canonical({ kind: 'confirm', ...request, trusted })
      const old = this.operation(ticket, input.operationId, payload)
      if (old) return this.result(ticket, old.authorizationId!)
      const plan = ticket.planRevisions?.at(-1)
      if (!plan || plan.revision !== input.planRevision) throw new UserError('stalePlanRevision')
      const intentId = input.intent === 'rerun' ? input.operationId : 'execute'
      const existing = ticket.authorizations?.find(item => item.planRevision === input.planRevision && item.intent === input.intent
        && item.intentId === intentId && item.actor.source === trusted.actor.source && item.actor.id === trusted.actor.id)
      if (existing?.revokedAt) throw new UserError('planAuthorizationRevoked')
      if (!existing && input.intent === 'rerun' && !ticket.authorizations?.some(item => item.planRevision === input.planRevision && item.intent === 'execute')) throw new UserError('planRerunRequired')
      let authorization = existing
      if (!authorization) {
        if (ticket.ended) {
          const latestAuthorization = ticket.authorizations?.findLast(item => item.planRevision === plan.revision)
          const necessary = activePlanAssignments(ticket)
          if (input.intent !== 'rerun' || ticket.ended.outcome !== 'completed' || ticket.ended.by !== 'executor'
            || latestAuthorization?.revokedAt || !necessary.length
            || !necessary.every(item => item.state === 'ended' && item.report?.state === 'ready')) throw new UserError('ticketEnded')
          delete ticket.ended
        }
        const at = this.now(), id = this.makeId(), targetId = this.makeId()
        authorization = { id, projectId: ticket.projectId!, ticketId: ticket.id, planRevision: plan.revision, actor: copy(trusted.actor), message: copy(trusted.message), ...(trusted.originalMessage !== undefined ? { originalMessage: copy(trusted.originalMessage) } : {}), intent: input.intent, intentId, targetId, createdAt: at, graphPolicy: 'bounded-revisions' }
        ;(ticket.authorizations ??= []).push(authorization)
        ;(ticket.executionTargets ??= []).push({ id: targetId, authorizationId: id, planRevision: plan.revision, createdAt: at, waitingReason: 'executor-unavailable' })
        ticket.updatedAt = at
        ticket.projectStage = 'confirmed'
      }
      this.record(ticket, { id: input.operationId, kind: 'confirm', payload, authorizationId: authorization.id, targetId: authorization.targetId })
      this.options.repo.tickets.save(ticket)
      return this.result(ticket, authorization.id)
    })
  }
  private result(ticket: Ticket, authorizationId: string): PlanConfirmationResult {
    const authorization = ticket.authorizations?.find(item => item.id === authorizationId)
    const target = ticket.executionTargets?.find(item => item.id === authorization?.targetId)
    if (!authorization || !target) throw new UserError('unknownPlanAuthorization')
    return copy({ ticket, authorization, target })
  }
  revoke(input: RevokePlan): PlanAuthorization {
    return this.options.repo.atomic(() => {
      const ticket = this.ticket(input.projectId, input.ticketId)
      const payload = canonical({ kind: 'revoke', projectId: input.projectId, ticketId: input.ticketId, authorizationId: input.authorizationId })
      this.operation(ticket, input.operationId, payload)
      const authorization = ticket.authorizations?.find(item => item.id === input.authorizationId)
      if (!authorization) throw new UserError('unknownPlanAuthorization')
      if (!authorization.revokedAt) {
        authorization.revokedAt = this.now()
        ticket.updatedAt = authorization.revokedAt
      }
      if (input.operationId !== undefined && !ticket.planOperations?.some(item => item.id === input.operationId)) this.record(ticket, { id: input.operationId, kind: 'revoke', payload, authorizationId: authorization.id })
      this.options.repo.tickets.save(ticket)
      return copy(authorization)
    })
  }
  readAssignmentGraph(input: { projectId: string; ticketId: string; graphId?: string }): AssignmentGraphView {
    const ticket = this.ticket(input.projectId, input.ticketId, true)
    const graph = input.graphId ? ticket.assignmentGraphs?.find(item => item.id === input.graphId) : currentAssignmentGraph(ticket)
    if (input.graphId && !graph) throw new UserError('unknownPlanRevision')
    const authorization = ticket.authorizations?.find(item => item.id === graph?.authorizationId)
    const current = graph && currentAssignmentGraph(ticket, graph.authorizationId)
    const editable = !!graph && current?.id === graph.id && !authorization?.revokedAt && !ticket.ended && ticket.lifecycle?.stop.intent !== 'stop'
    return copy({ ticketId: ticket.id, ...(graph ? { graph } : {}), editable,
      ...(!graph ? { reason: ticket.authorizations?.length ? 'legacy-authorization' : 'confirmation-required' } : !editable ? { reason: 'historical-or-inactive' } : {}),
      members: (graph?.nodes ?? []).map(node => {
        const assignment = ticket.assignments.find(item => item.id === node.assignmentId)!
        return { assignmentId: node.assignmentId, state: assignment.state, canRevise: editable && this.revisable(assignment) }
      }) })
  }
  private revisable(assignment: Assignment): boolean {
    return assignment.state === 'pending' && !assignment.startedAt && !assignment.reportReceipt
      && (!assignment.report || assignment.report.state === 'waiting') && this.options.canReviseAssignment?.(assignment.id) === true
  }
  /** Replace only unexecuted contracts, preserving a bounded authorized graph and immutable receipt history. */
  reviseAssignments(input: ReviseAssignments): AssignmentGraphRevision {
    return this.options.repo.atomic(() => {
      const ticket = this.ticket(input.projectId, input.ticketId, true), assignments = normalizeGraphProposals(input.assignments)
      const request: ReviseAssignments = { projectId: input.projectId, ticketId: input.ticketId, graphId: input.graphId, expectedVersion: input.expectedVersion, operationId: input.operationId, assignments }
      const authority = this.options.resolveGraphAuthority?.(Object.freeze(copy(request)))
      if (!authority?.sessionId.trim() || !authority.inputId.trim() || !Number.isSafeInteger(authority.generation) || authority.generation < 1
        || !Number.isSafeInteger(authority.stateVersion) || authority.stateVersion < 0) throw new Error('Current coordinator graph lease is required')
      if (!input.operationId?.trim()) throw new UserError('planOperationConflict')
      const payload = graphCanonical({ kind: 'revise-assignments', projectId: input.projectId, ticketId: input.ticketId, graphId: input.graphId, expectedVersion: input.expectedVersion, assignments })
      const old = this.operation(ticket, input.operationId, payload)
      if (old) {
        const recorded = ticket.assignmentGraphs?.find(item => item.id === old.graphId)
        if (!recorded) throw new UserError('planOperationConflict')
        return copy(recorded)
      }
      if (ticket.assignmentGraphs?.some(item => item.operationId === input.operationId)) throw new UserError('planOperationConflict')
      const base = ticket.assignmentGraphs?.find(item => item.id === input.graphId), current = base && currentAssignmentGraph(ticket, base.authorizationId)
      if (!base || current?.id !== base.id || input.expectedVersion !== base.version) throw new UserError('stalePlanRevision')
      const authorization = ticket.authorizations?.find(item => item.id === base.authorizationId)
      if (!authorization || authorization.revokedAt || authorization.graphPolicy !== 'bounded-revisions') throw new UserError('planAuthorizationRevoked')
      if (ticket.ended || ticket.lifecycle?.stop.intent === 'stop') throw new UserError('ticketEnded')
      const plan = ticket.planRevisions!.find(item => item.revision === authorization.planRevision)!, initial = ticket.assignmentGraphs!.find(item => item.authorizationId === authorization.id && item.version === 1)!
      validateRevisedGraphScope(plan, initial, assignments)
      const locked = new Set(base.nodes.filter(node => !this.revisable(ticket.assignments.find(item => item.id === node.assignmentId)!)).map(node => node.assignmentId))
      const slots = assignGraphBudgetSlots(initial, base, assignments, locked), at = this.now(), version = base.version + 1
      const reusable = new Set<string>()
      const graph: AssignmentGraphRevision = { id: graphIdentity(ticket.id, authorization.id, version), version, projectId: input.projectId, ticketId: ticket.id,
        authorizationId: authorization.id, targetId: authorization.targetId, planRevision: authorization.planRevision, previousId: base.id, operationId: input.operationId, createdAt: at,
        createdBy: { kind: 'coordinator', sessionId: authority.sessionId, generation: authority.generation, inputId: authority.inputId, stateVersion: authority.stateVersion },
        nodes: assignments.map(proposal => {
          const existing = base.nodes.find(node => node.proposal.key === proposal.key), budgetSlot = slots.get(proposal.key)!
          if (existing && existing.budgetSlot === budgetSlot && graphCanonical(existing.proposal) === graphCanonical(proposal)) {
            reusable.add(proposal.key); return { assignmentId: existing.assignmentId, budgetSlot, proposal: copy(proposal) }
          }
          return { assignmentId: this.makeId(), budgetSlot, proposal: copy(proposal) }
        }) }
      // Replacing an upstream ID also replaces pending descendants whose contracts reference that ID.
      let changed: boolean
      do {
        changed = false
        for (const node of graph.nodes) if (reusable.has(node.proposal.key)) {
          const existing = ticket.assignments.find(item => item.id === node.assignmentId)!
          if (graphCanonical(existing.contract!.inputs) === graphCanonical(graphNodeInputs(ticket, graph, node, initial, plan))) continue
          if (locked.has(existing.id)) throw new Error('A consumed input version cannot be replaced')
          ;(node as { assignmentId: string }).assignmentId = this.makeId(); reusable.delete(node.proposal.key); changed = true
        }
      } while (changed)
      const currentIds = new Set(graph.nodes.map(node => node.assignmentId))
      for (const oldNode of base.nodes) if (!currentIds.has(oldNode.assignmentId)) {
        const assignment = ticket.assignments.find(item => item.id === oldNode.assignmentId)!
        if (!this.revisable(assignment)) throw new Error('An execution cannot be superseded')
        assignment.state = 'ended'; assignment.endedAt = at; assignment.endedReason = 'superseded'; delete assignment.waitingReason; delete assignment.budgetWait
        assignment.report = { state: 'dropped', summary: `Superseded by assignment graph ${version}`, at }
      }
      for (const node of graph.nodes) if (!ticket.assignments.some(item => item.id === node.assignmentId)) {
        const proposal = node.proposal, workerPlan = { ...content(plan), assignments: undefined, goal: proposal.goal, outputs: proposal.outputs, resources: proposal.resources,
          cost: proposal.cost, completion: proposal.completion, acceptance: proposal.acceptance }
        ticket.assignments.push({ id: node.assignmentId, projectId: ticket.projectId, ticketId: ticket.id, state: 'pending', createdAt: at, waitingReason: 'executor-unavailable',
          report: { state: 'waiting', summary: 'executor-unavailable', at }, contract: { graphVersion: version, assignmentKey: proposal.key, proposal: copy(proposal),
            authorizationId: authorization.id, targetId: authorization.targetId, planRevision: plan.revision, plan: workerPlan, inputs: graphNodeInputs(ticket, graph, node, initial, plan) } })
      }
      const again = this.options.resolveGraphAuthority?.(Object.freeze(copy(request)))
      if (graphCanonical(again) !== graphCanonical(authority)) throw new Error('Coordinator graph lease changed')
      ;(ticket.assignmentGraphs ??= []).push(graph); ticket.updatedAt = at
      this.record(ticket, { id: input.operationId, kind: 'revise-assignments', payload, authorizationId: authorization.id, targetId: authorization.targetId, planRevision: plan.revision, graphId: graph.id })
      this.options.repo.tickets.save(ticket)
      return copy(graph)
    })
  }
  private initialGraph(input: Omit<RegisterPlanAssignment, 'assignmentKey' | 'inputs'>, assignments: Assignment[]): Assignment[] {
    const ticket = this.ticket(input.projectId, input.ticketId, true), authorization = ticket.authorizations!.find(item => item.id === input.authorizationId)!
    if (authorization.graphPolicy !== 'bounded-revisions' || currentAssignmentGraph(ticket, authorization.id)) return assignments
    const plan = ticket.planRevisions!.find(item => item.revision === authorization.planRevision)!, proposals = initialGraphProposals(plan, plan.revision)
    const graph: AssignmentGraphRevision = { id: graphIdentity(ticket.id, authorization.id, 1), version: 1, projectId: ticket.projectId!, ticketId: ticket.id,
      authorizationId: authorization.id, targetId: authorization.targetId, planRevision: plan.revision, operationId: `initial:${authorization.id}`, createdAt: authorization.createdAt,
      createdBy: { kind: 'confirmation', messageId: authorization.message.id }, nodes: proposals.map(proposal => ({
        assignmentId: assignments.find(item => item.contract?.assignmentKey === (plan.assignments?.length ? proposal.key : undefined))!.id, budgetSlot: proposal.key, proposal })) }
    ;(ticket.assignmentGraphs ??= []).push(graph); this.options.repo.tickets.save(ticket)
    return assignments
  }
  /** Materializes a confirmed graph atomically; repeated confirmation never reactivates historical work. */
  registerAssignments(input: Omit<RegisterPlanAssignment, 'assignmentKey' | 'inputs'>): Assignment[] {
    return this.options.repo.atomic(() => {
      const ticket = this.ticket(input.projectId, input.ticketId, true)
      const plan = ticket.planRevisions?.find(item => item.revision === input.planRevision)
      if (!plan?.assignments?.length) return this.initialGraph(input, [this.registerAssignment(input)])
      validateAssignmentGraph(plan.assignments)
      const registered = new Map<string, Assignment>()
      const register = (name: string): Assignment => {
        const previous = registered.get(name)
        if (previous) return previous
        const proposal = plan.assignments!.find(item => item.key === name)!
        const dependencies = proposal.dependencies.map(dep => register(dep))
        const assignment = this.registerAssignment({ ...input, assignmentKey: name, inputs: [
          ...(plan.artifactInputs ?? []).map(ref => ({ kind: 'artifact' as const, ...ref })),
          ...dependencies.map(dep => ({ kind: 'dependency' as const, ticketId: ticket.id, assignmentId: dep.id })),
        ] })
        registered.set(name, assignment)
        return assignment
      }
      return this.initialGraph(input, plan.assignments.map(item => register(item.key)))
    })
  }
  registerAssignment(input: RegisterPlanAssignment): Assignment {
    return this.options.repo.atomic(() => {
      const ticket = this.ticket(input.projectId, input.ticketId, true)
      const authorization = ticket.authorizations?.find(item => item.id === input.authorizationId)
      const target = ticket.executionTargets?.find(item => item.id === input.targetId)
      if (!authorization || !target || target.authorizationId !== authorization.id || authorization.targetId !== target.id) throw new UserError('unknownPlanAuthorization')
      if (authorization.revokedAt) throw new UserError('planAuthorizationRevoked')
      if (authorization.projectId !== input.projectId || authorization.ticketId !== input.ticketId) throw new UserError('projectOwnership')
      const old = ticket.assignments.find(item => item.contract?.targetId === target.id && item.contract.assignmentKey === input.assignmentKey)
      const plan = ticket.planRevisions?.find(item => item.revision === input.planRevision)
      if (!plan || authorization.planRevision !== input.planRevision || target.planRevision !== input.planRevision
        || (!old && ticket.planRevisions?.at(-1)?.revision !== input.planRevision)) throw new UserError('stalePlanRevision')
      if (!old && ticket.ended) throw new UserError('ticketEnded')
      const proposal = input.assignmentKey ? plan.assignments?.find(item => item.key === input.assignmentKey) : undefined
      if (plan.assignments?.length && !proposal) throw new UserError('invalidPlanInput')
      const inputs = copy(input.inputs ?? plan.artifactInputs?.map(item => ({ kind: 'artifact' as const, ...item })) ?? [])
      for (const pinned of plan.artifactInputs ?? []) {
        if (!inputs.some(item => item.kind === 'artifact' && item.artifactId === pinned.artifactId && item.contentVersion === pinned.contentVersion)) throw new UserError('invalidPlanInput')
      }
      if (!Array.isArray(inputs)) throw new UserError('invalidPlanInput')
      for (const ref of inputs) {
        if (ref?.kind === 'artifact') {
          if (!this.options.validateArtifact?.(input.projectId, ref.artifactId, ref.contentVersion)) throw new UserError('invalidPlanInput')
          continue
        }
        if (!ref || ref.kind !== 'dependency' || ref.ticketId !== ticket.id || typeof ref.assignmentId !== 'string' || !ref.assignmentId.trim()
          || !ticket.assignments.some(item => item.id === ref.assignmentId && item.contract
            && item.ticketId === ticket.id && item.projectId === ticket.projectId)) throw new UserError('invalidPlanInput')
      }
      const workerPlan = proposal ? { ...content(plan), assignments: undefined, goal: proposal.goal, outputs: proposal.outputs, resources: proposal.resources, cost: proposal.cost, completion: proposal.completion, acceptance: proposal.acceptance } : content(plan)
      const contract = { authorizationId: authorization.id, targetId: target.id, planRevision: plan.revision, plan: workerPlan, inputs, ...(proposal ? { assignmentKey: proposal.key, proposal } : {}) }
      if (old) {
        if (canonical(old.contract) !== canonical(contract)) throw new UserError('planAssignmentConflict')
        return copy(old)
      }
      const at = this.now(), assignment: Assignment = { id: this.makeId(), projectId: input.projectId, ticketId: input.ticketId, state: 'pending', contract, waitingReason: 'executor-unavailable', createdAt: at,
        report: { state: 'waiting', summary: 'executor-unavailable', at } }
      ticket.assignments.push(assignment)
      ticket.updatedAt = at
      this.options.repo.tickets.save(ticket)
      return copy(assignment)
    })
  }
}
