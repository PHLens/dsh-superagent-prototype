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

it('can resume an unconsumed feedback judgment after an unrelated project conversation advances the input state', async () => {
  const f = contextFixture()
  f.c.reports.submit(f.attempt.sessionId, { operationId: 'blocked', state: 'blocked', completed: 'A partial finding', evidence: ['A saved source'], artifacts: [{ id: f.artifact.id, contentVersion: f.artifact.contentVersion }], unresolved: ['A source choice remains'] })
  const reply = vi.spyOn((f.c as any).sessions, 'reply').mockRejectedValueOnce(new Error('Coordinator unavailable before native consumption'))
  f.c.pumpEvents(); await f.c.idle(); expect(reply).toHaveBeenCalledTimes(1)
  const prior = f.c.conversations.stateVersion(f.project.id)
  reply.mockImplementation(async (agent: any) => ({ text: 'Controlled successful answer', sessionId: agent.id, turn: 2, dshMessageId: 'after-normal-input' }))
  f.c.send('owner', f.project.id, { requestId: 'unrelated-chat', text: 'Remind me of this project name; keep the outstanding source choice unresolved.' })
  await f.c.idle()
  expect(f.c.conversations.stateVersion(f.project.id)).toBeGreaterThan(prior)
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 600_000)
  f.c.pumpEvents(); await f.c.idle()
  expect(new ProjectEvents(h.runtime.store).pending(f.project.id), 'feedback recovery error: ' + new ProjectEvents(h.runtime.store).failure(f.project.id)).toEqual([])
  expect(reply).toHaveBeenCalledTimes(3)
})
