/** Explicit server-owned execution identities. Business state remains in Ticket/Assignment. */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { Assignment, CodeCheckBinding, Ticket } from '../core/index.ts'
import { activeAssignmentByKey, isActivePlanAssignment } from '../core/assignment-graphs.ts'
import type { Store } from './store.ts'
import { deliveryBranchFor, type ExecutionIdentity } from './execution-environment.ts'
import { verifyExecutionIdentity, writeExecutionIdentity } from '../infra/environment.ts'
import type { ManagedSkillSnapshot, SkillLoadRecord } from './managed-skills.ts'

export const EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_attempt (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS worker_artifact (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(attempt_id, operation_id));
CREATE TABLE IF NOT EXISTS worker_report (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(attempt_id, operation_id));
CREATE TABLE IF NOT EXISTS acceptance_decision (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, operation_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(ticket_id, operation_id));
`
export interface Attempt {
  id: string; projectId: string; ticketId: string; assignmentId: string; lease: string; sessionId: string
  workspaceId?: string; cwd: string; root: string; status: 'preparing' | 'prepared' | 'running' | 'settling' | 'ended' | 'reconcile'
  prepare?: { realpath: string; at: string; method: 'managed-empty-directory-v1' }
  fenced?: true
  context?: { toolContractVersion?: number; promptRevision: number; roleRules: string; projectConventions: string; model: unknown; tools: string[]; resources: readonly string[]; skills: { name: string; version: string }[] }
  identity?: ExecutionIdentity
  codeCheckBinding?: CodeCheckBinding
  skillSnapshot?: import('./managed-skills.ts').ManagedSkillSnapshot[]
  /** Skill body pages actually loaded in this execution, in the order they were served. */
  skillLoads?: SkillLoadRecord[]
  /** Immutable artifact versions consumed when this attempt was admitted. */
  inputs?: readonly { artifactId: string; contentVersion: string; assignmentId?: string; reportId?: string }[]
  reviewTarget?: { assignmentId: string; attemptId: string; lease: string; reportId: string; conditionsVersion: number; artifacts: { id: string; contentVersion: string }[] }
  createdAt: string; error?: string
}
export function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}
/** Create managed ancestors one at a time; never follow a preexisting symlink. */
export function managedDirectory(root: string, target: string): void {
  if (!contained(root, target)) throw new Error('Managed directory escaped its root')
  let current = root
  for (const component of relative(root, target).split('/').filter(Boolean)) {
    current = join(current, component)
    try { mkdirSync(current, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory() || realpathSync(current) !== current) throw new Error('Managed directory is a symlink or not a directory')
  }
}
/** Allocates server-owned execution identities and verifies preparation and active authorization. */
export class ExecutionAttempts {
  readonly stateDir: string
  /** Live resource grants for this application; the first authority wins so a narrower one cannot replace it. */
  private authority?: { granted(projectId: string, resourceId: string): boolean }
  claimResourceAuthority(authority: { granted(projectId: string, resourceId: string): boolean }): void { this.authority ??= authority }
  private ended?: (attemptId: string) => void
  /** Observes every Attempt that reaches `ended` once its write is committed, whichever path ended it. */
  onEnded(hook: (attemptId: string) => void): void { this.ended = hook }
  get resourceAuthority(): { granted(projectId: string, resourceId: string): boolean } | undefined { return this.authority }
  constructor(readonly store: Store, stateDir: string, private readonly skillAdmission?: (assignment: Assignment) => ManagedSkillSnapshot[], private readonly identityAdmission?: (projectId: string, assignment: Assignment, executionId: string) => ExecutionIdentity | undefined, private readonly codeCheckAdmission?: (projectId: string, assignment: Assignment) => CodeCheckBinding | undefined) { this.stateDir = realpathSync(stateDir) }
  all(): Attempt[] { return this.store.db.prepare('SELECT value FROM execution_attempt ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Attempt) }
  save(value: Attempt): void {
    const row = this.store.db.prepare('SELECT value FROM execution_attempt WHERE id=?').get(value.id) as { value?: string } | undefined
    const previous = row?.value ? (JSON.parse(row.value) as Attempt).status : undefined
    this.store.db.prepare('INSERT INTO execution_attempt VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, value.sessionId, JSON.stringify(value))
    if (previous !== 'ended' && value.status === 'ended') this.store.afterCommit(() => this.ended?.(value.id))
  }
  pinIdentity(attemptId: string, identity: ExecutionIdentity): Attempt {
    const attempt = this.all().find(item => item.id === attemptId); if (!attempt) throw new Error('Unknown execution attempt')
    if (identity.executionId !== attempt.id || identity.projectId !== attempt.projectId) throw new Error('Execution identity does not belong to attempt')
    if (attempt.identity && JSON.stringify(attempt.identity) !== JSON.stringify(identity)) throw new Error('Execution identity is already pinned')
    attempt.identity = identity; this.save(attempt); return attempt
  }
  identity(attemptId: string): ExecutionIdentity { const attempt = this.all().find(item => item.id === attemptId); if (!attempt?.identity) throw new Error('Execution identity is not pinned'); return attempt.identity }
  /**
   * A resource-bound code check runs in an app-owned staging tree and needs no GitHub identity. Use the
   * exact pinned identity when one exists; otherwise derive only the stable local facts from Attempt.
   */
  identityForCodeValidation(attemptId: string): ExecutionIdentity {
    const attempt = this.all().find(item => item.id === attemptId)
    if (!attempt) throw new Error('Unknown execution attempt')
    return attempt.identity ?? { executionId: attempt.id, projectId: attempt.projectId, gitAuthorName: 'dsh-superagent', gitAuthorEmail: 'dsh-superagent@localhost', capturedAt: attempt.createdAt }
  }
  bySession(sessionId: string): Attempt | undefined {
    const row = this.store.db.prepare('SELECT value FROM execution_attempt WHERE session_id=?').get(sessionId)
    return row ? JSON.parse(String(row.value)) as Attempt : undefined
  }
  /**
   * Resolve the Session/Attempt/Assignment ownership a committed receipt still belongs to. This intentionally skips
   * authorization, resource and directory checks: those govern live writes, not read-only historical receipt lookup.
   */
  receiptOwner(sessionId: string): { attempt: Attempt; ticket: Ticket; assignment: Assignment } {
    const attempt = this.bySession(sessionId), ticket = attempt && this.store.tickets.get(attempt.ticketId)
    const assignment = ticket?.assignments.find(item => item.id === attempt?.assignmentId)
    const newest = this.all().findLast(item => item.assignmentId === attempt?.assignmentId)
    if (!attempt || !ticket || !assignment?.contract || ticket.projectId !== attempt.projectId
      || assignment.projectId !== attempt.projectId || assignment.ticketId !== ticket.id || attempt.fenced
      || newest?.lease !== attempt.lease || !['prepared', 'running', 'settling', 'ended'].includes(attempt.status)) throw new Error('Stale or unauthorized worker execution')
    return { attempt, ticket, assignment }
  }
  /** No caller supplied project/task/attempt/lease fields are accepted by worker tools. */
  resolve(sessionId: string, receipt = false): { attempt: Attempt; ticket: Ticket; assignment: Assignment } {
    const attempt = this.bySession(sessionId), ticket = attempt && this.store.tickets.get(attempt.ticketId)
    const assignment = ticket?.assignments.find(item => item.id === attempt?.assignmentId)
    const auth = assignment?.contract && ticket?.authorizations?.find(item => item.id === assignment.contract!.authorizationId)
    const newest = this.all().findLast(item => item.assignmentId === attempt?.assignmentId)
    const lifecycleBlocked = ticket?.lifecycle && (ticket.lifecycle.pause.intent === 'pause' || ticket.lifecycle.stop.intent === 'stop')
    if (!attempt || !ticket || !assignment?.contract || (!receipt && (ticket.ended || lifecycleBlocked)) || ticket.projectId !== attempt.projectId || assignment.projectId !== attempt.projectId
      || assignment.ticketId !== ticket.id || (!receipt && (assignment.state === 'ended' || !isActivePlanAssignment(ticket, assignment.id))) || !auth || auth.revokedAt || attempt.fenced || newest?.lease !== attempt.lease
      || !(receipt ? ['prepared', 'running', 'settling', 'ended'] : ['prepared', 'running']).includes(attempt.status)) throw new Error('Stale or unauthorized worker execution')
    this.validateDirectory(attempt)
    return { attempt, ticket, assignment }
  }
  /** Re-publishes the complete identity files from the persisted Attempt, then asserts their bytes. */
  private ensureIdentityFiles(attempt: Attempt): void {
    if (!attempt.identity?.repositoryId) return
    writeExecutionIdentity(this.stateDir, attempt.identity)
    verifyExecutionIdentity(this.stateDir, attempt.identity)
  }
  validateDirectory(attempt: Attempt): void {
    if (!attempt.prepare || realpathSync(attempt.cwd) !== attempt.prepare.realpath || realpathSync(attempt.root) !== attempt.root
      || !contained(attempt.root, attempt.prepare.realpath) || !statSync(attempt.cwd).isDirectory()) throw new Error('Execution preparation evidence or realpath does not match')
  }
  allocate(ticket: Ticket, assignment: Assignment, options: { fresh?: boolean } = {}): Attempt {
    const auth = ticket.authorizations?.find(item => item.id === assignment.contract?.authorizationId)
    if (!ticket.projectId || !assignment.contract || !auth || auth.revokedAt || ticket.ended || assignment.state === 'ended' || !isActivePlanAssignment(ticket, assignment.id)) throw new Error('Assignment is not authorized')
    const previous = this.all().findLast(item => item.assignmentId === assignment.id)
    if (previous && !options.fresh) {
      // The Attempt committed before its identity files existed; a retry must publish them from the
      // persisted pin or fail closed, never return an Attempt that would fall back to deployment defaults.
      if (previous.identity) writeExecutionIdentity(this.stateDir, previous.identity)
      return previous
    }
    const inputs: NonNullable<Attempt['inputs']>[number][] = []
    let reviewTarget: Attempt['reviewTarget']
    const review = assignment.contract.proposal?.review
    if (review) {
      const target = activeAssignmentByKey(ticket, assignment.contract.authorizationId, review.target)
      const attempt = target && this.all().findLast(item => item.assignmentId === target.id)
      const row = attempt && this.store.db.prepare('SELECT value FROM worker_report WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1').get(attempt.id)
      const report = row && JSON.parse(String(row.value)) as { id: string; state: string; artifacts: { id: string; contentVersion: string }[] } | undefined
      if (!target || !attempt || attempt.fenced || attempt.status === 'reconcile' || !report || report.state !== 'ready'
        || review.conditionsVersion !== (target.contract!.plan.acceptance?.version ?? target.contract!.planRevision)) throw new Error('Review target is not ready at the registered conditions version')
      reviewTarget = { assignmentId: target.id, attemptId: attempt.id, lease: attempt.lease, reportId: report.id, conditionsVersion: review.conditionsVersion, artifacts: report.artifacts }
      for (const artifact of report.artifacts) inputs.push({ artifactId: artifact.id, contentVersion: artifact.contentVersion, assignmentId: target.id, reportId: report.id })
    }

    for (const ref of assignment.contract.inputs) {
      if (ref.kind === 'artifact') { inputs.push({ artifactId: ref.artifactId, contentVersion: ref.contentVersion }); continue }
      if (ref.assignmentId === reviewTarget?.assignmentId) continue
      const upstream = ticket.assignments.find(item => item.id === ref.assignmentId)
      if (ref.ticketId !== ticket.id || upstream?.state !== 'ended' || upstream.endedReason !== 'accepted') throw new Error('Assignment dependency is not accepted')
      const upstreamAttempt = this.all().findLast(item => item.assignmentId === upstream.id && !item.fenced)
      const report = this.store.db.prepare('SELECT value FROM worker_report WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1').get(upstreamAttempt?.id ?? '')
      const result = report && JSON.parse(String(report.value)) as { id: string; state: string; artifacts: { id: string; contentVersion: string }[] } | undefined
      if (!result || result.state !== 'ready') throw new Error('Assignment dependency has no current ready report')
      for (const artifact of result.artifacts) {
        if (!this.store.registeredArtifact(ticket.projectId, artifact.id, artifact.contentVersion)) throw new Error('Dependency artifact version is unavailable')
        inputs.push({ artifactId: artifact.id, contentVersion: artifact.contentVersion, assignmentId: upstream.id, reportId: result.id })
      }
    }
    const projectRoot = join(this.stateDir, 'projects', ticket.projectId)
    managedDirectory(this.stateDir, projectRoot)
    const root = realpathSync(projectRoot)
    if (!contained(realpathSync(this.stateDir), root)) throw new Error('Project root escaped state directory')
    const id = randomUUID()
    const codeCheckBinding = this.codeCheckAdmission?.(ticket.projectId, assignment)
    // Which registered resource carries the repository identity is a project decision; it fails closed on ambiguity.
    const admitted = this.identityAdmission?.(ticket.projectId, assignment, id)
    // The delivery branch is server-owned and persisted with the Attempt. Admission may already
    // supply one, but a project repository identity must never leave it to a worker or to legacy
    // ticket.execution state.
    const identity = admitted && admitted.repositoryId && !admitted.deliveryBranch ? { ...admitted, deliveryBranch: deliveryBranchFor(id) } : admitted
    const attempt: Attempt = { id, projectId: ticket.projectId, ticketId: ticket.id, assignmentId: assignment.id,
      lease: randomUUID(), sessionId: `project-worker-${randomUUID()}`, root, cwd: join(root, 'executions', id), status: 'preparing', inputs, reviewTarget, ...(this.skillAdmission ? { skillSnapshot: this.skillAdmission(assignment) } : {}), ...(identity ? { identity } : {}), ...(codeCheckBinding ? { codeCheckBinding } : {}), createdAt: new Date().toISOString() }
    this.store.atomic(() => this.save(attempt))
    if (identity) writeExecutionIdentity(this.stateDir, identity)
    return attempt
  }
  /** Unknown filesystem effects are inspected, never accepted as a successful prepare. */
  prepare(attempt: Attempt): Attempt {
    // A prepared Attempt is still a recovery boundary: the identity directory may have been lost,
    // truncated or edited while the process was down. Rebuild it only from this persisted pin.
    this.ensureIdentityFiles(attempt)
    if (attempt.prepare) { this.validateDirectory(attempt); return attempt }
    if (attempt.status !== 'preparing') throw new Error('Preparation requires reconciliation')
    try {
      // A committed Attempt may have crashed between its DB write and file publication, or lost
      // files later; regenerate from the persisted pin and fail preparation if that is impossible.
      if (attempt.identity) { writeExecutionIdentity(this.stateDir, attempt.identity); verifyExecutionIdentity(this.stateDir, attempt.identity) }
      managedDirectory(attempt.root, join(attempt.root, 'executions'))
      if (realpathSync(join(attempt.root, 'executions')) !== join(attempt.root, 'executions')) throw new Error('Execution parent is a symlink')
      // Exclusive mkdir: even empty leftovers are unknown effects until explicitly reconciled.
      mkdirSync(attempt.cwd, { mode: 0o700 })
      const path = realpathSync(attempt.cwd)
      if (!contained(attempt.root, path) || readdirSync(path).length) throw new Error('Unexpected prepare contents')
      attempt.prepare = { realpath: path, at: new Date().toISOString(), method: 'managed-empty-directory-v1' }
      attempt.status = 'prepared'; this.save(attempt)
      return attempt
    } catch (error) {
      attempt.status = 'reconcile'; attempt.error = String(error); this.save(attempt); throw error
    }
  }
}
