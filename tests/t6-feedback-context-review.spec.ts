/** Feedback context and coalescing contract. Actual Runtime/SQLite, controlled coordinator reply; no provider/process requests. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { currentAssignmentGraph, type AssignmentProposal } from '../src/core/index.ts'
import { ProjectEvents } from '../src/app/events.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { for (const agent of h.agents.values()) { agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0 }; await h.stop() })
function contextFixture(count = 1) {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Context review', goal: 'Make an evidence-based comparison' })
  const original = c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Compare the sourced findings and decide what needs follow-up.' })
  h.runtime.store.db.prepare("UPDATE conversation_message SET status='answered' WHERE id=?").run(original.id)
  const proposals: AssignmentProposal[] = Array.from({ length: count }, (_, index) => ({ key: 'part' + index, goal: index === count - 1 && count > 1 ? 'UNRELATED_BRANCH_CONTEXT_ANCHOR: preserve this independent investigation' : 'Investigate part ' + index,
    outputs: ['part' + index + '.md'], dependencies: [], completion: 'A sourced account of part ' + index, resources: [], cost: 'One bounded attempt', writeScope: 'isolated-directory', acceptance: { version: 1, mode: 'human-review' } }))
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'save', plan: { goal: 'Compare the findings', scope: 'A bounded evidence review', outputs: proposals.flatMap(p => p.outputs), resources: [], environment: 'Managed file work', cost: count + ' bounded attempts', completion: 'Evidence-backed review', assignments: proposals } })
  const confirmed = c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  const ticket = h.runtime.store.tickets.get(plan.ticketId)!, assignment = ticket.assignments[0]!
  const attempt = c.attempts.prepare(c.attempts.allocate(ticket, assignment))
  const artifact = c.artifacts.write(attempt.sessionId, { operationId: 'artifact', output: assignment.contract!.plan.outputs[0]!, name: 'finding.md', content: '# Source-backed finding' })
  const checkpoint = vi.spyOn((c as any).sessions, 'checkpoint')
  return { c, project, plan, ticket, assignment, attempt, artifact, checkpoint }
}

/** Read-only server tools may supply omitted details on demand. Probe existing task/report-id schemas without prescribing a tool name or prompt format. */
async function availableKnowledge(f: ReturnType<typeof contextFixture>, agentId: string, reportId: string) {
  const rows = [String(f.checkpoint.mock.calls.at(-1)?.[1] ?? ''), new ProjectEvents(h.runtime.store).feedback(f.project.id)?.prompt ?? '']
  const values: Record<string, unknown> = { ticket_id: f.ticket.id, ticketId: f.ticket.id, task_id: f.ticket.id, taskId: f.ticket.id,
    report_id: reportId, reportId, revision: f.plan.revision, plan_revision: f.plan.revision, offset: 0, limit: 20 }
  for (const [name, tool] of h.tools.get(agentId) ?? []) {
    if (!/^project_(?:read|list)/.test(name)) continue
    const schema = (tool as any).parameters ?? {}, required: string[] = schema.required ?? []
    const args: Record<string, unknown> = {}
    let supported = true
    for (const field of required) {
      if (field in values) args[field] = values[field]
      else if (field === 'id' && /report/.test(name)) args[field] = reportId
      else { supported = false; break }
    }
    if (!supported) continue
    try { rows.push(JSON.stringify(await h.runGuardedTool(agentId, name, args))) } catch { /* A read refusal is not usable judgment evidence. */ }
  }
  return rows.join('\n')
}

it('makes current completed work, evidence, decision reason and exact artifact versions available inline or through project reads', async () => {
  const f = contextFixture(), completed = 'COMPLETED_JUDGMENT_FACT: the two sources disagree on the date', evidence = 'EVIDENCE_JUDGMENT_FACT: source alpha says 2024; source beta says 2025', reason = 'DECISION_JUDGMENT_REASON: choose whether to prioritize publication date or observation date'
  const report = f.c.reports.submit(f.attempt.sessionId, { operationId: 'ready', state: 'ready', completed, evidence: [evidence], artifacts: [{ id: f.artifact.id, contentVersion: f.artifact.contentVersion }], unresolved: [] })
  f.c.reports.decide('owner', f.project.id, { ticketId: f.ticket.id, operationId: 'needs-choice', reportId: report.id, conclusion: 'needs_judgment', evidence: reason })
  let knowledge = ''
  vi.spyOn((f.c as any).sessions, 'reply').mockImplementation(async (agent: any) => { knowledge = await availableKnowledge(f, agent.id, report.id); return { text: 'Controlled response', sessionId: agent.id, turn: 1, dshMessageId: 'context-reviewed' } })
  f.c.pumpEvents(); await f.c.idle()
  const graph = currentAssignmentGraph(h.runtime.store.tickets.get(f.ticket.id)!)!
  expect({ currentReportLocated: knowledge.includes(report.id), currentWork: knowledge.includes(completed), evidence: knowledge.includes(evidence), decisionBasis: knowledge.includes(reason),
    artifactId: knowledge.includes(f.artifact.id), artifactVersion: knowledge.includes(f.artifact.contentVersion), graphLocated: knowledge.includes(graph.id) })
    .toEqual({ currentReportLocated: true, currentWork: true, evidence: true, decisionBasis: true, artifactId: true, artifactVersion: true, graphLocated: true })
})

it('makes actual unresolved blockers available to a feedback coordinator without requiring full execution logs', async () => {
  const f = contextFixture(), blocker = 'UNRESOLVED_JUDGMENT_BLOCKER: source beta access is unavailable'
  const report = f.c.reports.submit(f.attempt.sessionId, { operationId: 'blocked', state: 'blocked', completed: 'One source was checked', evidence: ['Source alpha is saved'], artifacts: [{ id: f.artifact.id, contentVersion: f.artifact.contentVersion }], unresolved: [blocker] })
  let knowledge = ''
  vi.spyOn((f.c as any).sessions, 'reply').mockImplementation(async (agent: any) => { knowledge = await availableKnowledge(f, agent.id, report.id); return { text: 'Controlled response', sessionId: agent.id, turn: 1, dshMessageId: 'blocker-reviewed' } })
  f.c.pumpEvents(); await f.c.idle()
  expect(knowledge).toContain(blocker)
})

it('coalesces a Task snapshot rather than multiplying all branch context by each event', async () => {
  const f = contextFixture(16)
  for (let index = 0; index < 40; index++) f.c.reports.submit(f.attempt.sessionId, { operationId: 'blocked-' + index, state: 'blocked', completed: 'Updated blocked finding ' + index, evidence: ['An updated source check'], artifacts: [{ id: f.artifact.id, contentVersion: f.artifact.contentVersion }], unresolved: ['Needs a source choice'] })
  let prompt = ''
  vi.spyOn((f.c as any).sessions, 'reply').mockImplementation(async (agent: any) => { prompt = String(f.checkpoint.mock.calls.at(-1)?.[1] ?? ''); return { text: 'Controlled response', sessionId: agent.id, turn: 1, dshMessageId: 'coalesced' } })
  f.c.pumpEvents(); await f.c.idle()
  // The unrelated branch may appear in a title, goal, plan and graph summary;
  // it must not be copied again for all forty updates to another branch.
  expect(prompt.split('UNRELATED_BRANCH_CONTEXT_ANCHOR').length - 1, 'prompt bytes=' + Buffer.byteLength(prompt) + '; actual blocked-report events=40; branches=16').toBeLessThanOrEqual(4)
  expect(prompt.length).toBeGreaterThan(0)
})
