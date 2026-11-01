/** Execution identities and time-bounded leases; the caller supplies authoritative context and clock. */
import type { AssignmentId, AttemptId, AuthorizationId, LeaseId } from './project-ids.ts'
import { assertProjectOwnership, type TaskOwned } from './project-model.ts'

export interface ExecutionBinding extends TaskOwned {
  readonly assignmentId: AssignmentId
  readonly authorizationId: AuthorizationId
}

export type AttemptState = 'preparing' | 'running' | 'pausing' | 'paused' | 'stopped' | 'failed' | 'completed'
export interface Attempt extends ExecutionBinding {
  readonly id: AttemptId
  readonly leaseId: LeaseId
  readonly state: AttemptState
  readonly createdAt: string
  readonly endedAt?: string
}

export interface Lease extends ExecutionBinding {
  readonly id: LeaseId
  readonly attemptId: AttemptId
  readonly issuedAt: string
  readonly expiresAt: string
  readonly endedAt?: string
}

/** The interval is [issuedAt, expiresAt). Invalid, not-yet-issued and ended leases fail closed. */
export function isLeaseFresh(lease: Lease, now: string): boolean {
  const issued = Date.parse(lease.issuedAt), expires = Date.parse(lease.expiresAt), time = Date.parse(now)
  return lease.endedAt === undefined && Number.isFinite(issued) && Number.isFinite(expires) && Number.isFinite(time)
    && issued < expires && issued <= time && time < expires
}

/** A lease must belong to the current attempt, assignment, authorization, task and project. */
export function validateAttemptLease(attempt: Attempt, lease: Lease, now: string): void {
  assertProjectOwnership(attempt.projectId, lease)
  for (const field of ['taskId', 'assignmentId', 'authorizationId'] as const) {
    if (typeof attempt[field] !== 'string' || !attempt[field].trim() || attempt[field] !== lease[field]) {
      throw new Error(`Lease ${field} does not match the current attempt`)
    }
  }
  if (typeof attempt.id !== 'string' || !attempt.id.trim() || attempt.id !== lease.attemptId
    || typeof attempt.leaseId !== 'string' || !attempt.leaseId.trim() || attempt.leaseId !== lease.id) {
    throw new Error('Lease does not identify the current attempt')
  }
  if (!['running', 'pausing'].includes(attempt.state) || attempt.endedAt !== undefined || !isLeaseFresh(lease, now)) {
    throw new Error('Execution lease is not active')
  }
  const created = Date.parse(attempt.createdAt)
  if (!Number.isFinite(created) || created > Date.parse(lease.issuedAt)) throw new Error('Lease predates its attempt')
}
