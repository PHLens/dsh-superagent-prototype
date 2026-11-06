/** Application adapter for project plans: authenticated conversation identity and durable plan operations. */
import { activePlanAssignments, currentAssignmentGraph, Plans, UserError, type Assignment, type AssignmentGraphRevision, type CoordinatorGraphAuthority, type PlanAssignmentInput, type PlanAuthorization, type PlanConfirmationResult, type PlanIntent, type PlanRevision, type Project, type RegisterPlanAssignment, type SavePlan, type Ticket } from '../core/index.ts'
import type { AssignmentGraphView, ConfirmPlan, ReviseAssignments, RevokePlan } from '../core/plans.ts'
import type { CodeCheck, PlanContent } from '../core/model.ts'
import type { Store } from './store.ts'
import { ConversationStore, type ConversationMessage } from './conversation-store.ts'
import { ProjectEvents } from './events.ts'
import { assignmentFacts, readFact } from './project-facts.ts'

export type ProjectPlanConfirmation = PlanConfirmationResult & { assignment: Assignment; message: ConversationMessage }
export type ProjectPlanInput = Omit<SavePlan, 'projectId' | 'ticketId'> & { ticketId?: string }
export interface CoordinatorGraphLease extends CoordinatorGraphAuthority { authorize(): void }

