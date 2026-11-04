/** Outbox delivery when processing is paused or a Source kind registers late. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps delivery unknown without a second provider call when post-send event writes fail', async () => {
  const project = h.runtime.projectCoordinator.create('alice', { name: 'Event failure project', goal: 'Send exactly once' })
  const provider = vi.spyOn(h.runtime.sources, 'send').mockResolvedValue('sent')
  h.runtime.store.db.exec(`CREATE TRIGGER fail_delivery_event BEFORE INSERT ON project_event
    WHEN json_extract(NEW.payload, '$.kind') = 'delivery-changed'
      AND json_extract(NEW.payload, '$.version') = 'event-failure'
      AND NEW.id LIKE '%:send-started'
    BEGIN SELECT RAISE(ABORT, 'injected delivery event failure'); END`)
  const channel = feishu('1', 'x').channel!
  h.runtime.outbox.send({ id: 'event-failure', channel: { ...channel, address: { ...channel.address, projectId: project.id } },
    text: 'Send once', kind: 'notice' })
  await h.runtime.sendReplies()
  expect(provider).toHaveBeenCalledTimes(1)
  expect(h.runtime.store.receipts.get('event-failure')).toMatchObject({ status: 'pending', reconciliation: { state: 'unknown', phase: 'send-started' } })
  const delivery = (h.runtime.store.db.prepare("SELECT payload FROM project_event WHERE project_id=? AND json_extract(payload, '$.kind')='delivery-changed' ORDER BY sequence").all(project.id) as { payload: string }[])
    .map(row => JSON.parse(row.payload) as { operationId: string })
  expect(delivery.map(event => event.operationId.split(':').at(-1))).toEqual(['queued'])
  h.runtime.store.db.exec('DROP TRIGGER fail_delivery_event')
  h.runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='project-event'").run()
  await h.runtime.effects.idle()
  const repaired = (h.runtime.store.db.prepare("SELECT payload FROM project_event WHERE project_id=? AND json_extract(payload, '$.kind')='delivery-changed' ORDER BY sequence").all(project.id) as { payload: string }[])
    .map(row => JSON.parse(row.payload) as { operationId: string })
  expect(repaired.map(event => event.operationId.split(':').at(-1))).toEqual(['queued', 'send-started'])
  expect(h.runtime.store.receipts.get('event-failure')).toMatchObject({ status: 'pending', reconciliation: { state: 'unknown', phase: 'send-started' } })
})

it('timestamps every normal project delivery transition from its durable receipt', async () => {
  const project = h.runtime.projectCoordinator.create('alice', { name: 'Timestamped delivery', goal: 'Record delivery time' })
  vi.spyOn(h.runtime.sources, 'send').mockResolvedValue('sent')
  const channel = feishu('1', 'x').channel!
  h.runtime.outbox.send({ id: 'timestamped-delivery', channel: { ...channel, address: { ...channel.address, projectId: project.id } },
    text: 'Timestamp this', kind: 'notice' })
  await h.runtime.sendReplies()
  const receipt = h.runtime.store.receipts.get('timestamped-delivery')
  expect(receipt).toMatchObject({ status: 'sent' })
  expect(receipt?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(receipt?.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  const events = (h.runtime.store.db.prepare("SELECT payload FROM project_event WHERE project_id=? AND json_extract(payload, '$.kind')='delivery-changed' ORDER BY sequence")
    .all(project.id) as { payload: string }[]).map(row => JSON.parse(row.payload) as { operationId: string; at: string })
  expect(events.map(event => event.operationId.split(':').at(-1))).toEqual(['queued', 'send-started', 'sent'])
  for (const event of events) expect(Number.isFinite(Date.parse(event.at))).toBe(true)
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})


it('settles a paused project reply as channelGone when its repository grant is revoked before Resume, without a provider request', async () => {
  const project = h.runtime.projectCoordinator.create('alice', { name: 'Delivery project', goal: 'Deliver one result' })
  const repo = mkdtempSync(join(tmpdir(), 'delivery-repo-')); writeFileSync(join(repo, 'a.txt'), 'a')
  vi.spyOn(h.runtime, 'syncGitHubConsumers').mockImplementation(() => {})
  h.runtime.projectCoordinator.setRepositoryVerifier(async () => {})
  const resource = await h.runtime.projectCoordinator.registerResource('alice', project.id, { type: 'repository', path: repo, purpose: 'code-source', maxBytes: 100_000,
    identity: { repository: 'acme/widgets', gitAuthorName: 'Agent', gitAuthorEmail: 'agent@example.com' } }, 'delivery-resource')
  await h.runtime.settings.pause(true, 'panel')
  const send = vi.spyOn(h.runtime.sources, 'send')
  h.runtime.outbox.send({ id: 'project-held', channel: { source: 'github', thread: 'github:7', address: { projectId: project.id, resourceId: resource.id,
    repository: 'acme/widgets', account: 'agent-bot' } }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('project-held')).toBe('pending')
  h.runtime.projectCoordinator.revokeResource('alice', project.id, resource.id, 'delivery-revoke')
  await h.runtime.settings.pause(false, 'panel')
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5_000 })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
  expect(h.runtime.store.receipts.get('project-held')).toMatchObject({ status: 'dropped', dropped: { reason: 'channelGone' } })
  expect(send).not.toHaveBeenCalled()
  rmSync(repo, { recursive: true, force: true })
})
