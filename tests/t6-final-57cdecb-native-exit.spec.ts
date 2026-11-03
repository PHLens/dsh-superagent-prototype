/** Concurrency and native SDK consumer contracts; real-provider acceptance is separate. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { ManagedBudgetHooks, ProjectScheduler, type BudgetKind } from '../src/app/scheduler.ts'
import { deferred, waitUntil } from './fixtures/async.ts'

const limits = { model: 1, worker: 1, background: 1 }
const request = (id: string, projectId = 'a', kind: BudgetKind = 'worker') => ({ id, projectId, kind })
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



rcSuite('terminal evidence after native retention and observer reconstruction', () => {
  it.each([false, true])('preserves the producer acknowledgement truth after its JobView is removed (reported=%s)', async reported => {
    const f = await nativeContext(), done = deferred<any>(); let restored: ManagedBudgetHooks | undefined
    try {
      let job: any
      await f.shell('owner-a', 'retained-exit-fact', async () => { job = f.startJob('owner-a', 'retained-exit-fact', done.promise); return job })
      if (reported) done.resolve({ status: 'completed' })
      else done.reject(new Error('Producer never acknowledged physical exit'))
      await waitUntil(() => ['completed', 'failed'].includes(f.jobs.get(job, 'owner-a').status))
      f.hooks.dispose(); f.jobs.remove(job, 'owner-a')
      expect(f.jobs.list('owner-a')).toEqual([])
      const owner = { ownerId: 'owner-a', projectId: 'a', validate() {} }, scheduler = new ProjectScheduler({ limits: () => limits })
      restored = new ManagedBudgetHooks(f.ctx, scheduler, { resolve: id => id === owner.ownerId ? owner : undefined, owners: () => [owner] })
      restored.install()
      expect(restored.ownerExitKnown(owner.ownerId)).toBe(reported)
      expect(scheduler.status().filter(row => row.ownerId === owner.ownerId && row.kind === 'background')).toHaveLength(reported ? 0 : 1)
      if (!reported) {
        // Simulate a subsequent verified receipt in the same durable native Session.
        const session = f.owners.get(owner.ownerId).session
        const settled = session.snapshotEvents().findLast((event: any) => event.type === 'job/settled' && event.data.jobId === job)
        session.append('job/settled', { ...settled.data, producerReported: true })
        expect(restored.ownerExitKnown(owner.ownerId)).toBe(true)
        expect(scheduler.status().filter(row => row.ownerId === owner.ownerId && row.kind === 'background')).toHaveLength(0)
        restored.dispose()
        restored = new ManagedBudgetHooks(f.ctx, new ProjectScheduler({ limits: () => limits }), { resolve: id => id === owner.ownerId ? owner : undefined, owners: () => [owner] })
        restored.install()
        expect(restored.ownerExitKnown(owner.ownerId)).toBe(true)
      }
    } finally { done.resolve({ status: 'completed' }); restored?.dispose(); await f.cleanup() }
  })
})
