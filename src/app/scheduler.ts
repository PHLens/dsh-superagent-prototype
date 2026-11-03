/** Instance resource admission; existing durable input/execution facts reconstruct queues after recovery. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

export type BudgetKind = 'model' | 'worker' | 'background'
export interface BudgetLimits { model: number; worker: number; background: number; perProject?: Partial<Record<BudgetKind, number>> }
export interface BudgetRequest { id: string; projectId: string; kind: BudgetKind; ownerId?: string; signal?: AbortSignal; validate?: () => void }
export interface BudgetLease { readonly id: string; release(): void }
export interface SchedulerStatus {
  id: string; projectId: string; kind: BudgetKind; ownerId?: string; state: 'queued' | 'running'
  waitingReason?: 'global-budget' | 'project-fairness'
}
export interface SchedulerOptions {
  limits: () => BudgetLimits
  onChange?: (rows: readonly SchedulerStatus[]) => void
  cursor?: { read(kind: BudgetKind): string | undefined; write(kind: BudgetKind, projectId: string): void }
}
interface Entry { request: BudgetRequest; row: SchedulerStatus; lease: BudgetLease; resolve?: (lease: BudgetLease) => void; reject?: (error: unknown) => void; unlisten?: () => void }
const kinds: readonly BudgetKind[] = ['model', 'worker', 'background']
const aborted = () => new Error('Resource admission was cancelled')

/** Separate bounded pools avoid a worker holding the very slot its model call needs. */
export class ProjectScheduler {
  private readonly entries = new Map<string, Entry>()
  private readonly last = new Map<BudgetKind, string>()
  private pumping = false
  private closed?: Error
  constructor(private readonly options: SchedulerOptions) { this.limits() }
  private limits(): BudgetLimits {
    const limits = this.options.limits()
    for (const kind of kinds) for (const limit of [limits[kind], limits.perProject?.[kind] ?? limits[kind]]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Resource budgets must be positive integers')
    }
    return limits
  }
  private make(request: BudgetRequest, state: SchedulerStatus['state']): Entry {
    if (!request.id || !request.projectId || !kinds.includes(request.kind)) throw new Error('Resource identity required')
    const row: SchedulerStatus = { id: request.id, projectId: request.projectId, kind: request.kind, ...(request.ownerId ? { ownerId: request.ownerId } : {}), state }
    const entry: Entry = { request, row, lease: { id: request.id, release: () => {
      if (this.entries.get(request.id) !== entry) return
      entry.unlisten?.(); this.entries.delete(request.id); this.pump()
    } } }
    return entry
  }
  /** Recheck application authority when a queued request actually receives capacity. */
  acquire(request: BudgetRequest): Promise<BudgetLease> {
    if (this.closed) return Promise.reject(this.closed)
    if (this.entries.has(request.id)) return Promise.reject(new Error('Duplicate resource request'))
    if (request.signal?.aborted) return Promise.reject(request.signal.reason ?? aborted())
    let entry: Entry
    try { entry = this.make(request, 'queued') } catch (error) { return Promise.reject(error) }
    const promise = new Promise<BudgetLease>((resolve, reject) => { entry.resolve = resolve; entry.reject = reject })
    this.entries.set(request.id, entry)
    const cancel = () => { if (entry.row.state === 'queued') this.reject(entry, request.signal?.reason ?? aborted()) }
    request.signal?.addEventListener('abort', cancel, { once: true })
    entry.unlisten = () => request.signal?.removeEventListener('abort', cancel)
    this.pump()
    return promise
  }
  /** Account for an already observed live resource. This method never authorizes new execution. */
  adopt(request: BudgetRequest): BudgetLease {
    const old = this.entries.get(request.id)
    if (old) {
      if (old.row.state !== 'running' || old.row.projectId !== request.projectId || old.row.kind !== request.kind || old.row.ownerId !== request.ownerId) throw new Error('Observed resource identity conflict')
      return old.lease
    }
    const entry = this.make(request, 'running')
    this.entries.set(request.id, entry); this.notify(); return entry.lease
  }
  status(): SchedulerStatus[] { return [...this.entries.values()].map(entry => ({ ...entry.row })) }
  refresh(): void { this.pump() }
  cancelQueued(predicate: (row: SchedulerStatus) => boolean, reason = aborted()): void {
    for (const entry of [...this.entries.values()]) if (entry.row.state === 'queued' && predicate({ ...entry.row })) this.reject(entry, reason, false)
    this.pump()
  }
  /** Cancellation never certifies that an active stream/session/process has exited. */
  close(reason = new Error('Resource scheduler is closed')): void { this.closed = reason; this.cancelQueued(() => true, reason) }
  private reject(entry: Entry, reason: unknown, pump = true): void {
    if (this.entries.get(entry.row.id) !== entry) return
    entry.unlisten?.(); this.entries.delete(entry.row.id); entry.reject?.(reason)
    if (pump) this.pump()
  }
  private notify(): void { try { this.options.onChange?.(this.status()) } catch { /* Projections cannot lose capacity accounting. */ } }
  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      const limits = this.limits()
      for (const kind of kinds) while (!this.closed) {
        const active = [...this.entries.values()].filter(entry => entry.row.kind === kind && entry.row.state === 'running')
        const queued = [...this.entries.values()].filter(entry => entry.row.kind === kind && entry.row.state === 'queued')
        const counts = new Map<string, number>()
        for (const entry of active) counts.set(entry.row.projectId, (counts.get(entry.row.projectId) ?? 0) + 1)
        const cap = limits.perProject?.[kind] ?? limits[kind]
        for (const entry of queued) entry.row.waitingReason = (counts.get(entry.row.projectId) ?? 0) >= cap ? 'project-fairness' : 'global-budget'
        if (!queued.length || active.length >= limits[kind]) break
        const eligible = queued.filter(entry => (counts.get(entry.row.projectId) ?? 0) < cap)
        if (!eligible.length) break
        const projects = [...new Set(eligible.map(entry => entry.row.projectId))]
        const previous = this.last.get(kind) ?? this.options.cursor?.read(kind)
        const index = previous ? projects.indexOf(previous) : -1
        const selected = projects[(index + 1) % projects.length]!
        const entry = eligible.find(item => item.row.projectId === selected)!
        try {
          entry.request.signal?.throwIfAborted(); entry.request.validate?.()
          this.options.cursor?.write(kind, selected)
        } catch (error) { this.reject(entry, error, false); continue }
        entry.unlisten?.(); entry.row.state = 'running'; delete entry.row.waitingReason
        this.last.set(kind, selected); entry.resolve!(entry.lease)
      }
    } catch (error) {
      // Configuration/storage failures refuse queued work while preserving live occupancy.
      for (const entry of [...this.entries.values()]) if (entry.row.state === 'queued') this.reject(entry, error, false)
    } finally { this.pumping = false; this.notify() }
  }
}

