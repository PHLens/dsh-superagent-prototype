/** Read-only presentation of stored execution facts; never grants authority or advances work. */
import { createHash } from 'node:crypto'
import type { Assignment, Ticket } from '../core/model.ts'
import { activeAssignmentByKey, activePlanAssignments } from '../core/assignment-graphs.ts'
import type { Artifact } from './artifact-store.ts'
import type { Attempt } from './execution-attempts.ts'
import type { AcceptedReport, GateDecision } from './report-acceptance.ts'

export type ProjectWorkPhase = 'awaiting-confirmation' | 'queued' | 'preparing' | 'retrying' | 'running' | 'worker-idle'
  | 'semantic-review' | 'changes_required' | 'needs_judgment' | 'missing-artifacts' | 'unresolved-items' | 'delegation-pending'
  | 'failed' | 'blocked' | 'unknown' | 'authorization-revoked' | 'completed' | 'ended'
export interface AssignmentProgress {
  assignmentId: string
  assignmentKey?: string
  title: string
  goal: string
  state: Assignment['state']
  waitingReason?: string
  acceptanceHold?: string
  dependencies: string[]
  question?: { id: string; version?: number; question: string }
  gate?: { targetAssignmentId: string; conditionsVersion: number; conclusion?: GateDecision['conclusion'] }
  budgetWait?: 'global-budget' | 'project-fairness' | 'worker-slot'
  planRevision: number
  authorizationId: string
  attemptId?: string
  attemptState?: Attempt['status']
  phase: ProjectWorkPhase
  nativeState: 'running' | 'idle' | 'unknown'
  reportId?: string
  reportState?: AcceptedReport['state']
  reportAt?: string
  conditionsVersion: number
  decision?: GateDecision['conclusion']
}
export interface ProjectProgress {
  phase: ProjectWorkPhase | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'reconciling'
  workPhase: ProjectWorkPhase
  reconciliation?: 'checking' | 'clear' | 'unknown'
  completedAt?: string
  assignments: AssignmentProgress[]
}
function authorizationHold(ticket: Ticket, assignment: Assignment): boolean {
  const id = assignment.contract?.authorizationId
  return !id || !!ticket.authorizations?.find(item => item.id === id)?.revokedAt
}
interface Facts {
  attempts: readonly Attempt[]
  reports: readonly AcceptedReport[]
  decisions: readonly GateDecision[]
  artifacts: readonly Artifact[]
  nativeState?(sessionId: string): string | undefined
}

