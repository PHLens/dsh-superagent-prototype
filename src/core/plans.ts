/** Reviewed plan revisions and explicit authorizations, stored atomically in the project Ticket aggregate. */
import { UserError } from './errors.ts'
import { key } from './ids.ts'
import type { Assignment, PlanAssignmentInput, PlanAuthorization, PlanContent, PlanExecutionTarget, PlanIntent, PlanOperation, PlanRevision, Ticket, TrustedPlanConfirmation } from './model.ts'
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
}
export interface PlanConfirmationResult { authorization: PlanAuthorization; target: PlanExecutionTarget; ticket: Ticket }

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
  // Explicitly copy the contract fields; unknown model-supplied fields grant no authority.
  return copy({ goal: plan.goal, scope: plan.scope, outputs: plan.outputs, resources: plan.resources, environment: plan.environment, cost: plan.cost, completion: plan.completion })
}

/** No dispatcher: a confirmed target and its pending Assignment wait for the T4 executor. */
export class Plans {
  private readonly now: () => string
  private readonly makeId: () => string
  constructor(private readonly options: PlanServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.makeId = options.id ?? (() => crypto.randomUUID?.() ?? key('plan', Date.now().toString(36), Math.random().toString(36)))
  }
  private ticket(projectId: string, ticketId: string): Ticket {
    if (!this.options.repo.projects.get(projectId)) throw new UserError('unknownProject')
    const ticket = this.options.repo.tickets.get(ticketId)
    if (!ticket || ticket.projectId !== projectId) throw new UserError('projectOwnership')
    if (ticket.ended) throw new UserError('ticketEnded')
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
    const ticket = this.ticket(projectId, ticketId)
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
      const ticket = this.ticket(input.projectId, input.ticketId)
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
        const at = this.now(), id = this.makeId(), targetId = this.makeId()
        authorization = { id, projectId: ticket.projectId!, ticketId: ticket.id, planRevision: plan.revision, actor: copy(trusted.actor), message: copy(trusted.message), ...(trusted.originalMessage !== undefined ? { originalMessage: copy(trusted.originalMessage) } : {}), intent: input.intent, intentId, targetId, createdAt: at }
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
  registerAssignment(input: RegisterPlanAssignment): Assignment {
    return this.options.repo.atomic(() => {
      const ticket = this.ticket(input.projectId, input.ticketId)
      const authorization = ticket.authorizations?.find(item => item.id === input.authorizationId)
      const target = ticket.executionTargets?.find(item => item.id === input.targetId)
      if (!authorization || !target || target.authorizationId !== authorization.id || authorization.targetId !== target.id) throw new UserError('unknownPlanAuthorization')
      if (authorization.revokedAt) throw new UserError('planAuthorizationRevoked')
      if (authorization.projectId !== input.projectId || authorization.ticketId !== input.ticketId) throw new UserError('projectOwnership')
      const plan = ticket.planRevisions?.find(item => item.revision === input.planRevision)
      if (!plan || authorization.planRevision !== input.planRevision || target.planRevision !== input.planRevision
        || ticket.planRevisions?.at(-1)?.revision !== input.planRevision) throw new UserError('stalePlanRevision')
      const inputs = copy(input.inputs ?? [])
      if (!Array.isArray(inputs)) throw new UserError('invalidPlanInput')
      for (const ref of inputs) {
        // No trusted artifact registry exists before T4. Reject artifact references, including notes dressed up as artifacts.
        if (!ref || ref.kind !== 'dependency' || ref.ticketId !== ticket.id || typeof ref.assignmentId !== 'string' || !ref.assignmentId.trim()
          || !ticket.assignments.some(item => item.id === ref.assignmentId && item.contract
            && item.ticketId === ticket.id && item.projectId === ticket.projectId)) throw new UserError('invalidPlanInput')
      }
      const contract = { authorizationId: authorization.id, targetId: target.id, planRevision: plan.revision, plan: content(plan), inputs }
      const old = ticket.assignments.find(item => item.contract?.targetId === target.id)
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
