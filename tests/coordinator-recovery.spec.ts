import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { ConversationStore } from '../src/app/conversation-store.ts'
import { Projects } from '../src/core/index.ts'
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'coordinator-recovery-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})
const open = (path: string) => {
  const store = new Store(path)
  return { store, conversations: new ConversationStore(store) }
}
it('recovers a durable running lease after restart and rejects a late old mapping write', () => {
  const path = join(directory, 'db.sqlite')
  let { store, conversations } = open(path)
  const projects = new Projects({ repo: store })
  const project = projects.create({ name: 'A', goal: 'recover' })
  conversations.claimProject(project.id, 'alice', { newlyCreated: true })
  const mapping = conversations.saveMapping(project.id, 'alice', {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    cwd: directory,
  })
  const user = conversations.appendUser(project.id, 'alice', { clientRequestKey: 'request-1', text: 'persist me' })
  const lease = conversations.claimNext(project.id, 'alice', {
    generation: mapping.generation,
    sessionId: mapping.sessionId,
  })!
  expect(
    conversations.savePrompt(project.id, 'alice', {
      generation: lease.mapping.generation,
      inputId: user.id,
      revision: 3,
      text: 'prompt-v3',
    }),
  ).toEqual({ revision: 3, text: 'prompt-v3' })
  store.close()
  ;({ store, conversations } = open(path))
  expect(conversations.listMessages(project.id, 'alice').find((message) => message.id === user.id)).toMatchObject({
    status: 'running',
    mappingGeneration: mapping.generation,
    expectedStateVersion: lease.stateVersion,
  })
  expect(conversations.getPrompt(project.id, user.id)).toEqual({ revision: 3, text: 'prompt-v3' })
  conversations.complete(project.id, 'alice', {
    inputId: user.id,
    mappingGeneration: mapping.generation,
    expectedStateVersion: lease.stateVersion,
    text: 'recovered',
    sessionId: mapping.sessionId,
    turn: 'turn-7',
    dshMessageId: 'dsh-7',
  })
  expect(conversations.listMessages(project.id, 'alice')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        status: 'saved',
        userMessageId: user.id,
        turn: 'turn-7',
        dshMessageId: 'dsh-7',
      }),
    ]),
  )
  expect(() =>
    conversations.complete(project.id, 'alice', {
      inputId: user.id,
      mappingGeneration: mapping.generation,
      expectedStateVersion: lease.stateVersion,
      text: 'late',
      sessionId: mapping.sessionId,
    }),
  ).toThrow(/stale/i)
  store.close()
})
it('does not let one project lane block another project input', () => {
  const { store, conversations } = open(join(directory, 'db.sqlite'))
  const projects = new Projects({ repo: store })
  const a = projects.create({ name: 'A', goal: 'a' })
  const b = projects.create({ name: 'B', goal: 'b' })
  conversations.claimProject(a.id, 'alice', { newlyCreated: true })
  conversations.claimProject(b.id, 'alice', { newlyCreated: true })
  conversations.saveMapping(a.id, 'alice', { sessionId: 'sa', workspaceId: 'wa', cwd: '/a' })
  conversations.saveMapping(b.id, 'alice', { sessionId: 'sb', workspaceId: 'wb', cwd: '/b' })
  const am = conversations.appendUser(a.id, 'alice', { clientRequestKey: 'a', text: 'busy' })
  conversations.appendUser(b.id, 'alice', { clientRequestKey: 'b', text: 'independent' })
  conversations.claimNext(a.id, 'alice', { generation: 1, sessionId: 'sa' })
  const bl = conversations.claimNext(b.id, 'alice', { generation: 1, sessionId: 'sb' })
  expect(bl?.input.text).toBe('independent')
  expect(am.status).toBe('queued')
  store.close()
})