function assignmentProgress(ticket: Ticket, assignment: Assignment, facts: Facts): AssignmentProgress {
  const contract = assignment.contract!
  const attempt = facts.attempts.findLast(item => item.projectId === ticket.projectId && item.ticketId === ticket.id && item.assignmentId === assignment.id)
  const native = attempt && facts.nativeState?.(attempt.sessionId)
  const nativeState = native === 'running' || native === 'idle' ? native : 'unknown'
  const report = attempt && facts.reports.findLast(item => item.projectId === ticket.projectId && item.ticketId === ticket.id
    && item.assignmentId === assignment.id && item.attemptId === attempt.id && item.lease === attempt.lease)
  const target = contract.proposal?.review?.target
     ? activeAssignmentByKey(ticket, contract.authorizationId, contract.proposal.review.target)
     : undefined
   const targetAttempt = target && facts.attempts.findLast(item => item.projectId === ticket.projectId && item.ticketId === ticket.id && item.assignmentId === target.id)
   const targetReport = targetAttempt && facts.reports.findLast(item => item.projectId === ticket.projectId && item.ticketId === ticket.id && item.assignmentId === target.id && item.attemptId === targetAttempt.id && item.lease === targetAttempt.lease)
   const targetArtifacts = targetReport?.artifacts.flatMap(ref => facts.artifacts.filter(item => item.id === ref.id && item.contentVersion === ref.contentVersion
     && item.status === 'registered' && item.projectId === ticket.projectId && item.ticketId === ticket.id
     && item.assignmentId === target?.id && item.attemptId === targetAttempt?.id && item.lease === targetAttempt?.lease)) ?? []
   const gateTargetVersion = targetReport?.state === 'ready' && !targetAttempt?.fenced && targetAttempt?.status !== 'reconcile'
     && targetArtifacts.length === targetReport.artifacts.length && target?.contract?.plan.outputs.every(output => targetArtifacts.some(item => item.output === output))
     && (target.contract.plan.acceptance?.version ?? target.contract.planRevision) === contract.proposal?.review?.conditionsVersion
     ? createHash('sha256').update(JSON.stringify(targetReport.artifacts.map(ref => [ref.id, ref.contentVersion]))).digest('hex') : undefined
   const gateDecision = targetReport && gateTargetVersion ? facts.decisions.findLast(item => item.projectId === ticket.projectId && item.ticketId === ticket.id
     && item.assignmentId === target.id && item.reportId === targetReport.id && item.gate === 'completion:' + target.id
     && item.judge.generation === targetAttempt?.lease && item.targetVersion === gateTargetVersion && item.conditionsVersion === contract.proposal?.review?.conditionsVersion) : undefined
   const question = ticket.attentionQuestions?.find(item => item.binding?.assignmentId === assignment.id) ?? (ticket.attention?.binding?.assignmentId === assignment.id ? ticket.attention : undefined)
  const result: AssignmentProgress = {
    assignmentId: assignment.id, assignmentKey: contract.assignmentKey, title: contract.plan.goal.slice(0, 160), goal: contract.plan.goal,
    state: assignment.state, waitingReason: assignment.waitingReason,
    ...(attempt?.fenced ? { acceptanceHold: 'execution-fenced' } : attempt?.status === 'reconcile' ? { acceptanceHold: 'reconciliation-required' } : authorizationHold(ticket, assignment) ? { acceptanceHold: 'authorization-revoked' } : {}),
    dependencies: contract.inputs.flatMap(input => input.kind === 'dependency' ? [input.assignmentId] : []),
    ...(question ? { question: { id: question.id, version: question.version, question: question.question } } : {}),
    ...(assignment.budgetWait ? { budgetWait: assignment.budgetWait } : assignment.waitingReason === 'worker-slot' ? { budgetWait: 'worker-slot' as const } : {}),
    ...(contract.proposal?.review ? { gate: { targetAssignmentId: target?.id ?? assignment.id, conditionsVersion: contract.proposal?.review.conditionsVersion, ...(gateDecision ? { conclusion: gateDecision.conclusion } : {}) } } : {}),
    authorizationId: contract.authorizationId, planRevision: contract.planRevision,
    attemptId: attempt?.id, attemptState: attempt?.status, phase: 'queued', nativeState,
    conditionsVersion: contract.plan.acceptance?.version ?? contract.planRevision,
    ...(report ? { reportId: report.id, reportState: report.state, reportAt: report.at } : {}),
  }
  if (assignment.state === 'ended') {
    result.phase = assignment.endedReason === 'accepted' ? 'completed' : 'ended'
    return result
  }
  const authorization = ticket.authorizations?.find(item => item.id === contract.authorizationId)
  if (!authorization || authorization.revokedAt) { result.phase = 'authorization-revoked'; return result }
  if (attempt?.fenced) { result.phase = assignment.state === 'pending' ? 'retrying' : 'unknown'; return result }
  if (report?.state === 'ready' && attempt) {
    const registered = report.artifacts.flatMap(ref => facts.artifacts.filter(item => item.id === ref.id && item.contentVersion === ref.contentVersion
      && item.status === 'registered' && item.projectId === ticket.projectId && item.ticketId === ticket.id
      && item.assignmentId === assignment.id && item.attemptId === attempt.id && item.lease === attempt.lease))
    if (registered.length !== report.artifacts.length || contract.plan.outputs.some(output => !registered.some(item => item.output === output))) {
      result.phase = 'missing-artifacts'; return result
    }
    if (report.unresolved.length) { result.phase = 'unresolved-items'; return result }
    if (result.waitingReason === 'delegation-pending') { result.phase = 'delegation-pending'; return result }
    if (contract.plan.acceptance?.mode !== 'registered-files') {
      const targetVersion = createHash('sha256').update(JSON.stringify(report.artifacts.map(ref => [ref.id, ref.contentVersion]))).digest('hex')
      const decision = facts.decisions.findLast(item => item.projectId === ticket.projectId && item.ticketId === ticket.id
        && item.assignmentId === assignment.id && item.reportId === report.id && item.gate === 'completion:' + assignment.id
        && item.targetVersion === targetVersion && item.conditionsVersion === result.conditionsVersion && item.judge.generation === attempt.lease)
      result.decision = decision?.conclusion
      result.phase = !decision ? 'semantic-review' : decision.conclusion === 'passed' ? 'unknown' : decision.conclusion
      return result
    }
    // Completion is recorded by the aggregate. A ready record alone cannot invent that transition.
    result.phase = 'unknown'; return result
  }
  if (report?.state === 'failed' || report?.state === 'blocked') { result.phase = report.state; return result }
  if (!attempt) { result.phase = 'queued'; return result }
  if (attempt.status === 'reconcile') { result.phase = 'unknown'; return result }
  if (attempt.status === 'preparing' || attempt.status === 'prepared') { result.phase = 'preparing'; return result }
  result.phase = nativeState === 'running' ? 'running' : nativeState === 'idle' ? 'worker-idle' : 'unknown'
  return result
}

export function projectProgress(ticket: Ticket, facts: Facts): ProjectProgress {
  const assignments = activePlanAssignments(ticket).map(item => assignmentProgress(ticket, item, facts))
  const active = assignments.filter(item => !['completed', 'ended'].includes(item.phase))
  const priority: ProjectWorkPhase[] = ['running', 'unknown', 'failed', 'blocked', 'needs_judgment', 'changes_required',
    'missing-artifacts', 'unresolved-items', 'delegation-pending', 'semantic-review', 'authorization-revoked', 'retrying', 'preparing', 'queued', 'worker-idle']
  const workPhase: ProjectWorkPhase = ticket.ended ? ticket.ended.outcome === 'completed' ? 'completed' : 'ended'
    : priority.find(phase => active.some(item => item.phase === phase)) ?? (assignments.length ? 'unknown' : 'awaiting-confirmation')
  const lifecycle = ticket.lifecycle
  const explicitReconciliation = lifecycle?.reconciliation?.state
  const pendingExecutionCheck = assignments.some(item => item.attemptState === 'reconcile' && !['completed', 'ended'].includes(item.phase))
  const reconciliation = explicitReconciliation === 'checking' ? 'checking' : pendingExecutionCheck ? 'unknown' : explicitReconciliation
  const phase: ProjectProgress['phase'] = reconciliation === 'checking' ? 'reconciling' : reconciliation === 'unknown' ? 'unknown'
    : lifecycle?.stop.intent === 'stop' ? lifecycle.stop.state === 'exited' ? 'stopped' : 'stopping'
      : ticket.ended ? workPhase
        : lifecycle?.pause.intent === 'pause' ? lifecycle.pause.state === 'paused' ? 'paused' : 'pausing' : workPhase
  return { phase, workPhase, reconciliation, ...(ticket.ended ? { completedAt: ticket.ended.at } : {}), assignments }
}
