/** Independent capture contract matrix for fixed source 30594c89cff4c163f9db458350064aa9ae3327e8.
 * Correct-behavior assertions, not green counterexamples. All disk data is synthetic and allocated per test.
 * Runtime/Store/native protocol classes are real; host transport uses the in-memory native fixture.
 * Integration copies belong under tests/ so fixture/source imports resolve.
 */
/** Independent intended behavior; copied to review-artifacts for fixed-HEAD runs. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { startRuntime, type Host } from './fixtures/host.ts'
import { feishu } from './fixtures/host.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
import { Store } from '../src/app/store.ts'
import { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import { ConversationStore } from '../src/app/conversation-store.ts'
import { BackupService, type BackupServiceOptions } from '../src/app/backup-service.ts'
import { createRecoveryPoint, restoreRecoveryPoint, type RecoveryManifest } from '../src/app/backup.ts'
import { workerFixture } from './fixtures/project-worker.ts'

let h: Host | undefined, base: string
const stoppedServices: BackupService[] = [], stores: Store[] = []
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 't5-capture-contract-')); h = undefined })
afterEach(async () => {
  for (const service of stoppedServices.splice(0)) service.stop()
  if (h) { for (const agent of h.agents.values()) agent.status = 'idle'; await h.stop() }
  for (const store of stores.splice(0)) store.close()
  vi.useRealTimers(); vi.restoreAllMocks(); syncBuiltinESMExports(); rmSync(base, { recursive: true, force: true })
})
function emptyIdle(agent: any) { agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0 }
async function managedTask(label: string, retired = false) {
  const c = h!.runtime.projectCoordinator, p = c.create('owner', { name: label, goal: 'Capture only related work' })
  c.conversations.appendUser(p.id, 'owner', { clientRequestKey: `original-${label}`, text: 'Write one note.' })
  const plan = c.plans.save('owner', p.id, { expectedRevision: 0, operationId: `plan-${label}`, plan: { goal: label, scope: 'One file', outputs: ['note'], resources: [], environment: 'Managed', cost: 'One worker', completion: 'One note', acceptance: { version: 1, mode: 'human-review' } } })
  c.confirm('owner', p.id, { ticketId: plan.ticketId, planRevision: 1, operationId: `confirm-${label}`, intent: 'execute' })
  h!.runtime.executor.dispatchProjects()
  await waitUntil(() => c.attempts.all().some(a => a.ticketId === plan.ticketId && a.status === 'running'))
  const attempt = c.attempts.all().find(a => a.ticketId === plan.ticketId)!
  const artifact = c.artifacts.write(attempt.sessionId, { operationId: 'file', output: 'note', name: 'note.md', content: `# ${label}` })
  emptyIdle(h!.agents.get(attempt.sessionId)!)
  const cwd = join(h!.directory, 'projects', p.id, 'coordinator'); mkdirSync(cwd, { recursive: true })
  const workspace = await h!.ctx.workspaceRegistry.create(realpathSync(cwd))
  const first = c.conversations.saveMapping(p.id, 'owner', { sessionId: `project-coordinator-${label}-1`, workspaceId: workspace.id, cwd: realpathSync(cwd) })
  await h!.controller.create({ sessionId: first.sessionId, workspaceId: workspace.id })
  const mapping = retired ? c.conversations.saveMapping(p.id, 'owner', { sessionId: `project-coordinator-${label}-2`, workspaceId: workspace.id, cwd: realpathSync(cwd), expectedGeneration: first.generation, reconciled: true, reason: 'Known read-only generation replaced' }) : first
  if (retired) await h!.controller.create({ sessionId: mapping.sessionId, workspaceId: workspace.id })
  return { c, p, plan, attempt, artifact, mapping, referencedIds: [...new Set([attempt.sessionId, first.sessionId, mapping.sessionId])] }
}

function nativeStore() {
  const rows = new Map<string, { session: Session; marker: string }>(), hidden = new Set<string>()
  let afterRead: undefined | ((id: string) => Promise<void>), readFaultUsed = false
  function add(id: string, cwd = h!.directory, marker = `RELATED_BODY_${id}`) {
    const branded = SessionId(id), session = Session.create(branded, [], { ...Session.create(branded).header, cwd })
    rows.set(id, { session, marker }); append(id, marker)
  }
  function append(id: string, text: string) {
    const session = rows.get(id)!.session, turn = session.snapshotEvents().filter(e => e.type === 'turn/start').length + 1
    session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 })
    session.append('system/message', { turn, step: 1, message: { id: MessageId(`${id}:${turn}`), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  function refresh() { for (const [id, agent] of h!.agents) if (!rows.has(id)) add(id, (agent as any).session.header.cwd ?? h!.directory) }
  function snapshot(id: string) {
    if (hidden.has(id) || !rows.has(id)) return undefined
    const session = rows.get(id)!.session
    return { header: session.header, revision: SessionPersistenceRevision(`${id}:${session.snapshotEvents().length}`), eventCount: session.snapshotEvents().length, formatStatus: 'current' as const }
  }
  const persistence = h!.ctx.sessionPersistence as any
  refresh()
  persistence.flush = vi.fn(async () => { refresh() })
  persistence.list = vi.fn(async () => { refresh(); return [...rows.keys()].flatMap(id => snapshot(id) ? [snapshot(id)!] : []) })
  persistence.stat = vi.fn(async (id: string) => { refresh(); return snapshot(id) })
  persistence.open = vi.fn(async (id: string) => {
    refresh(); const row = rows.get(id)
    if (!row || hidden.has(id)) throw new Error(`Synthetic native Session missing: ${id}`)
    return { id: SessionId(id), header: row.session.header, inheritedEventCount: 0, access: 'read',
      read: async () => {
        const events = row.session.snapshotEvents()
        if (afterRead && !readFaultUsed) { readFaultUsed = true; await afterRead(id) }
        return { eventState: 'detached', events }
      }, close: async () => {}, [Symbol.asyncDispose]: async () => {} }
  })
  return { rows, hidden, add, append, persistence, setReadFault: (fault: (id: string) => Promise<void>) => { afterRead = fault } }
}
function startBackup(retention = 7) {
  const copies = join(base, 'copies')
  h!.runtime.backup.start({ enabled: false, directory: copies, intervalMinutes: 5, retention })
  return copies
}
async function capture() { return h!.runtime.backup.run('manual').then(manifest => ({ manifest }), error => ({ error })) }
function pointPath(copies: string) { return join(copies, readdirSync(copies).sort().at(-1)!) }
function readNativeBodies(point: string, manifest: RecoveryManifest) {
  const refs = (manifest as RecoveryManifest & { nativeSessions?: { id: string; path: string }[] }).nativeSessions ?? []
  return refs.map(ref => ({ id: ref.id, value: JSON.parse(readFileSync(join(point, ref.path), 'utf8')) }))
}

it('exports exactly related mapped IDs, including retired generations, and excludes ordinary/prefix decoys', async () => {
  h = await startRuntime(); const a = await managedTask('scope-a', true), b = await managedTask('scope-b')
  const native = nativeStore(), allowed = new Set([h.runtime.masterId, ...a.referencedIds, ...b.referencedIds])
  native.add('ordinary-private-chat', h.directory, 'UNRELATED_PRIVATE_MARKER')
  native.add('project-unmapped-prefix-decoy', h.directory, 'PREFIX_DECOY_PRIVATE_MARKER')
  const copies = startBackup(), manifest = await h.runtime.backup.run('manual'), point = pointPath(copies)
  const bodies = readNativeBodies(point, manifest)
  expect(new Set(bodies.map(row => row.id))).toEqual(allowed)
  expect(native.persistence.open.mock.calls.map((call: any[]) => call[0]).every((id: string) => allowed.has(id))).toBe(true)
  const bytes = manifest.files.map(file => readFileSync(join(point, file.path)).toString('utf8')).join('\n')
  expect(bytes).not.toContain('UNRELATED_PRIVATE_MARKER'); expect(bytes).not.toContain('PREFIX_DECOY_PRIVATE_MARKER')
  for (const row of bodies) expect(JSON.stringify(row.value)).toContain(`RELATED_BODY_${row.id}`)
})

it('does not lose an acknowledged app input while native capture is awaiting', async () => {
  h = await startRuntime(); const f = await managedTask('input-during-capture'), native = nativeStore()
  let accepted = false
  native.setReadFault(async () => {
    const result = await h!.api('POST', `tickets/${f.plan.ticketId}/pause`)
    accepted = result.status === 200
  })
  const copies = startBackup(), result = await capture()
  if ('error' in result) { expect(h.runtime.backup.list()).toEqual([]); return }
  const db = new DatabaseSync(join(pointPath(copies), result.manifest.database.file), { readOnly: true })
  try {
    const ticket = JSON.parse(String(db.prepare('SELECT value FROM ticket WHERE id=?').get(f.plan.ticketId)?.value))
    if (accepted) expect(ticket.lifecycle.pause.intent).toBe('pause')
  } finally { db.close() }
})

it('handles a new related Session/mapping created during a native read as a new coherent cut or incomplete', async () => {
  h = await startRuntime(); const f = await managedTask('scope-during-capture'), native = nativeStore()
  let newId = '', mutationAccepted = false
  native.setReadFault(async () => {
    try {
      const old = f.c.conversations.currentMapping(f.p.id)!
      newId = 'project-coordinator-new-during-capture'
      const next = f.c.conversations.saveMapping(f.p.id, 'owner', { sessionId: newId, workspaceId: old.workspaceId, cwd: old.cwd, expectedGeneration: old.generation, reason: 'Synthetic concurrent managed replacement', reconciled: true })
      await h!.controller.create({ sessionId: next.sessionId, workspaceId: next.workspaceId })
      native.add(next.sessionId, next.cwd); mutationAccepted = true
    } catch { /* A real capture write gate may reject the concurrent change. */ }
  })
  const copies = startBackup(), result = await capture()
  if ('error' in result) { expect(h.runtime.backup.list()).toEqual([]); return }
  if (mutationAccepted) expect(readNativeBodies(pointPath(copies), result.manifest).map(row => row.id)).toContain(newId)
})

