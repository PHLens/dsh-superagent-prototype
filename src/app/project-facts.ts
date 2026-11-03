/** Bounded coordinator facts. Stored worker text is data, never authorization. */
import { readFileSync, realpathSync } from 'node:fs'
import { activePlanAssignments, currentAssignmentGraph, type Ticket } from '../core/index.ts'
import type { Store } from './store.ts'
import type { Attempt } from './execution-attempts.ts'
import { digest, type Artifact } from './artifact-store.ts'
import type { AcceptedReport, GateDecision } from './report-acceptance.ts'

const preview = (text: string, limit = 600) => ({ text: text.slice(0, limit), totalChars: text.length, truncated: text.length > limit })
function rows<T>(store: Store, table: 'worker_report' | 'acceptance_decision', ticketId: string): T[] {
  return store.db.prepare(`SELECT value FROM ${table} WHERE json_extract(value, '$.ticketId')=? ORDER BY rowid`).all(ticketId).map(row => JSON.parse(String(row.value)) as T)
}
export function assignmentFacts(store: Store, ticket: Ticket, input: { assignmentId?: string; offset?: number; limit?: number } = {}) {
  const offset = input.offset ?? 0, limit = Math.min(8, input.limit ?? 4)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid facts page')
  const graph = currentAssignmentGraph(ticket), all = activePlanAssignments(ticket).filter(a => !input.assignmentId || a.id === input.assignmentId)
  if (input.assignmentId && !all.length) throw new Error('Assignment is not in the current graph')
  const reports = rows<AcceptedReport>(store, 'worker_report', ticket.id), decisions = rows<GateDecision>(store, 'acceptance_decision', ticket.id)
  const assignments = all.slice(offset, offset + limit).map(a => {
    const attempt = store.db.prepare('SELECT value FROM execution_attempt ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Attempt).findLast(item => item.projectId === ticket.projectId && item.ticketId === ticket.id && item.assignmentId === a.id)
    const report = attempt && reports.findLast(r => r.assignmentId === a.id && r.attemptId === attempt.id && r.lease === attempt.lease)
    const decision = decisions.findLast(d => d.assignmentId === a.id && d.reportId === report?.id)
    return { assignmentId: a.id, ...(a.contract?.assignmentKey !== undefined ? { key: a.contract.assignmentKey } : {}), state: a.state,
      ...(a.waitingReason !== undefined ? { waitingReason: a.waitingReason } : {}),
      goal: preview(a.contract?.proposal?.goal ?? a.contract?.plan.goal ?? ''),
      conditions: { assignmentId: a.id, ...(a.contract ? { planRevision: a.contract.planRevision, conditionsVersion: a.contract.plan.acceptance?.version ?? a.contract.planRevision } : {}),
        completion: preview(a.contract?.plan.completion ?? ''), ...(a.contract?.plan.acceptance ? { acceptance: a.contract.plan.acceptance } : {}) },
      ...(report ? { report: { id: report.id, attemptId: report.attemptId, state: report.state, completed: preview(report.completed), evidence: report.evidence.slice(0, 4).map(s => preview(s, 300)), evidenceCount: report.evidence.length,
        unresolved: report.unresolved.slice(0, 4).map(s => preview(s, 300)), unresolvedCount: report.unresolved.length, artifacts: report.artifacts.slice(0, 8), artifactCount: report.artifacts.length } } : {}),
      ...(decision ? { decision: { id: decision.id, reportId: decision.reportId, conclusion: decision.conclusion, evidence: preview(decision.evidence), targetVersion: decision.targetVersion, conditionsVersion: decision.conditionsVersion } } : {}),
      ...(a.waitingReason === 'needs_judgment' ? { unresolvedChoice: 'Judge the current evidence against these conditions; coordinator reads do not pass this gate.' }
        : a.waitingReason === 'blocked' ? { unresolvedChoice: 'Resolve the reported blockers within authorization or explain the required human choice.' } : {}) }
  })
  return { ticketId: ticket.id, ...(graph ? { currentGraph: { id: graph.id, version: graph.version } } : {}), offset, total: all.length, next_offset: offset + assignments.length < all.length ? offset + assignments.length : null,
    assignments, readMore: { tool: 'project_read_assignment_facts', ticket_id: ticket.id }, readExact: { tool: 'project_read_fact', ticket_id: ticket.id, kinds: ['report', 'decision', 'assignment', 'artifact'], note: 'Use exact ids above; artifact requires content_version. Assignment pages return contentVersion; pass it as content_version on later pages and restart at offset 0 if stale. Text previews and arrays may be truncated. Page full records with offset/next_offset.' } }
}
export function readFact(store: Store, ticket: Ticket, input: { kind: 'report' | 'decision' | 'assignment' | 'artifact'; id: string; contentVersion?: string; offset?: number; limit?: number }) {
  let record: unknown
  if (input.kind === 'assignment') record = activePlanAssignments(ticket).find(a => a.id === input.id)
  else if (input.kind === 'artifact') {
    const row = store.db.prepare('SELECT value FROM worker_artifact WHERE id=?').get(input.id)
    const artifact = row && JSON.parse(String(row.value)) as Artifact | undefined
    if (artifact && artifact.projectId === ticket.projectId && artifact.ticketId === ticket.id && artifact.status === 'registered' && artifact.contentVersion === input.contentVersion) {
      if (realpathSync(artifact.path) !== artifact.path) throw new Error('Artifact path changed')
      const content = readFileSync(artifact.path, 'utf8')
      if (digest(content) !== artifact.contentVersion) throw new Error('Artifact content version changed')
      record = { id: artifact.id, contentVersion: artifact.contentVersion, assignmentId: artifact.assignmentId, output: artifact.output, name: artifact.name, content }
    }
  } else record = input.kind === 'report' ? rows<AcceptedReport>(store, 'worker_report', ticket.id).find(r => r.id === input.id) : rows<GateDecision>(store, 'acceptance_decision', ticket.id).find(d => d.id === input.id)
  if (!record) throw new Error('Fact not found in this project task')
  const text = JSON.stringify(record), offset = input.offset ?? 0, limit = Math.min(12000, input.limit ?? 6000)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid fact page')
  const contentVersion = input.kind === 'assignment' ? digest(text) : input.contentVersion
  if (input.kind === 'assignment' && ((offset > 0 && !input.contentVersion) || (input.contentVersion && input.contentVersion !== contentVersion))) throw new Error('Stale assignment content version; restart from offset 0')
  const content = text.slice(offset, offset + limit)
  return { ticketId: ticket.id, kind: input.kind, id: input.id, ...(contentVersion !== undefined ? { contentVersion } : {}), encoding: 'json', offset, totalChars: text.length, content, truncated: offset + content.length < text.length, next_offset: offset + content.length < text.length ? offset + content.length : null }
}
