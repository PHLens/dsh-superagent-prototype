/** Concurrency and native SDK consumer contracts; real-provider acceptance is separate. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { ManagedBudgetHooks, ProjectScheduler, type BudgetKind } from '../src/app/scheduler.ts'
import { deferred, waitUntil } from './fixtures/async.ts'

const limits = { model: 1, worker: 1, background: 1 }
const request = (id: string, projectId = 'a', kind: BudgetKind = 'worker') => ({ id, projectId, kind })
afterEach(() => { vi.restoreAllMocks() })

it('rotates by project across many tasks and preserves the cursor across scheduler reconstruction', async () => {
  const cursors = new Map<BudgetKind, string>()
  const options = { limits: () => limits, cursor: { read: (kind: BudgetKind) => cursors.get(kind), write: (kind: BudgetKind, value: string) => { cursors.set(kind, value) } } }
  const s = new ProjectScheduler(options), first = await s.acquire(request('a0'))
  const a = s.acquire(request('a1')), b = s.acquire(request('b1', 'b')), b2 = s.acquire(request('b2', 'b')), c = s.acquire(request('c1', 'c'))
  first.release(); const lb = await b
  expect(s.status().find(row => row.id === 'a1')?.state).toBe('queued')
  lb.release(); const lc = await c
  lc.release(); const la = await a
  la.release(); (await b2).release()
  const restored = new ProjectScheduler(options), occupied = restored.adopt(request('physical', 'c'))
  const nextB = restored.acquire(request('b3', 'b')), nextA = restored.acquire(request('a2'))
  occupied.release(); (await nextA).release(); (await nextB).release()
  expect(restored.status()).toEqual([])
})

it('keeps model, worker and background totals independent and makes project-cap waits visible', async () => {
  const s = new ProjectScheduler({ limits: () => ({ model: 1, worker: 2, background: 1, perProject: { worker: 1 } }) })
  const a = await s.acquire(request('a')), a2 = s.acquire(request('a2'))
  const b = await s.acquire(request('b', 'b'))
  const model = await s.acquire(request('m', 'a', 'model')), bg = await s.acquire(request('j', 'a', 'background'))
  expect(s.status().find(row => row.id === 'a2')?.waitingReason).toBe('project-fairness')
  a.release(); (await a2).release(); b.release(); model.release(); bg.release()
})

it('cancels queued requests and revalidates authorization after capacity becomes available', async () => {
  const s = new ProjectScheduler({ limits: () => limits }), first = await s.acquire(request('first'))
  const control = new AbortController(), validate = vi.fn(() => { throw new Error('Authorization revoked') })
  const cancelled = s.acquire({ ...request('cancel'), signal: control.signal }); const cancellation = expect(cancelled).rejects.toThrow('cancelled')
  control.abort(new Error('cancelled')); await cancellation
  const invalid = s.acquire({ ...request('invalid'), validate }); const rejection = expect(invalid).rejects.toThrow('revoked')
  first.release(); await rejection
  expect(validate).toHaveBeenCalledTimes(1); expect(s.status()).toEqual([])
})

it('does not release active work on close or abort and rejects duplicate execution identity', async () => {
  const s = new ProjectScheduler({ limits: () => limits }), control = new AbortController()
  const active = await s.acquire({ ...request('live'), signal: control.signal })
  await expect(s.acquire(request('live'))).rejects.toThrow('Duplicate')
  const queued = s.acquire(request('queued')), rejection = expect(queued).rejects.toThrow('closed')
  s.close(); control.abort(); await rejection
  expect(s.status()).toEqual([expect.objectContaining({ id: 'live', state: 'running' })])
  active.release(); active.release(); expect(s.status()).toEqual([])
})

it('adopts observed over-budget resources without admitting new work until enough real exits', async () => {
  const s = new ProjectScheduler({ limits: () => limits })
  const a = s.adopt(request('old-a')), b = s.adopt(request('old-b', 'b'))
  expect(s.adopt(request('old-a'))).toBe(a)
  expect(() => s.adopt(request('old-a', 'foreign'))).toThrow('identity')
  const pending = s.acquire(request('new'))
  a.release(); expect(s.status().find(row => row.id === 'new')?.state).toBe('queued')
  b.release(); (await pending).release()
})

it('responds to changed limits without dropping occupied resources or leaking finished history', async () => {
  let count = 1
  const s = new ProjectScheduler({ limits: () => ({ ...limits, worker: count }) }), a = await s.acquire(request('a'))
  const pending = s.acquire(request('b', 'b')); count = 2; s.refresh(); const b = await pending
  count = 1; s.refresh(); expect(s.status().filter(row => row.state === 'running')).toHaveLength(2)
  a.release(); b.release()
  for (let i = 0; i < 30; i++) (await s.acquire(request('short-' + i))).release()
  expect(s.status()).toEqual([])
})

const rcRoot = process.env.DSH_RC5_RUNTIME
const rcSuite = rcRoot ? describe : describe.skip
async function nativeContext() {
  const req = createRequire(join(rcRoot!, 'package.json'))
  for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-jobs-local']) expect(req(name + '/package.json').version).toBe('0.2.1-rc.5')
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const { AgentRegistry } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-agent')).href)
  const { Session, SessionId } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session')).href)
  const { LocalJobRegistry } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-jobs-local')).href)
  const attributionCtx = new Context(), initiators = new AgentRegistry(attributionCtx), ctx = new Context()
  const owners = new Map<string, any>()
  for (const id of ['owner-a', 'owner-b', 'unrelated']) owners.set(id, { id: SessionId(id), ctx, session: Session.create(SessionId(id)), status: 'idle' })
  ctx.reflect.provide('agents', { get: (id: string) => owners.get(id), currentInitiator: () => initiators.currentInitiator() })
  const jobs = new LocalJobRegistry(ctx, { maxConcurrentJobsPerOwner: 10, retainBytes: 262144, settledRetainBytes: 16384, pumpPollMs: 150 })
  const detach = jobs.attachController('T6-native-contract-no-external-producer')
  const s = new ProjectScheduler({ limits: () => limits }), allowed = new Set(['owner-a', 'owner-b']), uncertain = vi.fn()
  const resolve = (id: string) => id === 'unrelated' ? undefined : ({ ownerId: id, projectId: id === 'owner-a' ? 'a' : 'b', validate: () => { if (!allowed.has(id)) throw new Error('Managed owner is paused or revoked') } })
  const hooks = new ManagedBudgetHooks(ctx, s, { resolve, owners: () => [...allowed].map(id => resolve(id)!), onUncertain: uncertain })
  hooks.install()
  const model = (id: string, options: object, adapter: () => AsyncIterable<unknown>) => initiators.withInitiator(owners.get(id), () => ctx.waterfall(null, 'llm/stream', options, adapter)) as AsyncIterable<unknown>
  const shell = (id: string, callId: string, body: () => Promise<unknown>, signal = new AbortController().signal, name = 'bash') => ctx.waterfall(null, 'tools/execute', { name, callId, agent: owners.get(id), signal }, body) as Promise<unknown>
  const startJob = (owner: string | undefined, callId: string, done: Promise<unknown>, cancel = vi.fn()) => jobs.start({ kind: 'bash', label: 'in-memory producer', owner: owner as any, toolCall: { callId, rootCallId: callId }, run: () => ({ done, cancel }) })
  const cleanup = async () => { hooks.dispose(); detach(); await (jobs as any).disposeAll() }
  return { ctx, jobs, owners, s, hooks, allowed, model, shell, startJob, cleanup, uncertain }
}

rcSuite('actual rc.5 Cordis/initiator/job consumer hooks (no provider/process requests)', () => {
  it('captures the native initiator before lazy iteration and holds until stream cleanup really finishes', async () => {
    const f = await nativeContext(), cleanup = deferred<void>(), entered = vi.fn(), second = vi.fn()
    try {
      const iterator = f.model('owner-a', Object.freeze({ messages: Object.freeze([]) }), async function* () { entered(); try { yield 'first' } finally { await cleanup.promise } })[Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({ value: 'first', done: false }); expect(entered).toHaveBeenCalledOnce()
      const queued = f.model('owner-b', {}, async function* () { second(); yield 'second' })[Symbol.asyncIterator]()
      const wait = queued.next(); await new Promise(resolve => setImmediate(resolve)); expect(second).not.toHaveBeenCalled()
      const returning = iterator.return!(); await new Promise(resolve => setImmediate(resolve)); expect(second).not.toHaveBeenCalled()
      cleanup.resolve(); await returning; expect(await wait).toEqual({ value: 'second', done: false }); await queued.return!()
      expect(f.s.status()).toEqual([])
    } finally { cleanup.resolve(); await f.cleanup() }
  })
  it('shares one model budget across coordinator and worker owners, rejects revoked queued calls, and leaves unrelated calls alone', async () => {
    const f = await nativeContext(), blocker = deferred<void>(), second = vi.fn()
    try {
      const active = f.model('owner-a', {}, async function* () { yield 'active'; await blocker.promise })[Symbol.asyncIterator]()
      await active.next()
      const queued = f.model('owner-b', {}, async function* () { second(); yield 'denied' })[Symbol.asyncIterator]()
      const next = queued.next(), rejected = expect(next).rejects.toThrow('paused or revoked')
      f.allowed.delete('owner-b')
      const unrelated = f.model('unrelated', {}, async function* () { yield 'unrelated' })[Symbol.asyncIterator]()
      expect((await unrelated.next()).value).toBe('unrelated'); await unrelated.return!()
      await active.return!(); await rejected; expect(second).not.toHaveBeenCalled()
    } finally { blocker.resolve(); await f.cleanup() }
  })
  it('admits shell before its body and retains capacity after a background return and stop request until producer exit', async () => {
    const f = await nativeContext(), done = deferred<any>(), cancel = vi.fn(), other = vi.fn(async () => 'second')
    try {
      let job: any
      await f.shell('owner-a', 'call-a', async () => { job = f.startJob('owner-a', 'call-a', done.promise, cancel); return job })
      expect(f.s.status()).toEqual([expect.objectContaining({ kind: 'background', ownerId: 'owner-a', state: 'running' })])
      const waiting = f.shell('owner-b', 'call-b', other)
      await new Promise(resolve => setImmediate(resolve)); expect(other).not.toHaveBeenCalled()
      f.jobs.kill(job, 'owner-a'); expect(cancel).toHaveBeenCalledOnce(); expect(f.jobs.get(job, 'owner-a').status).toBe('stopping')
      expect(other).not.toHaveBeenCalled()
      done.resolve({ status: 'killed' }); await expect(waiting).resolves.toBe('second'); expect(f.s.status()).toEqual([])
    } finally { done.resolve({ status: 'killed' }); await f.cleanup() }
  })
  it('cancels queued pwsh and rechecks the actual owner before invoking a queued shell body', async () => {
    const f = await nativeContext(), done = deferred<any>(), control = new AbortController(), body = vi.fn(async () => 'should not start')
    try {
      await f.shell('owner-a', 'call-a', async () => f.startJob('owner-a', 'call-a', done.promise))
      const pending = f.shell('owner-b', 'pwsh-b', body, control.signal, 'pwsh'), rejection = expect(pending).rejects.toThrow('cancel queued')
      control.abort(new Error('cancel queued')); await rejection
      const revoked = f.shell('owner-b', 'bash-b', body), denied = expect(revoked).rejects.toThrow('paused or revoked')
      f.allowed.delete('owner-b'); done.resolve({ status: 'completed' }); await denied; expect(body).not.toHaveBeenCalled()
    } finally { done.resolve({ status: 'completed' }); await f.cleanup() }
  })
  it('reconstructs preexisting owner jobs and ignores unowned events delivered to native owner subscriptions', async () => {
    const f = await nativeContext(), owned = deferred<any>(), unowned = deferred<any>(), body = vi.fn(async () => 'admitted')
    try {
      f.startJob('owner-a', 'preexisting', owned.promise); f.hooks.sync()
      expect(f.s.status().filter(row => row.kind === 'background')).toHaveLength(1)
      const unknown = f.startJob(undefined, 'unowned', unowned.promise)
      expect(f.s.status().filter(row => row.kind === 'background')).toHaveLength(1)
      const queued = f.shell('owner-b', 'new-b', body)
      unowned.resolve({ status: 'completed' }); await f.jobs.wait(unknown, 1000); expect(body).not.toHaveBeenCalled()
      owned.resolve({ status: 'completed' }); await queued; expect(body).toHaveBeenCalledOnce()
    } finally { owned.resolve({ status: 'completed' }); unowned.resolve({ status: 'completed' }); await f.cleanup() }
  })
  it('holds a forced failed record as uncertain until explicit physical-exit reconciliation', async () => {
    const f = await nativeContext(), result = deferred<any>(), body = vi.fn(async () => 'later')
    try {
      await f.shell('owner-a', 'bad-producer', async () => f.startJob('owner-a', 'bad-producer', result.promise))
      const waiting = f.shell('owner-b', 'after-unknown', body)
      result.reject(new Error('Synthetic producer contract violation'))
      await waitUntil(() => f.uncertain.mock.calls.length === 1)
      expect(body).not.toHaveBeenCalled(); expect(f.s.status().some(row => row.ownerId === 'owner-a')).toBe(true)
      f.hooks.confirmOwnerExit('owner-a'); await waiting; expect(body).toHaveBeenCalledOnce()
      f.hooks.sync(); f.hooks.sync(); expect(f.s.status()).toEqual([])
    } finally { result.resolve({ status: 'completed' }); await f.cleanup() }
  })
  it('distinguishes a producer-reported failure from uncertain exit across repeated reconciliation', async () => {
    const f = await nativeContext(), done = deferred<any>()
    try {
      await f.shell('owner-a', 'known-failure', async () => f.startJob('owner-a', 'known-failure', done.promise))
      const waiting = f.shell('owner-b', 'after-failure', async () => 'next')
      done.resolve({ status: 'failed' }); await expect(waiting).resolves.toBe('next')
      f.hooks.sync(); f.hooks.sync(); expect(f.s.status()).toEqual([]); expect(f.uncertain).not.toHaveBeenCalled()
    } finally { done.resolve({ status: 'failed' }); await f.cleanup() }
  })
  it('retains uncertain occupancy after the owner unloads and after an observer is rebuilt without that loaded owner', async () => {
    const f = await nativeContext(), done = deferred<any>()
    let replacement: ManagedBudgetHooks | undefined
    try {
      await f.shell('owner-a', 'unloaded-failure', async () => f.startJob('owner-a', 'unloaded-failure', done.promise))
      f.owners.delete('owner-a')
      done.reject(new Error('Synthetic unloaded producer failure'))
      await waitUntil(() => f.uncertain.mock.calls.length > 0)
      expect(f.s.status().some(row => row.ownerId === 'owner-a')).toBe(true)
      f.hooks.dispose()
      const restored = new ProjectScheduler({ limits: () => limits })
      const owner = { ownerId: 'owner-a', projectId: 'a', validate: () => {} }
      replacement = new ManagedBudgetHooks(f.ctx, restored, { resolve: id => id === owner.ownerId ? owner : undefined, owners: () => [owner] })
      replacement.install()
      expect(restored.status()).toEqual([expect.objectContaining({ ownerId: 'owner-a', kind: 'background', state: 'running' })])
      replacement.confirmOwnerExit('owner-a'); replacement.sync(); expect(restored.status()).toEqual([])
    } finally { replacement?.dispose(); done.resolve({ status: 'completed' }); await f.cleanup() }
  })
  it('observes successful job exit after the same native identity reloads a different Session object', async () => {
    const f = await nativeContext(), first = deferred<any>(), second = deferred<any>()
    try {
      const id = await f.shell('owner-a', 'before-reload', async () => f.startJob('owner-a', 'before-reload', first.promise))
      first.resolve({ status: 'completed' }); await f.jobs.wait(id, 1000, 'owner-a')
      const owner = f.owners.get('owner-a'), previous = owner.session
      owner.session = previous.constructor.create(previous.id, previous.snapshotEvents(), previous.header)
      await f.shell('owner-a', 'after-reload', async () => f.startJob('owner-a', 'after-reload', second.promise))
      const waiting = f.shell('owner-b', 'after-reloaded-job', async () => 'ready')
      second.resolve({ status: 'completed' }); await expect(waiting).resolves.toBe('ready')
      expect(f.uncertain).not.toHaveBeenCalled(); expect(f.s.status()).toEqual([])
    } finally { first.resolve({ status: 'completed' }); second.resolve({ status: 'completed' }); await f.cleanup() }
  })
})
