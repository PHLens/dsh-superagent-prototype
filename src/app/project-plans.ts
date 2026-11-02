/** Application adapter for project plans: authenticated conversation identity and durable plan operations. */
import { Plans, UserError, type Assignment, type PlanAssignmentInput, type PlanAuthorization, type PlanConfirmationResult, type PlanIntent, type PlanRevision, type Project, type RegisterPlanAssignment, type SavePlan, type Ticket } from '../core/index.ts'
import type { ConfirmPlan, RevokePlan } from '../core/plans.ts'
import type { Store } from './store.ts'
import { ConversationStore, type ConversationMessage } from './conversation-store.ts'

export type ProjectPlanConfirmation = PlanConfirmationResult & { assignment: Assignment; message: ConversationMessage }
export type ProjectPlanInput = Omit<SavePlan, 'projectId' | 'ticketId'> & { ticketId?: string }

/** Binds the core Plans service to the authenticated project conversation. */
export class ProjectPlans {
  readonly conversations: ConversationStore
  constructor(private readonly store: Store, private readonly projects: { get(id: string): Project; createDraft(projectId: string, input: { title: string }): Ticket }, conversations = new ConversationStore(store)) {
    this.conversations = conversations
  }
  private owner(actorId: string, projectId: string): void {
    const owner = this.conversations.getOwner(projectId)
    if (!owner || owner.actorId !== actorId) throw new UserError('unknownProject')
    this.projects.get(projectId)
  }
  private confirmation(actorId: string, projectId: string, request: ConfirmPlan, requireBinding = true): { message: ConversationMessage; original: ConversationMessage } | undefined {
    const binding = this.store.get<{ request: ConfirmPlan; messageId: string }>(`project-plan-confirmation:${projectId}:${request.operationId}` as never)
    if (requireBinding && !binding) return undefined
    if (binding && (binding.request.projectId !== request.projectId || binding.request.ticketId !== request.ticketId || binding.request.planRevision !== request.planRevision || binding.request.operationId !== request.operationId || binding.request.intent !== request.intent)) throw new UserError('planOperationConflict')
    const messages = this.conversations.listMessages(projectId, actorId)
    const confirmationIndex = messages.findLastIndex(message => message.role === 'user'
      && (message.clientRequestKey === request.operationId || message.clientRequestKey === `plan-confirm:${request.operationId}`)
      && (request.intent === 'rerun' ? /^(?:再运行一次|run it again)$/ : /^(?:按这个方案做|执行这个方案|implement this plan)$/).test(message.text))
    if (confirmationIndex < 1 || (binding && binding.messageId !== messages[confirmationIndex]!.id)) return undefined
    const original = messages.slice(0, confirmationIndex).findLast(message => message.role === 'user'
      && !ProjectPlans.isConfirmation(message.text)
      && (message.status === 'queued' || message.status === 'running' || message.status === 'answered' || message.status === 'saved'))
    return original ? { message: messages[confirmationIndex]!, original } : undefined
  }
  private service(actorId: string, projectId: string): Plans {
    this.owner(actorId, projectId)
    return new Plans({
      repo: this.store,
      validateArtifact: (projectId, id, version) => this.store.registeredArtifact(projectId, id, version),
      resolveConfirmation: request => {
        if (request.projectId !== projectId) return undefined
        const evidence = this.confirmation(actorId, projectId, request)
        if (!evidence) return undefined
        return { actor: { source: 'web', id: actorId }, message: { id: evidence.message.id, text: evidence.message.text }, originalMessage: { id: evidence.original.id, text: evidence.original.text }, explicit: true,
          planRevision: request.planRevision, intent: request.intent }
      },
    })
  }
  list(actorId: string, projectId: string, input: { offset?: number; limit?: number } = {}) {
    this.owner(actorId, projectId)
    const offset = Math.max(0, input.offset ?? 0), limit = Math.min(20, Math.max(1, input.limit ?? 8))
    const tickets = this.store.tickets.list().filter(ticket => ticket.projectId === projectId)
    const page = tickets.slice(offset, offset + limit).map(ticket => ({
      ticketId: ticket.id,
      title: ticket.title.slice(0, 200),
      latestRevision: ticket.planRevisions?.at(-1)?.revision,
      revisionCount: ticket.planRevisions?.length ?? 0,
      goal: ticket.planRevisions?.at(-1)?.goal.slice(0, 300),
      authorizationCount: ticket.authorizations?.length ?? 0,
      assignmentCount: ticket.assignments?.length ?? 0,
    }))
    return { items: page, offset, limit, total: tickets.length, hasMore: offset + page.length < tickets.length }
  }
  read(actorId: string, projectId: string, input: { ticketId: string; revision?: number }): PlanRevision {
    this.owner(actorId, projectId)
    const ticket = this.store.tickets.get(input.ticketId)
    if (!ticket || ticket.projectId !== projectId) throw new UserError('unknownTicket')
    const revision = ticket.planRevisions?.find(item => input.revision === undefined ? item.revision === ticket.planRevisions!.at(-1)!.revision : item.revision === input.revision)
    if (!revision) throw new UserError('unknownTicket')
    return revision
  }
  static isConfirmation(text: string): boolean {
    return /^(?:按这个方案做|执行这个方案|implement this plan|再运行一次|run it again)$/.test(text)
  }
  save(actorId: string, projectId: string, input: ProjectPlanInput): PlanRevision {
    this.owner(actorId, projectId)
    return this.store.atomic(() => {
      const prior = input.operationId ? this.store.tickets.list().find(item => item.projectId === projectId
        && item.planOperations?.some(operation => operation.id === input.operationId)) : undefined
      const ticket = input.ticketId ? this.store.tickets.get(input.ticketId) : prior
      if (input.ticketId && !ticket) throw new UserError('unknownTicket')
      if (prior && ticket && prior.id !== ticket.id) throw new UserError('planOperationConflict')
      const target = ticket ?? this.projects.createDraft(projectId, { title: input.plan.goal.slice(0, 200) })
      if (target.projectId !== projectId) throw new UserError('projectOwnership')
      return this.service(actorId, projectId).save({ ...input, projectId, ticketId: target.id })
    })
  }
  get(actorId: string, projectId: string, ticketId: string, revision?: number): PlanRevision {
    return this.service(actorId, projectId).get(projectId, ticketId, revision)
  }
  confirm(actorId: string, projectId: string, request: ConfirmPlan): ProjectPlanConfirmation {
    this.owner(actorId, projectId)
    if (request.projectId !== projectId) throw new UserError('projectOwnership')
    return this.store.atomic(() => {
      const evidence = this.confirmation(actorId, projectId, request, false)
      if (!evidence) throw new UserError('planConfirmationRequired')
      this.store.set(`project-plan-confirmation:${projectId}:${request.operationId}` as never, { request, messageId: evidence.message.id })
      const result = this.service(actorId, projectId).confirm(request)
      const assignment = this.service(actorId, projectId).registerAssignment({ projectId, ticketId: request.ticketId,
        authorizationId: result.authorization.id, targetId: result.target.id, planRevision: request.planRevision })
      this.store.db.prepare("UPDATE conversation_message SET status='saved' WHERE id=?").run(evidence.message.id)
      return { ...result, assignment, message: { ...evidence.message, status: 'saved' as const } }
    })
  }
  revoke(actorId: string, projectId: string, request: RevokePlan): PlanAuthorization {
    this.owner(actorId, projectId)
    if (request.projectId !== projectId) throw new UserError('projectOwnership')
    return this.service(actorId, projectId).revoke(request)
  }
  registerAssignment(actorId: string, projectId: string, input: Omit<RegisterPlanAssignment, 'projectId'>): Assignment {
    return this.service(actorId, projectId).registerAssignment({ ...input, projectId })
  }
  tickets(actorId: string, projectId: string): Ticket[] {
    this.owner(actorId, projectId)
    return this.store.tickets.list().filter(ticket => ticket.projectId === projectId)
  }
  static taskCandidate(tickets: readonly Ticket[]): Ticket[] {
    return tickets.filter(ticket => {
      if (!ticket.planRevisions?.at(-1)) return false
      if (ticket.projectStage === 'awaiting-confirmation') return true
      return ticket.projectStage === 'confirmed' && !!ticket.authorizations?.some(item => !item.revokedAt)
    })
  }
}

export type { PlanIntent, PlanAssignmentInput }
