import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Store } from '../src/app/store.ts'
import { ProjectSessions, ProjectSessionInterrupted } from '../src/app/project-session.ts'

const adapter = Object.create(ProjectSessions.prototype) as ProjectSessions
const events = (reason = 'completed', interrupted = false): SessionEvent[] => [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { id: 'dsh-superagent:input-1', role: 'user', content: [{ type: 'text', text: 'Question' }], source: { kind: 'dsh-superagent', form: 'relay' } } },
  { type: 'assistant/message', data: { turn: 1, interrupted, message: { id: 'answer-1', role: 'assistant', content: [{ type: 'reasoning', text: 'Private reasoning' }, { type: 'text', text: 'Saved answer' }] } } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } },
] as unknown as SessionEvent[]

/** Restored native inbox stays idle until a waking submission, as in rc.5. */
function restoredHost(consumed = false, boundary: 'nextTurn' | 'nextStep' = 'nextTurn') {
  const message = { id: 'dsh-superagent:input-1', role: 'user', content: [{ type: 'text', text: 'Question' }], source: { kind: 'dsh-superagent', form: 'relay' } }
  let log = consumed ? events().slice(0, 2) : []
  const inbox = {
    nextTurn: !consumed && boundary === 'nextTurn' ? [message] : [],
    nextStep: !consumed && boundary === 'nextStep' ? [message] : [],
    remove: vi.fn((id: string) => {
      for (const queue of [inbox.nextTurn, inbox.nextStep]) {
        const index = queue.findIndex(item => item.id === id)
        if (index >= 0) { queue.splice(index, 1); return true }
      }
      return false
    }),
  }
  const send = vi.fn((value: typeof message, target: string, wake: boolean) => {
    if ([...inbox.nextTurn, ...inbox.nextStep].some(item => item.id === value.id)) throw new Error('message is already pending')
    expect(value).toBe(message)
    expect(target).toBe(boundary === 'nextTurn' ? 'next-turn' : 'next-step')
    expect(wake).toBe(true)
    log = events()
  })
  const agent = { id: 'session-1', status: 'idle', inbox, send, followup: vi.fn(),
    session: { snapshotEvents: () => log }, whenIdle: vi.fn(async () => {}),
    ctx: { systemPrompt: { section: vi.fn(() => () => {}) } },
  } as unknown as Agent
  const flush = vi.fn(async () => {})
  const ctx = { on: vi.fn(), agents: new Map([[agent.id, agent]]), sessionPersistence: {
    flush, open: async () => ({ read: async (offset: number) => ({ events: offset ? [] : log }), [Symbol.asyncDispose]: async () => {} }),
  } } as unknown as Context
  const controller = new AbortController()
  const sessions = new ProjectSessions(ctx, {} as Store, controller.signal)
  sessions.checkpoint(agent, 'Restricted discussion checkpoint')
  return { sessions, agent, message, send, inbox, flush, controller }
}

describe('project Session completion reconciliation', () => {
  it('uses the durable user/turn/message reference and excludes reasoning', () => {
    expect(adapter.completed(events(), 'input-1')).toEqual({ text: 'Saved answer', sessionId: '', turn: 1, dshMessageId: 'answer-1' })
    expect(adapter.completed(events(), 'other-input')).toBeUndefined()
  })
  it('does not save unfinished or interrupted output', () => {
    expect(adapter.completed(events().slice(0, -1), 'input-1')).toBeUndefined()
    expect(() => adapter.completed(events('aborted'), 'input-1')).toThrow('aborted')
    expect(() => adapter.completed(events('completed', true), 'input-1')).toThrow('without a reply')
  })
  it('does not borrow completion from a later turn', () => {
    const unfinished = events().slice(0, -1)
    const later = events().map(event => ({ ...event, data: { ...event.data, turn: 2 } })) as SessionEvent[]
    expect(adapter.completed([...unfinished, ...later], 'input-1')).toBeUndefined()
  })
})

describe('project Session restart delivery', () => {
  it.each(['nextTurn', 'nextStep'] as const)('resumes %s after durable inbox flush before consume using the original ID exactly once', async boundary => {
    const host = restoredHost(false, boundary)
    const authorize = vi.fn()
    const reply = await host.sessions.reply(host.agent, 'input-1', 'Question', authorize)
    expect(reply).toEqual({ text: 'Saved answer', sessionId: 'session-1', turn: 1, dshMessageId: 'answer-1' })
    expect(host.send).toHaveBeenCalledExactlyOnceWith(host.message, boundary === 'nextTurn' ? 'next-turn' : 'next-step', true)
    expect(host.agent.followup).not.toHaveBeenCalled()
    expect(host.agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
    // Business-save retry reconciles the same reply without another host wake.
    expect(await host.sessions.reply(host.agent, 'input-1', 'Question', authorize)).toEqual(reply)
    expect(host.send).toHaveBeenCalledTimes(1)
  })
  it('flushes an already completed reply before returning without resending native input', async () => {
    const host = restoredHost()
    host.inbox.nextTurn.splice(0, 1)
    host.agent.session.snapshotEvents = () => events()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    host.flush.mockImplementation(() => gate)
    const pending = host.sessions.reply(host.agent, 'input-1', 'Question', vi.fn())
    await Promise.resolve()
    expect(host.flush).toHaveBeenCalled()
    expect(host.send).not.toHaveBeenCalled()
    release()
    await expect(pending).resolves.toEqual({ text: 'Saved answer', sessionId: 'session-1', turn: 1, dshMessageId: 'answer-1' })
    expect(host.send).not.toHaveBeenCalled()
  })
  it('rejects a recovered completed reply when authorization closes during persistence flush', async () => {
    const host = restoredHost()
    host.inbox.nextTurn.splice(0, 1)
    host.agent.session.snapshotEvents = () => events()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    host.flush.mockImplementation(() => gate)
    let valid = true
    const pending = host.sessions.reply(host.agent, 'input-1', 'Question', () => { if (!valid) throw new Error('Stale or closed coordinator') })
    await Promise.resolve()
    valid = false
    release()
    await expect(pending).rejects.toThrow('Stale or closed')
    expect(host.send).not.toHaveBeenCalled()
  })
  it('rejects stale or closed authorization after delivery flush without waking pending work', async () => {
    const host = restoredHost()
    let valid = true
    host.flush.mockImplementation(async () => { valid = false })
    await expect(host.sessions.reply(host.agent, 'input-1', 'Question', () => {
      if (!valid) throw new Error('Stale or closed coordinator')
    })).rejects.toThrow('Stale or closed')
    expect(host.send).not.toHaveBeenCalled()
    expect(host.inbox.remove).not.toHaveBeenCalled()
    expect(host.inbox.nextTurn).toEqual([host.message])
  })
  it('does not wake when shutdown races the delivery flush', async () => {
    const host = restoredHost()
    host.flush.mockImplementation(async () => { host.controller.abort(new Error('Shutdown')) })
    await expect(host.sessions.reply(host.agent, 'input-1', 'Question')).rejects.toThrow('Shutdown')
    expect(host.send).not.toHaveBeenCalled()
  })
  it('keeps consumed but unfinished input explicit and does not duplicate its native message', async () => {
    const host = restoredHost(true)
    await expect(host.sessions.reply(host.agent, 'input-1', 'Question')).rejects.toBeInstanceOf(ProjectSessionInterrupted)
    expect(host.send).not.toHaveBeenCalled()
    expect(host.agent.followup).not.toHaveBeenCalled()
    expect(host.agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
  })
})
