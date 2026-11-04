/** Durable native validation ownership. Registry status alone never proves physical exit. */
import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectScheduler, BudgetLease } from './scheduler.ts'
import type { ExecutionIdentity } from './execution-environment.ts'
import type { Store } from './store.ts'
import type { NativeValidationRunner } from './code-validation.ts'

/** Public rc.5 registry surface; the native service remains the execution owner. */
export interface ValidationNativeJobs {
  start(spec: { kind: 'bash'; label: string; owner: SessionId; toolCall: { callId: string; rootCallId: string }; run(native: { id: string }): { done: Promise<Outcome>; cancel(reason?: string): void } }): string
  wait(id: any, timeoutMs: number, owner?: SessionId, signal?: AbortSignal): Promise<{ owner?: string; status: string }>
  kill(id: any, owner?: SessionId, reason?: string): unknown
}
type NativeJobs = ValidationNativeJobs
type JobId = string
type Outcome = { status: 'completed' | 'killed' | 'failed'; detail: string }
export interface ValidationProcessResult {
  status: 'passed' | 'failed' | 'aborted' | 'unknown'
  exitCode?: number; signal?: string; stdout: string; stderr: string; error?: string
  /** Only the trusted producer sets this after observing its whole managed range empty. */
  physicalExit?: true
}
export interface ValidationJobOwner {
  readonly projectId: string; readonly ownerId: string
  readonly attemptId?: string; readonly lease?: string
  validate(): void
}
export interface ValidationJobRecord {
  version: 1; id: string; requestHash: string; projectId: string; ownerId: string
  attemptId: string; lease: string; cwd: string
  phase: 'queued' | 'running' | 'stopping' | 'unknown' | 'exited'
  physicalExit: boolean; nativeJobId?: JobId; createdAt: string; updatedAt: string
  result?: ValidationProcessResult; error?: string
}
const NOT_STARTED = 'Restart before native registration; no producer started'
export interface ValidationJobPersistence { list(): ValidationJobRecord[]; save(record: ValidationJobRecord): void; /** Removes a journal entry whose producer was never registered; optional for old fixtures. */ remove?(id: string): void }
/** Uses the application KV transaction and its existing consistent backup. */
export function validationJobPersistence(store: Pick<Store, 'atomic' | 'get' | 'set'>): ValidationJobPersistence {
  const key = 't7.native-validation-jobs'
  return {
    list: () => structuredClone(store.get<ValidationJobRecord[]>(key) ?? []),
    save: record => store.atomic(() => {
      const rows = store.get<ValidationJobRecord[]>(key) ?? [], index = rows.findIndex(item => item.id === record.id)
      if (index < 0) rows.push(structuredClone(record)); else rows[index] = structuredClone(record)
      store.set(key, rows)
    }),
  }
}
export interface ValidationJobOptions {
  persistence: ValidationJobPersistence; jobs: NativeJobs
  /** Trusted host inspection of this exact producer. Idle/missing/terminal job views are insufficient. */
  inspectExit(record: Readonly<ValidationJobRecord>, signal: AbortSignal): Promise<boolean>
  maxRunMs?: number; exitWaitMs?: number; now?: () => string
}
interface Live { ownerId: string; nativeJobId: JobId; controller: AbortController; cancel(): void; settle(outcome: Outcome): void; settled: boolean; cleanup(): void }
const unknown = (error: unknown): ValidationProcessResult => ({ status: 'unknown', stdout: '', stderr: '', error: String(error).slice(0, 4000) })
const outcome = (result: ValidationProcessResult): Outcome => ({
  status: result.status === 'aborted' ? 'killed' : result.status === 'passed' ? 'completed' : 'failed',
  detail: result.error ?? (result.exitCode === undefined ? result.status : 'exit code: ' + result.exitCode),
})
const bounded = (result: ValidationProcessResult): ValidationProcessResult => ({
  status: result.status, stdout: result.stdout.slice(0, 80_000), stderr: result.stderr.slice(0, 20_000),
  ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
  ...(result.signal === undefined ? {} : { signal: result.signal }),
  ...(result.error === undefined ? {} : { error: result.error.slice(0, 4000) }),
  ...(result.physicalExit === true ? { physicalExit: true as const } : {}),
})

