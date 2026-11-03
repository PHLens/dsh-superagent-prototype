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


it('restores a discussion-only project coordinator cwd and its files after all source directories are unavailable', async () => {
  h = await startRuntime()
  const c = h.runtime.projectCoordinator, p = c.create('owner', { name: 'Discussion only', goal: 'Discuss before deciding on work' })
  c.conversations.appendUser(p.id, 'owner', { clientRequestKey: 'discussion-only', text: 'Keep this an ordinary discussion.' })
  const cwd = join(h.directory, 'projects', p.id, 'coordinator')
  mkdirSync(cwd, { recursive: true }); writeFileSync(join(cwd, 'discussion-note.md'), '# Only discussion, no Ticket')
  const workspace = await h.ctx.workspaceRegistry.create(realpathSync(cwd))
  const mapping = c.conversations.saveMapping(p.id, 'owner', { sessionId: 'project-discussion-only-1', workspaceId: workspace.id, cwd: realpathSync(cwd) })
  await h.controller.create({ sessionId: mapping.sessionId, workspaceId: workspace.id })
  expect(c.attempts.all()).toHaveLength(0); expect(h.runtime.store.tickets.list()).toHaveLength(0)
  nativeStore(); const copies = startBackup(), manifest = await h.runtime.backup.run('manual'), point = pointPath(copies)
  await h.runtime.stop(); renameSync(h.directory, join(base, 'original-discussion-state-unavailable'))
  const target = join(base, 'discussion-restored'), restoredManifest = h.runtime.backup.restore(point, target)
  const store = new Store(join(target, 'orchestrator.sqlite'))
  try {
    const restored = new ConversationStore(store).currentMapping(p.id)!
    const body = readNativeBodies(target, restoredManifest).find(row => row.id === mapping.sessionId)!.value
    console.log('DISCUSSION ONLY observation', { coverage: manifest.coverage, roots: manifest.boundaries, restoredCwd: restored.cwd, nativeCwd: body.header.cwd, directoryExists: existsSync(restored.cwd), fileExists: existsSync(join(restored.cwd, 'discussion-note.md')) })
    expect.soft(restored.cwd.startsWith(realpathSync(target))).toBe(true)
    expect.soft(existsSync(restored.cwd)).toBe(true)
    expect.soft(body.header.cwd).toBe(restored.cwd)
    expect.soft(existsSync(join(restored.cwd, 'discussion-note.md'))).toBe(true)
    if (existsSync(join(restored.cwd, 'discussion-note.md'))) expect(readFileSync(join(restored.cwd, 'discussion-note.md'), 'utf8')).toBe('# Only discussion, no Ticket')
  } finally { store.close() }
})

it('publishes and restores a complete empty application when no native Session has ever materialized', async () => {
  h = await startRuntime(); h.agents.delete(h.runtime.masterId)
  nativeStore(); const copies = startBackup(), manifest = await h.runtime.backup.run('manual'), point = pointPath(copies)
  console.log('EMPTY APPLICATION observation', { coverage: manifest.coverage, nativeSessions: manifest.nativeSessions, health: h.runtime.health.backup, listed: h.runtime.backup.list() })
  expect.soft(manifest.coverage).toEqual({ kind: 'application-full', nativeSessionIds: [] })
  expect.soft(manifest.nativeSessions).toEqual([])
  expect.soft(h.runtime.backup.list().map(row => row.path)).toContain(point)
  expect.soft(() => h!.runtime.backup.restore(point, join(base, 'empty-restored'))).not.toThrow()
})