/** Binds the core Plans service to the authenticated project conversation. */
export class ProjectPlans {
  readonly conversations: ConversationStore
  constructor(private readonly store: Store, private readonly projects: { get(id: string): Project; createDraft(projectId: string, input: { title: string }): Ticket }, conversations = new ConversationStore(store), private readonly resolveCheck?: (projectId: string, plan: PlanContent, check: CodeCheck) => CodeCheck) {
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
  private service(actorId: string, projectId: string, lease?: CoordinatorGraphLease): Plans {
    this.owner(actorId, projectId)
    return new Plans({
      repo: this.store,
      validateArtifact: (projectId, id, version) => this.store.registeredArtifact(projectId, id, version),
      canReviseAssignment: assignmentId => !this.store.db.prepare("SELECT 1 FROM execution_attempt WHERE json_extract(value, '$.assignmentId')=? LIMIT 1").get(assignmentId),
      resolveGraphAuthority: () => {
        if (!lease) return undefined
        lease.authorize()
        const mapping = this.conversations.currentMapping(projectId)
        if (!mapping || mapping.sessionId !== lease.sessionId || mapping.generation !== lease.generation) throw new Error('Stale coordinator graph generation')
        return { sessionId: lease.sessionId, generation: lease.generation, inputId: lease.inputId, stateVersion: lease.stateVersion }
      },
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
      ...(ticket.planRevisions?.length ? { latestRevision: ticket.planRevisions.at(-1)!.revision } : {}),
      revisionCount: ticket.planRevisions?.length ?? 0,
      ...(ticket.planRevisions?.length ? { goal: ticket.planRevisions.at(-1)!.goal.slice(0, 300) } : {}),
      authorizationCount: ticket.authorizations?.length ?? 0,
      assignmentCount: ticket.assignments?.length ?? 0,
      ...(currentAssignmentGraph(ticket) ? { currentGraph: { id: currentAssignmentGraph(ticket)!.id, version: currentAssignmentGraph(ticket)!.version } } : {}),
      activeAssignmentCount: activePlanAssignments(ticket).filter(item => item.state !== 'ended').length,
      assignments: activePlanAssignments(ticket).filter(item => item.state !== 'ended').slice(0, 8).map(item => ({ id: item.id,
        ...(item.contract?.assignmentKey !== undefined ? { assignmentKey: item.contract.assignmentKey } : {}),
        ...(item.contract ? { title: item.contract.plan.goal.slice(0, 160) } : {}), state: item.state,
        ...(item.waitingReason !== undefined ? { waitingReason: item.waitingReason } : {}) })),
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
      const saved = this.service(actorId, projectId).save({ ...input, plan: this.normalizeCodeChecks(projectId, input.plan), projectId, ticketId: target.id })
      new ProjectEvents(this.store).append({ id: `plan:${saved.ticketId}:${saved.revision}`, projectId, ticketId: saved.ticketId,
        kind: 'task-changed', version: String(saved.revision), operationId: input.operationId ?? `plan:${saved.ticketId}:${saved.revision}`,
        at: saved.createdAt })
      return saved
    })
  }
  /**
   * The reviewed contract carries exact captured material versions. Resolve the top-level check
   * first, then every explicit Assignment check against that Assignment's own resource subset.
   * A matching nested check inherits the top-level result from the same capture boundary; a
   * genuinely different check is resolved independently. Sharing a resource at two different
   * content versions is a changed review boundary and fails closed.
   */
  private normalizeCodeChecks(projectId: string, plan: PlanContent): PlanContent {
    const resolve = this.resolveCheck
    if (!resolve) return plan
    const captured = new Map<string, string>()
    const remember = (check: CodeCheck): void => {
      const refs: [string | undefined, string][] = [[check.sourceResourceId, check.sourceVersion], [check.configResourceId, check.configVersion], [check.runtimeResourceId, check.runtimeVersion ?? '']]
      for (const [id, version] of refs) {
        if (!id || !version) continue
        const known = captured.get(id)
        if (known !== undefined && known !== version) throw new Error('Code check material changed between resolution steps')
        captured.set(id, version)
      }
    }
    const topCheck = plan.acceptance?.codeCheck
    const top = topCheck ? resolve(projectId, plan, topCheck) : undefined
    if (top) remember(top)
    const assignments = plan.assignments?.map(assignment => {
      const nested = assignment.acceptance.codeCheck
      if (!nested) return assignment
      // An Assignment may only select from the canonical plan inventory, never from an
      // undeclared ID placed in its own resource list.
      const inventory = assignment.resources.filter(id => plan.resources.includes(id))
      const check = top && this.matchesTopCheck(nested, top, inventory) ? top : resolve(projectId, { ...plan, resources: inventory }, nested)
      if (check !== top) remember(check)
      return { ...assignment, acceptance: { ...assignment.acceptance, codeCheck: check } }
    })
    return { ...plan, ...(top ? { acceptance: { ...plan.acceptance!, codeCheck: top } } : {}), ...(assignments ? { assignments } : {}) }
  }
  /** Compare reviewed check intent, never model-supplied versions. The resolved IDs must also be granted to the Assignment. */
  private matchesTopCheck(nested: CodeCheck, top: CodeCheck, resources: readonly string[]): boolean {
    const sameArgs = Array.isArray(nested.args) && Array.isArray(top.args) && nested.args.length === top.args.length
      && nested.args.every((arg, index) => arg === top.args[index])
    if (!sameArgs || nested.command !== top.command || nested.profile !== top.profile) return false
    for (const [explicit, resolved] of [[nested.sourceResourceId, top.sourceResourceId], [nested.configResourceId, top.configResourceId], [nested.runtimeResourceId, top.runtimeResourceId]] as const) {
      if (explicit !== undefined && explicit !== resolved) return false
    }
    return [top.sourceResourceId, top.configResourceId, top.runtimeResourceId].every(id => id === undefined || resources.includes(id))
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
      const assignments = this.service(actorId, projectId).registerAssignments({ projectId, ticketId: request.ticketId,
        authorizationId: result.authorization.id, targetId: result.target.id, planRevision: request.planRevision })
      this.store.db.prepare("UPDATE conversation_message SET status='saved' WHERE id=?").run(evidence.message.id)
      new ProjectEvents(this.store).append({ id: `conversation:${evidence.message.id}:saved:0:0`, projectId, ticketId: request.ticketId,
        kind: 'conversation-message', version: evidence.message.id, operationId: `${evidence.message.id}:saved:0:0`, at: evidence.message.createdAt })
      const ticket = this.store.tickets.get(request.ticketId)!, graph = currentAssignmentGraph(ticket, result.authorization.id)
      if (graph) new ProjectEvents(this.store).append({ id: `graph:${graph.id}`, projectId, ticketId: graph.ticketId,
        kind: 'assignment-ready', version: graph.id, operationId: graph.operationId, at: graph.createdAt })
      return { ...result, ticket, assignment: assignments[0]!, assignments, message: { ...evidence.message, status: 'saved' as const } }
    })
  }
  revoke(actorId: string, projectId: string, request: RevokePlan): PlanAuthorization {
    this.owner(actorId, projectId)
    if (request.projectId !== projectId) throw new UserError('projectOwnership')
    return this.store.atomic(() => {
      const revoked = this.service(actorId, projectId).revoke(request)
      new ProjectEvents(this.store).append({ id: `task:${revoked.ticketId}:${revoked.id}:revoked`, projectId,
        ticketId: revoked.ticketId, authorizationId: revoked.id, kind: 'task-changed', version: revoked.id,
        operationId: request.operationId ?? `revoke:${revoked.id}`, at: revoked.revokedAt ?? revoked.createdAt })
      return revoked
    })
  }
  registerAssignment(actorId: string, projectId: string, input: Omit<RegisterPlanAssignment, 'projectId'>): Assignment {
    return this.service(actorId, projectId).registerAssignment({ ...input, projectId })
  }
  readAssignmentGraph(actorId: string, projectId: string, input: { ticketId: string; graphId?: string }): AssignmentGraphView {
    return this.service(actorId, projectId).readAssignmentGraph({ ...input, projectId })
  }
  reviseAssignments(actorId: string, projectId: string, input: Omit<ReviseAssignments, 'projectId'>, lease: CoordinatorGraphLease): AssignmentGraphRevision {
    this.owner(actorId, projectId)
    if (!lease || typeof lease.authorize !== 'function') throw new Error('Current coordinator graph lease is required')
    return this.store.atomic(() => {
      const graph = this.service(actorId, projectId, lease).reviseAssignments({ ...input, projectId })
      new ProjectEvents(this.store).append({ id: `graph:${graph.id}`, projectId, ticketId: graph.ticketId, kind: 'assignment-ready', version: graph.id, operationId: graph.operationId, at: graph.createdAt })
      return graph
    })
  }
  tickets(actorId: string, projectId: string): Ticket[] {
    this.owner(actorId, projectId)
    return this.store.tickets.list().filter(ticket => ticket.projectId === projectId)
  }
  readAssignmentFacts(actorId: string, projectId: string, input: { ticketId: string; assignmentId?: string; offset?: number; limit?: number }) {
    this.owner(actorId, projectId); const ticket = this.store.tickets.get(input.ticketId)
    if (!ticket || ticket.projectId !== projectId) throw new UserError('unknownProject')
    return assignmentFacts(this.store, ticket, input)
  }
  readFact(actorId: string, projectId: string, input: { ticketId: string; kind: 'report' | 'decision' | 'assignment' | 'artifact' | 'input'; id: string; contentVersion?: string; offset?: number; limit?: number }) {
    this.owner(actorId, projectId); const ticket = this.store.tickets.get(input.ticketId)
    if (!ticket || ticket.projectId !== projectId) throw new UserError('unknownProject')
    return readFact(this.store, ticket, input)
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
