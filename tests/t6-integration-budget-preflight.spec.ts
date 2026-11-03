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

it('accounts for one actual worker only once while its native preparation is awaiting', async () => {
  const settings = h.runtime.store.settings(); h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const sessions = (h.runtime as any).sessions, original = sessions.ensure.bind(sessions), release = deferred<void>()
  let preparing = false
  vi.spyOn(sessions, 'ensure').mockImplementation(async (...args: any[]) => { if (args[3] === 'worker') { preparing = true; await release.promise } return original(...args) })
  try {
    const f = oneWorker('reservation-to-native-owner')
    h.runtime.executor.dispatchProjects()
    await waitUntil(() => preparing)
    expect(f.c.attempts.all().filter(a => a.ticketId === f.plan.ticketId)).toHaveLength(1)
    h.runtime.executor.dispatchProjects()
    const occupancy = h.runtime.scheduler.status().filter(row => row.kind === 'worker' && row.state === 'running')
    expect(occupancy).toHaveLength(1)
  } finally { release.resolve(); await new Promise(resolve => setImmediate(resolve)) }
})

it('puts a real current coordinator mapping through the same instance model admission before invoking the model body', async () => {
  const settings = h.runtime.store.settings(); h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'coordinator-model-budget', goal: 'Ordinary discussion' })
  const cwd = join(h.directory, 'projects', project.id, 'coordinator'); mkdirSync(cwd, { recursive: true })
  const workspace = await h.ctx.workspaceRegistry.create(realpathSync(cwd))
  const mapping = c.conversations.saveMapping(project.id, 'owner', { sessionId: `project-${project.id}-budget-probe`, workspaceId: workspace.id, cwd: realpathSync(cwd) })
  await h.controller.create({ sessionId: mapping.sessionId, workspaceId: workspace.id } as never)
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'coordinator-model-input', text: 'Discuss the project' })
  c.conversations.claimNext(project.id, 'owner', mapping)
  ;(h.agents as any).currentInitiator = () => h.agents.get(mapping.sessionId)
  ;(h.runtime as any).budgetHooks.install()
  const held = await h.runtime.scheduler.acquire({ id: 'occupied-model-budget', projectId: 'other-project', kind: 'model' })
  const body = vi.fn(), iterator = (h.ctx as any).waterfall(h.ctx.llm, 'llm/stream', { signal: new AbortController().signal }, async function* () { body(); yield 'model result' })[Symbol.asyncIterator]()
  const pending = iterator.next(); void pending.catch(() => {})
  try {
    await new Promise(resolve => setImmediate(resolve))
    expect(body).not.toHaveBeenCalled()
    expect(h.runtime.scheduler.status()).toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: mapping.sessionId, kind: 'model', state: 'queued' })]))
  } finally { held.release(); await pending.catch(() => {}); await iterator.return?.() }
})
