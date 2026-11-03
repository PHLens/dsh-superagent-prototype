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
it('exposes a queued model-budget wait and clears it after actual admission', async () => {
  const settings = h.runtime.store.settings(); h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const f = oneWorker('temporary-model-wait'); await pump()
  const a = f.c.attempts.all().findLast(item => item.ticketId === f.plan.ticketId)!
  await waitUntil(() => h.agents.get(a.sessionId)?.status === 'running')
  ;(h.agents as any).currentInitiator = () => h.agents.get(a.sessionId)
  ;(h.runtime as any).budgetHooks.install()
  const held = await h.runtime.scheduler.acquire({ id: 'other-model-stream', projectId: 'other-project', kind: 'model' })
  const iterator = (h.ctx as any).waterfall(h.ctx.llm, 'llm/stream', { signal: new AbortController().signal }, async function* () { yield 'allowed' })[Symbol.asyncIterator]()
  const pending = iterator.next(); void pending.catch(() => {})
  const progress = () => f.c.view('owner', f.project.id).tasks.find(t => t.id === f.plan.ticketId)!.progress.assignments.find(item => item.assignmentId === a.assignmentId)!
  try {
    await new Promise(resolve => setImmediate(resolve))
    const queued = progress()
    held.release(); await pending; await iterator.return?.()
    expect(progress().budgetWait).toBeUndefined()
    expect(queued.budgetWait).toBe('global-budget')
  } finally { held.release(); await pending.catch(() => {}); await iterator.return?.() }
})