it('does not publish a stale native body together with a causally later registered artifact', async () => {
  h = await startRuntime(); const f = await managedTask('native-revision-change'), native = nativeStore()
  let affected = '', newArtifact = ''
  native.setReadFault(async id => {
    affected = id; native.append(id, 'NATIVE_REVISION_CHANGED_DURING_CAPTURE')
    const a = f.c.artifacts.write(f.attempt.sessionId, { operationId: 'later-version', output: 'note', name: 'later.md', content: '# Later durable result' }); newArtifact = a.id
  })
  const copies = startBackup(), result = await capture()
  if ('error' in result) { expect(h.runtime.backup.list()).toEqual([]); return }
  const point = pointPath(copies), bodies = readNativeBodies(point, result.manifest)
  expect(JSON.stringify(bodies.find(row => row.id === affected)?.value)).toContain('NATIVE_REVISION_CHANGED_DURING_CAPTURE')
  const db = new DatabaseSync(join(point, result.manifest.database.file), { readOnly: true })
  try { expect(db.prepare('SELECT id FROM worker_artifact WHERE id=?').get(newArtifact)).toBeTruthy() } finally { db.close() }
})

it('new unrelated native work neither enters the archive nor invalidates the app snapshot', async () => {
  h = await startRuntime(); await managedTask('unrelated-during-capture'); const native = nativeStore()
  native.setReadFault(async () => { native.add('ordinary-created-during-capture', h!.directory, 'NEW_UNRELATED_BODY') })
  const copies = startBackup(), manifest = await h.runtime.backup.run('manual')
  expect(JSON.stringify(readNativeBodies(pointPath(copies), manifest))).not.toContain('NEW_UNRELATED_BODY')
})

