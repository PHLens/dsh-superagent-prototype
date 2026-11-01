/** Reports are immutable execution facts, not commands to mark a task completed. */
import { validateAttemptLease, type Attempt, type ExecutionBinding, type Lease } from './attempts.ts'
import type { ReportState } from './model.ts'
import type { ArtifactId, AttemptId, LeaseId } from './project-ids.ts'
import { assertProjectOwnership } from './project-model.ts'

/** A proposed outcome. Artifact ownership and task completion aggregation are later application responsibilities. */
export interface ReportEffect {
  readonly kind: ReportState
  readonly summary: string
  readonly artifactIds: readonly ArtifactId[]
  readonly evidence: readonly string[]
}

export interface ExecutionReport extends ExecutionBinding {
  readonly attemptId: AttemptId
  readonly leaseId: LeaseId
  /** Stable across transport retries; the eventual store enforces uniqueness/content consistency. */
  readonly operationId: string
  readonly createdAt: string
  readonly effects: readonly ReportEffect[]
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const states: readonly ReportState[] = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

/** Validate against the current server-resolved attempt and lease, not identities supplied by the worker. */
export function validateExecutionReport(report: ExecutionReport, attempt: Attempt, lease: Lease, now: string): void {
  validateAttemptLease(attempt, lease, now)
  assertProjectOwnership(attempt.projectId, report)
  for (const field of ['taskId', 'assignmentId', 'authorizationId'] as const) {
    if (report[field] !== attempt[field]) throw new Error(`Report ${field} does not match the current attempt`)
  }
  if (report.attemptId !== attempt.id || report.leaseId !== lease.id) throw new Error('Report is from a stale execution')
  if (!nonempty(report.operationId)) throw new Error('A stable report operation id is required')
  const reported = Date.parse(report.createdAt)
  if (!Number.isFinite(reported) || reported < Date.parse(lease.issuedAt) || reported > Date.parse(now)) {
    throw new Error('Report time is outside the execution lease')
  }
  if (!Array.isArray(report.effects) || report.effects.length === 0) throw new Error('Report effects are required')
  for (const effect of report.effects) {
    if (!effect || !states.includes(effect.kind) || !nonempty(effect.summary)
      || !Array.isArray(effect.artifactIds) || !effect.artifactIds.every(nonempty)
      || !Array.isArray(effect.evidence) || !effect.evidence.every(nonempty)) {
      throw new Error('Invalid report effect')
    }
  }
}

/** Snapshot only the defined contract fields, retaining no mutable references to the caller's report. */
export function createExecutionReport(report: ExecutionReport, attempt: Attempt, lease: Lease, now: string): ExecutionReport {
  validateExecutionReport(report, attempt, lease, now)
  return Object.freeze({
    projectId: report.projectId, taskId: report.taskId, assignmentId: report.assignmentId,
    authorizationId: report.authorizationId, attemptId: report.attemptId, leaseId: report.leaseId,
    operationId: report.operationId, createdAt: report.createdAt,
    effects: Object.freeze(report.effects.map(effect => Object.freeze({
      kind: effect.kind, summary: effect.summary,
      artifactIds: Object.freeze([...effect.artifactIds]), evidence: Object.freeze([...effect.evidence]),
    }))),
  })
}
