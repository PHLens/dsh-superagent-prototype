import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startRuntime, type Host } from './fixtures/host.ts'
let h: Host, foreign: string

afterEach(async () => {
  if (h) { for (const a of h.agents.values()) a.status = 'idle'; await h.stop() }
  if (foreign) rmSync(foreign, { recursive: true, force: true })
})

it('does not turn an unconfirmed draft resource reference into filesystem backup authority', async () => {
  h = await startRuntime(); foreign = mkdtempSync(join(tmpdir(), 'unregistered-workspace-'))
  const sentinel = 'UNREGISTERED_OTHER_PROJECT_DATA_8931'; writeFileSync(join(foreign, 'foreign-note.md'), sentinel)
  const c = h.runtime.projectCoordinator, p = c.create('owner', { name: 'Draft resource scope', goal: 'Discuss one note' })
  const plan = c.plans.save('owner', p.id, { expectedRevision: 0, operationId: 'draft', plan: { goal: 'One note', scope: 'A possible future resource, not yet approved', outputs: ['note'], resources: [foreign], environment: 'No execution authorized', cost: 'None', completion: 'Discuss only' } })
  expect(h.runtime.store.tickets.get(plan.ticketId)?.authorizations ?? []).toHaveLength(0)
  const manifest = await h.runtime.backup.run('manual')
  const point = h.runtime.backup.list()[0]!.path
  const copied = manifest.files.filter(f => f.path.endsWith('/foreign-note.md') && readFileSync(join(point, f.path), 'utf8') === sentinel)
  expect(copied).toHaveLength(0)
})

it('does not let an unapproved missing resource reference block application capture', async () => {
  h = await startRuntime(); foreign = mkdtempSync(join(tmpdir(), 'missing-resource-'))
  const missing = join(foreign, 'never-created')
  const c = h.runtime.projectCoordinator, p = c.create('owner', { name: 'Missing draft resource', goal: 'Discuss one note' })
  c.plans.save('owner', p.id, { expectedRevision: 0, operationId: 'missing-draft', plan: { goal: 'One note', scope: 'Future resource', outputs: ['note'], resources: [missing], environment: 'No execution authorized', cost: 'None', completion: 'Discuss only' } })
  const manifest = await h.runtime.backup.run('manual')
  expect(manifest.consistency).toBe('declared-files-quiesced')
  expect(manifest.missing).toEqual([])
  expect(h.runtime.backup.list()).toHaveLength(1)
})