it.each(['registered-artifact', 'prepared-cwd', 'known-native-session'] as const)('fails visibly if required %s material is missing', async missing => {
  h = await startRuntime(); const f = await managedTask(`missing-${missing}`), native = nativeStore()
  if (missing === 'registered-artifact') rmSync(f.artifact.path)
  if (missing === 'prepared-cwd') renameSync(f.attempt.cwd, f.attempt.cwd + '-unavailable')
  if (missing === 'known-native-session') native.hidden.add(f.attempt.sessionId)
  startBackup(); const result = await capture()
  expect.soft('error' in result).toBe(true)
  expect.soft(h.runtime.backup.list()).toEqual([])
  expect.soft(h.runtime.health.backup?.state).not.toBe('ready')
})

it('does not invent a never-persisted unused master from its allocation ID alone', async () => {
  h = await startRuntime(); await managedTask('optional-master')
  // The master has no business input/turn and was never materialized in this
  // synthetic native store. Its allocated KV ID is not evidence of a lost log.
  h.agents.delete(h.runtime.masterId)
  const native = nativeStore(); expect(native.rows.has(h.runtime.masterId)).toBe(false)
  h.controller.create.mockClear()
  const copies = startBackup(), manifest = await h.runtime.backup.run('manual')
  expect(readNativeBodies(pointPath(copies), manifest).map(row => row.id)).not.toContain(h.runtime.masterId)
  expect(h.controller.create).not.toHaveBeenCalled()
})

