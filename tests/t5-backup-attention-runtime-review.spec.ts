import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { Store } from '../src/app/store.ts'
import { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import { ArtifactStore } from '../src/app/artifact-store.ts'
import { createRecoveryPoint, restoreRecoveryPoint } from '../src/app/backup.ts'

let h: Host | undefined, root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 't5-integration-review-')); h = undefined })
afterEach(async () => {
  if (h) {
    h.runtime.backup.stop()
    for (const agent of h.agents.values()) agent.status = 'idle'
    let open = false
    try { h.runtime.store.db.prepare('SELECT 1').get(); open = true } catch {}
    if (open) await (h.runtime as unknown as { shutdown(): Promise<void> }).shutdown()
    await h.stop()
  }
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})
async function project(label: string) {
  const c = h!.runtime.projectCoordinator, p = c.create('owner', { name: label, goal: 'One file' })
  c.conversations.appendUser(p.id, 'owner', { clientRequestKey: `original-${label}`, text: 'Write one Markdown note.' })
  const plan = c.plans.save('owner', p.id, { expectedRevision: 0, operationId: `plan-${label}`, plan: {
    goal: label, scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed worker', cost: 'One worker',
    completion: 'One nonempty note', acceptance: { version: 1, mode: 'registered-files' },
  } })
  c.confirm('owner', p.id, { ticketId: plan.ticketId, planRevision: 1, operationId: `confirm-${label}`, intent: 'execute' })
  h!.runtime.executor.dispatchProjects()
  await waitUntil(() => c.attempts.all().some(a => a.ticketId === plan.ticketId && a.status === 'running'))
  const attempt = c.attempts.all().find(a => a.ticketId === plan.ticketId)!, agent = h!.agents.get(attempt.sessionId)!
  return { c, p, plan, attempt, agent }
}
function emptyIdle(agent: any) { agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0 }
async function question(label: string) {
  const f = await project(label)
  emptyIdle(f.agent)
  const { question: q } = await h!.runGuardedTool(f.attempt.sessionId, 'project_worker_request_question', {
    operation_id: `question-${label}`, question: 'Which dataset should this worker use?',
  }) as { question: { id: string; version: number; question: string } }
  return { ...f, q }
}
function continuations(sessionId: string) {
  return h!.deliveries.mock.calls.map(([d]) => d).filter(d => d.sessionId === sessionId && d.text.includes('answered the pending Attention'))
}

it('the actual Runtime backup restores managed artifacts without reading the original workspace', async () => {
  h = await startRuntime()
  const outputs: { projectId: string; id: string; contentVersion: string }[] = []
  for (const label of ['project-a', 'project-b']) {
    const f = await project(label)
    const a = f.c.artifacts.write(f.attempt.sessionId, { operationId: 'file', output: 'note', name: 'note.md', content: `# ${label}` })
    f.c.reports.submit(f.attempt.sessionId, { operationId: 'ready', state: 'ready', completed: 'Note complete', evidence: ['Registered file'], artifacts: [{ id: a.id, contentVersion: a.contentVersion }], unresolved: [] })
    emptyIdle(f.agent); outputs.push({ projectId: f.p.id, id: a.id, contentVersion: a.contentVersion })
  }
  const copies = join(root, 'copies')
  h.runtime.backup.start({ enabled: false, directory: copies, intervalMinutes: 5, retention: 7 })
  const manifest = await h.runtime.backup.run('manual')
  const source = join(copies, readdirSync(copies)[0]!)
  console.log('RUNTIME backup material', { files: manifest.files.map(f => f.path), boundaries: manifest.boundaries, consistency: manifest.consistency, health: h.runtime.health.backup })
  expect.soft(manifest.boundaries.workspaces.length).toBeGreaterThan(0)
  expect(manifest.boundaries.nativeState).toEqual([])
  expect(manifest.nativeSessions.length).toBeGreaterThan(0)
  await h.runtime.stop()
  renameSync(join(h.directory, 'projects'), join(h.directory, 'projects-unavailable'))
  const restoredRoot = join(root, 'restored')
  h.runtime.backup.restore(source, restoredRoot)
  const store = new Store(join(restoredRoot, 'orchestrator.sqlite'))
  try {
    const artifacts = new ArtifactStore(store, new ExecutionAttempts(store, restoredRoot))
    const readable = outputs.map(a => { try { return !!artifacts.read(a.projectId, a.id, a.contentVersion).content } catch { return false } })
    console.log('RESTORED artifact availability with original hidden', readable)
    expect(readable).toEqual([true, true])
  } finally { store.close() }
})

