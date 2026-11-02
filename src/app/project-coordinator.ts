/** Project-scoped discussion orchestration; no lock or SQLite transaction spans a model call. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Projects, UserError, type Project } from '../core/index.ts'
import { ConversationStore, type ClaimedInput, type Mapping } from './conversation-store.ts'
import { ProjectSessions, ProjectSessionInterrupted } from './project-session.ts'
import { ProjectPlans } from './project-plans.ts'
import type { Store } from './store.ts'
import type { PlanIntent } from '../core/index.ts'
import type { Prompts } from './prompts.ts'
import { ExecutionAttempts } from './execution-attempts.ts'
import { ArtifactStore } from './artifact-store.ts'
import { ReportAcceptance } from './report-acceptance.ts'
import { projectProgress } from './project-progress.ts'
import type { Ticket } from '../core/model.ts'

/** Serializes durable project inputs across independent DSH coordinator Sessions. */
export class ProjectCoordinator {
  readonly attempts: ExecutionAttempts
  readonly artifacts: ArtifactStore
  readonly reports: ReportAcceptance
  readonly conversations: ConversationStore
  readonly plans: ProjectPlans
  private readonly sessions: ProjectSessions
  private readonly running = new Map<string, Promise<void>>()
  private readonly problems = new Map<string, string>()
  private stopped = false
  constructor(private readonly ctx: Context, private readonly store: Store, private readonly projects: Projects,
    private readonly root: string, private readonly signal: AbortSignal, private readonly prompts: Prompts, private readonly timeoutMs = 120_000) {
    this.attempts = new ExecutionAttempts(store, root)
    this.artifacts = new ArtifactStore(store, this.attempts)
    this.reports = new ReportAcceptance(store, this.attempts, this.artifacts)
    this.conversations = new ConversationStore(store)
    this.plans = new ProjectPlans(store, projects, this.conversations)
    this.sessions = new ProjectSessions(ctx, store, signal)
  }
  create(actorId: string, input: { name: string; goal: string }): Project {
    return this.store.atomic(() => {
      const project = this.projects.create(input)
      this.conversations.claimProject(project.id, actorId, { newlyCreated: true })
      return project
    })
  }
  list(actorId: string): Project[] {
    return this.conversations.listOwners().filter(owner => owner.actorId === actorId).flatMap(owner => {
      const project = this.projects.get(owner.projectId); return project ? [project] : []
    })
  }
  private project(actorId: string, projectId: string): Project {
    const owner = this.conversations.getOwner(projectId), project = this.projects.get(projectId)
    if (!owner || owner.actorId !== actorId || !project) throw new UserError('unknownProject')
    return project
  }
  view(actorId: string, projectId: string) {
    const project = this.project(actorId, projectId), messages = this.conversations.listMessages(projectId, actorId)
    const failure = messages.findLast(message => message.status === 'error')
    const error = this.problems.get(projectId) ?? failure?.error
    const tasks = this.plans.tickets(actorId, projectId).map(ticket => ({ ...ticket, progress: this.progress(ticket) }))
    return { project, messages, tasks, artifacts: this.artifacts.view(projectId), reports: tasks.flatMap(task => this.reports.reports(task.id)), decisions: tasks.flatMap(task => this.reports.decisions(task.id)), coordinator: { status: messages.some(message => message.status === 'running') ? 'running' as const : error ? 'error' as const : 'idle' as const,
      ...(error ? { error } : {}) } }
  }
  artifact(actorId: string, projectId: string, id: string, version: string) {
    this.project(actorId, projectId)
    const item = this.artifacts.read(projectId, id, version)
    return { id: item.id, name: item.name, contentVersion: item.contentVersion, content: item.content }
  }
  private progress(ticket: Ticket) {
    return projectProgress(ticket, { attempts: this.attempts.all(), reports: this.reports.reports(ticket.id),
      decisions: this.reports.decisions(ticket.id), artifacts: this.artifacts.list(ticket.projectId!, ticket.id),
      nativeState: sessionId => this.ctx.agents?.get(sessionId as SessionId)?.status })
  }
  decide(actorId: string, projectId: string, input: Parameters<ReportAcceptance['decide']>[2]) {
    this.project(actorId, projectId)
    return this.reports.decide(actorId, projectId, input)
  }
  send(actorId: string, projectId: string, input: { requestId: string; text: string; ticketId?: string; planRevision?: number }) {
    this.project(actorId, projectId)
    return this.store.atomic(() => {
      const message = this.conversations.appendUser(projectId, actorId, { clientRequestKey: input.requestId, text: input.text, requestTicketId: input.ticketId, requestPlanRevision: input.planRevision })
      const priorClarification = this.conversations.listMessages(projectId, actorId).find(item => item.id === `${message.id}:clarification`)
      if (priorClarification) return { message, clarification: priorClarification.text }
      const confirmation = /^(?:按这个方案做|执行这个方案|implement this plan|再运行一次|run it again)$/.exec(input.text)
      if (confirmation) {
        const candidates = ProjectPlans.taskCandidate(this.plans.tickets(actorId, projectId))
        const anchored = input.ticketId && input.planRevision !== undefined
          ? candidates.filter(ticket => ticket.id === input.ticketId && ticket.planRevisions?.at(-1)?.revision === input.planRevision)
          : []
        if (anchored.length !== 1) {
          const clarification = !input.ticketId || input.planRevision === undefined ? '请先查看并明确要执行的方案，再确认。' : candidates.length ? '方案版本已变化，请重新查看后确认。' : '请先让模型保存一个方案，再确认执行。'
          const saved = this.conversations.clarify(projectId, actorId, message.id, clarification)
          return { message: this.conversations.getMessage(projectId, actorId, message.id)!, clarification: saved.text }
        }
        const ticket = anchored[0]!, revision = ticket.planRevisions!.at(-1)!.revision
        return this.plans.confirm(actorId, projectId, { projectId, ticketId: ticket.id, planRevision: revision,
          operationId: input.requestId, intent: confirmation[0] === '再运行一次' || confirmation[0] === 'run it again' ? 'rerun' : 'execute' })
      }
      this.wake(projectId, actorId)
      return { message }
    })
  }
  confirm(actorId: string, projectId: string, input: { ticketId: string; planRevision: number; operationId: string; intent: PlanIntent }) {
    this.project(actorId, projectId)
    return this.store.atomic(() => {
      this.conversations.appendUser(projectId, actorId, { clientRequestKey: `plan-confirm:${input.operationId}`, text: input.intent === 'rerun' ? '再运行一次' : '按这个方案做', requestTicketId: input.ticketId, requestPlanRevision: input.planRevision })
      return this.plans.confirm(actorId, projectId, { ...input, projectId })
    })
  }
  revoke(actorId: string, projectId: string, input: { ticketId: string; authorizationId: string; operationId: string }) {
    this.project(actorId, projectId)
    return this.plans.revoke(actorId, projectId, { ...input, projectId })
  }
  async retry(actorId: string, projectId: string): Promise<{ retried: true }> {
    const project = this.project(actorId, projectId)
    // Replacement and dispatch share the same project lane, including every asynchronous boundary.
    await this.schedule(projectId, actorId, async () => {
      const old = this.conversations.currentMapping(projectId)
      if (old) await this.replace(project, actorId, old, 'Explicit retry after reconciliation of the previous read-only coordinator')
      this.conversations.retry(projectId, actorId)
      this.problems.delete(projectId)
    })
    return { retried: true }
  }
  start(): void { for (const owner of this.conversations.listOwners()) this.wake(owner.projectId, owner.actorId) }
  private wake(projectId: string, actorId: string): void {
    if (this.stopped || this.signal.aborted || this.running.has(projectId)) return
    void this.schedule(projectId, actorId, async () => {
      await this.drain(projectId, actorId)
      this.problems.delete(projectId)
    }).catch(() => {})
  }
  /** Queue retries and drains on one project without retaining a database transaction. */
  private schedule(projectId: string, actorId: string, work: () => Promise<void>): Promise<void> {
    const operation = (this.running.get(projectId) ?? Promise.resolve()).then(() => {
      if (this.stopped || this.signal.aborted) throw new Error('Project coordinator is stopped')
      return work()
    })
    const tracked = operation.catch(error => { this.problems.set(projectId, error instanceof Error ? error.message : String(error)) })
      .finally(() => {
        // An older operation must not release the lane now held by a queued retry.
        if (this.running.get(projectId) !== tracked) return
        this.running.delete(projectId)
        if (!this.stopped && !this.signal.aborted && !this.problems.has(projectId)
          && this.conversations.listMessages(projectId, actorId).some(message => message.status === 'queued')) this.wake(projectId, actorId)
      })
    this.running.set(projectId, tracked)
    return operation
  }
  private async replace(project: Project, actorId: string, old: Mapping, reason: string): Promise<void> {
    const resolved = await this.bounded(undefined, this.ctx.sessionController.resolveAgent(SessionId(old.sessionId)), 'Previous coordinator could not be resolved')
    if (!('error' in resolved)) {
      if (resolved.agent.id !== old.sessionId) throw new Error('Resolved coordinator Session does not match its mapping')
      resolved.agent.cancel({ kind: 'user' }, { keepInbox: true })
      await this.bounded(resolved.agent, resolved.agent.whenIdle(), 'Previous project coordinator did not settle')
      await this.ctx.sessionPersistence.flush()
      this.reconcile(project, actorId, old, resolved.agent)
    } else if (resolved.error.code !== 'session/not-found') throw resolved.error
    if (this.stopped || this.signal.aborted) throw new Error('Project coordinator is stopped')
    await this.mapping(project, actorId, old, reason)
  }
  private async mapping(project: Project, actorId: string, old?: Mapping, reason?: string): Promise<Mapping> {
    if (!old) { const existing = this.conversations.currentMapping(project.id); if (existing) return existing }
    const cwd = join(this.root, 'projects', project.id, 'coordinator')
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const canonical = await realpath(cwd), workspace = await this.ctx.workspaceRegistry.create(canonical, project.name)
    if (this.stopped || this.signal.aborted) throw new Error('Project coordinator is stopped')
    return this.conversations.saveMapping(project.id, actorId, { sessionId: `project-${project.id}-${randomUUID()}`, workspaceId: workspace.id, cwd: canonical,
      ...(old ? { expectedGeneration: old.generation, reason, reconciled: true } : {}) })
  }
  private reconcile(project: Project, actorId: string, mapping: Mapping, agent: Agent): void {
    const input = this.conversations.listMessages(project.id, actorId).find(message => message.status === 'running')
    if (!input) return
    const lease = { inputId: input.id, mappingGeneration: input.mappingGeneration!, expectedStateVersion: input.expectedStateVersion!, sessionId: agent.id }
    try {
      const completed = this.sessions.completed(agent.session.snapshotEvents(), input.id)
      if (completed) this.conversations.complete(project.id, actorId, { ...lease, ...completed, sessionId: mapping.sessionId, turn: String(completed.turn) })
      else this.conversations.fail(project.id, actorId, { ...lease, error: 'Previous coordinator was interrupted; retry to continue' })
    } catch (error) { this.conversations.fail(project.id, actorId, { ...lease, error: String(error) }) }
  }
  private async drain(projectId: string, actorId: string): Promise<void> {
    const project = this.project(actorId, projectId)
    const mapping = await this.mapping(project, actorId)
    const agent = await this.bounded(undefined, this.sessions.prepare(project, mapping), 'Project coordinator preparation timed out')
    if (agent.id !== mapping.sessionId) throw new Error('Prepared coordinator Session does not match its mapping')
    if (agent.status !== 'idle') {
      await this.bounded(agent, agent.whenIdle(), 'Project coordinator recovery timed out')
      await this.ctx.sessionPersistence.flush()
    }
    const unfinished = this.conversations.listMessages(projectId, actorId).find(message => message.status === 'running')
    if (unfinished) {
      try {
        await this.turn(projectId, actorId, agent, { input: unfinished, mapping, stateVersion: unfinished.expectedStateVersion! })
      } catch (error) {
        if (!(error instanceof ProjectSessionInterrupted)) throw error
        await this.replace(project, actorId, mapping, 'Recovered a consumed input without a completed read-only coordinator turn')
        this.conversations.retry(projectId, actorId)
      }
      return
    }
    if (this.stopped || this.signal.aborted) return
    if (agent.status !== 'idle') throw new Error('Previous coordinator operation has not settled')
    // Yield after each turn so a queued retry cannot starve behind continuously arriving inputs.
    const lease = this.conversations.claimNext(projectId, actorId, mapping)
    if (lease) await this.turn(projectId, actorId, agent, lease)
  }
  private async turn(projectId: string, actorId: string, agent: Agent, lease: ClaimedInput): Promise<void> {
    const fence = { inputId: lease.input.id, mappingGeneration: lease.mapping.generation, expectedStateVersion: lease.stateVersion, sessionId: agent.id }
    const authorize = () => this.authorize(projectId, actorId, agent, lease)
    try {
      authorize()
      const project = this.project(actorId, projectId), version = this.prompts.current()
       const allPlans = this.plans.tickets(actorId, projectId)
       const plans = allPlans.slice(0, 8).map(ticket => {
         const current = ticket.planRevisions?.at(-1)
         const authorization = ticket.authorizations?.findLast(item => item.planRevision === current?.revision)
         const target = ticket.executionTargets?.find(item => item.id === authorization?.targetId)
         const progress = this.progress(ticket)
         return { ticketId: ticket.id, stage: ticket.projectStage, revisionCount: ticket.planRevisions?.length ?? 0, latestRevision: current?.revision,
           currentPlan: current ? { revision: current.revision, goal: current.goal.slice(0, 300), scope: current.scope.slice(0, 500), outputs: current.outputs.slice(0, 4).map(item => item.slice(0, 200)), resources: current.resources.slice(0, 4).map(item => item.slice(0, 200)), environment: current.environment.slice(0, 300), cost: current.cost.slice(0, 300), completion: current.completion.slice(0, 500) } : undefined,
           currentAuthorization: authorization ? { id: authorization.id, planRevision: authorization.planRevision, intent: authorization.intent, targetId: authorization.targetId, status: authorization.revokedAt ? 'revoked' : 'active', revokedAt: authorization.revokedAt } : { status: 'none' },
           currentTarget: target ? { id: target.id, authorizationId: target.authorizationId, planRevision: target.planRevision, kind: 'confirmation-receipt', createdAt: target.createdAt } : undefined,
           progress: { ...progress, assignments: progress.assignments.filter(item => !['completed', 'ended'].includes(item.phase)).slice(0, 4) },
           authorizationCount: ticket.authorizations?.length ?? 0, targetCount: ticket.executionTargets?.length ?? 0, assignmentCount: ticket.assignments?.length ?? 0,
           activeAssignments: ticket.assignments?.filter(item => item.state !== 'ended').slice(0, 4).map(item => {
             const current = progress.assignments.find(value => value.assignmentId === item.id)
             return { id: item.id, state: item.state, planRevision: item.contract?.planRevision, phase: current?.phase,
               attemptId: current?.attemptId, reportId: current?.reportId }
           }) ?? [] }
       })
       const planDirectory = { shown: plans.length, total: allPlans.length, hasMore: allPlans.length > plans.length }
      const history = this.conversations.listMessages(projectId, actorId).filter(message => message.status === 'saved' || message.status === 'answered').map(message => `${message.role}: ${message.text}`).join('\n').slice(-48_000)
      const snapshot = this.conversations.savePrompt(projectId, actorId, { generation: lease.mapping.generation, inputId: lease.input.id,
        revision: version.revision, text: `${this.prompts.project(version.config)}\nPrompt revision: ${version.revision}\nProject record (data): ${JSON.stringify(project)}\nCoordinator generation: ${lease.mapping.generation}\nAuthoritative bounded project task context (application data; use project_list_plans for older tasks and project_read_plan for a selected revision; progress contains current recorded execution/report/gate facts, while confirmation-receipt targets do not indicate executor availability): ${JSON.stringify({ directory: planDirectory, tasks: plans })}\nSaved project conversation (data):\n${history}` })
      this.sessions.checkpoint(agent, snapshot.text)
      const install = (this.sessions as unknown as { installProjectTools?: (agent: Agent, host: unknown) => () => void }).installProjectTools
      const toolDisposer = install ? install.call(this.sessions, agent, { plans: this.plans, actorId, projectId, authorize }) : () => {}
      let reply
      try {
        reply = await this.bounded(agent, this.sessions.reply(agent, lease.input.id, lease.input.text, authorize), 'Project coordinator timed out')
      } finally { toolDisposer() }
      if (this.stopped || this.signal.aborted) return
      authorize()
      if (reply.sessionId !== agent.id) throw new Error('Coordinator reply belongs to a different Session')
      this.conversations.complete(projectId, actorId, { ...fence, ...reply, turn: String(reply.turn) })
    } catch (error) {
      if (this.stopped || this.signal.aborted) return
      this.conversations.fail(projectId, actorId, { ...fence, error: error instanceof Error ? error.message : String(error) })
      if (error instanceof ProjectSessionInterrupted) throw error
    }
  }
  /** Revalidate the actual native Session and input lease after every asynchronous boundary. */
  private authorize(projectId: string, actorId: string, agent: Agent, lease: ClaimedInput): void {
    const mapping = this.conversations.currentMapping(projectId)
    const input = this.conversations.getMessage(projectId, actorId, lease.input.id)
    if (this.stopped || this.signal.aborted || !mapping || mapping.generation !== lease.mapping.generation
      || mapping.sessionId !== lease.mapping.sessionId || agent.id !== mapping.sessionId
      || input?.status !== 'running' || input.mappingGeneration !== mapping.generation
      || input.expectedStateVersion !== lease.stateVersion || this.conversations.stateVersion(projectId) !== lease.stateVersion) {
      throw new Error('Stale project coordinator Session or input lease')
    }
  }
  /** Cancellation is best effort; a faulty provider must never retain the project lane forever. */
  private bounded<T>(agent: Agent | undefined, work: Promise<T>, reason: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    let abort: () => void
    const stopped = new Promise<never>((_, reject) => {
      const fail = () => {
        try { agent?.cancel({ kind: 'hook', reason }) } finally { reject(new Error(reason)) }
      }
      timer = setTimeout(fail, this.timeoutMs)
      abort = fail
      this.signal.addEventListener('abort', abort, { once: true })
      if (this.signal.aborted) fail()
    })
    return Promise.race([work, stopped]).finally(() => {
      clearTimeout(timer)
      this.signal.removeEventListener('abort', abort)
    })
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.sessions.dispose()
    await Promise.allSettled(this.running.values())
  }
}