export interface ManagedBudgetOwner { ownerId: string; projectId: string; validate(): void }
export interface ManagedBudgetHost {
  resolve(trustedSessionId: string): ManagedBudgetOwner | undefined
  owners(): readonly ManagedBudgetOwner[]
  onUncertain?(ownerId: string, jobId: string): void
}
interface BudgetJob { id: string; owner?: string; status: string }
interface JobFact { seq: number; type: string; data: { jobId?: string; toolCall?: { callId: string }; producerReported?: boolean } }
interface JobSession { snapshotEvents(): readonly JobFact[] }
interface JobRegistry {
  list(ownerId: string): readonly BudgetJob[]
  events: { subscribe(filter: { owner: string }, listener: (event: { type: string; job?: BudgetJob }) => void): () => void }
}
interface HookContext {
  on(name: string, listener: (...args: any[]) => any): () => void
  agents: { currentInitiator(): { id: string } | undefined; get(id: string): { session: JobSession } | undefined }
  jobs?: JobRegistry
}
interface ShellReservation { owner: ManagedBudgetOwner; callId?: string; lease: BudgetLease; bodyDone: boolean; jobs: Set<string> }
const liveJob = (job: BudgetJob) => ['running', 'stopping'].includes(job.status)

/** Public native hooks scoped by server-resolved owner identity, without replacing host services. */
export class ManagedBudgetHooks {
  private readonly ctx: HookContext
  private readonly releases: (() => void)[] = []
  private readonly watched = new Map<string, { owner: ManagedBudgetOwner; dispose: () => void }>()
  private readonly shells = new Map<string, ShellReservation>()
  private readonly uncertain = new Map<string, string>()
  private readonly jobCalls = new Map<string, string>()
  private readonly acknowledged = new Map<string, string>()
  private readonly sessions = new Map<string, JobSession>()
  private readonly jobSessions = new Map<string, { ownerId: string; session: JobSession }>()
  private readonly factCursor = new WeakMap<JobSession, number>()
  private installed = false
  constructor(ctx: Context, private readonly scheduler: ProjectScheduler, private readonly host: ManagedBudgetHost) { this.ctx = ctx as unknown as HookContext }
  install(): void {
    if (this.installed) return
    if (typeof this.ctx.agents.currentInitiator !== 'function') throw new Error('Managed model budgeting requires native initiator attribution')
    this.installed = true
    this.releases.push(this.ctx.on('llm/stream', (options: { signal?: AbortSignal }, next: () => AsyncIterable<unknown>) => {
      // The native waterfall is lazy; capture attribution now, inside the actual driver boundary.
      const id = this.ctx.agents.currentInitiator()?.id, owner = id && this.host.resolve(id)
      if (!owner) return next()
      this.watch(owner)
      const scheduler = this.scheduler
      return (async function* () {
        const lease = await scheduler.acquire({ id: `model:${owner.ownerId}:${randomUUID()}`, kind: 'model', ownerId: owner.ownerId, projectId: owner.projectId, signal: options.signal, validate: () => owner.validate() })
        try {
          options.signal?.throwIfAborted(); owner.validate()
          for await (const chunk of next()) { options.signal?.throwIfAborted(); yield chunk }
        } finally { lease.release() }
      })()
    }))
    this.releases.push(this.ctx.on('tools/execute', async (exec: { name: string; callId: string; agent?: { id: string }; signal: AbortSignal }, next: () => Promise<unknown>) => {
      if (!['bash', 'pwsh'].includes(exec.name) || !exec.agent) return next()
      const owner = this.host.resolve(exec.agent.id)
      if (!owner) return next()
      this.watch(owner); this.syncOwner(owner)
      const id = `shell:${owner.ownerId}:${exec.callId}`
      const lease = await this.scheduler.acquire({ id, projectId: owner.projectId, ownerId: owner.ownerId, kind: 'background', signal: exec.signal, validate: () => owner.validate() })
      const reservation: ShellReservation = { owner, callId: exec.callId, lease, bodyDone: false, jobs: new Set() }
      this.shells.set(id, reservation)
      try { exec.signal.throwIfAborted(); owner.validate(); return await next() }
      finally { reservation.bodyDone = true; this.syncOwner(owner) }
    }))
    this.sync()
  }
  /** Include historical attempt owners still physically alive before starting more work. */
  sync(): void {
    const owners = this.host.owners(), ids = new Set(owners.map(owner => owner.ownerId))
    for (const owner of owners) { this.watch(owner); this.syncOwner(owner) }
    for (const [id, watcher] of this.watched) if (!ids.has(id) && ![...this.shells.values()].some(row => row.owner.ownerId === id)) {
      watcher.dispose(); this.watched.delete(id); this.sessions.delete(id)
      for (const [jobId, ownerId] of this.acknowledged) if (ownerId === id) this.acknowledged.delete(jobId)
    }
  }
  private watch(owner: ManagedBudgetOwner): void {
    if (this.watched.has(owner.ownerId) || !this.ctx.jobs) return
    const dispose = this.ctx.jobs.events.subscribe({ owner: owner.ownerId }, event => {
      // Native owner subscriptions include unowned events; those never acquire this project's identity.
      if (event.job?.owner !== owner.ownerId) return
      this.syncOwner(owner)
    })
    this.watched.set(owner.ownerId, { owner, dispose })
  }
  private syncOwner(owner: ManagedBudgetOwner): void {
    if (!this.ctx.jobs) {
      for (const [id, row] of this.shells) if (row.owner.ownerId === owner.ownerId && row.bodyDone) { this.shells.delete(id); row.lease.release() }
      return
    }
    // A read failure propagates and preserves reservations: unknown is not an exit.
    const jobs = this.ctx.jobs.list(owner.ownerId).filter(job => job.owner === owner.ownerId)
    for (const [jobId, ownerId] of this.acknowledged) if (ownerId === owner.ownerId && !jobs.some(job => job.id === jobId)) this.acknowledged.delete(jobId)
    const tracked = new Set([...this.shells.values()].filter(row => row.owner.ownerId === owner.ownerId).flatMap(row => [...row.jobs]))
    const relevant = new Set([...jobs.filter(job => liveJob(job) || job.status === 'failed').map(job => job.id), ...tracked])
    // JobView omits invocation identity and producer acknowledgement. The original
    // Session can receive a settlement even after its Agent leaves the live registry.
    const loaded = this.ctx.agents.get(owner.ownerId)?.session
    if (loaded) this.sessions.set(owner.ownerId, loaded)
    const current = this.sessions.get(owner.ownerId)
    const readers = new Set([...(current ? [current] : []), ...[...this.jobSessions.values()].filter(row => row.ownerId === owner.ownerId).map(row => row.session)])
    for (const session of readers) {
      const cursor = this.factCursor.get(session) ?? -1
      for (const event of session.snapshotEvents()) {
        if (event.seq <= cursor) continue
        this.factCursor.set(session, event.seq)
        const data = event.data
        if (!data?.jobId || !relevant.has(data.jobId)) continue
        if (event.type === 'job/registered') {
          if (data.toolCall) this.jobCalls.set(data.jobId, data.toolCall.callId)
          if (!this.jobSessions.has(data.jobId)) this.jobSessions.set(data.jobId, { ownerId: owner.ownerId, session })
        }
        if (event.type === 'job/settled' && data.producerReported === true) { this.acknowledged.set(data.jobId, owner.ownerId); this.uncertain.delete(data.jobId) }
        if (event.type === 'job/settled' && data.producerReported === false && !this.acknowledged.has(data.jobId)) {
          this.uncertain.set(data.jobId, owner.ownerId)
          try { this.host.onUncertain?.(owner.ownerId, data.jobId) } catch { /* Unknown occupancy stays reserved. */ }
        }
      }
    }
    for (const job of jobs) if (!liveJob(job) && (tracked.has(job.id) || job.status === 'failed') && !this.acknowledged.has(job.id)) {
      if (!this.uncertain.has(job.id)) {
        this.uncertain.set(job.id, owner.ownerId)
        try { this.host.onUncertain?.(owner.ownerId, job.id) } catch { /* Unknown occupancy stays reserved. */ }
      }
    }
    const occupied = jobs.filter(job => liveJob(job) || this.uncertain.has(job.id))
    for (const [jobId, ownerId] of this.uncertain) if (ownerId === owner.ownerId && !occupied.some(job => job.id === jobId)) occupied.push({ id: jobId, owner: ownerId, status: 'unknown' })
    for (const job of occupied) {
      let reservation = [...this.shells.values()].find(row => row.owner.ownerId === owner.ownerId && (row.jobs.has(job.id) || row.callId !== undefined && row.callId === this.jobCalls.get(job.id)))
      if (!reservation) {
        const id = `background-job:${owner.ownerId}:${job.id}`
        reservation = { owner, lease: this.scheduler.adopt({ id, ownerId: owner.ownerId, projectId: owner.projectId, kind: 'background' }), bodyDone: true, jobs: new Set() }
        this.shells.set(id, reservation)
      }
      reservation.jobs.add(job.id)
    }
    for (const [id, row] of [...this.shells]) {
      if (row.owner.ownerId !== owner.ownerId || !row.bodyDone) continue
      const stillLive = [...row.jobs].some(jobId => this.uncertain.has(jobId) || occupied.some(job => job.id === jobId))
      if (!stillLive) {
        for (const jobId of row.jobs) { this.jobCalls.delete(jobId); this.jobSessions.delete(jobId); if (jobs.find(job => job.id === jobId)?.status !== 'failed') this.acknowledged.delete(jobId) }
        this.shells.delete(id); row.lease.release()
      }
    }
    const held = new Set([...this.shells.values()].filter(row => row.owner.ownerId === owner.ownerId).flatMap(row => [...row.jobs]))
    for (const [jobId, row] of this.jobSessions) if (row.ownerId === owner.ownerId && !held.has(jobId) && !jobs.some(job => job.id === jobId && liveJob(job))) { this.jobSessions.delete(jobId); this.jobCalls.delete(jobId) }
  }
  /** The caller must independently certify physical exit, beyond a registry-forced failure record. */
  confirmOwnerExit(ownerId: string): void {
    for (const [id, row] of [...this.shells]) if (row.owner.ownerId === ownerId) {
      if (!row.bodyDone) throw new Error('Shell body has not settled')
      const jobs = this.ctx.jobs?.list(ownerId).filter(job => job.owner === ownerId && liveJob(job)) ?? []
      if (jobs.length) throw new Error('Owned jobs have not exited')
      for (const jobId of row.jobs) { this.uncertain.delete(jobId); this.jobCalls.delete(jobId); this.jobSessions.delete(jobId); this.acknowledged.set(jobId, ownerId) }
      this.shells.delete(id); row.lease.release()
    }
  }
  dispose(): void {
    for (const release of this.releases.splice(0)) release()
    for (const { dispose } of this.watched.values()) dispose()
    this.watched.clear(); this.installed = false
    // Disposing observers does not certify resource exit or release their active leases.
  }
}