it('safeRestore does not schedule backup writes or retention into the inherited destination', async () => {
  const copies = join(root, 'copies'), unrelated = join(copies, '000-user-documents')
  mkdirSync(unrelated, { recursive: true }); writeFileSync(join(unrelated, 'keep.txt'), 'Synthetic restore destination sentinel')
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  h = await startRuntime(store => {
    const db = String(store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file)
    writeFileSync(join(dirname(db), 'restore-profile.json'), JSON.stringify({ execution: false, model: false, outbound: false }))
    store.saveSettings({ ...store.settings(), backup: { enabled: true, directory: copies, intervalMinutes: 5, retention: 1 } })
  })
  expect(h.runtime.safeRestore).toBe(true)
  await vi.advanceTimersByTimeAsync(300_000)
  console.log('SAFE RESTORE backup activity', { directories: readdirSync(copies), unrelatedPresent: existsSync(unrelated), health: h.runtime.health.backup })
  expect.soft(readdirSync(copies)).toEqual(['000-user-documents'])
  expect.soft(existsSync(unrelated)).toBe(true)
})

it('restored database paths refer to copied files even when explicit managed roots were captured', async () => {
  h = await startRuntime()
  const f = await project('declared-file-restore')
  const artifact = f.c.artifacts.write(f.attempt.sessionId, { operationId: 'file', output: 'note', name: 'note.md', content: '# Captured file' })
  emptyIdle(f.agent)
  await h.runtime.stop()
  const sourceDatabase = join(h.directory, 'orchestrator.sqlite'), source = join(root, 'declared-point')
  const sourceStore = new Store(sourceDatabase)
  let copied = false
  try {
    const manifest = createRecoveryPoint(sourceStore, { databasePath: sourceDatabase, destination: source, roots: { workspaces: [join(h.directory, 'projects')] } })
    copied = manifest.files.some(file => file.path.endsWith('/note.md'))
  } finally { sourceStore.close() }
  expect(copied).toBe(true)
  renameSync(join(h.directory, 'projects'), join(h.directory, 'projects-unavailable'))
  const restoredRoot = join(root, 'declared-restored')
  restoreRecoveryPoint(source, restoredRoot)
  const restored = new Store(join(restoredRoot, 'orchestrator.sqlite'))
  try {
    const artifacts = new ArtifactStore(restored, new ExecutionAttempts(restored, restoredRoot))
    let readable = false
    try { readable = artifacts.read(f.p.id, artifact.id, artifact.contentVersion).content === '# Captured file' } catch {}
    console.log('DECLARED file restore path observation', { bytesWereCaptured: copied, artifactReadableWithOriginalHidden: readable })
    expect(readable).toBe(true)
  } finally { restored.close() }
})

it('backup settings can be saved through the authenticated settings endpoint', async () => {
  h = await startRuntime()
  const response = await h.api('PUT', 'settings/backup', { revision: h.runtime.store.blockRevision('backup'), value: { enabled: false, directory: join(root, 'copies'), intervalMinutes: 5, retention: 7 } })
  console.log('BACKUP settings HTTP response', response)
  expect(response.status).toBe(200)
})

