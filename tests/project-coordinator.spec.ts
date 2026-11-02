import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Prompts } from '../src/app/prompts.ts'
import { Store } from '../src/app/store.ts'
import { Projects } from '../src/core/index.ts'
import { ProjectCoordinator } from '../src/app/project-coordinator.ts'

const mock = vi.hoisted(() => ({
  ProjectSessionInterrupted: class extends Error {
    constructor(readonly requestId: string) {
      super(`Session consumed request ${requestId}`)
      this.name = 'ProjectSessionInterrupted'
    }
  },
  prepare: vi.fn(),
  reply: vi.fn(),
  completed: vi.fn(),
  checkpoint: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock('../src/app/project-session.ts', () => ({
  ProjectSessionInterrupted: mock.ProjectSessionInterrupted,
  ProjectSessions: class {
    prepare(...args: unknown[]) {
      return mock.prepare(...args)
    }
    reply(...args: unknown[]) {
      return mock.reply(...args)
    }
    completed(...args: unknown[]) {
      return mock.completed(...args)
    }
    checkpoint(...args: unknown[]) {
      return mock.checkpoint(...args)
    }
    dispose(...args: unknown[]) {
      return mock.dispose(...args)
    }
  },
}))
let directory: string
let store: Store
let manager: ProjectCoordinator
let ctx: Context
const agent = (id = 'session') => ({
  id,
  status: 'idle',
  session: { snapshotEvents: () => [] },
  cancel: vi.fn(),
  whenIdle: vi.fn(async () => {}),
})
beforeEach(() => {
  vi.resetAllMocks()
  directory = mkdtempSync(join(tmpdir(), 'project-coordinator-'))
  store = new Store(join(directory, 'db.sqlite'))
  ctx = {
    workspaceRegistry: { create: vi.fn(async () => ({ id: 'workspace' })) },
    sessionController: { resolveAgent: vi.fn() },
    sessionPersistence: { flush: vi.fn(async () => {}) },
  } as unknown as Context
  const prompts = { current: () => ({ revision: 7, config: {} }), project: () => 'Discuss only' } as unknown as Prompts
  manager = new ProjectCoordinator(
    ctx,
    store,
    new Projects({ repo: store }),
    directory,
    new AbortController().signal,
    prompts,
  )
  mock.prepare.mockImplementation(async (_project: unknown, mapping: { sessionId: string }) => agent(mapping.sessionId))
  mock.reply.mockImplementation(async (value: { id: string }) => ({
    text: 'saved reply',
    turn: 42,
    sessionId: value.id,
    dshMessageId: 'dsh-42',
  }))
})
afterEach(async () => {
  await manager.stop()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

it('persists input before slow Session preparation and keeps project lanes independent', async () => {
  const a = manager.create('alice', { name: 'A', goal: 'a' })
  const b = manager.create('alice', { name: 'B', goal: 'b' })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  mock.prepare.mockImplementation(async (project: { id: string }, mapping: { sessionId: string }) => {
    if (project.id === a.id) await gate
    return agent(mapping.sessionId)
  })
  const { message } = manager.send('alice', a.id, { requestId: 'a1', text: 'wait' })
  expect(manager.conversations.getMessage(a.id, 'alice', message.id)?.status).toBe('queued')
  manager.send('alice', b.id, { requestId: 'b1', text: 'continue' })
  try {
    await vi.waitFor(() =>
      expect(manager.view('alice', b.id).messages.some((value) => value.status === 'saved')).toBe(true),
    )
  } finally {
    release()
  }
  await vi.waitFor(() =>
    expect(manager.view('alice', a.id).messages.some((value) => value.status === 'saved')).toBe(true),
  )
  expect(manager.view('alice', a.id).messages.find((value) => value.role === 'assistant')).toMatchObject({
    turn: '42',
    dshMessageId: 'dsh-42',
    status: 'saved',
  })
})

it('resumes a persisted running input instead of claiming a second turn after restart', async () => {
  const p = manager.create('alice', { name: 'A', goal: 'a' })
  const storage = manager.conversations
  storage.saveMapping(p.id, 'alice', { sessionId: 'saved-session', workspaceId: 'workspace', cwd: directory })
  const user = storage.appendUser(p.id, 'alice', { clientRequestKey: 'r', text: 'recover' })
  storage.claimNext(p.id, 'alice', { generation: 1, sessionId: 'saved-session' })
  manager.start()
  await vi.waitFor(() => expect(mock.reply).toHaveBeenCalled())
  expect(mock.reply.mock.calls[0]?.[1]).toBe(user.id)
})

it('serializes retry replacement with concurrent sends so an old agent cannot claim the new generation', async () => {
  const p = manager.create('alice', { name: 'Race', goal: 'fence' })
  const storage = manager.conversations
  storage.saveMapping(p.id, 'alice', { sessionId: 'old-session', workspaceId: 'workspace', cwd: directory })
  const user = storage.appendUser(p.id, 'alice', { clientRequestKey: 'failed', text: 'retry me' })
  const lease = storage.claimNext(p.id, 'alice', { generation: 1, sessionId: 'old-session' })!
  storage.fail(p.id, 'alice', {
    inputId: user.id,
    mappingGeneration: 1,
    expectedStateVersion: lease.stateVersion,
    error: 'interrupted',
    sessionId: 'old-session',
  })
  let resolveRetry!: () => void
  let resolvePrepare!: () => void
  const retryGate = new Promise<void>((resolve) => {
    resolveRetry = resolve
  })
  const prepareGate = new Promise<void>((resolve) => {
    resolvePrepare = resolve
  })
  const old = agent('old-session')
  vi.mocked(ctx.sessionController.resolveAgent).mockImplementation(async () => {
    await retryGate
    return { agent: old } as never
  })
  mock.prepare.mockImplementation(async (_project: unknown, mapping: { sessionId: string }) => {
    if (mapping.sessionId === 'old-session') await prepareGate
    return agent(mapping.sessionId)
  })
  const retry = manager.retry('alice', p.id)
  await vi.waitFor(() => expect(ctx.sessionController.resolveAgent).toHaveBeenCalled())
  manager.send('alice', p.id, { requestId: 'concurrent', text: 'queued during retry' })
  expect(mock.prepare).not.toHaveBeenCalled()
  resolveRetry()
  try {
    await vi.waitFor(() => expect(storage.currentMapping(p.id)?.generation).toBe(2))
  } finally {
    resolvePrepare()
  }
  await retry
  await vi.waitFor(() => expect(mock.reply).toHaveBeenCalled())
  const dispatched = mock.reply.mock.calls.map((call) => ({
    agentId: (call[0] as { id: string }).id,
    inputId: call[1] as string,
  }))
  expect(dispatched.some((item) => item.agentId === 'old-session' && item.inputId !== user.id)).toBe(false)
})

it('recovers a consumed persisted input onto a new mapping without duplicating the user message', async () => {
  const p = manager.create('alice', { name: 'Consumed', goal: 'recover' })
  const storage = manager.conversations
  const oldMapping = storage.saveMapping(p.id, 'alice', { sessionId: 'old-session', workspaceId: 'workspace', cwd: directory })
  const user = storage.appendUser(p.id, 'alice', { clientRequestKey: 'consumed', text: 'recover this' })
  storage.claimNext(p.id, 'alice', { generation: oldMapping.generation, sessionId: oldMapping.sessionId })
  vi.mocked(ctx.sessionController.resolveAgent).mockResolvedValue({ agent: agent('old-session') } as never)
  let attempts = 0
  mock.reply.mockImplementation(async (value: { id: string }, inputId: string) => {
    attempts++
    if (attempts === 1) throw new mock.ProjectSessionInterrupted(inputId)
    return { text: 'recovered reply', turn: 2, sessionId: value.id, dshMessageId: 'recovered-2' }
  })
  manager.start()
  await vi.waitFor(() => expect(storage.listMessages(p.id, 'alice').some((value) => value.status === 'saved')).toBe(true), { timeout: 2000 })
  const messages = storage.listMessages(p.id, 'alice')
  expect(messages.filter((value) => value.role === 'user')).toHaveLength(1)
  expect(messages.filter((value) => value.role === 'assistant')).toHaveLength(1)
  expect(messages.find((value) => value.id === user.id)?.status).toBe('answered')
  expect(storage.currentMapping(p.id)?.generation).toBe(2)
  expect(messages.find((value) => value.role === 'assistant')?.mappingGeneration).toBe(2)
})

it('bounds a hung provider turn while another project still completes durably', async () => {
  await manager.stop()
  const prompts = { current: () => ({ revision: 7, config: {} }), project: () => 'Discuss only' } as unknown as Prompts
  manager = new ProjectCoordinator(ctx, store, new Projects({ repo: store }), directory, new AbortController().signal, prompts, 20)
  const first = manager.create('alice', { name: 'Hung', goal: 'timeout' })
  const second = manager.create('alice', { name: 'Healthy', goal: 'continue' })
  mock.reply.mockImplementation(async (value: { id: string }, _inputId: string, text: string) => {
    if (text === 'hang') return await new Promise<never>(() => {})
    return { text: 'healthy reply', turn: 1, sessionId: value.id, dshMessageId: 'healthy-1' }
  })
  manager.send('alice', first.id, { requestId: 'hang', text: 'hang' })
  manager.send('alice', second.id, { requestId: 'healthy', text: 'healthy' })
  await vi.waitFor(() => expect(manager.view('alice', second.id).messages.some((value) => value.status === 'saved')).toBe(true), { timeout: 1000 })
  await vi.waitFor(() => expect(manager.view('alice', first.id).messages.some((value) => value.status === 'error')).toBe(true), { timeout: 1000 })
})

it('accepts further durable input while a model turn is pending', async () => {
  const p = manager.create('alice', { name: 'A', goal: 'a' })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  mock.reply.mockImplementationOnce(async (value: { id: string }) => {
    await gate
    return { text: 'first', turn: 1, sessionId: value.id, dshMessageId: 'dsh-1' }
  })
  manager.send('alice', p.id, { requestId: 'one', text: 'first request' })
  try {
    await vi.waitFor(() => expect(mock.reply).toHaveBeenCalledTimes(1))
    const second = manager.send('alice', p.id, { requestId: 'two', text: 'second request' }).message
    expect(manager.conversations.getMessage(p.id, 'alice', second.id)?.status).toBe('queued')
    const independentReader = new Store(join(directory, 'db.sqlite'))
    try {
      expect(
        independentReader.db.prepare('SELECT status FROM conversation_message WHERE id=?').get(second.id)?.status,
      ).toBe('queued')
    } finally {
      independentReader.close()
    }
    expect(mock.reply).toHaveBeenCalledTimes(1)
  } finally {
    release()
  }
  await vi.waitFor(() =>
    expect(manager.view('alice', p.id).messages.filter((value) => value.status === 'saved')).toHaveLength(2),
  )
})
