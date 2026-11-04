/** Actual rc.5 JobRegistry and SQLite ownership probes; only the final range case starts OS processes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/app/store.ts'
import { ManagedBudgetHooks, ProjectScheduler } from '../src/app/scheduler.ts'
import { NativeValidationJobAdapter, validationJobPersistence, type ValidationProcessResult } from '../src/app/native-validation-job.ts'
import { deferred, waitUntil } from './fixtures/async.ts'

const rcRoot = process.env.DSH_RC5_RUNTIME
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const passed = (): ValidationProcessResult => ({ status: 'passed', exitCode: 0, stdout: 'actual producer output', stderr: '', physicalExit: true })
const identity = { executionId: 'attempt-a', projectId: 'project-a', gitAuthorName: 'Owner', gitAuthorEmail: 'owner@example.test', capturedAt: '2026-11-04T00:00:00.000Z' }
const owner = { projectId: 'project-a', ownerId: 'owner-a', attemptId: 'attempt-a', lease: 'lease-a', validate: () => {} }
async function fixture(runner: { run: (...args: any[]) => Promise<any> }, inspectExit: (...args: any[]) => Promise<boolean> = async () => false) {
  const req = createRequire(join(rcRoot!, 'package.json'))
  for (const pkg of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-jobs-local']) expect(req(pkg + '/package.json').version).toBe('0.2.1-rc.5')
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const { Session, SessionId } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session')).href)
  const { LocalJobRegistry } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-jobs-local')).href)
  const ctx = new Context(), owners = new Map<string, any>()
  for (const id of ['owner-a', 'owner-b']) owners.set(id, { id: SessionId(id), ctx, session: Session.create(SessionId(id)), status: 'idle' })
  ctx.reflect.provide('agents', { get: (id: string) => owners.get(id), currentInitiator: () => undefined })
  const jobs = new LocalJobRegistry(ctx, { maxConcurrentJobsPerOwner: 10, retainBytes: 262144, settledRetainBytes: 16384, pumpPollMs: 20 })
  const detach = jobs.attachController('T7-validation-boundary-test')
  const root = mkdtempSync(join(tmpdir(), 't7-native-validation-')); roots.push(root)
  let store = new Store(join(root, 'application.sqlite'))
  const persistence = { list: () => validationJobPersistence(store).list(), save: (row: Parameters<ReturnType<typeof validationJobPersistence>['save']>[0]) => validationJobPersistence(store).save(row) }
  const reopen = () => { store.close(); store = new Store(join(root, 'application.sqlite')); return store }
  const makeScheduler = () => new ProjectScheduler({ limits: () => ({ model: 1, worker: 1, background: 1 }) })
  const scheduler = makeScheduler()
  const options = { persistence, jobs, inspectExit, exitWaitMs: 200, maxRunMs: 5_000 }
  const adapter = new NativeValidationJobAdapter(scheduler, runner, options)
  const cleanup = async () => {
    adapter.stopOwner('owner-a'); adapter.stopOwner('owner-b')
    for (const row of adapter.records().filter(row => row.phase !== 'exited')) {
      options.inspectExit = async () => true
      await adapter.reconcile(row.id)
    }
    detach(); await jobs.disposeAll(); store.close()
  }
  return { req, ctx, jobs, owners, detach, root, get store() { return store }, reopen, persistence, scheduler, makeScheduler, options, adapter, cleanup }
}
const suite = describe.skipIf(!rcRoot)
suite('durable native validation ownership through actual rc.5 registry', () => {
  it('registers an owned native job and shares exactly one background reservation with ManagedBudgetHooks until producer exit', async () => {
    const done = deferred<ValidationProcessResult>(), run = vi.fn(() => done.promise), f = await fixture({ run })
    const hooks = new ManagedBudgetHooks(f.ctx, f.scheduler, { resolve: id => id === owner.ownerId ? owner : undefined, owners: () => [owner] })
    hooks.install()
    try {
      const pending = f.adapter.run(owner, 'op-a', ['node', 'test.js'], f.root, identity, new AbortController().signal)
      await waitUntil(() => run.mock.calls.length === 1)
      const row = f.adapter.records()[0]!
      expect(f.jobs.get(row.nativeJobId, 'owner-a')).toMatchObject({ owner: 'owner-a', status: 'running' })
      expect(f.scheduler.status()).toHaveLength(1)
      expect(f.adapter.ownerExitKnown('owner-a')).toBe(false)
      expect(f.owners.get('owner-a').session.snapshotEvents().some((event: any) => event.type === 'job/registered' && event.data.jobId === row.nativeJobId)).toBe(true)
      done.resolve(passed()); expect(await pending).toMatchObject({ status: 'passed', physicalExit: true })
      expect(f.adapter.records()[0]).toMatchObject({ phase: 'exited', physicalExit: true, result: { exitCode: 0 } })
      hooks.sync(); expect(f.scheduler.status()).toEqual([])
      expect(f.adapter.ownerExitKnown('owner-a')).toBe(true)
      expect(f.owners.get('owner-a').session.snapshotEvents().some((event: any) => event.type === 'job/settled' && event.data.producerReported === true)).toBe(true)
    } finally { done.resolve(passed()); hooks.dispose(); await f.cleanup() }
  })
  it('does not release a nonaborted throwing producer and reconstructs the durable unknown after a SQLite reopen', async () => {
    const run = vi.fn(async () => { throw new Error('range observation failed') }), f = await fixture({ run })
    try {
      expect(await f.adapter.run(owner, 'op-unknown', ['node'], f.root, identity, new AbortController().signal)).toMatchObject({ status: 'unknown' })
      expect(f.scheduler.status()).toHaveLength(1)
      expect(await f.adapter.reconcile('op-unknown')).toBe(false)
      const reopened = f.reopen(), scheduler = f.makeScheduler()
      const restored = new NativeValidationJobAdapter(scheduler, { run }, { ...f.options, persistence: validationJobPersistence(reopened) })
      expect(scheduler.status()).toHaveLength(1)
      expect(restored.ownerExitKnown('owner-a')).toBe(false)
      expect(await restored.run(owner, 'op-unknown', ['node'], f.root, identity, new AbortController().signal)).toMatchObject({ status: 'unknown' })
      expect(run).toHaveBeenCalledOnce()
      // Missing/terminal registry records alone never release the reconstructed reservation.
      expect(await restored.reconcile('op-unknown')).toBe(false)
    } finally { await f.cleanup() }
  })
  it('keeps a successful label without physical exit unknown and requires the registered exit observer to reconcile', async () => {
    let exited = false
    const f = await fixture({ run: async () => ({ status: 'passed', exitCode: 0, stdout: '', stderr: '' }) }, async () => exited)
    try {
      expect(await f.adapter.run(owner, 'op-label', ['node'], f.root, identity, new AbortController().signal)).toMatchObject({ status: 'unknown' })
      expect(await f.adapter.reconcile('op-label')).toBe(false)
      expect(f.scheduler.status()).toHaveLength(1)
      exited = true
      expect(await f.adapter.reconcile('op-label')).toBe(true)
      expect(f.adapter.records()[0]).toMatchObject({ phase: 'exited', result: { status: 'aborted' } })
      expect(f.scheduler.status()).toEqual([])
    } finally { await f.cleanup() }
  })
  it('cancels the actual native job but keeps occupancy until its compliant producer confirms exit', async () => {
    const done = deferred<ValidationProcessResult>(); let childSignal: AbortSignal | undefined
    const f = await fixture({ run: async (_a, _c, _i, signal) => { childSignal = signal; return done.promise } })
    try {
      const pending = f.adapter.run(owner, 'op-stop', ['node'], f.root, identity, new AbortController().signal)
      await waitUntil(() => childSignal !== undefined)
      f.adapter.stopOwner(owner.ownerId)
      expect(childSignal!.aborted).toBe(true)
      expect(await pending).toMatchObject({ status: 'unknown' })
      expect(f.jobs.get(f.adapter.records()[0]!.nativeJobId, 'owner-a').status).toBe('stopping')
      expect(f.scheduler.status()).toHaveLength(1)
      done.resolve(passed())
      await waitUntil(() => f.adapter.records()[0]?.phase === 'exited')
      expect(f.adapter.records()[0]!.result?.status).toBe('aborted')
      expect(f.scheduler.status()).toEqual([])
    } finally { done.resolve(passed()); await f.cleanup() }
  })
  it('denies a queued stale owner before native registration and leaves another project untouched', async () => {
    const run = vi.fn(async () => passed()), f = await fixture({ run }); let allowed = true
    const blocker = f.scheduler.adopt({ id: 'other-project-live', projectId: 'project-b', ownerId: 'owner-b', kind: 'background' })
    try {
      const pending = f.adapter.run({ ...owner, validate: () => { if (!allowed) throw new Error('lease revoked') } }, 'op-queued', ['node'], f.root, identity, new AbortController().signal)
      const refused = expect(pending).rejects.toThrow('lease revoked')
      allowed = false; blocker.release(); await refused
      expect(run).not.toHaveBeenCalled()
      expect(f.jobs.list('owner-a')).toEqual([])
      expect(f.adapter.records()[0]).toMatchObject({ phase: 'exited', physicalExit: true })
    } finally { blocker.release(); await f.cleanup() }
  })
  it('does not promote a physically exited result after the attempt lease changes', async () => {
    const done = deferred<ValidationProcessResult>(), run = vi.fn(() => done.promise), f = await fixture({ run }); let valid = true
    try {
      const pending = f.adapter.run({ ...owner, validate: () => { if (!valid) throw new Error('stale execution lease') } }, 'op-stale', ['node'], f.root, identity, new AbortController().signal)
      await waitUntil(() => run.mock.calls.length === 1)
      valid = false; done.resolve(passed())
      expect(await pending).toMatchObject({ status: 'aborted', physicalExit: true })
      expect(f.scheduler.status()).toEqual([])
    } finally { done.resolve(passed()); await f.cleanup() }
  })
  it('reserves one exact operation and rejects changed payloads instead of rerunning', async () => {
    const done = deferred<ValidationProcessResult>(), run = vi.fn(() => done.promise), f = await fixture({ run })
    try {
      const first = f.adapter.run(owner, 'op-once', ['node'], f.root, identity, new AbortController().signal)
      const duplicate = f.adapter.run(owner, 'op-once', ['node'], f.root, identity, new AbortController().signal)
      await expect(f.adapter.run(owner, 'op-once', ['python'], f.root, identity, new AbortController().signal)).rejects.toThrow('identity conflict')
      done.resolve(passed()); expect(await duplicate).toEqual(await first); expect(run).toHaveBeenCalledOnce()
      expect(await f.adapter.run(owner, 'op-once', ['node'], f.root, identity, new AbortController().signal)).toMatchObject({ status: 'passed' })
      expect(run).toHaveBeenCalledOnce()
    } finally { done.resolve(passed()); await f.cleanup() }
  })
  it('fails closed before the process when native controllers or durable services are absent', async () => {
    const run = vi.fn(async () => passed()), f = await fixture({ run })
    try {
      const noServices = new NativeValidationJobAdapter(f.scheduler, { run })
      await expect(noServices.run(owner, 'op-no-services', ['node'], f.root, identity, new AbortController().signal)).rejects.toThrow('services are unavailable')
      f.detach()
      await expect(f.adapter.run(owner, 'op-no-controller', ['node'], f.root, identity, new AbortController().signal)).rejects.toThrow()
      expect(run).not.toHaveBeenCalled(); expect(f.scheduler.status()).toEqual([])
      expect(f.adapter.records()[0]).toMatchObject({ phase: 'exited', physicalExit: true })
    } finally { await f.cleanup() }
  })

  it('retires a queued scheduler admission when reconciliation proves no producer started', async () => {
    const run = vi.fn(async () => passed()), f = await fixture({ run })
    const blocker = f.scheduler.adopt({ id: 'other-live', projectId: 'project-b', ownerId: 'owner-b', kind: 'background' })
    try {
      const pending = f.adapter.run(owner, 'op-queued-reconcile', ['node'], f.root, identity, new AbortController().signal)
      const refused = expect(pending).rejects.toThrow()
      expect(await f.adapter.reconcile('op-queued-reconcile')).toBe(true)
      blocker.release(); await refused
      expect(run).not.toHaveBeenCalled(); expect(f.jobs.list('owner-a')).toEqual([])
    } finally { blocker.release(); await f.cleanup() }
  })
  it('stops a live native producer even when its application journal cannot be read', async () => {
    let signal: AbortSignal | undefined
    const f = await fixture({ run: async (_a, _c, _i, childSignal) => { signal = childSignal; return { status: 'unknown', stdout: '', stderr: '' } } })
    const persistence = f.options.persistence
    try {
      await f.adapter.run(owner, 'op-journal-outage', ['node'], f.root, identity, new AbortController().signal)
      f.options.persistence = { list: () => { throw new Error('Journal unavailable') }, save: persistence.save }
      expect(() => f.adapter.stopOwner(owner.ownerId)).not.toThrow()
      expect(signal!.aborted).toBe(true)
      f.options.persistence = persistence
      expect(f.scheduler.status()).toHaveLength(1)
    } finally { f.options.persistence = persistence; await f.cleanup() }
  })
  it('preserves unknown occupancy when reconciliation is cancelled during native settlement', async () => {
    const f = await fixture({ run: async () => ({ status: 'unknown', stdout: '', stderr: '' }) }, async () => true)
    const jobs = f.options.jobs
    try {
      await f.adapter.run(owner, 'op-cancel-reconcile', ['node'], f.root, identity, new AbortController().signal)
      const control = new AbortController()
      f.options.jobs = { start: jobs.start.bind(jobs), kill: jobs.kill.bind(jobs), wait: async () => { control.abort(new Error('Inspection cancelled')); throw control.signal.reason } }
      await expect(f.adapter.reconcile('op-cancel-reconcile', control.signal)).rejects.toThrow('Inspection cancelled')
      expect(f.adapter.records()[0]!.phase).toBe('unknown'); expect(f.scheduler.status()).toHaveLength(1)
    } finally { f.options.jobs = jobs; await f.cleanup() }
  })
  it('does not equate actual parent exit0 with an empty native subprocess range', async () => {
    let handle: any
    const f = await fixture({ run: async (argv, cwd, _identity, signal) => {
      const { LocalSubprocessRuntime } = await import(pathToFileURL(f.req.resolve('@deepseek-ai/dsh-subprocess-local')).href)
      const subprocess = new LocalSubprocessRuntime(f.ctx)
      handle = subprocess.spawn({ argv, cwd, signal, graceMs: 100, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
      const exit = await handle.done
      expect(exit.exitCode).toBe(0)
      const empty = await handle.waitForExit(AbortSignal.timeout(50))
      return { status: empty ? 'passed' : 'unknown', exitCode: exit.exitCode, stdout: '', stderr: '', ...(empty ? { physicalExit: true } : {}) }
    } }, async (_record, signal) => handle ? handle.waitForExit(AbortSignal.any([signal, AbortSignal.timeout(200)])) : false)
    try {
      const script = "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref()"
      const result = await f.adapter.run(owner, 'op-range', [process.execPath, '-e', script], f.root, identity, new AbortController().signal)
      expect(result.status).toBe('unknown'); expect(f.scheduler.status()).toHaveLength(1)
      expect(await f.adapter.reconcile('op-range')).toBe(false)
      f.adapter.stopOwner(owner.ownerId)
      await handle.waitForExit(AbortSignal.timeout(2000))
      expect(await f.adapter.reconcile('op-range')).toBe(true)
      expect(f.scheduler.status()).toEqual([])
    } finally { handle?.terminate(); if (handle) await handle.waitForExit(AbortSignal.timeout(2000)); await f.cleanup() }
  })
})
