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
import { Engine, Projects, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { ProjectCoordinator } from './project-coordinator.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
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
  private closingFlag = false
  private stopping?: Promise<void>
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
      this.projectCoordinator = new ProjectCoordinator(ctx, store, this.projects, machine.stateDir, this.lifetime, prompts)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
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
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId, attempts,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => attempts.bySession(agent.id) ? projectWorkerTools(attempts, artifacts, reports, engine, agent.id) : ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      const databasePath = store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
      if (typeof databasePath !== 'string') throw new Error('Orchestrator database path is unavailable')
      this.backup = new BackupService({ store, databasePath, destinationRoot: join(machine.stateDir, 'backups'), recovery: {},
        recoveryRoots: () => {
           const projects = join(machine.stateDir, 'projects')
           const workspaces = store.tickets.list().flatMap(ticket => ticket.execution?.directory && existsSync(ticket.execution.directory) ? [ticket.execution.directory] : [])
           return { workspaces: [...new Set([projects, ...workspaces].filter(existsSync))], nativeState: [] }
         },
        prepareMaterials: () => this.backupMaterials(), applicationFull: true, health: board.claim('backup'), lifetime: this.lifetime })
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() }, backupChanged: value => { if (!this.safeRestore) this.backup.start(value) } })
      if (!this.safeRestore) this.backup.start(store.settings().backup)
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, attempts, masterId, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        checkpointFiles: ticket => ticket.projectId ? artifacts.list(ticket.projectId, ticket.id).filter(item => item.status === 'registered').map(item => item.path) : [],
        reportReady: (ticket, assignment, attempt) => reports.reports(ticket.id).some(report => report.attemptId === attempt.id && report.lease === attempt.lease && report.assignmentId === assignment.id && report.state === 'ready'),
        evidenceReady: (ticket, assignment, attempt) => {
          const related = reports.reports(ticket.id).filter(report => report.attemptId === attempt.id && report.lease === attempt.lease && report.assignmentId === assignment.id)
          if (related.some(report => report.artifacts.some(ref => { try { artifacts.read(attempt.projectId, ref.id, ref.contentVersion); return false } catch { return true } }))) return false
          return !artifacts.list(attempt.projectId, ticket.id).some(item => item.attemptId === attempt.id && item.lease === attempt.lease && item.status === 'writing')
        },
        outboundUnknown: ticket => store.db.prepare("SELECT 1 FROM outbox WHERE json_extract(value, '$.ticketId') = ? AND json_extract(value, '$.reconciliation.state') = 'unknown' LIMIT 1").get(ticket.id) !== undefined,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
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
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects, projectPass: () => executor.dispatchProjects(),
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get githubProblem() { return setup.githubProblem }, get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
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
  pump(): Promise<void> { return this.safeRestore ? Promise.resolve() : this.passes.pump() }
  sendReplies(): Promise<void> { return this.safeRestore ? Promise.resolve() : this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return this.safeRestore || !this.setup.configured() || this.store.settings().paused }
  private managedBackupSessionIds(): Set<string> {
    const ids = new Set<string>([this.masterId])
    for (const ticket of this.store.tickets.list()) if (!ticket.projectId) ids.add(workerSessionId(ticket.id))
    for (const attempt of this.projectCoordinator.attempts.all()) ids.add(attempt.sessionId)
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
    for (const project of this.store.projects.list()) if (project.directory) workspaces.add(project.directory)
    for (const ticket of this.store.tickets.list()) {
      if (ticket.execution?.directory) workspaces.add(ticket.execution.directory)
      // Plan resources are declarative data until a separate authorization/registration
      // contract grants backup authority; never read draft paths during capture.
      for (const revision of ticket.planRevisions ?? []) for (const resource of revision.resources) if (resource.startsWith('/')) externalResources.add(resource)
      if (ticket.projectId) for (const artifact of this.projectCoordinator.artifacts.list(ticket.projectId, ticket.id)) attachments.add(artifact.path)
    }
    for (const attempt of this.projectCoordinator.attempts.all()) {
      for (const path of [attempt.root, attempt.cwd]) workspaces.add(path)
    }
    for (const mapping of this.projectCoordinator.conversations.listMappings()) workspaces.add(mapping.cwd)
    for (const path of [...workspaces, ...attachments]) if (!existsSync(path)) throw new Error(`Required recovery material is missing: ${path}`)
    const roots = { workspaces: [...workspaces], attachments: [...attachments], nativeState: [], externalResources: [...externalResources] }
    const capturedDb = this.recoveryDbToken()
    const capturedFiles = this.recoveryFilesToken([...roots.workspaces, ...roots.attachments])
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
        if (this.recoveryFilesToken([...roots.workspaces, ...roots.attachments]) !== capturedFiles) throw new Error('Recovery files changed during capture')
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
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    let canRelease = false
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().filter(ticket => !ticket.projectId).map(ticket => workerSessionId(ticket.id)),
        ...this.projectCoordinator.attempts.all().map(attempt => attempt.sessionId)]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      // Startup may still be unwinding a cancelled probe or write; it must finish before environment restoration and DB/lock release.
      await Promise.allSettled([this.ready, passes, this.effects.drain(), this.projectCoordinator.stop()])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      // A timeout is an unknown boundary. Keep the sessions, executor and Store fenced and open until native work is known idle.
      const drained = await this.executor.shutdown()
      if (!drained) return
      this.executor.dispose()
      this.sessions.dispose()
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
