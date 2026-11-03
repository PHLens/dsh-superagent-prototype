/** WIP integration preflight. Runtime/SQLite plus existing synthetic host, not actual provider acceptance. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { startRuntime, type Host } from './fixtures/host.ts'
import { deferred, waitUntil } from './fixtures/async.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => {
  for (const agent of h.agents.values()) { agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0 }
  await h.stop(); vi.restoreAllMocks()
})
function oneWorker(label: string) {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: label, goal: 'One bounded file' })
  const input = c.conversations.appendUser(project.id, 'owner', { clientRequestKey: label, text: 'Create one note' })
  h.runtime.store.db.prepare("UPDATE conversation_message SET status='answered' WHERE id=?").run(input.id)
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'save-' + label, plan: { goal: label, scope: 'One note', outputs: ['note.md'], resources: [], environment: 'Managed', cost: 'One worker', completion: 'One file', acceptance: { version: 1, mode: 'registered-files' } } })
  c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm-' + label, intent: 'execute' })
  return { c, project, plan }
}


async function pump(n = 5) { for (let i = 0; i < n; i++) { h.runtime.executor.dispatchProjects(); await new Promise(resolve => setImmediate(resolve)) } }
it('readmits a resumed worker before waking it when another project retains an uncertain physical owner', async () => {
  const settings = h.runtime.store.settings(); h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const first = oneWorker('warm-resume-a'); await pump()
  const a = first.c.attempts.all().findLast(item => item.ticketId === first.plan.ticketId)!
  await waitUntil(() => h.agents.get(a.sessionId)?.status === 'running')
  expect((await h.api('POST', `tickets/${first.plan.ticketId}/pause`)).status).toBe(200)
  await pump(); await waitUntil(() => h.runtime.store.tickets.get(first.plan.ticketId)?.lifecycle?.pause.state === 'paused')
  const second = oneWorker('unknown-other-owner-b'); await pump()
  const b = second.c.attempts.all().findLast(item => item.ticketId === second.plan.ticketId)!
  await waitUntil(() => h.agents.get(b.sessionId)?.status === 'running')
  const saved = h.agents.get(b.sessionId)!
  second.c.attempts.save({ ...b, status: 'reconcile', error: 'Synthetic lost physical-owner observation; not an exit' })
  h.agents.delete(b.sessionId)
  try {
    await pump()
    expect(h.runtime.scheduler.status().filter(row => row.kind === 'worker' && row.state === 'running')).toHaveLength(1)
    expect((await h.api('POST', `tickets/${first.plan.ticketId}/resume`)).status).toBe(200)
    await pump()
    expect(h.agents.get(a.sessionId)?.status).toBe('idle')
  } finally { h.agents.set(b.sessionId, saved); saved.status = 'idle' }
})
