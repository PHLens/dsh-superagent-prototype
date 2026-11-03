/** Independent recovery completeness checks for 7616f04 / merged tree a8dc127.
 * All filesystem material is synthetic and allocated by the tests.
 * Application Runtime/SQLite are real classes; native services use the in-memory fixture.
 * Prior lifecycle/answer-delivery results remain valid. These tests expose recovery material/cut gaps.
 * Put under tests/ when integrating; a compressed native export should be checked through its restored reader.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { startRuntime, feishu, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { Store } from '../src/app/store.ts'
import { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import { ArtifactStore } from '../src/app/artifact-store.ts'
import { ConversationStore } from '../src/app/conversation-store.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { workerFixture } from './fixtures/project-worker.ts'
import { createRecoveryPoint } from '../src/app/backup.ts'

let h: Host, base: string
beforeEach(async () => { base = mkdtempSync(join(tmpdir(), 't5-completeness-review-')); h = await startRuntime() })
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports()
  for (const agent of h.agents.values()) agent.status = 'idle'
  await h.stop()
  rmSync(base, { recursive: true, force: true })
})
async function task(label: string) {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: label, goal: 'A recoverable file task' })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: `original-${label}`, text: 'Write one Markdown note.' })
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: `plan-${label}`, plan: {
    goal: label, scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed worker', cost: 'One worker', completion: 'One note', acceptance: { version: 1, mode: 'human-review' },
  } })
  c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: `confirm-${label}`, intent: 'execute' })
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => c.attempts.all().some(a => a.ticketId === plan.ticketId && a.status === 'running'))
  const attempt = c.attempts.all().find(a => a.ticketId === plan.ticketId)!
  const artifact = c.artifacts.write(attempt.sessionId, { operationId: 'file', output: 'note', name: 'note.md', content: `# ${label}` })
  const agent = h.agents.get(attempt.sessionId)!
  agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0
  const cwd = join(h.directory, 'projects', project.id, 'coordinator')
  mkdirSync(cwd, { recursive: true })
  const workspace = await h.ctx.workspaceRegistry.create(realpathSync(cwd))
  const mapping = c.conversations.saveMapping(project.id, 'owner', { sessionId: `coordinator-${project.id}`, workspaceId: workspace.id, cwd: realpathSync(cwd) })
  return { c, project, plan, attempt, artifact, mapping }
}

it('captures necessary native bodies and restores both project execution/coordinator mappings independently of original paths', async () => {
  const tasks = [await task('recover-a'), await task('recover-b')]
  const marker = 'SYNTHETIC_NATIVE_TOOL_RESULT_BODY_7616'
  const nativeRoot = join(base, 'host-native-sessions')
  mkdirSync(nativeRoot)
  const journal = tasks.map(t => {
    const id = SessionId(t.attempt.sessionId), session = Session.create(id, [], { ...Session.create(id).header, cwd: t.attempt.cwd })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('system/message', { turn: 1, step: 1, message: { id: MessageId(`native-${id}`), role: 'system', content: [{ type: 'text', text: marker }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return { sessionId: id, header: session.header, events: session.snapshotEvents() }
  })
  writeFileSync(join(nativeRoot, 'session-journal.json'), JSON.stringify(journal))
  // Provide the public persistence reader for synthetic host state outside the
  // application workspace, as native persistence actually lives independently.
  const persistence = h.ctx.sessionPersistence as any
  const managedIds = [h.runtime.masterId, ...tasks.flatMap(item => [item.attempt.sessionId, item.mapping.sessionId])]
  persistence.list = vi.fn(async () => managedIds.map(id => ({ header: { id }, revision: { sequence: 1 } })))
  persistence.stat = vi.fn(async (_id: string) => ({ revision: { sequence: 1 } }))
  persistence.open.mockImplementation(async (id: string) => ({ read: async () => ({ eventState: 'detached', events: journal.find(x => x.sessionId === id)?.events ?? [] }), [Symbol.asyncDispose]: async () => {} }))
  persistence.flush.mockClear(); persistence.open.mockClear()
  const copies = join(base, 'copies')
  h.runtime.backup.start({ enabled: false, directory: copies, intervalMinutes: 5, retention: 7 })
  const manifest = await h.runtime.backup.run('manual'), point = join(copies, readdirSync(copies)[0]!)
  const nativeBodyCaptured = manifest.files.some(file => readFileSync(join(point, file.path)).includes(Buffer.from(marker)))
  console.log('NATIVE capture observation', { nativeBodyCaptured, persistenceReads: persistence.open.mock.calls.length, persistenceFlushes: persistence.flush.mock.calls.length, declaredNativeRoots: manifest.boundaries.nativeState, consistency: manifest.consistency })
  expect.soft(nativeBodyCaptured).toBe(true)
  const pinnedRules = tasks.map(t => t.c.attempts.bySession(t.attempt.sessionId)?.context?.roleRules)
  expect(pinnedRules.every(rules => typeof rules === 'string' && rules.length > 0)).toBe(true)
  await h.runtime.stop()
  renameSync(nativeRoot, join(base, 'original-native-state-unavailable'))
  renameSync(h.directory, join(base, 'original-state-unavailable'))
  const restoredRoot = join(base, 'restored')
  h.runtime.backup.restore(point, restoredRoot)
  const store = new Store(join(restoredRoot, 'orchestrator.sqlite'))
  try {
    const attempts = new ExecutionAttempts(store, restoredRoot), artifacts = new ArtifactStore(store, attempts), conversations = new ConversationStore(store)
    const results = tasks.map((t, index) => {
      const a = attempts.bySession(t.attempt.sessionId)!, mapping = conversations.currentMapping(t.project.id)!
      let attemptPathsReadable = false, coordinatorPathReadable = false
      try { attempts.validateDirectory(a); attemptPathsReadable = true } catch {}
      try { coordinatorPathReadable = !!realpathSync(mapping.cwd) } catch {}
      return { artifactReadable: artifacts.read(t.project.id, t.artifact.id, t.artifact.contentVersion).content === `# ${t.project.name}`, attemptPathsReadable, coordinatorPathReadable, pinnedRulesPreserved: a.context?.roleRules === pinnedRules[index] }
    })
    console.log('DETACHED two-project restore observation', results)
    expect.soft(results.map(r => r.artifactReadable)).toEqual([true, true])
    expect.soft(results.map(r => r.attemptPathsReadable)).toEqual([true, true])
    expect.soft(results.map(r => r.coordinatorPathReadable)).toEqual([true, true])
  } finally { store.close() }
})

it('does not publish a file set assembled across different live writer checkpoints as a complete recovery point', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('backup-coherence-1', 'Run the experiment.'))
  const cwd = ticket.execution!.directory!, a = join(cwd, 'a-work.txt'), b = join(cwd, 'b-work.txt')
  writeFileSync(a, '0'); writeFileSync(b, '0')
  const originalRead = fs.readFileSync.bind(fs)
  let changed = false
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...args: any[]) => {
    // An external worker can progress after A has been hashed/copied/verified
    // while the synchronous backup process is about to inspect B. The live
    // pair progresses 00 -> 10 -> 11; 01 never existed at any checkpoint.
    if (String(path) === b && !changed) { changed = true; writeFileSync(a, '1'); writeFileSync(b, '1') }
    return (originalRead as any)(path, ...args)
  }) as any)
  syncBuiltinESMExports()
  const copies = join(base, 'copies')
  h.runtime.backup.start({ enabled: false, directory: copies, intervalMinutes: 5, retention: 7 })
  const result = await h.runtime.backup.run('manual').then(manifest => ({ manifest, rejected: false })).catch(() => ({ manifest: undefined, rejected: true }))
  spy.mockRestore(); syncBuiltinESMExports()
  if (result.rejected) return
  const manifest = result.manifest!, point = join(copies, readdirSync(copies)[0]!)
  const copied = ['a-work.txt', 'b-work.txt'].map(name => readFileSync(join(point, manifest.files.find(file => file.path.endsWith('/' + name))!.path), 'utf8'))
  console.log('CROSS checkpoint backup observation', { activeNativeWorker: h.agents.get(sessionId)?.status, changed, copied, incomplete: manifest.incomplete, consistency: manifest.consistency, health: h.runtime.health.backup })
  expect.soft(changed).toBe(true)
  expect.soft(copied[0]).toBe(copied[1])
})

it('restores registered artifact paths when configured roots use the actual tmp filesystem alias', async () => {
  const alias = mkdtempSync('/tmp/t5-alias-review-'), hidden = alias + '-unavailable'
  const f = workerFixture(alias, { version: 1, mode: 'registered-files' })
  let sourceOpen = true
  try {
    f.prepare()
    const artifact = f.write(), point = join(base, 'alias-point')
    const manifest = createRecoveryPoint(f.store, { databasePath: join(alias, 'project.sqlite'), destination: point, roots: { workspaces: [join(alias, 'projects')] } })
    f.store.close(); sourceOpen = false
    renameSync(alias, hidden)
    const target = join(base, 'alias-restored')
    h.runtime.backup.restore(point, target)
    const restored = new Store(join(target, 'orchestrator.sqlite'))
    try {
      const artifacts = new ArtifactStore(restored, new ExecutionAttempts(restored, target))
      let readable = false
      try { readable = artifacts.read(f.project.id, artifact.id, artifact.contentVersion).content === artifact.content } catch {}
      console.log('TMP alias restore observation', { configuredRoot: manifest.mappings[0]?.source, originalArtifactPath: artifact.path, readableAfterOriginalHidden: readable })
      expect(readable).toBe(true)
    } finally { restored.close() }
  } finally {
    if (sourceOpen) f.store.close()
    rmSync(alias, { recursive: true, force: true }); rmSync(hidden, { recursive: true, force: true })
  }
})