/** Reserves before registration and reconstructs uncertain occupancy without rerunning any producer. */
export class NativeValidationJobAdapter {
  private readonly held = new Map<string, BudgetLease>()
  private readonly live = new Map<string, Live>()
  private readonly active = new Map<string, Promise<ValidationProcessResult>>()
  private readonly controllers = new Map<string, { ownerId: string; controller: AbortController }>()
  private readonly now: () => string
  private readonly maxRunMs: number
  private readonly exitWaitMs: number
  constructor(private readonly scheduler: ProjectScheduler, private readonly runner: NativeValidationRunner, private readonly options?: ValidationJobOptions) {
    this.now = options?.now ?? (() => new Date().toISOString())
    this.maxRunMs = options?.maxRunMs ?? 300_000; this.exitWaitMs = options?.exitWaitMs ?? 2_000
    for (const ms of [this.maxRunMs, this.exitWaitMs]) if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647) throw new Error('Invalid validation deadline')
    for (const old of options?.persistence.list() ?? []) {
      if (old.phase === 'exited') continue
      if (old.phase === 'queued' && !old.nativeJobId) {
        this.save({ ...old, phase: 'exited', physicalExit: true, updatedAt: this.now(),
          result: { status: 'aborted', stdout: '', stderr: '', physicalExit: true, error: NOT_STARTED } })
      } else {
        const record = { ...old, phase: 'unknown' as const, updatedAt: this.now(), error: 'Recovered validation requires physical exit inspection' }
        this.save(record)
        this.held.set(record.id, scheduler.adopt({ id: this.reservation(record), projectId: record.projectId, ownerId: record.ownerId, kind: 'background' }))
      }
    }
  }
  private services(): ValidationJobOptions {
    if (!this.options) throw new Error('Durable native validation job services are unavailable')
    return this.options
  }
  private save(record: ValidationJobRecord): void { this.services().persistence.save(structuredClone(record)) }
  private get(id: string): ValidationJobRecord | undefined { return this.services().persistence.list().find(row => row.id === id) }
  private reservation(record: ValidationJobRecord): string {
    return record.nativeJobId ? 'background-job:' + record.ownerId + ':' + record.nativeJobId : 'validation-queued:' + record.id
  }
  records(): ValidationJobRecord[] { return structuredClone(this.services().persistence.list()) }
  /** Drops only the restart-before-registration tombstone: no producer existed, so no outcome is lost. */
  forgetNotStarted(id: string): boolean {
    const row = this.get(id)
    if (!row || row.phase !== 'exited' || row.physicalExit !== true || row.result?.status !== 'aborted' || row.result.error !== NOT_STARTED) return false
    // The tombstone itself proves no producer existed. Removing it is tidy, but a caller's older
    // persistence without remove can still retry because run() treats this exact tombstone as unwritten.
    try { this.services().persistence.remove?.(id) } catch { /* the in-memory scheduler record is still authoritative */ }
    return true
  }
  ownerExitKnown(ownerId: string): boolean { return this.records().filter(row => row.ownerId === ownerId).every(row => row.phase === 'exited' && row.physicalExit) }
  private release(id: string): void { this.held.get(id)?.release(); this.held.delete(id); this.controllers.delete(id) }
  private uncertain(id: string, error: unknown): ValidationProcessResult {
    const result = unknown(error), current = this.get(id)
    if (current && current.phase !== 'exited') this.save({ ...current, phase: 'unknown', updatedAt: this.now(), error: result.error, result })
    return result
  }
  run(owner: ValidationJobOwner, id: string, argv: readonly string[], cwd: string, identity: ExecutionIdentity, signal: AbortSignal): Promise<ValidationProcessResult> {
    try {
      this.services(); owner.validate(); signal.throwIfAborted()
      if (!id || !owner.attemptId || !owner.lease || owner.attemptId !== identity.executionId || owner.projectId !== identity.projectId || !argv.length)
        throw new Error('Server-owned validation attempt, lease and identity are required')
      const requestHash = createHash('sha256').update(JSON.stringify([owner.projectId, owner.ownerId, owner.attemptId, owner.lease, argv, cwd, identity])).digest('hex')
      const old = this.get(id)
      if (old && old.requestHash !== requestHash) throw new Error('Validation operation identity conflict')
      const active = this.active.get(id); if (active) return active
      const notStarted = !!old && old.phase === 'exited' && old.physicalExit === true && old.result?.status === 'aborted' && old.result.error === NOT_STARTED
      if (old && !notStarted) return Promise.resolve(old.phase === 'exited' && old.physicalExit && old.result ? structuredClone(old.result) : unknown('Validation requires reconciliation; producer will not rerun'))
      const record: ValidationJobRecord = { version: 1, id, requestHash, projectId: owner.projectId, ownerId: owner.ownerId,
        attemptId: owner.attemptId, lease: owner.lease, cwd, phase: 'queued', physicalExit: false, createdAt: this.now(), updatedAt: this.now() }
      this.save(record)
      const pending = this.start(owner, record, [...argv], cwd, structuredClone(identity), signal)
      this.active.set(id, pending)
      void pending.finally(() => { if (this.active.get(id) === pending) this.active.delete(id) }).catch(() => {})
      return pending
    } catch (error) { return Promise.reject(error) }
  }
  private async start(owner: ValidationJobOwner, record: ValidationJobRecord, argv: string[], cwd: string, identity: ExecutionIdentity, callerSignal: AbortSignal): Promise<ValidationProcessResult> {
    const controller = new AbortController()
    this.controllers.set(record.id, { ownerId: owner.ownerId, controller })
    const signal = AbortSignal.any([callerSignal, controller.signal])
    let lease: BudgetLease
    try { lease = await this.scheduler.acquire({ id: this.reservation(record), projectId: owner.projectId, ownerId: owner.ownerId, kind: 'background', signal, validate: () => owner.validate() }) }
    catch (error) { this.notStarted(record, error); throw error }
    this.held.set(record.id, lease)
    try {
      owner.validate(); signal.throwIfAborted()
      if (this.get(record.id)?.phase !== 'queued') throw new Error('Validation admission is no longer queued')
    } catch (error) { this.notStarted(record, error); throw error }
    let notify!: (result: ValidationProcessResult) => void
    const response = new Promise<ValidationProcessResult>(resolve => { notify = resolve })
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopping = false
    const unlisten = () => { signal.removeEventListener('abort', stop); if (timer) clearTimeout(timer) }
    const stop = () => {
      if (stopping) return
      stopping = true
      // Physical cancellation must still happen if durable storage is temporarily unavailable.
      controller.abort(new Error('Validation cancellation requested'))
      try {
        const current = this.get(record.id)
        if (current && current.phase !== 'exited') this.save({ ...current, phase: 'stopping', updatedAt: this.now() })
      } catch { /* Keep native ownership and the scheduler lease until a later trustworthy inspection. */ }
      notify(unknown('Cancellation requested; waiting for physical exit'))
    }
    try {
      const nativeId = this.services().jobs.start({
        kind: 'bash', label: 'Project code validation ' + record.attemptId, owner: SessionId(owner.ownerId),
        toolCall: { callId: record.id, rootCallId: record.id },
        run: native => {
          const registered = { ...record, nativeJobId: native.id, phase: 'running' as const, updatedAt: this.now() }
          this.save(registered)
          // This exact id is also used by ManagedBudgetHooks, preventing double accounting.
          const nativeLease = this.scheduler.adopt({ id: this.reservation(registered), projectId: owner.projectId, ownerId: owner.ownerId, kind: 'background' })
          this.held.set(record.id, nativeLease); lease.release()
          let settle!: (result: Outcome) => void
          const done = new Promise<Outcome>(resolve => { settle = resolve })
          this.live.set(record.id, { ownerId: owner.ownerId, nativeJobId: native.id, controller, cancel: stop, settle, settled: false, cleanup: unlisten })
          // JobRegistry preflights/commits first. No native registration => no process.
          queueMicrotask(() => { void this.produce(owner, registered, argv, cwd, identity, controller.signal, notify, unlisten).catch(error => {
            try { notify(this.uncertain(record.id, error)) } catch { notify(unknown(error)) }
          }) })
          return { done, cancel: stop }
        },
      })
      if (this.get(record.id)?.nativeJobId !== nativeId) throw new Error('Native validation registration mismatch')
      signal.addEventListener('abort', stop, { once: true })
      timer = setTimeout(stop, this.maxRunMs); timer.unref?.()
      if (signal.aborted) stop()
    } catch (error) {
      unlisten()
      if (!this.live.has(record.id)) this.notStarted(record, error)
      throw error
    }
    return response
  }
  private notStarted(record: ValidationJobRecord, error: unknown): void {
    this.save({ ...record, phase: 'exited', physicalExit: true, updatedAt: this.now(),
      result: { status: 'aborted', stdout: '', stderr: '', physicalExit: true, error: String(error).slice(0, 4000) } })
    this.release(record.id)
  }
  private async produce(owner: ValidationJobOwner, record: ValidationJobRecord, argv: string[], cwd: string, identity: ExecutionIdentity,
    signal: AbortSignal, notify: (result: ValidationProcessResult) => void, unlisten: () => void): Promise<void> {
    let invoked = false
    try {
      let result: ValidationProcessResult
      try {
        owner.validate(); signal.throwIfAborted(); invoked = true
        result = bounded(await this.runner.run(argv, cwd, identity, signal, record.id) as ValidationProcessResult)
      } catch (error) { result = invoked ? unknown(error) : { status: 'aborted', stdout: '', stderr: '', physicalExit: true, error: String(error) } }
      if (result.physicalExit !== true) { notify(this.uncertain(record.id, result.error ?? 'Producer has not certified physical range exit')); return }
      if (signal.aborted) result = { ...result, status: 'aborted', error: 'Validation cancelled' }
      try { owner.validate() } catch (error) { result = { ...result, status: 'aborted', error: String(error) } }
      if (result.status === 'passed' && (result.exitCode !== 0 || result.signal !== undefined)) result = { ...result, status: 'failed', error: 'Producer lacks successful exit facts' }
      this.save({ ...this.get(record.id)!, physicalExit: true, result, updatedAt: this.now() })
      const live = this.live.get(record.id)!
      live.settled = true; live.settle(outcome(result))
      const view = await this.services().jobs.wait(record.nativeJobId!, this.exitWaitMs, SessionId(record.ownerId))
      if (view.owner !== record.ownerId || ['running', 'stopping'].includes(view.status)) { notify(this.uncertain(record.id, 'Native settlement not acknowledged')); return }
      this.save({ ...this.get(record.id)!, phase: 'exited', physicalExit: true, result, updatedAt: this.now() })
      this.release(record.id); this.live.delete(record.id); notify(result)
    } finally { if (this.get(record.id)?.physicalExit) unlisten() }
  }
  /** Trusted pause/stop control. A cancellation request never releases occupancy. */
  stopOwner(ownerId: string, reason = 'Project paused or stopped'): void {
    // Cancellation has trusted in-memory ownership even if the journal cannot currently be read.
    for (const live of this.live.values()) if (live.ownerId === ownerId && !live.settled) {
      try { this.services().jobs.kill(live.nativeJobId, SessionId(ownerId), reason) } catch { live.cancel() }
    }
    for (const [id, pending] of this.controllers) if (pending.ownerId === ownerId && !this.live.has(id)) pending.controller.abort(new Error(reason))
    let rows: ValidationJobRecord[]
    try { rows = this.records() } catch { return }
    for (const row of rows.filter(item => item.ownerId === ownerId && item.phase !== 'exited' && !this.live.has(item.id))) {
      try { this.save({ ...row, phase: 'stopping', updatedAt: this.now(), error: reason }) }
      catch { /* Request native cancellation even when its journal cannot currently be updated. */ }
      if (row.nativeJobId) {
        try { this.services().jobs.kill(row.nativeJobId, SessionId(ownerId), reason) }
        catch (error) { this.live.get(row.id)?.controller.abort(new Error(reason)); this.uncertain(row.id, error) }
      } else this.controllers.get(row.id)?.controller.abort(new Error(reason))
    }
  }
  /** No caller-supplied proof: the registered host observer must verify the same whole process range. */
  async reconcile(id: string, signal = new AbortController().signal): Promise<boolean> {
    const options = this.services(), row = this.get(id)
    if (!row) throw new Error('Unknown validation job')
    if (row.phase === 'exited' && row.physicalExit) return true
    signal.throwIfAborted()
    if (row.phase === 'queued' && this.controllers.has(id)) {
      // Retire the scheduler request itself; recording a no-process observation cannot leave an admission alive.
      this.controllers.get(id)!.controller.abort(new Error('Queued validation reconciled before registration'))
      await this.active.get(id)?.catch(() => {})
      signal.throwIfAborted()
      const cancelled = this.get(id)
      return cancelled?.phase === 'exited' && cancelled.physicalExit
    }
    let exited: boolean
    try { exited = row.physicalExit || await options.inspectExit(Object.freeze(structuredClone(row)), signal) } catch { return false }
    signal.throwIfAborted()
    if (!exited) return false
    const current = this.get(id)
    if (!current || current.requestHash !== row.requestHash || current.lease !== row.lease || current.nativeJobId !== row.nativeJobId) return false
    if (current.phase === 'exited' && current.physicalExit) return true
    const result: ValidationProcessResult = { status: 'aborted', stdout: '', stderr: '', physicalExit: true, error: 'Reconciled physical exit; no success claim' }
    const live = this.live.get(id)
    if (live && !live.settled) { live.settled = true; live.settle(outcome(result)) }
    if (row.nativeJobId) {
      try {
        const view = await options.jobs.wait(row.nativeJobId, this.exitWaitMs, SessionId(row.ownerId), signal)
        if (view.owner !== row.ownerId || ['running', 'stopping'].includes(view.status)) return false
      } catch { /* The host verified range exit even if this process-local registry no longer retains the job. */ }
    }
    signal.throwIfAborted()
    const latest = this.get(id)
    if (!latest || latest.requestHash !== row.requestHash || latest.lease !== row.lease || latest.nativeJobId !== row.nativeJobId) return false
    if (latest.phase === 'exited' && latest.physicalExit) return true
    this.save({ ...latest, phase: 'exited', physicalExit: true, result, updatedAt: this.now() })
    live?.cleanup(); this.release(id); this.live.delete(id); return true
  }
}