it('the actual continuation gives the worker the persisted answer content', async () => {
  h = await startRuntime()
  const f = await question('answer-content'), text = 'ANSWER_SENTINEL_DATASET_B_7391'
  expect(await h.api('POST', `tickets/${f.plan.ticketId}/attention`, { version: 1, questionId: f.q.id, text })).toMatchObject({ status: 200, body: { resolved: true } })
  await waitUntil(() => continuations(f.attempt.sessionId).length === 1)
  const context = await h.runGuardedTool(f.attempt.sessionId, 'project_worker_context', {})
  const visible = continuations(f.attempt.sessionId).map(d => d.text).join('\n') + JSON.stringify(context)
  console.log('ANSWER availability', { inContinuationOrManagedContext: visible.includes(text), tools: [...h.tools.get(f.attempt.sessionId)!.keys()] })
  expect(visible).toContain(text)
})

it('answer replay after a post-commit continuation interruption delivers once', async () => {
  h = await startRuntime()
  const f = await question('answer-crash'), body = { version: 1, questionId: f.q.id, text: 'ANSWER_BEFORE_CRASH_2747' }
  const fail = vi.spyOn(h.runtime.executor, 'continueAfterAttention').mockRejectedValueOnce(new Error('Injected exit after answer commit, before native delivery'))
  expect(await h.api('POST', `tickets/${f.plan.ticketId}/attention`, body)).toMatchObject({ status: 500 })
  expect(h.runtime.store.tickets.get(f.plan.ticketId)?.attentionHistory?.[0]?.answers[0]?.text).toBe(body.text)
  fail.mockRestore()
  const replay = await h.api('POST', `tickets/${f.plan.ticketId}/attention`, body)
  for (let i = 0; i < 3; i++) await h.runtime.pump()
  console.log('ANSWER crash/replay observation', { response: replay.body, continuations: continuations(f.attempt.sessionId).length })
  expect.soft(replay.body.resolved).toBe(true)
  expect.soft(continuations(f.attempt.sessionId)).toHaveLength(1)
})

it('returns the same answer receipt and retains a conflicting answer for reconciliation', async () => {
  h = await startRuntime()
  const f = await question('answer-conflict'), body = { version: 1, questionId: f.q.id, text: 'FIRST_ANSWER_2747' }
  const first = await h.api('POST', `tickets/${f.plan.ticketId}/attention`, body)
  const same = await h.api('POST', `tickets/${f.plan.ticketId}/attention`, body)
  const conflict = 'CONFLICT_ANSWER_7391'
  await h.api('POST', `tickets/${f.plan.ticketId}/attention`, { ...body, text: conflict })
  const ticket = h.runtime.store.tickets.get(f.plan.ticketId)!
  console.log('ANSWER repeat/conflict observation', { first: first.body, same: same.body, retainedConflict: JSON.stringify(ticket).includes(conflict) })
  expect.soft(same.body).toEqual(first.body)
  expect.soft(JSON.stringify(ticket)).toContain(conflict)
})

it('keeps a paused answer queued and delivers it once after explicit resume', async () => {
  h = await startRuntime()
  const f = await question('answer-paused'), text = 'PAUSED_ANSWER_8391'
  h.runtime.engine.pauseTicket(f.plan.ticketId); h.runtime.executor.dispatchProjects()
  await waitUntil(() => h!.runtime.store.tickets.get(f.plan.ticketId)?.lifecycle?.pause.state === 'paused')
  expect(await h.api('POST', `tickets/${f.plan.ticketId}/attention`, { version: 1, questionId: f.q.id, text })).toMatchObject({ status: 200, body: { resolved: true } })
  expect(continuations(f.attempt.sessionId)).toHaveLength(0)
  expect(h.runtime.store.tickets.get(f.plan.ticketId)?.lifecycle?.pause.intent).toBe('pause')
  expect(await h.api('POST', `tickets/${f.plan.ticketId}/resume`)).toMatchObject({ status: 200 })
  for (let i = 0; i < 3; i++) await h.runtime.pump()
  await waitUntil(() => continuations(f.attempt.sessionId).length === 1)
  expect(continuations(f.attempt.sessionId)).toHaveLength(1)
})
