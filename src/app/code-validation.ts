/** Server-owned structured code validation receipts bound to an Assignment attempt and lease. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { managedDirectory } from './execution-attempts.ts'
import type { Commands } from '../infra/commands.ts'
import type { CodeCheck, CodeCheckBinding } from '../core/model.ts'
import type { Store } from './store.ts'
import type { ExecutionAttempts } from './execution-attempts.ts'
import type { ExecutionIdentity } from './execution-environment.ts'
import { NativeValidationJobAdapter, type ValidationProcessResult, type ValidationJobOptions, type ValidationNativeJobs } from './native-validation-job.ts'
import type { ProjectScheduler } from './scheduler.ts'
import type { ProjectResources } from './project-resources.ts'
import type { Attempt } from './execution-attempts.ts'
export interface NativeValidationRunner { run(argv: readonly string[], cwd: string, identity: ExecutionIdentity, signal: AbortSignal, operationId?: string): Promise<ValidationProcessResult> }
export interface CodeValidationReceipt {
  id: string; operationId: string; attemptId: string; lease: string
  profile: string
  /** The reviewed check identity, kept for display; it never resolves the executable. */
  command: string; args: readonly string[]
  /** The command line actually executed, with the staged trees resolved. */
  argv?: readonly string[]
  sourceResourceId?: string; configResourceId?: string; runtimeResourceId?: string; runtimeVersion?: string
  sourceVersion: string; configVersion: string
  status: 'running' | 'passed' | 'failed' | 'aborted' | 'unknown'
  exitCode?: number; signal?: string; outputHash?: string; output?: string; error?: string; createdAt: string
}
export const codeValidationOperation = (attemptId: string, planVersion: number): string => `code:${attemptId}:${planVersion}`
// The worker submits the reviewed logical check; resource ids are the server's own binding, so they
// are compared against that binding rather than demanded back from the contract.
const payload = (check: CodeCheck) => JSON.stringify([check.command, check.args, check.profile, check.sourceVersion, check.configVersion, check.runtimeVersion])
/** Executes and records one server-resolved code check for an owned attempt. */
export class CodeValidation {
  private nativeJobs?: NativeValidationJobAdapter
  constructor(private readonly store: Store, private readonly attempts: ExecutionAttempts, private readonly runner?: NativeValidationRunner, private readonly now = () => new Date().toISOString(), private readonly authorize?: (sessionId: string) => void, private readonly resources?: ProjectResources) {}
  setScheduler(scheduler: ProjectScheduler, options: Omit<ValidationJobOptions, 'persistence' | 'jobs'> & { persistence: ValidationJobOptions['persistence']; jobs: ValidationNativeJobs }): void {
    if (!this.runner) throw new Error('Native owned code validation runner is unavailable')
    this.nativeJobs = new NativeValidationJobAdapter(scheduler, this.runner, options)
    // Reopen/startup runs before any worker may retry or resume. A receipt with no durable native
    // record at the same operation id can only be a process-death orphan: no producer start was
    // recorded, so clearing it is a known-not-started result rather than a guessed outcome.
    this.recoverOrphans()
  }
  /**
   * Clears only reservations that have no corresponding native job record. Any native record (even
   * queued/unknown) is evidence that reconciliation, not silent deletion, owns the outcome.
   */
  recoverOrphans(): number {
    if (!this.nativeJobs) return 0
    const native = new Map(this.nativeJobs.records().map(record => [record.id, record]))
    const rows = this.store.db.prepare("SELECT attempt_id, operation_id FROM code_validation WHERE json_extract(value, '$.status') = 'running'").all() as { attempt_id: string; operation_id: string }[]
    let cleared = 0
    for (const row of rows) {
      const record = native.get(row.operation_id)
      // A real native record owns reconciliation, except the adapter's restart-before-registration
      // tombstone: its producer never existed, so both its journal entry and the reservation are
      // safely retired to let the same operation start for the first time.
      if (record && !(record.phase === 'exited' && this.nativeJobs.forgetNotStarted(record.id))) continue
      const attempt = this.attempts.all().find(item => item.id === row.attempt_id)
      if (attempt) try { this.discardStaging(attempt) } catch { /* the reservation is still safe to clear */ }
      const result = this.store.db.prepare("DELETE FROM code_validation WHERE attempt_id=? AND operation_id=? AND json_extract(value, '$.status') = 'running'").run(row.attempt_id, row.operation_id)
      cleared += Number(result.changes)
    }
    return cleared
  }
  stopOwner(ownerId: string, reason?: string): void { this.nativeJobs?.stopOwner(ownerId, reason) }
  ownerExitKnown(ownerId: string): boolean { return this.nativeJobs ? this.nativeJobs.ownerExitKnown(ownerId) : true }
  async reconcileOwner(ownerId: string, signal?: AbortSignal): Promise<void> {
    if (!this.nativeJobs) return
    this.recoverOrphans()
    for (const record of this.nativeJobs.records().filter(row => row.ownerId === ownerId && row.phase !== 'exited')) {
      await this.nativeJobs.reconcile(record.id, signal)
    }
  }
  async reconcile(operationId: string, signal?: AbortSignal): Promise<boolean> { return this.nativeJobs ? await this.nativeJobs.reconcile(operationId, signal) : false }
  get(attemptId: string, operationId: string): CodeValidationReceipt | undefined { const row = this.store.db.prepare('SELECT value FROM code_validation WHERE attempt_id=? AND operation_id=?').get(attemptId, operationId) as { value?: string } | undefined; return row?.value ? JSON.parse(row.value) as CodeValidationReceipt : undefined }
  /** Re-reads the pinned material and interpreter before every use; any drift is a real change. */
  private assertBindingCurrent(attempt: { projectId: string; id: string; lease: string }, binding: CodeCheckBinding): void {
    if (!this.resources) throw new Error('Trusted code-check resource materializer is unavailable')
    const source = this.resources.assertCurrent(attempt.projectId, binding.sourceResourceId)
    const config = this.resources.assertCurrent(attempt.projectId, binding.configResourceId)
    if (source.version !== binding.sourceVersion || config.version !== binding.configVersion) throw new Error('Validation input binding changed')
    // An interpreter replaced after admission must not keep running or passing.
    // Every executable profile is pinned to one registered interpreter; an attempt without that
    // pin cannot start, and a revoked or replaced interpreter fails before that attempt starts too.
    if (!binding.runtimeResourceId) throw new Error('Code check binding has no registered interpreter')
    if (this.resources.executable(attempt.projectId, binding.runtimeResourceId).version !== binding.runtimeVersion) throw new Error('Validation runtime binding changed')
  }
  /**
   * Staging is app-owned and deterministic per Attempt. A directory this application recorded for the
   * same operation is rebuilt from scratch without following links; anything else already there is an
   * unknown effect and fails closed.
   */
  private stage(attempt: Attempt, binding: CodeCheckBinding, operationId: string): { sourceDir: string; configDir: string } {
    if (!this.resources) throw new Error('Trusted code-check resource materializer is unavailable')
    const root = join(this.attempts.stateDir, 'staging', attempt.projectId, attempt.id), marker = join(root, '.dsh-code-check.json')
    managedDirectory(this.attempts.stateDir, dirname(root))
    const existing = lstatSync(root, { throwIfNoEntry: false })
    if (existing) {
      const recorded = (() => {
        try {
          const info = lstatSync(marker)
          if (info.isSymbolicLink() || !info.isFile()) return undefined
          return JSON.parse(readFileSync(marker, 'utf8')) as { operationId?: string; lease?: string; sourceVersion?: string; configVersion?: string; runtimeVersion?: string }
        } catch { return undefined }
      })()
      const same = recorded?.operationId === operationId && recorded.lease === attempt.lease && recorded.sourceVersion === binding.sourceVersion
        && recorded.configVersion === binding.configVersion && recorded.runtimeVersion === binding.runtimeVersion
      if (existing.isSymbolicLink() || !existing.isDirectory() || !same) throw new Error('Code material staging destination already exists')
      // Name-based removal: symlinks inside are deleted, never traversed.
      rmSync(root, { recursive: true, force: true })
    }
    mkdirSync(root, { mode: 0o700 })
    writeFileSync(marker, JSON.stringify({ operationId, lease: attempt.lease, sourceVersion: binding.sourceVersion, configVersion: binding.configVersion, runtimeVersion: binding.runtimeVersion, at: this.now() }), { flag: 'wx', mode: 0o600 })
    return { sourceDir: join(root, 'source'), configDir: join(root, 'config') }
  }
  /** Removes app-owned staging only when no completion marker made it reusable work. */
  private discardStaging(attempt: Attempt): void {
    const root = join(this.attempts.stateDir, 'staging', attempt.projectId, attempt.id), marker = join(root, '.dsh-code-check.json')
    const existing = lstatSync(root, { throwIfNoEntry: false })
    if (!existing) return
    const marked = lstatSync(marker, { throwIfNoEntry: false })
    if (marked?.isFile() && !marked.isSymbolicLink()) return
    if (existing.isSymbolicLink() || !existing.isDirectory()) return
    rmSync(root, { recursive: true, force: true })
  }
  async run(sessionId: string, operationId: string, check: CodeCheck, commands: Commands, signal: AbortSignal): Promise<CodeValidationReceipt> {
    const { attempt, assignment } = this.attempts.resolve(sessionId)
    this.authorize?.(sessionId)
    const required = assignment.contract?.plan.acceptance?.codeCheck
    if (!required || payload(required) !== payload(check)) throw new Error('Code check is not part of the pinned Assignment contract')
    if (!/^[A-Za-z0-9_.\/-]+$/.test(check.command) || check.command.includes('..')) throw new Error('Code check command is not approved')
    const binding = attempt.codeCheckBinding
    if (!binding && this.resources) throw new Error('Evidence-producing code checks require a trusted resource binding')
    let argv: string[] = [check.command, ...check.args]
    let cwd = attempt.cwd
    if (binding) {
      if (!this.resources) throw new Error('Trusted code-check resource materializer is unavailable')
      // The contract names resources and their exact captured versions; the binding is the same
      // resolution taken again at admission, so any drift is a real change and fails closed.
      if (binding.profile !== check.profile) throw new Error('Code check does not match the server-resolved binding')
      if ((check.sourceResourceId && check.sourceResourceId !== binding.sourceResourceId)
        || (check.configResourceId && check.configResourceId !== binding.configResourceId)
        || (check.runtimeResourceId && check.runtimeResourceId !== binding.runtimeResourceId)) throw new Error('Code check does not reference the pinned resources')
      if (binding.sourceVersion !== check.sourceVersion || binding.configVersion !== check.configVersion) throw new Error('Code check material changed since review')
      if ((check.runtimeVersion ?? undefined) !== (binding.runtimeVersion ?? undefined)) throw new Error('Code check runtime changed since review')
      this.assertBindingCurrent(attempt, binding)
    }
    const validate = (): void => {
      const current = this.attempts.resolve(sessionId).attempt
      if (current.id !== attempt.id || current.lease !== attempt.lease) throw new Error('Stale validation attempt lease')
      this.authorize?.(sessionId)
      if (binding) this.assertBindingCurrent(attempt, binding)
    }
    if (this.resources && !this.nativeJobs) throw new Error('Production validation requires durable native job services')
    const id = createHash('sha256').update(JSON.stringify([attempt.id, attempt.lease, operationId])).digest('hex')
    // A completed or reserved operation is returned before any staging side effect, so a retry of the
    // same operation never collides with material the first run already prepared.
    const existing = this.get(attempt.id, operationId)
    if (existing) { if (existing.status === 'running') throw new Error('Code validation outcome is unknown and requires reconciliation'); return existing }
    // The logical reviewed command is the receipt identity; argv names the resolved executable.
    const started: CodeValidationReceipt = { id, operationId, attemptId: attempt.id, lease: attempt.lease, profile: binding?.profile ?? check.profile,
      command: check.command, args: [...check.args], ...(binding ? { argv: [...binding.argv] } : {}),
      ...(binding ? { sourceResourceId: binding.sourceResourceId, configResourceId: binding.configResourceId } : {}),
      ...(binding?.runtimeResourceId ? { runtimeResourceId: binding.runtimeResourceId, ...(binding.runtimeVersion === undefined ? {} : { runtimeVersion: binding.runtimeVersion }) } : {}),
      sourceVersion: binding?.sourceVersion ?? check.sourceVersion, configVersion: binding?.configVersion ?? check.configVersion, status: 'running', createdAt: this.now() }
    try { this.store.db.prepare('INSERT INTO code_validation(id,attempt_id,operation_id,value) VALUES(?,?,?,?)').run(id, attempt.id, operationId, JSON.stringify(started)) } catch { throw new Error('Code validation operation was concurrently reserved; reconcile its outcome') }
    // Everything below can fail before any producer starts. Those failures are known-not-started:
    // remove the reservation so the same operation can be retried, and remove only app-owned staging
    // that has no completion marker (a marked directory is rebuilt idempotently by `stage`).
    const notStarted = (error: unknown): never => {
      try { this.discardStaging(attempt) } catch { /* the original failure remains authoritative */ }
      this.store.db.prepare('DELETE FROM code_validation WHERE id=? AND attempt_id=? AND operation_id=? AND value LIKE \'%"status":"running"%\'').run(id, attempt.id, operationId)
      throw error
    }
    let identity: ExecutionIdentity
    try {
      if (binding) {
        const { sourceDir, configDir } = this.stage(attempt, binding, operationId)
        this.resources!.materialize(attempt.projectId, binding.sourceResourceId, sourceDir)
        this.resources!.materialize(attempt.projectId, binding.configResourceId, configDir)
        argv = binding.argv.map(item => item.replaceAll('{source}', sourceDir).replaceAll('{config}', configDir))
        cwd = sourceDir
      }
      // Registered material can be checked with no GitHub identity; the local facts stay server-owned and deterministic.
      identity = binding ? this.attempts.identityForCodeValidation(attempt.id) : this.attempts.identity(attempt.id)
      // Raw Commands execution is deliberately unavailable for evidence-producing checks.
      if (!this.runner) throw new Error('Native owned code validation runner is unavailable; reserved operation requires reconciliation')
    } catch (error) { return notStarted(error) }
    const runner = this.runner
    let result: ValidationProcessResult
    try {
      result = this.nativeJobs
        ? await this.nativeJobs.run({ projectId: attempt.projectId, ownerId: attempt.sessionId, attemptId: attempt.id, lease: attempt.lease, validate }, operationId, argv, cwd, identity, signal)
        : await runner.run(argv, cwd, identity, signal, operationId)
    } catch (error) {
      // The adapter may refuse admission before any producer starts (for example after a pause) and
      // persist a definitive, physically-clear not-started outcome. Settle the reservation from that
      // fact instead of leaving a receipt stuck in `running` forever.
      const settled = this.nativeJobs?.records().find(row => row.attemptId === attempt.id && row.lease === attempt.lease)
      if (!settled) {
        // The adapter failed before it could create a durable job record, so no producer can have
        // started. Remove the reservation and let the same operation be retried.
        this.store.db.prepare('DELETE FROM code_validation WHERE id=? AND attempt_id=? AND operation_id=? AND value LIKE \'%"status":"running"%\'').run(id, attempt.id, operationId)
        throw error
      }
      if (settled.phase !== 'exited' || settled.physicalExit !== true || settled.result?.status !== 'aborted') throw error
      const aborted: CodeValidationReceipt = { ...started, status: 'aborted', outputHash: createHash('sha256').update('').digest('hex'), output: '',
        error: settled.result.error ?? String(error) }
      this.store.db.prepare('UPDATE code_validation SET value=? WHERE id=? AND attempt_id=? AND operation_id=?').run(JSON.stringify(aborted), id, attempt.id, operationId)
      throw error
    }
    // Authority that ended during the producer cannot turn a result into a pass, but it must not
    // leave an unresolvable reservation either: persist an aborted, non-certifiable outcome.
    const revalidate = (): string | undefined => { try { validate(); return undefined } catch (error) { return String(error) } }
    let authorityError = revalidate()
    const output = `${result.stdout}${result.stderr}`.slice(0, 100_000)
    const status = authorityError ? 'aborted' : result.status === 'passed' && (result.exitCode !== 0 || result.signal !== undefined) ? 'unknown' : result.status
    const receipt: CodeValidationReceipt = { ...started, ...(binding ? { argv: [...argv] } : {}), status, ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }), ...(result.signal === undefined ? {} : { signal: result.signal }), outputHash: createHash('sha256').update(output).digest('hex'), output, ...((authorityError ?? result.error) === undefined ? {} : { error: authorityError ?? result.error }) }
    const late = authorityError ?? revalidate()
    if (late) { receipt.status = 'aborted'; receipt.error = late }
    this.store.db.prepare('UPDATE code_validation SET value=? WHERE id=? AND attempt_id=? AND operation_id=?').run(JSON.stringify(receipt), id, attempt.id, operationId)
    return receipt
  }
  requirePassed(attemptId: string, lease: string, check: CodeCheck, operationId: string): CodeValidationReceipt {
    const receipt = this.get(attemptId, operationId)
    const binding = this.attempts.all().find(item => item.id === attemptId)?.codeCheckBinding
    // A bound check is certified by its pinned resources and their captured content versions, never
    // by the display command: the resolved argv names an owner-registered interpreter.
    const same = binding
      ? receipt?.profile === binding.profile && receipt.sourceResourceId === binding.sourceResourceId && receipt.sourceVersion === binding.sourceVersion
        && receipt.configResourceId === binding.configResourceId && receipt.configVersion === binding.configVersion
        && (receipt.runtimeResourceId ?? undefined) === (binding.runtimeResourceId ?? undefined)
        && (receipt.runtimeVersion ?? undefined) === (binding.runtimeVersion ?? undefined)
      : receipt?.profile === check.profile && receipt.sourceVersion === check.sourceVersion && receipt.configVersion === check.configVersion
        && receipt.command === check.command && JSON.stringify(receipt.args) === JSON.stringify(check.args)
    if (!receipt || receipt.lease !== lease || receipt.status !== 'passed' || !same || receipt.exitCode !== 0 || receipt.signal !== undefined) throw new Error('Required code validation receipt is missing, stale or failed')
    return receipt
  }
}
