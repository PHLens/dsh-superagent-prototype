/** Independent capture contract matrix for fixed source 30594c89cff4c163f9db458350064aa9ae3327e8.
 * Correct-behavior assertions, not green counterexamples. All disk data is synthetic and allocated per test.
 * Runtime/Store/native protocol classes are real; host transport uses the in-memory native fixture.
 * Integration copies belong under tests/ so fixture/source imports resolve.
 */
/** Independent intended behavior; copied to review-artifacts for fixed-HEAD runs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
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


// Explicit optional integration: no host modules are resolved unless configured.
const rc5Root = process.env.DSH_RC5_RUNTIME
const rc5Suite = rc5Root ? describe : describe.skip

async function realRcJobs() {
  const runtimeRequire = createRequire(join(rc5Root!, 'package.json'))
  for (const name of ['@deepseek-ai/dsh-jobs-local', '@deepseek-ai/dsh-agent']) {
    const version = runtimeRequire(`${name}/package.json`).version
    if (version !== '0.2.1-rc.5') throw new Error(`Expected ${name}@0.2.1-rc.5, got ${version}`)
  }
  const { Context: RcContext } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href)
  const { LocalJobRegistry } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-jobs-local')).href)
  const { agentEvents } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-agent')).href)
  const ctx = new RcContext()
  ctx.reflect.provide('agents', h!.agents)
  const registry = new LocalJobRegistry(ctx, { maxConcurrentJobsPerOwner: 10, retainBytes: 262144, settledRetainBytes: 16384, pumpPollMs: 150 })
  const detachController = registry.attachController('independent-review-inmemory')
  const facade = (h!.runtime as any).ctx.get('jobs')
  vi.spyOn(facade, 'list').mockImplementation((id: any) => registry.list(id))
  vi.spyOn(facade.events, 'subscribe').mockImplementation((filter: any, fn: any) => registry.events.subscribe(filter, fn))
  return { registry, agentEvents, cleanup: async () => { await (registry as any).disposeAll(); detachController() } }
}

rc5Suite('RC5 host integration (skipped unless DSH_RC5_RUNTIME is configured)', () => {
it.each(['owned-related-job', 'related-agent-status', 'owned-unrelated-job', 'unowned-unrelated-job'] as const)('honors actual rc.5 %s events without accepting related writer ABA or blocking unrelated activity', async kind => {
  h = await startRuntime()
  if (kind === 'owned-unrelated-job') await h.controller.create({sessionId:'ordinary-unrelated-owner'})
  const native = nativeStore(), actual = await realRcJobs()
  try {
    native.setReadFault(async () => {
      if (kind === 'related-agent-status') {
        const agent = h!.agents.get(h!.runtime.masterId)!
        agent.status = 'running'; actual.agentEvents(h!.ctx as any, agent as any).emit('agent/status', { status: 'running' })
        agent.status = 'idle'; actual.agentEvents(h!.ctx as any, agent as any).emit('agent/status', { status: 'idle' })
        return
      }
      const owner = kind === 'owned-related-job' ? h!.runtime.masterId : kind === 'owned-unrelated-job' ? 'ordinary-unrelated-owner' : undefined
      const id = actual.registry.start({kind:'review',label:'Synthetic in-memory producer, no external process',...(owner ? {owner:owner as any} : {}),run:() => ({done:Promise.resolve({status:'completed'}),cancel:() => {}})})
      await actual.registry.wait(id, 1000, owner as any)
    })
    startBackup(); const result = await capture()
    console.log('ACTUAL RC5 event observation', {kind,error:'error' in result ? String(result.error) : undefined})
    expect('error' in result).toBe(['owned-related-job','related-agent-status'].includes(kind))
  } finally { await actual.cleanup() }
})

})
