/** Explicit server-owned execution identities. Business state remains in Ticket/Assignment. */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { Assignment, Ticket } from '../core/index.ts'
import type { Store } from './store.ts'

export const EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_attempt (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS worker_artifact (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(attempt_id, operation_id));
CREATE TABLE IF NOT EXISTS worker_report (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(attempt_id, operation_id));
CREATE TABLE IF NOT EXISTS acceptance_decision (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, operation_id TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(ticket_id, operation_id));
`
export interface Attempt {
  id: string; projectId: string; ticketId: string; assignmentId: string; lease: string; sessionId: string
  workspaceId?: string; cwd: string; root: string; status: 'preparing' | 'prepared' | 'running' | 'ended' | 'reconcile'
  prepare?: { realpath: string; at: string; method: 'managed-empty-directory-v1' }
  fenced?: true
  context?: { toolContractVersion?: number; promptRevision: number; roleRules: string; projectConventions: string; model: unknown; tools: string[]; resources: readonly string[]; skills: { name: string; version: string }[] }
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
  constructor(readonly store: Store, stateDir: string) { this.stateDir = realpathSync(stateDir) }
  all(): Attempt[] { return this.store.db.prepare('SELECT value FROM execution_attempt ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Attempt) }
  save(value: Attempt): void { this.store.db.prepare('INSERT INTO execution_attempt VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, value.sessionId, JSON.stringify(value)) }
  bySession(sessionId: string): Attempt | undefined {
    const row = this.store.db.prepare('SELECT value FROM execution_attempt WHERE session_id=?').get(sessionId)
    return row ? JSON.parse(String(row.value)) as Attempt : undefined
  }
  /** No caller supplied project/task/attempt/lease fields are accepted by worker tools. */
  resolve(sessionId: string, receipt = false): { attempt: Attempt; ticket: Ticket; assignment: Assignment } {
    const attempt = this.bySession(sessionId), ticket = attempt && this.store.tickets.get(attempt.ticketId)
    const assignment = ticket?.assignments.find(item => item.id === attempt?.assignmentId)
    const auth = assignment?.contract && ticket?.authorizations?.find(item => item.id === assignment.contract!.authorizationId)
    const newest = this.all().findLast(item => item.assignmentId === attempt?.assignmentId)
    const lifecycleBlocked = ticket?.lifecycle && (ticket.lifecycle.pause.intent === 'pause' || ticket.lifecycle.stop.intent === 'stop')
    if (!attempt || !ticket || !assignment?.contract || (!receipt && (ticket.ended || lifecycleBlocked)) || ticket.projectId !== attempt.projectId || assignment.projectId !== attempt.projectId
      || assignment.ticketId !== ticket.id || (!receipt && assignment.state === 'ended') || !auth || auth.revokedAt || attempt.fenced || newest?.lease !== attempt.lease
      || !(receipt ? ['prepared', 'running', 'ended'] : ['prepared', 'running']).includes(attempt.status)) throw new Error('Stale or unauthorized worker execution')
    this.validateDirectory(attempt)
    return { attempt, ticket, assignment }
  }
  validateDirectory(attempt: Attempt): void {
    if (!attempt.prepare || realpathSync(attempt.cwd) !== attempt.prepare.realpath || realpathSync(attempt.root) !== attempt.root
      || !contained(attempt.root, attempt.prepare.realpath) || !statSync(attempt.cwd).isDirectory()) throw new Error('Execution preparation evidence or realpath does not match')
  }
  allocate(ticket: Ticket, assignment: Assignment, options: { fresh?: boolean } = {}): Attempt {
    const auth = ticket.authorizations?.find(item => item.id === assignment.contract?.authorizationId)
    if (!ticket.projectId || !assignment.contract || !auth || auth.revokedAt || ticket.ended || assignment.state === 'ended') throw new Error('Assignment is not authorized')
    const previous = this.all().findLast(item => item.assignmentId === assignment.id)
    if (previous && !options.fresh) return previous
    const inputs: NonNullable<Attempt['inputs']>[number][] = []
    let reviewTarget: Attempt['reviewTarget']
    const review = assignment.contract.proposal?.review
    if (review) {
      const target = ticket.assignments.find(item => item.contract?.assignmentKey === review.target && item.contract.authorizationId === assignment.contract!.authorizationId)
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
    const id = randomUUID(), attempt: Attempt = { id, projectId: ticket.projectId, ticketId: ticket.id, assignmentId: assignment.id,
      lease: randomUUID(), sessionId: `project-worker-${randomUUID()}`, root, cwd: join(root, 'executions', id), status: 'preparing', inputs, reviewTarget, createdAt: new Date().toISOString() }
    this.store.atomic(() => this.save(attempt))
    return attempt
  }
  /** Unknown filesystem effects are inspected, never accepted as a successful prepare. */
  prepare(attempt: Attempt): Attempt {
    if (attempt.prepare) { this.validateDirectory(attempt); return attempt }
    if (attempt.status !== 'preparing') throw new Error('Preparation requires reconciliation')
    try {
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