function unitService(store: Store, root: string, lifecycle: AbortController, verify: () => Promise<void>, now: () => Date) {
  const health = { get: vi.fn(), set: vi.fn(), release: vi.fn() }
  const service = new BackupService({ store, databasePath: join(base, 'unit.sqlite'), destinationRoot: root, recovery: {}, health, lifetime: lifecycle.signal, now,
    prepareMaterials: async () => ({ roots: {}, nativeSessions: [], consistency: 'declared-files-quiesced', verify }) })
  service.start({ enabled: false, directory: root, intervalMinutes: 5, retention: 2 }); stoppedServices.push(service)
  return { service, health }
}
it.each(['verify-error', 'stop-after-copy', 'abort-after-copy'] as const)('never promotes %s after files were written, including after service restart', async fault => {
  const store = new Store(join(base, 'unit.sqlite')); stores.push(store)
  const root = join(base, 'unit-copies'), lifetime = new AbortController(); let tick = 0
  const now = () => new Date(1_700_000_000_000 + tick++ * 1000)
  let verifyImpl = async () => {}
  const first = unitService(store, root, lifetime, () => verifyImpl(), now)
  await first.service.run('manual'); const good1 = first.service.list()[0]!.path
  const entered = deferred(), gate = deferred()
  verifyImpl = async () => { entered.resolve(); await gate.promise; if (fault === 'verify-error') throw new Error('Synthetic DB/native epoch mismatch after file verification') }
  const pending = first.service.run('manual'); await entered.promise
  const failurePoint = readdirSync(root).map(name => join(root, name)).find(path => path !== good1)!
  expect(existsSync(join(failurePoint, 'INCOMPLETE'))).toBe(true)
  if (fault === 'stop-after-copy') first.service.stop()
  if (fault === 'abort-after-copy') lifetime.abort()
  gate.resolve(); await expect(pending).rejects.toThrow()
  const fresh = unitService(store, root, new AbortController(), async () => {}, now)
  expect(fresh.service.list().map(p => p.path)).not.toContain(failurePoint)
  expect(() => fresh.service.restore(failurePoint, join(base, 'failed-point-restore'))).toThrow()
  await fresh.service.run('manual')
  expect(existsSync(good1)).toBe(true)
  expect(fresh.service.list()).toHaveLength(2)
})

it('does not list, restore or count an older integrity-valid partial point as a complete one', async () => {
  h = await startRuntime(); await managedTask('legacy-partial'); nativeStore()
  vi.useFakeTimers({ toFake: ['Date'] })
  const copies = startBackup(2)
  await h.runtime.backup.run('manual'); const good1 = h.runtime.backup.list()[0]!.path
  vi.setSystemTime(new Date(Date.now() + 500))
  const partial = join(copies, `${new Date().toISOString().replaceAll(':', '-')}-manual`)
  createRecoveryPoint(h.runtime.store, { databasePath: join(h.directory, 'orchestrator.sqlite'), destination: partial, roots: { workspaces: [join(h.directory, 'projects')] } })
  expect.soft(h.runtime.backup.list().map(p => p.path)).not.toContain(partial)
  let restoreAccepted = false
  try { h.runtime.backup.restore(partial, join(base, 'partial-restored')); restoreAccepted = true } catch {}
  expect.soft(restoreAccepted).toBe(false)
  vi.setSystemTime(new Date(Date.now() + 500))
  await h.runtime.backup.run('manual')
  expect.soft(existsSync(good1)).toBe(true)
  expect.soft(h.runtime.backup.list()).toHaveLength(2)
})

it('preserves one ownership tree under overlapping parent/child roots and canonical aliases', () => {
  const directory = mkdtempSync('/tmp/t5-overlap-contract-'), hidden = directory + '-hidden'
  const f = workerFixture(directory, { version: 1, mode: 'registered-files' }); let open = true
  try {
    const attempt = f.prepare(), id = SessionId(attempt.sessionId), session = Session.create(id, [], { ...Session.create(id).header, cwd: attempt.cwd })
    const point = join(base, 'overlap-point')
    createRecoveryPoint(f.store, { databasePath: join(directory, 'project.sqlite'), destination: point, roots: { workspaces: [attempt.cwd, attempt.root] }, nativeSessions: [{ id, header: session.header, events: session.snapshotEvents(), inheritedEventCount: 0 }], consistency: 'declared-files-quiesced' })
    f.store.close(); open = false; renameSync(directory, hidden)
    const target = join(base, 'overlap-restored'), manifest = restoreRecoveryPoint(point, target)
    const store = new Store(join(target, 'orchestrator.sqlite'))
    try {
      const attempts = new ExecutionAttempts(store, target), restored = attempts.bySession(attempt.sessionId)!
      expect.soft(() => attempts.validateDirectory(restored)).not.toThrow()
      const archive = JSON.parse(readFileSync(join(target, manifest.nativeSessions[0]!.path), 'utf8'))
      expect(archive.header.cwd).toBe(restored.cwd)
      expect(existsSync(restored.root)).toBe(true); expect(existsSync(restored.cwd)).toBe(true)
    } finally { store.close() }
  } finally { if (open) f.store.close(); rmSync(directory, { recursive: true, force: true }); rmSync(hidden, { recursive: true, force: true }) }
})

