/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, Projects, key, reasonText, type EngineForSettings, type ProjectFeedbackFact, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type ExecutionIdentity, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { ProjectCoordinator } from './project-coordinator.ts'
import { ProjectEvents } from './events.ts'
import { executionIdentityContributor } from './execution-identity.ts'
import { WorkerCleanup } from './worker-cleanup.ts'
import { ProjectScheduler, ManagedBudgetHooks } from './scheduler.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { watch as watchGithub } from '../sources/github.ts'
import { githubNamespaceOf, githubThreadNumber } from '../sources/github-namespace.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { BackupService, type BackupMaterialSnapshot } from './backup-service.ts'
import type { NativeSessionArchive } from './backup.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, projectWorkerTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly projects: Projects
  readonly projectCoordinator: ProjectCoordinator
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly backup: BackupService
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  /** Restore profiles are read-only by construction; this is checked before native sessions/effects start. */
  readonly safeRestore: boolean
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  readonly scheduler: ProjectScheduler
  private budgetHooks?: ManagedBudgetHooks
  private closingFlag = false
  private stopping?: Promise<void>
  private workerCleanup?: WorkerCleanup
  private readonly githubConsumers = new Map<string, { signature: string; controller: AbortController }>()
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    this.safeRestore = existsSync(join(machine.stateDir, 'restore-profile.json'))
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      this.projects = new Projects({ repo: store })
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      this.projectCoordinator = new ProjectCoordinator(ctx, store, this.projects, machine.stateDir, this.lifetime, prompts)
      this.projectCoordinator.setRepositoryVerifier(({ repository, accountId, accountCli }, signal) => commands.verifyRepository(repository, { cli: accountCli, login: accountId }, signal))
      this.projectCoordinator.setGithubContext(identity => this.contextForExecution(identity))
      this.projectCoordinator.setResourceChange(() => this.syncGitHubConsumers())
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync && !this.safeRestore) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const { attempts, artifacts, reports } = this.projectCoordinator
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId, attempts, reports, skillCatalog: this.projectCoordinator.skills, knowledge: this.projectCoordinator.knowledge, resources: this.projectCoordinator.resources,
        delegations: this.projectCoordinator.delegations,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => attempts.bySession(agent.id) ? projectWorkerTools(attempts, artifacts, reports, engine, agent.id, this.projectCoordinator.resources, this.projectCoordinator.validation, this.commands, this.projectCoordinator.delegations) : ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      const databasePath = store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
      if (typeof databasePath !== 'string') throw new Error('Orchestrator database path is unavailable')
      this.backup = new BackupService({ store, databasePath, destinationRoot: join(machine.stateDir, 'backups'), recovery: {},
        recoveryRoots: () => {
           const projects = join(machine.stateDir, 'projects')
           const workspaces = store.tickets.list().flatMap(ticket => ticket.execution?.directory && existsSync(ticket.execution.directory) ? [ticket.execution.directory] : [])
           const externalResources = this.projects.list().flatMap(project => this.projectCoordinator.resources.list(project.id)).filter(resource => !resource.revoked).map(resource => resource.path)
           return { workspaces: [...new Set([projects, ...workspaces].filter(existsSync))], nativeState: [], externalResources: [...new Set(externalResources.filter(existsSync))] }
         },
        prepareMaterials: () => this.backupMaterials(), applicationFull: true, health: board.claim('backup'), lifetime: this.lifetime })
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() }, backupChanged: value => { if (!this.safeRestore) this.backup.start(value) } })
      if (!this.safeRestore) this.backup.start(store.settings().backup)
      this.scheduler = new ProjectScheduler({ limits: () => { const count = store.settings().executor.maxWorkers; return { model: count, worker: count, background: count } },
        cursor: { read: kind => store.get(`budget.cursor.${kind}`), write: (kind, projectId) => store.set(`budget.cursor.${kind}`, projectId) },
        onChange: rows => {
          for (const ticket of store.tickets.list().filter(item => item.projectId)) {
            let changed = false
            for (const branch of ticket.assignments) {
              const ownerIds = attempts.all().filter(item => item.assignmentId === branch.id).map(item => item.sessionId)
              const wait = rows.find(row => row.state === 'queued' && (row.id.startsWith(`worker:${branch.id}:`) || row.ownerId && ownerIds.includes(row.ownerId)))?.waitingReason
              const projected = wait as ('global-budget' | 'project-fairness' | undefined)
              if (branch.budgetWait !== projected) { branch.budgetWait = projected; changed = true }
            }
            if (changed) store.tickets.save(ticket)
          }
        } })
      // A read-only restore profile must never create, adopt, stop or rewrite native validation jobs.
      if (!this.safeRestore) this.projectCoordinator.setScheduler(this.scheduler, this.ctx.get('jobs') as import('./native-validation-job.ts').ValidationNativeJobs)
       this.projectCoordinator.setBudgetWaitResolver(projectId => {
        const mapping = this.projectCoordinator.conversations.currentMapping(projectId)
        return this.scheduler.status().find(row => row.kind === 'model' && row.state === 'queued' && row.projectId === projectId && row.ownerId === mapping?.sessionId)?.waitingReason
      })
      // Retiring finished workers touches only the navigation surface; the restore profile never writes it.
      this.workerCleanup = this.safeRestore ? undefined : new WorkerCleanup({ ctx, store, attempts, lifetime: this.lifetime,
        closing: () => this.closing(), ownerExitKnown: ownerId => (this.budgetHooks?.ownerExitKnown(ownerId) ?? false) && this.projectCoordinator.validation.ownerExitKnown(ownerId) })
      // Acceptance itself ends an Attempt without passing through the Executor, so ending is observed
      // where it is written rather than at each caller.
      attempts.onEnded(attemptId => { void this.workerCleanup?.consider(attemptId).catch(() => {}) })
      this.executor = new DshExecutor({ scheduler: this.scheduler, context: ctx, get engine() { return runtime.engine }, store, effects, attempts, masterId, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        checkpointFiles: ticket => ticket.projectId ? artifacts.list(ticket.projectId, ticket.id).filter(item => item.status === 'registered').map(item => item.path) : [],
        reportReady: (ticket, assignment, attempt) => reports.reports(ticket.id).some(report => report.attemptId === attempt.id && report.lease === attempt.lease && report.assignmentId === assignment.id && report.state === 'ready'),
        reaggregateProject: attempt => { try { reports.reaggregate(attempt.sessionId) } catch { /* Stale, paused or damaged state remains held by its durable report. */ } },
        delegationResultsPending: attempt => this.projectCoordinator.delegations.pendingResults(attempt.id).length > 0,
        evidenceReady: (ticket, assignment, attempt) => {
          const related = reports.reports(ticket.id).filter(report => report.attemptId === attempt.id && report.lease === attempt.lease && report.assignmentId === assignment.id)
          if (related.some(report => report.artifacts.some(ref => { try { artifacts.read(attempt.projectId, ref.id, ref.contentVersion); return false } catch { return true } }))) return false
          return !artifacts.list(attempt.projectId, ticket.id).some(item => item.attemptId === attempt.id && item.lease === attempt.lease && item.status === 'writing')
        },
        ownerExitKnown: ownerId => (this.budgetHooks?.ownerExitKnown(ownerId) ?? false) && this.projectCoordinator.validation.ownerExitKnown(ownerId),
        reconcileOwner: async ownerId => { await this.projectCoordinator.validation.reconcileOwner(ownerId); this.workerCleanup?.start() },
        retireWorker: attemptId => { void this.workerCleanup?.consider(attemptId).catch(() => {}) },
         outboundUnknown: ticket => store.db.prepare("SELECT 1 FROM outbox WHERE json_extract(value, '$.ticketId') = ? AND json_extract(value, '$.reconciliation.state') = 'unknown' LIMIT 1").get(ticket.id) !== undefined,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      const validateWorker = (ownerId: string, lease: string) => {
        const { attempt, ticket } = attempts.resolve(ownerId)
        if (this.lifetime.aborted || this.closing() || this.paused() || attempt.lease !== lease || ticket.lifecycle?.pause.intent === 'pause' || ticket.lifecycle?.stop.intent === 'stop') throw new Error('Managed owner authority changed')
      }
      const managedAncestorOf = (ownerId: string) => {
        let parent = this.ctx.agents.get(ownerId as SessionId)?.session.header.parentSession
        for (let depth = 0; parent !== undefined && depth < 8; depth++) {
          const parentAttempt = attempts.bySession(parent)
          if (parentAttempt) return parentAttempt
          const child = this.projectCoordinator.delegations.byChildSession(parent)
          if (child) return attempts.bySession(child.parentSessionId)
          parent = this.ctx.agents.get(parent)?.session.header.parentSession
        }
        return undefined
      }
      const legacyAncestorOf = (ownerId: string) => {
        let parent = this.ctx.agents.get(ownerId as SessionId)?.session.header.parentSession
        for (let depth = 0; parent !== undefined && depth < 8; depth++) {
          const ticket = store.tickets.list().find(item => !item.projectId && workerSessionId(item.id) === parent)
          if (ticket) return ticket
          const child = this.projectCoordinator.delegations.byChildSession(parent)
          if (child) parent = child.parentSessionId as SessionId
          else parent = this.ctx.agents.get(parent)?.session.header.parentSession
        }
        return undefined
      }
      const legacyOwners = () => [
        ...store.tickets.list().filter(ticket => !ticket.projectId).map(ticket => ({ ownerId: workerSessionId(ticket.id), projectId: 'legacy', validate: () => {
          const current = store.tickets.get(ticket.id)
          if (this.lifetime.aborted || this.closing() || this.paused() || !current || current.ended || current.lifecycle?.pause.intent === 'pause' || current.lifecycle?.stop.intent === 'stop') throw new Error('Legacy worker authority changed')
        } }))
      ]
      this.budgetHooks = new ManagedBudgetHooks(ctx, this.scheduler, {
        resolve: ownerId => {
          const delegated = this.projectCoordinator.delegations.byChildSession(ownerId)
          if (delegated) return { ownerId, projectId: delegated.projectId, validate: () => {
            const current = this.projectCoordinator.delegations.byChildSession(ownerId)
            if (!current || !['requested', 'starting', 'running'].includes(current.state)) throw new Error('Delegation authority changed')
            this.projectCoordinator.delegations.authorizeChild(ownerId)
          } }
          const unrecordedParent = managedAncestorOf(ownerId)
          if (unrecordedParent) return { ownerId, projectId: unrecordedParent.projectId, validate: () => {
            throw new Error('Subagent has no recorded delegation budget owner')
          } }
          const attempt = attempts.all().findLast(item => item.sessionId === ownerId)
          if (!attempt) {
            const mapping = this.projectCoordinator.conversations.listMappings().find(item => item.sessionId === ownerId)
            if (!mapping) {
              const legacy = store.tickets.list().find(item => !item.projectId && workerSessionId(item.id) === ownerId)
              const legacyTicket = legacy ?? legacyAncestorOf(ownerId)
              if (!legacyTicket) {
                if (this.ctx.agents.get(ownerId as SessionId)?.session.header.origin === 'subagent') return { ownerId, projectId: 'unknown-subagent', validate: () => {
                  throw new Error('Subagent ancestry is unknown or has no recorded delegation budget owner')
                } }
                return undefined
              }
              return { ownerId, projectId: 'legacy', validate: () => {
                const current = store.tickets.get(legacyTicket.id)
                if (this.lifetime.aborted || this.closing() || this.paused() || !current || current.ended || current.lifecycle?.pause.intent === 'pause' || current.lifecycle?.stop.intent === 'stop') throw new Error('Legacy worker authority changed')
              } }
            }
            return { ownerId, projectId: mapping.projectId, validate: () => {
              this.projectCoordinator.validateBudgetOwner(ownerId, mapping.projectId, mapping.generation)
              const current = this.projectCoordinator.conversations.currentMapping(mapping.projectId)
              if (this.lifetime.aborted || this.closing() || this.paused() || current?.generation !== mapping.generation || current.sessionId !== ownerId) throw new Error('Coordinator owner authority changed')
            } }
          }
          return { ownerId, projectId: attempt.projectId, validate: () => validateWorker(ownerId, attempt.lease) }
        },
        owners: () => [...legacyOwners(), ...attempts.all().filter(attempt => !!attempt.sessionId).map(attempt => ({ ownerId: attempt.sessionId, projectId: attempt.projectId, validate: () => {
          validateWorker(attempt.sessionId, attempt.lease)
        } })), ...this.projectCoordinator.delegations.activeChildSessions().map(childSessionId => {
          const delegation = this.projectCoordinator.delegations.byChildSession(childSessionId)!
          return { ownerId: childSessionId, projectId: delegation.projectId, validate: () => this.projectCoordinator.delegations.authorizeChild(childSessionId) }
        }), ...this.projectCoordinator.conversations.listMappings().map(mapping => ({ ownerId: mapping.sessionId, projectId: mapping.projectId, validate: () => this.projectCoordinator.validateBudgetOwner(mapping.sessionId, mapping.projectId, mapping.generation) }))],
        onUncertain: (ownerId, jobId) => {
          const attempt = attempts.all().findLast(item => item.sessionId === ownerId)
          if (!attempt) {
            const mapping = this.projectCoordinator.conversations.listMappings().find(item => item.sessionId === ownerId)
            if (mapping) store.set(`project-coordinator-uncertain:${ownerId}`, { jobId, projectId: mapping.projectId, generation: mapping.generation })
            return
          }
          const ticket = store.tickets.get(attempt.ticketId), branch = ticket?.assignments.find(item => item.id === attempt.assignmentId)
          if (branch && ticket) { attempt.status = 'reconcile'; attempt.error = `Unknown physical exit for job ${jobId}`; branch.waitingReason = 'preparation-reconciliation'; store.atomic(() => { attempts.save(attempt); store.tickets.save(ticket) }) }
        }
      })
      this.budgetHooks.install()
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused(), commandsFor: message => {
          const address = message.channel.address
          if (!address.projectId || !address.resourceId) return undefined
          const identity = this.projectCoordinator.identities.pin(address.projectId, address.resourceId, `github-delivery:${message.id}`)
          return this.commands.forExecution(identity)
        }, deliveryAuthorization: message => {
          const address = message.channel.address
          if (message.channel.source !== 'github' || !address.projectId || !address.resourceId) return 'authorized'
          try {
            const resource = this.projectCoordinator.resources.get(address.projectId, address.resourceId)
            if (resource.type !== 'repository') return 'revoked'
            const identity = this.projectCoordinator.identities.pin(address.projectId, address.resourceId, `github-delivery:${message.id}`)
            if (!identity.repository || !identity.accountId) return 'revoked'
            if (address.repository && address.repository.toLowerCase() !== identity.repository.toLowerCase()) return 'revoked'
            if (address.account && address.account.toLowerCase() !== identity.accountId.toLowerCase()) return 'revoked'
            return 'authorized'
          } catch { return 'revoked' }
        } })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
        projectFeedback: fact => this.recordProjectFeedback(fact), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            const repositoryFor = (thread: string): string | undefined => ended.projectId
              ? this.projectCoordinator.pullRepositoryFor(ended.projectId, thread)
              : setup.deployment.repository
            for (const message of pullEndNotices(ended, request, repositoryFor)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects, projectPass: () => { this.budgetHooks?.sync(); this.scheduler.refresh(); this.syncGitHubConsumers(); this.projectCoordinator.pumpEvents(); return executor.dispatchProjects() },
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get githubProblem() { return setup.githubProblem }, get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
        receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
      void this.ready.then(() => { this.syncGitHubConsumers() }).catch(() => {})
      // A crash may commit a terminal Attempt without ever delivering onEnded. Recover those after
      // startup is ready (restore and backup capture have settled), never during the commit itself.
      void this.ready.then(() => { this.workerCleanup?.start() }).catch(() => {})
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /**
   * Builds a Source context from one persisted project/resource/Attempt identity. The Commands
   * snapshot, deployment view, namespace, cursors and ticket/thread filters all belong to that
   * execution; no shared Runtime namespace is mutated.
   */
  contextForExecution(identity: ExecutionIdentity): SourceContext {
    const commands = this.commands.forExecution(identity), setup = this.setup
    return sourceContextOf({
      store: this.store, outbox: this.outbox, engine: this.engine, sources: this.sources, ready: this.ready,
      commands, deployment: commands.deployment, configured: () => setup.configured(),
      githubNamespace: githubNamespaceOf(identity),
      get setupProblem() { return setup.problem ?? setup.githubProblem },
      get githubProblem() { return setup.githubProblem },
      get feishuProblem() { return setup.feishuProblem },
      receive: trigger => this.passes.receive(trigger),
    }, { kind: 'github', health: [] })
  }
  /** Starts/stops one project-facing poller per active registered repository resource. */
  syncGitHubConsumers(): void {
    if (this.safeRestore || this.closing() || !this.setup.configured()) return
    const wanted = new Map<string, { identity: import('./execution-environment.ts').ExecutionIdentity; signature: string }>()
    for (const project of this.projects.list()) for (const resource of this.projectCoordinator.resources.list(project.id)) {
      if (resource.type !== 'repository' || resource.revoked) continue
      let identity: import('./execution-environment.ts').ExecutionIdentity
      try { identity = this.projectCoordinator.identities.pin(project.id, resource.id, `github-poll:${project.id}:${resource.id}`) }
      catch { continue }
      const signature = JSON.stringify([identity.repository, identity.accountId, identity.accountCli, identity.gitAuthorName, identity.gitAuthorEmail])
      wanted.set(`${project.id}:${resource.id}`, { identity, signature })
    }
    for (const [key, live] of this.githubConsumers) {
      if (!wanted.has(key)) { live.controller.abort(); this.githubConsumers.delete(key) }
    }
    for (const [key, value] of wanted) {
      const existing = this.githubConsumers.get(key)
      if (existing?.signature === value.signature) continue
      existing?.controller.abort()
      const controller = new AbortController()
      this.githubConsumers.set(key, { signature: value.signature, controller })
      void watchGithub(this.contextForExecution(value.identity), controller.signal, { silentHealth: true }).catch(() => {})
    }
  }
  /** Registers the per-attempt DSH_* shell facts once the host's shell-env registry is available. */
  private bindShellIdentity(): void {
    if (this.shellIdentityBound) return
    // Reflect, not property access: the shell-env registry is an optional host capability here.
    const registry = (this.ctx as Context & { reflect?: { get(name: string, strict?: boolean): unknown } }).reflect?.get('shellEnv') as { register(contributor: unknown): () => void } | undefined
    if (!registry) return
    registry.register(executionIdentityContributor(this.projectCoordinator.attempts, this.projectCoordinator.resources))
    this.shellIdentityBound = true
  }
  private shellIdentityBound = false
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem ?? this.setup.githubProblem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.safeRestore ? 'filtered' : this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> {
    if (!this.safeRestore) { this.budgetHooks?.sync(); this.scheduler.refresh(); this.projectCoordinator.pumpEvents() }
    return this.safeRestore ? Promise.resolve() : this.passes.pump()
  }
  sendReplies(): Promise<void> { return this.safeRestore ? Promise.resolve() : this.outbox.sent() }
  /** Records the one durable project fact for a human Trigger that reached a live project Ticket. Called inside intake's transaction. */
  private recordProjectFeedback(fact: ProjectFeedbackFact): void {
    const ticket = this.store.tickets.get(fact.ticketId)
    if (!ticket || ticket.projectId !== fact.projectId) throw new Error('Project feedback does not belong to its Ticket project')
    const trigger = this.store.triggers.get(fact.triggerId)
    if (!trigger) throw new Error('Project feedback Trigger is missing')
    // A scoped Source records the project that owns its Channel. Never let a cross-project Trigger become this Task's
    // feedback merely because an invalid subscription makes it reach the Ticket.
    const addressProject = trigger.channel?.address?.projectId
    if (typeof addressProject === 'string' && addressProject !== fact.projectId) return
    const meta = trigger.meta
    const numbers = new Set(trigger.threads.flatMap(thread => {
      const number = githubThreadNumber(thread.id)
      return number === undefined ? [] : [number]
    }))
    if (typeof meta.number === 'number') numbers.add(meta.number)
    const repository = typeof trigger.channel?.address?.repository === 'string' ? trigger.channel.address.repository : undefined
    // A Follow records only the Thread, not the Assignment that claimed it. The durable worker_report row does: its
    // PR URL, assignment and Attempt are server-owned. Bind only when that evidence names this Task's report; never
    // guess the latest Assignment, which may be unrelated and already retired.
    const report = !numbers.size ? undefined : this.projectCoordinator.reports.reports(ticket.id).findLast(item => {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(item.prUrl ?? '')
      return !!match && numbers.has(Number(match[2])) && (!repository || match[1]?.toLowerCase() === repository.toLowerCase())
        && ticket.assignments.some(assignment => assignment.id === item.assignmentId)
    })
    const assignment = report ? ticket.assignments.find(item => item.id === report.assignmentId) : undefined
    const attempt = report ? this.projectCoordinator.attempts.all().find(item => item.id === report.attemptId
      && item.assignmentId === report.assignmentId && item.ticketId === ticket.id && item.projectId === ticket.projectId) : undefined
    const resourceIds = [...new Set([...ticket.planRevisions?.at(-1)?.resources ?? [], ...(attempt?.identity?.repositoryId ? [attempt.identity.repositoryId] : [])])]
    const budgetSlot = assignment && ticket.assignmentGraphs?.at(-1)?.nodes.find(node => node.assignmentId === assignment.id)?.budgetSlot
    const boundary = { pause: ticket.lifecycle?.pause.intent ?? 'none', stop: ticket.lifecycle?.stop.intent ?? 'none' }
    const text = trigger.text
    new ProjectEvents(this.store).append({
      id: `project-feedback:${fact.ticketId}:${fact.triggerId}`, projectId: fact.projectId, ticketId: fact.ticketId,
      kind: 'project-feedback', version: fact.triggerId, operationId: fact.triggerId, at: fact.at,
      scope: report ? 'assignment' : 'task',
      ...(report ? { reportId: report.id, reportOperationId: report.operationId } : {}),
      ...(assignment ? { assignmentId: assignment.id } : {}), ...(attempt ? { attemptId: attempt.id } : {}),
      resourceIds, ...(assignment?.contract ? { authorizationId: assignment.contract.authorizationId } : {}), ...(budgetSlot ? { budgetSlot } : {}),
      boundary, triggerId: fact.triggerId, inputId: fact.inputId,
      feedback: { triggerId: fact.triggerId, inputId: fact.inputId, source: trigger.source, text: text.slice(0, 8_000),
        textTruncated: text.length > 8_000, threadKeys: [...fact.threads], at: trigger.at,
        ...(text.length > 8_000 ? { readExact: { tool: 'project_read_fact' as const, ticket_id: fact.ticketId, kind: 'input' as const, id: fact.inputId } } : {}),
        actorId: trigger.actor.id,
        ...(trigger.url ? { url: trigger.url } : {}),
        ...(typeof meta.number === 'number' ? { number: meta.number } : {}),
        ...(typeof meta.isPr === 'boolean' ? { isPr: meta.isPr } : {}),
        ...(typeof meta.kind === 'string' ? { kind: meta.kind } : {}) },
    })
  }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return this.safeRestore || !this.setup.configured() || this.store.settings().paused }
  private managedBackupSessionIds(): Set<string> {
    const ids = new Set<string>([this.masterId])
    for (const ticket of this.store.tickets.list()) if (!ticket.projectId) ids.add(workerSessionId(ticket.id))
    for (const attempt of this.projectCoordinator.attempts.all()) ids.add(attempt.sessionId)
    for (const sessionId of this.projectCoordinator.delegations.childSessions()) ids.add(sessionId)
    for (const row of this.store.db.prepare('SELECT session_id FROM conversation_mapping').all() as { session_id: string }[]) ids.add(row.session_id)
    return ids
  }
  private recoveryDbToken(): string {
    const path = join(this.machine.stateDir, `.backup-token-${randomUUID()}.sqlite`)
    try {
      this.store.db.prepare('VACUUM INTO ?').run(path)
      return createHash('sha256').update(readFileSync(path)).digest('hex')
    } finally { if (existsSync(path)) unlinkSync(path) }
  }
  private recoveryFilesToken(paths: string[]): string {
    const hash = createHash('sha256')
    const visit = (path: string) => {
      let stat
      try { stat = lstatSync(path) } catch { return }
      if (stat.isSymbolicLink()) return
      if (stat.isDirectory()) { for (const entry of readdirSync(path)) visit(join(path, entry)) ; return }
      if (stat.isFile()) hash.update(path).update(readFileSync(path))
    }
    for (const path of [...new Set(paths)].sort()) visit(path)
    return hash.digest('hex')
  }
  private async backupMaterials(): Promise<BackupMaterialSnapshot> {
    // Registered writer activity is an epoch, not a content hash: even a writer
    // that restores its bytes before verification invalidates this capture.
    const ids = this.managedBackupSessionIds()
    const jobs = this.ctx.get('jobs') as { list(id: string): readonly { owner?: string; status: string }[]; events: { subscribe(filter: { owner: string }, listener: (event: unknown) => void): () => void } } | undefined
    const related = (agent: Agent): boolean => ids.has(agent.id)
    const quiet = () => {
      for (const id of ids) {
        const agent = this.ctx.agents.get(id as SessionId)
        if ((agent && agent.status !== 'idle') || jobs?.list(id).some(job => job.owner === id && ['running', 'stopping'].includes(job.status))) throw new Error(`Active application writer prevents recovery capture: ${id}`)
      }
    }
    quiet()
    let changed = false
    const releases: Array<() => void> = []
    const release = () => { for (const dispose of releases.splice(0)) dispose() }
    releases.push(this.ctx.on('agent/status', ({ agent }) => { if (related(agent)) changed = true }))
    for (const id of ids) if (jobs) releases.push(jobs.events.subscribe({ owner: id }, (event) => {
      const value = event as { owner?: unknown; output?: { owner?: unknown }; job?: { owner?: unknown }; lifecycle?: { job?: { owner?: unknown } } } | undefined
      const owner = value?.output?.owner ?? value?.lifecycle?.job?.owner ?? value?.job?.owner ?? value?.owner
      if (typeof owner === 'string' && ids.has(owner)) changed = true
    }))
    try {
      const materials = await this.readBackupMaterials()
      const verify = materials.verify
      return { ...materials, release, verify: async () => {
        await verify?.()
        quiet()
        if (changed) throw new Error('Registered application writer activity changed during recovery capture')
      } }
    } catch (error) { release(); throw error }
  }
  private async readBackupMaterials(): Promise<BackupMaterialSnapshot> {
    await this.passes.idle()
    await this.projectCoordinator.idle()
    if (this.executor.activeCount() > 0) throw new Error('Active application writer jobs prevent a complete recovery point')
    await this.ctx.sessionPersistence.flush()
    const listedAll = await this.ctx.sessionPersistence.list()
    const associated = this.managedBackupSessionIds()
    const masterEvidence = listedAll.some(snapshot => snapshot.header.id === this.masterId)
      || !!this.ctx.agents.get(this.masterId as SessionId) || !!this.store.get(KV.sessions.prompts(this.masterId))?.length
      || !!await this.ctx.sessionPersistence.stat(this.masterId as SessionId)
    const unusedMaster = !masterEvidence
    if (unusedMaster) associated.delete(this.masterId)
    const snapshots = listedAll.filter(snapshot => associated.has(snapshot.header.id))
    const nativeSessions: NativeSessionArchive[] = []
    for (const snapshot of snapshots) {
      const handle = await this.ctx.sessionPersistence.open(snapshot.header.id as SessionId, 'read')
      try {
        const body = await handle.read()
        nativeSessions.push({ id: snapshot.header.id, header: snapshot.header, inheritedEventCount: handle.inheritedEventCount ?? 0, events: body.events, revision: snapshot.revision })
      } finally {
        if (typeof handle.close === 'function') await handle.close()
        else await handle[Symbol.asyncDispose]?.()
      }
    }
    const workspaces = new Set<string>(), attachments = new Set<string>(), externalResources = new Set<string>()
    for (const project of this.store.projects.list()) {
      if (project.directory) workspaces.add(project.directory)
      // Only an explicit registered Resource grants backup authority. Draft plan text never does.
      for (const resource of this.projectCoordinator.resources.list(project.id)) if (!resource.revoked) externalResources.add(resource.path)
    }
    for (const ticket of this.store.tickets.list()) {
      if (ticket.execution?.directory) workspaces.add(ticket.execution.directory)
      if (ticket.projectId) for (const artifact of this.projectCoordinator.artifacts.list(ticket.projectId, ticket.id)) attachments.add(artifact.path)
    }
    for (const attempt of this.projectCoordinator.attempts.all()) {
      for (const path of [attempt.root, attempt.cwd]) workspaces.add(path)
    }
    for (const mapping of this.projectCoordinator.conversations.listMappings()) workspaces.add(mapping.cwd)
    for (const path of [...workspaces, ...attachments, ...externalResources]) if (!existsSync(path)) throw new Error(`Required recovery material is missing: ${path}`)
    const roots = { workspaces: [...workspaces], attachments: [...attachments], nativeState: [], externalResources: [...externalResources] }
    const capturedDb = this.recoveryDbToken()
    const capturedFiles = this.recoveryFilesToken([...roots.workspaces, ...roots.attachments, ...roots.externalResources])
    const capturedAttempts = JSON.stringify(this.projectCoordinator.attempts.all())
    const revisions = new Map(nativeSessions.map(session => [session.id, session.revision]))
    return {
      roots,
      nativeSessions,
      expectedNativeSessionIds: [...associated],
      relocations: [{ source: this.machine.stateDir, path: '.' }],
      consistency: 'declared-files-quiesced',
      verify: async () => {
        if (this.executor.activeCount() > 0) throw new Error('Application writer jobs started during recovery capture')
        if (this.recoveryDbToken() !== capturedDb) throw new Error('Database changed during recovery capture')
        if (JSON.stringify(this.projectCoordinator.attempts.all()) !== capturedAttempts) throw new Error('Managed worker changed during recovery capture')
        if (this.recoveryFilesToken([...roots.workspaces, ...roots.attachments, ...roots.externalResources]) !== capturedFiles) throw new Error('Recovery files changed during capture')
        const currentIds = this.managedBackupSessionIds()
        if (unusedMaster && !this.ctx.agents.get(this.masterId as SessionId) && !await this.ctx.sessionPersistence.stat(this.masterId as SessionId)) currentIds.delete(this.masterId)
        for (const id of currentIds) {
          const current = await this.ctx.sessionPersistence.stat(id as SessionId)
          if (!current || !revisions.has(id) || JSON.stringify(current.revision) !== JSON.stringify(revisions.get(id))) throw new Error(`Managed native session changed during recovery capture: ${id}`)
        }
        for (const id of revisions.keys()) if (!currentIds.has(id)) throw new Error(`Managed native session disappeared during recovery capture: ${id}`)
      }
    }
  }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    try {
      if (this.safeRestore) {
        this.runtimeHealth.set({ state: 'ready', detail: 'Offline read-only recovery profile; execution, model, and outbound sends are prohibited', at: now() })
        return
      }
      const configured = await this.setup.run(this.store.settings())
      if (this.closing()) return
      if (!configured) {
        this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
        return
      }
      this.sessions.install()
      this.executor.install()
      await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
      if (this.closing()) return
      for (const id of this.settings.syncable()) {
        await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
        if (this.closing()) return
      }
      this.projectCoordinator.setAccountProfile(this.setup.deployment.github
        ? { cli: this.setup.deployment.github.cli, login: this.setup.deployment.github.login, repository: this.setup.deployment.repository } : undefined)
      this.bindShellIdentity()
      this.projectCoordinator.start()
      this.executor.resume()
      this.passes.start()
      this.effects.start()
      this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    } catch (error) {
      // Stopping cancels setup rather than turning it into a resource failure or an unhandled ready rejection.
      if (!this.lifetime.aborted) throw error
    }
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, backup, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, backup, health, machine, masterId, ready, sourceLinks, safeRestore: this.safeRestore, projectCoordinator: this.projectCoordinator,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem ?? setup.githubProblem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, syncGitHubConsumers: () => { runtime.syncGitHubConsumers() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; this.scheduler.close(); const passes = this.passes.stop(); this.stopped.abort()
    let canRelease = false
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().filter(ticket => !ticket.projectId).map(ticket => workerSessionId(ticket.id)),
        ...this.projectCoordinator.attempts.all().map(attempt => attempt.sessionId), ...this.projectCoordinator.delegations.activeChildSessions()]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      // Startup may still be unwinding a cancelled probe or write; it must finish before environment restoration and DB/lock release.
      await Promise.allSettled([this.ready, passes, this.effects.drain(), this.projectCoordinator.stop()])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      // A timeout is an unknown boundary. Keep the sessions, executor and Store fenced and open until native work is known idle.
      const drained = await this.executor.shutdown()
      if (!drained) return
      this.budgetHooks?.sync(); this.budgetHooks?.dispose()
      this.executor.dispose()
      this.sessions.dispose()
      for (const consumer of this.githubConsumers.values()) consumer.controller.abort()
        this.githubConsumers.clear()
        for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
      canRelease = true
    } finally {
      this.setup.restore()
      if (!canRelease) return
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
