/** Application loader capabilities and actual native output validation; no provider calls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Store } from '../src/app/store.ts'
import { SkillCatalog, type SkillInvocationPolicy } from '../src/app/skill-catalog.ts'
import type { ManagedSkillSnapshot } from '../src/app/managed-skills.ts'
import { managedSkillTools, type ManagedSkillToolsHost } from '../src/app/tools/managed-skill.ts'
import type { Tool } from '../src/app/tools/tool.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'managed-skill-tools-')), path = join(root, 'db.sqlite'), store = new Store(path), catalog = new SkillCatalog(store)
  let closed = false, live = true
  let policy: Omit<SkillInvocationPolicy, 'pin'> = { role: 'worker', stage: 'execute', resources: ['res-a'], tools: ['project_write_artifact'] }
  const close = () => { if (!closed) { store.close(); closed = true } }
  cleanup.push(() => { close(); rmSync(root, { recursive: true, force: true }) })
  const publish = (name: string, body = 'PINNED PRIVATE BODY', version = '1') => catalog.publish({ name, version, body, description: 'Only a bounded metadata summary', roles: ['worker'], stages: ['execute'], resources: ['res-a'], tools: ['project_write_artifact'], enabled: true })
  const snapshots = (): ManagedSkillSnapshot[] => {
    const candidates = catalog.candidates(policy), pins = catalog.pin(candidates)
    return candidates.map((candidate, index) => ({ candidate, pin: pins[index]! }))
  }
  const authorize = vi.fn(() => { if (!live) throw new Error('Stale execution lease'); return policy })
  const host = (extra: Partial<ManagedSkillToolsHost> = {}): ManagedSkillToolsHost => ({ catalog, snapshots: snapshots(), authorize, ...extra })
  return { root, path, store, catalog, publish, snapshots, authorize, host, close,
    revokeLease: () => { live = false }, setPolicy: (value: Partial<typeof policy>) => { policy = { ...policy, ...value } } }
}
async function call(tools: Tool[], name: string, args: unknown = {}, signal = new AbortController().signal) {
  const selected = tools.find(row => row.name === name)!
  return selected.execute(selected.schema.parse(args), signal) as Promise<Record<string, any>>
}
it('lists bounded metadata and returns the exact pinned body in versioned pages', async () => {
  const f = fixture(), record = f.publish('allowed', 'abcdef')
  const tools = managedSkillTools(f.host()), page = await call(tools, 'project_list_skills')
  expect(page.skills).toHaveLength(1)
  expect(JSON.stringify(page)).not.toContain('abcdef')
  const read = page.skills[0].read
  const body = await call(tools, 'project_load_skill', { skill_id: read.skill_id, version: read.version, body_hash: read.body_hash })
  expect(body).toMatchObject({ id: record.id, name: 'allowed', version: '1', content: 'abcdef', truncated: false, next_offset: null })
  expect(body.bodyHash).toBe(read.body_hash)
  const paged = managedSkillTools(f.host({ onLoaded: vi.fn() }))
  const first = await call(paged, 'project_load_skill', { skill_id: record.id, limit: 3 })
  expect(first).toMatchObject({ content: 'abc', next_offset: 3, totalChars: 6, truncated: true })
  expect(await call(paged, 'project_load_skill', { skill_id: record.id, offset: first.next_offset, limit: 3 })).toMatchObject({ content: 'def', next_offset: null })
  await expect(call(paged, 'project_load_skill', { skill_id: record.id, offset: 7 })).rejects.toThrow('offset')
  f.catalog.disable(record.id)
  await expect(call(tools, 'project_list_skills')).resolves.toBeDefined()
})

it('keeps a bound capability snapshot closed and restores its original body after rebinding', async () => {
  const f = fixture(); f.publish('one')
  const snapshots = f.snapshots(), tools = managedSkillTools(f.host({ snapshots }))
  const newer = f.publish('two'); snapshots.push(f.snapshots().find(row => row.candidate.id === newer.id)!)
  expect((await call(tools, 'project_list_skills')).skills.map((row: { name: string }) => row.name)).toEqual(['one'])
  await expect(call(tools, 'project_load_skill', { skill_id: newer.id })).rejects.toThrow('outside')
  const closed: ManagedSkillSnapshot[] = []
  expect(managedSkillTools(f.host({ snapshots: closed }))).toEqual([])
  const record = f.publish('stable', 'ORIGINAL BODY'), saved = JSON.parse(JSON.stringify(f.snapshots()))
  f.publish('stable', 'NEWER BODY', '2'); f.close()
  const store = new Store(f.path), catalog = new SkillCatalog(store); cleanup.push(() => store.close())
  const rebound = managedSkillTools({ catalog, snapshots: saved, authorize: f.authorize })
  expect(await call(rebound, 'project_load_skill', { skill_id: record.id })).toMatchObject({ content: 'ORIGINAL BODY', version: '1' })
})

it('reauthorizes role, stage, dependencies, hash, enablement and lease on every load', async () => {
  const f = fixture(), record = f.publish('allowed'), read = vi.spyOn(f.catalog, 'body'), tools = managedSkillTools(f.host())
  await expect(call(tools, 'project_load_skill', { skill_id: record.id, version: 'other' })).rejects.toThrow('version')
  await expect(call(tools, 'project_load_skill', { skill_id: record.id, body_hash: '0'.repeat(64) })).rejects.toThrow('version')
  await expect(call(tools, 'project_load_skill', { skill_id: 'foreign' })).rejects.toThrow('outside')
  expect(read).not.toHaveBeenCalled()
  for (const scope of [{ role: 'coordinator' as const }, { stage: 'plan' }, { resources: [] }, { tools: [] }]) {
    f.setPolicy({ role: 'worker', stage: 'execute', resources: ['res-a'], tools: ['project_write_artifact'], ...scope })
    await expect(call(tools, 'project_load_skill', { skill_id: record.id })).rejects.toThrow('unauthorized')
  }
  const allowed = { role: 'worker' as const, stage: 'execute', resources: ['res-a'], tools: ['project_write_artifact'] }
  f.setPolicy(allowed)
  const forged = managedSkillTools(f.host({ catalog: { candidates: f.catalog.candidates.bind(f.catalog), body: () => 'AMBIENT DIFFERENT BODY' } }))
  await expect(call(forged, 'project_load_skill', { skill_id: record.id })).rejects.toThrow('pinned hash')
  const loaded: unknown[] = [], changing = managedSkillTools(f.host({ beforeRecord: () => f.setPolicy({ ...allowed, resources: [] }), onLoaded: value => { loaded.push(value) } }))
  await expect(call(changing, 'project_load_skill', { skill_id: record.id })).rejects.toThrow('unauthorized')
  expect(loaded).toEqual([])
  const aborted = new AbortController(); aborted.abort(new Error('cancelled'))
  await expect(call(tools, 'project_load_skill', { skill_id: record.id }, aborted.signal)).rejects.toThrow('cancelled')
  f.catalog.disable(record.id)
  await expect(call(tools, 'project_load_skill', { skill_id: record.id })).rejects.toThrow('unavailable')
  const g = fixture(), other = g.publish('allowed')
  const stale = managedSkillTools(g.host({ beforeRecord: () => g.revokeLease() }))
  await expect(call(stale, 'project_load_skill', { skill_id: other.id })).rejects.toThrow('Stale')
})

const nativeSuite = process.env.DSH_RC5_RUNTIME ? describe : describe.skip
nativeSuite('actual rc.5 model-facing tool registration', () => {
  it('accepts the first JSON body response and rejects forged scope or stale access', async () => {
    const f = fixture(), record = f.publish('allowed'), definitions = managedSkillTools(f.host())
    const req = createRequire(join(process.env.DSH_RC5_RUNTIME!, 'package.json'))
    expect(req('@deepseek-ai/dsh-tools/package.json').version).toBe('0.2.1-rc.5')
    const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
    const { ToolRuntime } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href)
    const ctx = new Context(); ctx.reflect.provide('systemPrompt', { tools: () => () => {} })
    const runtime = new ToolRuntime(ctx)
    const disposers = definitions.map(def => runtime.register({ name: def.name, description: def.description, parameters: z.toJSONSchema(def.schema),
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args: unknown, exec: { signal: AbortSignal }) => def.execute(def.schema.parse(args), exec.signal) }))
    cleanup.push(() => disposers.forEach(dispose => dispose()))
    const invoke = (args: Record<string, unknown>) => runtime.execute({ callId: crypto.randomUUID(), name: 'project_load_skill', arguments: args, signal: new AbortController().signal })
    const first = await invoke({ skill_id: record.id })
    expect(first.isError).toBe(false); expect(first.value.content).toBe('PINNED PRIVATE BODY')
    const forged = await invoke({ skill_id: record.id, project_id: 'foreign', role: 'coordinator' })
    expect(forged.isError).toBe(true)
    f.revokeLease(); const stale = await invoke({ skill_id: record.id })
    expect(stale.isError).toBe(true); expect(JSON.stringify(stale)).not.toContain('PINNED PRIVATE BODY')
  })
})