it('restores every scoped native cwd and checkpoint file after the original state directory is unavailable', async () => {
  h = await startRuntime(); const f = await managedTask('master-checkpoint-detach')
  h.runtime.engine.pauseTicket(f.plan.ticketId); h.runtime.executor.dispatchProjects()
  await waitUntil(() => h!.runtime.store.tickets.get(f.plan.ticketId)?.lifecycle?.pause.state === 'paused')
  expect(h.runtime.store.tickets.get(f.plan.ticketId)?.lifecycle?.checkpoint?.files).toHaveLength(1)
  nativeStore(); const copies = startBackup(), manifest = await h.runtime.backup.run('manual'), point = pointPath(copies)
  await h.runtime.stop(); renameSync(h.directory, join(base, 'original-state-unavailable'))
  const target = join(base, 'detached-restored'), restoredManifest = h.runtime.backup.restore(point, target)
  const invalidHeaders = readNativeBodies(target, restoredManifest).filter(row => { try { return !realpathSync(row.value.header.cwd) } catch { return true } }).map(row => row.id)
  const store = new Store(join(target, 'orchestrator.sqlite'))
  try {
    const ticket = store.tickets.get(f.plan.ticketId)!
    const checkpointReadable = ticket.lifecycle!.checkpoint!.files.map(path => { try { return readFileSync(path, 'utf8') === '# master-checkpoint-detach' } catch { return false } })
    console.log('DETACHED native/checkpoint observation', { invalidHeaders, checkpointReadable })
    expect.soft(invalidHeaders).toEqual([])
    expect.soft(checkpointReadable).toEqual([true])
  } finally { store.close() }
})

it('does not admit a never-existing file combination when a live owner writer returns bytes to their old values', async () => {
  h = await startRuntime(); const f = await h.acceptedTicket(feishu('aba-file-writer-1', 'Run the experiment.'))
  const job = h.jobs.run(f.sessionId, 'registered writer with reversible working data')
  nativeStore()
  const cwd = f.ticket.execution!.directory!, a = join(cwd, 'a-work.txt'), b = join(cwd, 'b-work.txt')
  writeFileSync(a, '0'); writeFileSync(b, '0')
  const read = fs.readFileSync.bind(fs); let aReads = 0, bReads = 0, raised = false, reset = false
  const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...args: any[]) => {
    const active = h!.jobs.service.list(f.sessionId).some(value => value.id === job && value.status === 'running')
    if (String(path) === a) {
      aReads++
      if (active && aReads === 4 && raised) { writeFileSync(b, '0'); writeFileSync(a, '0'); reset = true }
    }
    if (String(path) === b) {
      bReads++
      if (active && bReads === 2) { writeFileSync(a, '1'); writeFileSync(b, '1'); raised = true }
    }
    return (read as any)(path, ...args)
  }) as any)
  syncBuiltinESMExports()
  const copies = startBackup(), result = await capture()
  readSpy.mockRestore(); syncBuiltinESMExports()
  if ('error' in result) return
  const point = pointPath(copies), values = ['a-work.txt', 'b-work.txt'].map(name => readFileSync(join(point, result.manifest.files.find(file => file.path.endsWith('/' + name))!.path), 'utf8'))
  // Live source transitions 00 -> 10 -> 11 -> 10 -> 00, never 01. The
  // assertion permits refusal or any coherent snapshot mechanism, not a
  // particular admission implementation or a claimed mode string.
  console.log('ABA file capture observation', { raised, reset, values, source: [readFileSync(a, 'utf8'), readFileSync(b, 'utf8')], consistency: result.manifest.consistency })
  expect(values[0]).toBe(values[1])
})
