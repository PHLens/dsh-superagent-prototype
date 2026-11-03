/** Supplemental capture epochs: transient registered writers and subscription lifetime. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { startRuntime, type Host } from './fixtures/host.ts'
import { deferred } from './fixtures/async.ts'

let h: Host
beforeEach(async () => {
  h = await startRuntime()
  const workspace = await h.ctx.workspaceRegistry.create(h.directory)
  await h.controller.create({ sessionId: h.runtime.masterId, workspaceId: workspace.id })
  for (const agent of h.agents.values()) agent.status = 'idle'
  h.runtime.backup.start({ enabled: false, directory: join(h.directory, 'epoch-copies'), intervalMinutes: 5, retention: 7 })
})
afterEach(async () => {
  for (const agent of h.agents.values()) agent.status = 'idle'
  await h.stop()
})

/** Observe real runtime subscriptions without replacing the scoped jobs implementation. */
function observeSubscriptions() {
  const jobs = h.jobs.service.events
  const subscribe = jobs.subscribe.bind(jobs)
  let jobCount = 0, statusCount = 0
  vi.spyOn(jobs, 'subscribe').mockImplementation((filter, listener) => {
    jobCount++
    const dispose = subscribe(filter, listener)
    return () => { jobCount--; dispose() }
  })
  const on = h.ctx.on.bind(h.ctx)
  vi.spyOn(h.ctx, 'on').mockImplementation(((name: string, ...args: unknown[]) => {
    const dispose = (on as (...args: any[]) => () => void)(name, ...args)
    if (name !== 'agent/status') return dispose
    statusCount++
    return () => { statusCount--; dispose() }
  }) as typeof h.ctx.on)
  return { get jobs() { return jobCount }, get status() { return statusCount } }
}
function holdNativeRead() {
  const entered = deferred(), resume = deferred()
  h.ctx.sessionPersistence.open = vi.fn(async () => ({
    inheritedEventCount: 0,
    read: async () => { entered.resolve(); await resume.promise; return { events: [] } },
    close: async () => {},
  })) as unknown as typeof h.ctx.sessionPersistence.open
  return { entered: entered.promise, resume: () => resume.resolve() }
}

it('rejects a related registered job that starts and finishes entirely during an awaited native read', async () => {
  const subscriptions = observeSubscriptions(), read = holdNativeRead()
  const capture = h.runtime.backup.run('manual')
  await read.entered
  expect(subscriptions.jobs).toBeGreaterThan(0)
  expect(subscriptions.status).toBe(1)
  const job = h.jobs.run(h.runtime.masterId, 'transient application writer')
  h.jobs.end(job)
  for (const agent of h.agents.values()) agent.status = 'idle'
  expect(h.jobs.service.list(h.runtime.masterId).every(job => job.status === 'completed')).toBe(true)
  read.resume()
  await expect(capture).rejects.toThrow(/writer activity changed/i)
  expect(h.runtime.backup.list()).toEqual([])
  expect(h.runtime.health.backup?.state).not.toBe('ready')
  expect(subscriptions.jobs).toBe(0)
  expect(subscriptions.status).toBe(0)
})

it('permits unrelated registered jobs and releases capture subscriptions after success', async () => {
  const subscriptions = observeSubscriptions(), read = holdNativeRead()
  const capture = h.runtime.backup.run('manual')
  await read.entered
  expect(subscriptions.jobs).toBeGreaterThan(0)
  const completed = h.jobs.run('ordinary-chat', 'unrelated transient writer')
  h.jobs.end(completed)
  const running = h.jobs.run('ordinary-other-chat', 'unrelated continuing writer')
  read.resume()
  const manifest = await capture
  expect(manifest.consistency).toBe('declared-files-quiesced')
  expect(h.runtime.backup.list()).toHaveLength(1)
  expect(subscriptions.jobs).toBe(0)
  expect(subscriptions.status).toBe(0)
  h.jobs.end(running)
})

it('releases capture subscriptions if reading native persistence fails', async () => {
  const subscriptions = observeSubscriptions()
  h.ctx.sessionPersistence.open = vi.fn(async () => { throw new Error('synthetic native read failure') })
  await expect(h.runtime.backup.run('manual')).rejects.toThrow('synthetic native read failure')
  expect(subscriptions.jobs).toBe(0)
  expect(subscriptions.status).toBe(0)
  expect(h.runtime.backup.list()).toEqual([])
})
