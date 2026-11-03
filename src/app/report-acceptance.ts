/** Report receipt and deterministic aggregation never call a coordinator model. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Assignment, Ticket } from '../core/index.ts'
import type { Store } from './store.ts'
import { ExecutionAttempts, type Attempt } from './execution-attempts.ts'
import { ArtifactStore, digest } from './artifact-store.ts'
import { ConversationStore } from './conversation-store.ts'
import { ProjectEvents } from './events.ts'

export interface FileReport {
  operationId: string; state: 'progress' | 'ready' | 'blocked' | 'failed'
  completed: string; evidence: string[]; artifacts: { id: string; contentVersion: string }[]; unresolved: string[]; prUrl?: string
}
export interface AcceptedReport extends FileReport { id: string; attemptId: string; lease: string; sessionId: string; projectId: string; ticketId: string; assignmentId: string; at: string }
export interface GateDecision {
  id: string; operationId: string; reportId: string; projectId: string; ticketId: string; assignmentId: string; gate: string; targetVersion: string; conditionsVersion: number
  judge: { actorId: string; source: 'authenticated-web' | 'registered-worker'; generation: string; assignmentId?: string; attemptId?: string; lease?: string }; conclusion: 'passed' | 'changes_required' | 'needs_judgment'; evidence: string; at: string
}
/** Persists worker receipts and independently validates version-bound acceptance before completing work. */
export class ReportAcceptance {
  constructor(readonly store: Store, readonly attempts: ExecutionAttempts, readonly artifacts: ArtifactStore) {}
  reports(ticketId: string): AcceptedReport[] { return this.store.db.prepare('SELECT value FROM worker_report ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as AcceptedReport).filter(item => item.ticketId === ticketId) }
  decisions(ticketId: string): GateDecision[] { return this.store.db.prepare('SELECT value FROM acceptance_decision ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as GateDecision).filter(item => item.ticketId === ticketId) }
  submit(sessionId: string, input: FileReport): AcceptedReport {
    const { attempt } = this.attempts.resolve(sessionId, true)
    if (!input.operationId.trim() || !input.completed.trim() || !input.evidence.length || input.evidence.some(item => !item.trim())) throw new Error('Report needs completed work and evidence')
    return this.store.atomic(() => {
      const { ticket, assignment } = this.attempts.resolve(sessionId, true)
      const previous = this.reports(ticket.id).find(item => item.attemptId === attempt.id && item.operationId === input.operationId)
      if (previous) {
        const { id: _id, attemptId: _a, lease: _l, sessionId: _s, projectId: _p, ticketId: _t, assignmentId: _as, at: _at, ...payload } = previous
        if (!isDeepStrictEqual(payload, JSON.parse(JSON.stringify(input)))) throw new Error('Report operation id conflict')
        return previous
      }
      this.attempts.resolve(sessionId)
      for (const ref of input.artifacts) {
        const item = this.artifacts.read(attempt.projectId, ref.id, ref.contentVersion)
        if (item.ticketId !== ticket.id || item.assignmentId !== assignment.id || item.attemptId !== attempt.id || item.lease !== attempt.lease) throw new Error('Foreign artifact in report')
      }
      const report: AcceptedReport = { ...input, id: randomUUID(), attemptId: attempt.id, lease: attempt.lease, sessionId, projectId: attempt.projectId, ticketId: ticket.id, assignmentId: assignment.id, at: new Date().toISOString() }
      this.store.db.prepare('INSERT INTO worker_report VALUES (?,?,?,?)').run(report.id, attempt.id, input.operationId, JSON.stringify(report))
      assignment.report = { state: input.state === 'ready' ? 'waiting' : input.state, summary: input.completed, at: report.at }
      this.aggregate(ticket, assignment, attempt, report)
      return report
    })
  }
  target(report: AcceptedReport): string { return digest(JSON.stringify(report.artifacts.map(ref => [ref.id, ref.contentVersion]))) }
  decide(actorId: string, projectId: string, input: { ticketId: string; operationId: string; reportId: string; conclusion: GateDecision['conclusion']; evidence: string }): GateDecision {
    const owner = new ConversationStore(this.store).getOwner(projectId)
    if (owner?.actorId !== actorId || !input.operationId.trim() || !input.evidence.trim()) throw new Error('Decision ownership or evidence missing')
    return this.store.atomic(() => {
      const report = this.reports(input.ticketId).find(item => item.id === input.reportId)
      if (!report || report.projectId !== projectId || report.state !== 'ready') throw new Error('Decision report not found')
      const { ticket, assignment, attempt } = this.attempts.resolve(report.sessionId, true)
      if (this.reports(ticket.id).filter(item => item.assignmentId === assignment.id).at(-1)?.id !== report.id) throw new Error('Stale gate target')
      const old = this.decisions(ticket.id).find(item => item.operationId === input.operationId)
      if (old) {
        if (old.reportId !== report.id || old.targetVersion !== this.target(report) || old.conclusion !== input.conclusion || old.evidence !== input.evidence || old.judge.actorId !== actorId) throw new Error('Decision operation id conflict')
        return old
      }
      this.attempts.resolve(report.sessionId)
      const decision: GateDecision = { id: randomUUID(), operationId: input.operationId, reportId: report.id, projectId, ticketId: ticket.id, assignmentId: assignment.id, gate: `completion:${assignment.id}`,
        targetVersion: this.target(report), conditionsVersion: assignment.contract!.plan.acceptance?.version ?? assignment.contract!.planRevision,
        judge: { actorId, source: 'authenticated-web', generation: attempt.lease }, conclusion: input.conclusion, evidence: input.evidence, at: new Date().toISOString() }
      this.store.db.prepare('INSERT INTO acceptance_decision VALUES (?,?,?,?)').run(decision.id, ticket.id, input.operationId, JSON.stringify(decision))
      this.aggregate(ticket, assignment, attempt, report, decision.at)
      return decision
    })
  }
  decideWorker(sessionId: string, input: { operationId: string; reportId: string; conclusion: GateDecision['conclusion']; evidence: string }): GateDecision {
    if (!input.operationId.trim() || !input.evidence.trim()) throw new Error('Judge operation and evidence required')
    return this.store.atomic(() => {
      const judge = this.attempts.resolve(sessionId)
      const registration = judge.assignment.contract!.proposal?.review, snapshot = judge.attempt.reviewTarget
      if (!registration || !snapshot || input.reportId !== snapshot.reportId || snapshot.assignmentId === judge.assignment.id) throw new Error('Judge has no registered target snapshot')
      const report = this.reports(judge.ticket.id).find(item => item.id === snapshot.reportId)
      const target = judge.ticket.assignments.find(item => item.id === snapshot.assignmentId)
      const targetAttempt = this.attempts.all().findLast(item => item.assignmentId === snapshot.assignmentId)
      if (!report || report.state !== 'ready' || target?.contract?.assignmentKey !== registration.target || target.contract.authorizationId !== judge.assignment.contract!.authorizationId
        || targetAttempt?.id !== snapshot.attemptId || targetAttempt.lease !== snapshot.lease || targetAttempt.fenced || targetAttempt.status === 'reconcile'
        || this.reports(judge.ticket.id).findLast(item => item.assignmentId === target.id)?.id !== report.id
        || registration.conditionsVersion !== snapshot.conditionsVersion || (target.contract.plan.acceptance?.version ?? target.contract.planRevision) !== snapshot.conditionsVersion) throw new Error('Stale or unauthorized judge target')
      const operationId = `judge:${judge.attempt.id}:${input.operationId}`
      const existing = this.decisions(judge.ticket.id).find(item => item.operationId === operationId)
      if (existing) {
        if (existing.reportId !== report.id || existing.evidence !== input.evidence || existing.conclusion !== input.conclusion) throw new Error('Judge operation conflict')
        return existing
      }
      this.attempts.resolve(report.sessionId)
      const decision: GateDecision = { id: randomUUID(), operationId, reportId: report.id, projectId: judge.attempt.projectId, ticketId: judge.ticket.id, assignmentId: target.id, gate: `completion:${target.id}`, targetVersion: this.target(report), conditionsVersion: snapshot.conditionsVersion,
        judge: { actorId: sessionId, source: 'registered-worker', generation: snapshot.lease, assignmentId: judge.assignment.id, attemptId: judge.attempt.id, lease: judge.attempt.lease }, conclusion: input.conclusion, evidence: input.evidence, at: new Date().toISOString() }
      this.store.db.prepare('INSERT INTO acceptance_decision VALUES (?,?,?,?)').run(decision.id, judge.ticket.id, operationId, JSON.stringify(decision))
      this.aggregate(judge.ticket, target, targetAttempt, report, decision.at)
      return decision
    })
  }
  private aggregate(ticket: Ticket, assignment: Assignment, attempt: Attempt, report: AcceptedReport, completionAt = report.at): void {
    let reason: string | undefined
    if (report.state !== 'ready') reason = report.state === 'progress' ? undefined : report.state
    else {
      const outputs = report.artifacts.map(ref => this.artifacts.read(attempt.projectId, ref.id, ref.contentVersion).output)
      if (assignment.contract!.plan.outputs.some(output => !outputs.includes(output))) reason = 'missing-artifacts'
      else if (report.unresolved.length) reason = 'unresolved-items'
      else if ((ticket.attentionQuestions?.some(question => question.binding?.assignmentId === assignment.id && !question.resolvedAt)
        || (ticket.attention?.binding?.assignmentId === assignment.id && !ticket.attention.resolvedAt))) reason = 'unresolved-question'
      else if (assignment.contract!.plan.acceptance?.mode !== 'registered-files') {
        const decision = this.decisions(ticket.id).findLast(item => item.assignmentId === assignment.id && item.reportId === report.id && item.targetVersion === this.target(report)
          && item.conditionsVersion === (assignment.contract!.plan.acceptance?.version ?? assignment.contract!.planRevision) && item.judge.generation === attempt.lease)
        if (decision?.conclusion !== 'passed') reason = decision?.conclusion ?? 'semantic-review'
      }
      if (!reason) {
        assignment.state = 'ended'; assignment.endedAt = completionAt; assignment.endedReason = 'accepted'; assignment.report = { state: 'ready', summary: report.completed, at: report.at }
        attempt.status = 'ended'; this.attempts.save(attempt)
        if (ticket.assignments.filter(item => item.contract).every(item => item.state === 'ended' && item.endedReason === 'accepted')) ticket.ended = { at: completionAt, by: 'executor', outcome: 'completed' }
      }
    }
    assignment.waitingReason = reason as Assignment['waitingReason']
    const retry = assignment.contract?.proposal?.retry
    const retries = this.attempts.all().filter(item => item.assignmentId === assignment.id).length - 1
    if ((reason === 'changes_required' || reason === 'failed') && retry?.on.includes(reason) && retries < retry.limit) {
      assignment.state = 'pending'; assignment.startedAt = undefined
      assignment.waitingReason = 'retrying'
      attempt.status = 'ended'; attempt.error = `Registered retry: ${reason}`; this.attempts.save(attempt)
    }
    ticket.updatedAt = new Date().toISOString(); this.store.tickets.save(ticket)
    new ProjectEvents(this.store).append({ id: `report:${report.id}:${reason ?? 'accepted'}`, projectId: attempt.projectId, ticketId: ticket.id, assignmentId: assignment.id, kind: reason ? 'acceptance-changed' : 'report-recorded', version: report.id, operationId: report.operationId, at: report.at })
    // Durable return to the project conversation; no coordinator availability or generation is required.
    const owner = new ConversationStore(this.store).getOwner(attempt.projectId)
    if (owner && report.state !== 'progress') {
      const id = `worker-result:${report.id}:${reason ?? 'accepted'}`
      const reasons: Record<string, string> = {
        'missing-artifacts': '必要文件尚未全部提交', 'unresolved-items': '仍有未解决的工作事项', 'unresolved-question': '仍有未回答的问题',
        'semantic-review': '等待独立语义复核', changes_required: '独立复核要求修改', needs_judgment: '等待进一步独立判断',
        blocked: '执行遇到阻碍', failed: '执行失败，等待处理',
      }
      const unresolved = report.unresolved.length ? `\n未决事项：\n${report.unresolved.map(item => `- ${item}`).join('\n')}` : ''
      const text = `${ticket.title}: ${report.completed}\n${reason ? `等待：${reasons[reason] ?? '等待执行条件满足'}` : '已按登记条件完成。'}${unresolved}\n成果：${report.artifacts.length} 个文件，可在成果区查看。`
      this.store.db.prepare(`INSERT OR IGNORE INTO conversation_message (id,project_id,client_request_key,role,actor_id,text,created_at,status,request_ticket_id) VALUES (?,?,?,'assistant',?,?,?,'saved',?)`)
        .run(id, attempt.projectId, id, owner.actorId, text, ticket.updatedAt, ticket.id)
    }
  }
}
