import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { ConversationStore } from '../src/app/conversation-store.ts'
import { Projects } from '../src/core/index.ts'
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'conversation-store-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})
const open = (path: string) => {
  const store = new Store(path)
  return { store, conversations: new ConversationStore(store) }
}
it('keeps two project conversations isolated and durable across restart', () => {
  const path = join(directory, 'db.sqlite')
  let { store, conversations } = open(path)
  const projects = new Projects({ repo: store })
  const a = projects.create({ name: 'A', goal: 'one' })
  const b = projects.create({ name: 'B', goal: 'two' })
  conversations.claimProject(a.id, 'alice', { newlyCreated: true })
  conversations.claimProject(b.id, 'bob', { newlyCreated: true })
  const first = conversations.appendUser(a.id, 'alice', { clientRequestKey: 'r1', text: 'hello' })
  conversations.appendUser(b.id, 'bob', { clientRequestKey: 'r1', text: 'other' })
  conversations.saveMapping(a.id, 'alice', { sessionId: 's1', workspaceId: 'w1', cwd: '/a' })
  const lease = conversations.claimNext(a.id, 'alice', { generation: 1, sessionId: 's1' })!
  conversations.complete(a.id, 'alice', {
    inputId: first.id,
    mappingGeneration: lease.mapping.generation,
    expectedStateVersion: lease.stateVersion,
    text: 'hi',
    sessionId: 's1',
    turn: 'turn-1',
  })
  store.close()
  ;({ store, conversations } = open(path))
  expect(conversations.listMessages(a.id, 'alice')).toHaveLength(2)
  expect(conversations.listMessages(b.id, 'bob')).toHaveLength(1)
  expect(conversations.currentMapping(a.id)?.generation).toBe(1)
  expect(conversations.getOwner(a.id)?.actorId).toBe('alice')
  store.close()
})
it('requires explicit ownership and makes duplicate client requests idempotent', () => {
  const { store, conversations } = open(join(directory, 'db.sqlite'))
  const projects = new Projects({ repo: store })
  const project = projects.create({ name: 'A', goal: 'one' })
  expect(() => conversations.appendUser(project.id, 'alice', { clientRequestKey: 'r', text: 'x' })).toThrow(
    /ownership/i,
  )
  expect(() => conversations.claimProject(project.id, 'alice', { newlyCreated: false })).toThrow(/unowned/i)
  conversations.claimProject(project.id, 'alice', { newlyCreated: true })
  const one = conversations.appendUser(project.id, 'alice', { clientRequestKey: 'r', text: 'x' })
  expect(conversations.appendUser(project.id, 'alice', { clientRequestKey: 'r', text: 'x' })).toEqual(one)
  expect(() => conversations.appendUser(project.id, 'alice', { clientRequestKey: 'r', text: 'different' })).toThrow(
    /different/i,
  )
  store.close()
})
it('queues while busy and fences stale completion after mapping replacement', () => {
  const { store, conversations } = open(join(directory, 'db.sqlite'))
  const projects = new Projects({ repo: store })
  const project = projects.create({ name: 'A', goal: 'one' })
  conversations.claimProject(project.id, 'alice', { newlyCreated: true })
  conversations.saveMapping(project.id, 'alice', { sessionId: 's1', workspaceId: 'w1', cwd: '/a' })
  const first = conversations.appendUser(project.id, 'alice', { clientRequestKey: '1', text: 'one' })
  const second = conversations.appendUser(project.id, 'alice', { clientRequestKey: '2', text: 'two' })
  const lease = conversations.claimNext(project.id, 'alice', { generation: 1, sessionId: 's1' })!
  expect(conversations.claimNext(project.id, 'alice', { generation: 1, sessionId: 's1' })).toBeUndefined()
  expect(() =>
    conversations.saveMapping(project.id, 'alice', {
      sessionId: 's2',
      workspaceId: 'w2',
      cwd: '/a2',
      expectedGeneration: 1,
    }),
  ).toThrow(/reconciliation/i)
  conversations.saveMapping(project.id, 'alice', {
    sessionId: 's2',
    workspaceId: 'w2',
    cwd: '/a2',
    expectedGeneration: 1,
    reconciled: true,
    reason: 'timeout',
  })
  expect(() =>
    conversations.complete(project.id, 'alice', {
      inputId: first.id,
      mappingGeneration: lease.mapping.generation,
      expectedStateVersion: lease.stateVersion,
      text: 'late',
      sessionId: 's1',
    }),
  ).toThrow(/stale/i)
  expect(conversations.retry(project.id, 'alice')?.id).toBe(first.id)
  expect(conversations.listMessages(project.id, 'alice').find((item) => item.id === second.id)?.status).toBe('queued')
  store.close()
})
