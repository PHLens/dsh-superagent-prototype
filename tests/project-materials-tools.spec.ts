/** Production consumers of project materials: paged reads, idempotent writes, and durable skill loads. */
import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Projects } from '../src/core/projects.ts'
import { ConversationStore } from '../src/app/conversation-store.ts'
import { ProjectResources } from '../src/app/project-resources.ts'
import { KnowledgeStore } from '../src/app/knowledge-store.ts'
import { SkillCatalog } from '../src/app/skill-catalog.ts'
import { projectTools } from '../src/app/tools/main.ts'
import { projectWorkerTools } from '../src/app/tools/executor.ts'
import { bindManagedSkills, recordSkillLoad } from '../src/app/managed-skills.ts'
import { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import { workerFixture } from './fixtures/project-worker.ts'
import type { Commands } from '../src/infra/commands.ts'

function materials(directory: string) {
  const store = new Store(join(directory, 'db.sqlite')), projects = new Projects({ repo: store })
  const project = projects.create({ name: 'Materials', goal: 'Read the registered tree' })
  const resources = new ProjectResources(store), knowledge = new KnowledgeStore(store), skills = new SkillCatalog(store)
  return { store, projects, project, resources, knowledge, skills }
}

function tool(host: Parameters<typeof projectTools>[0], name: string) {
  return projectTools(host).find(item => item.name === name)!
}

it('continues a material listing from the returned snapshot and refuses stale, foreign or unconfirmed pages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 't7-material-pages-'))
  try {
    const f = materials(directory), root = join(directory, 'tree')
    mkdirSync(root)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, name), `${name}\n`)
    const resource = f.resources.register({ projectId: f.project.id, type: 'directory', path: root, purpose: 'context', maxBytes: 64_000 })
    const host = { plans: {} as never, actorId: 'owner', projectId: f.project.id, authorize: () => {}, materials: { resources: f.resources, knowledge: f.knowledge } }
    const read = tool(host, 'project_read_material')
    const first = await read.execute(read.schema.parse({ kind: 'resource', id: resource.id, limit: 2 }), new AbortController().signal) as { entries: { name: string }[]; next_offset: number | null; continuation: { path: string; version: string; expiresAt: string; offset: number } }
    expect(first.entries.map(item => item.name)).toEqual(['a.txt', 'b.txt']); expect(first.next_offset).toBe(2)
    // The returned continuation is the exact page-2 request; no separate offset bookkeeping is needed.
    const second = await read.execute(read.schema.parse({ kind: 'resource', id: resource.id, limit: 2, snapshot: first.continuation }), new AbortController().signal) as { entries: { name: string }[]; next_offset: number | null }
    expect(second.entries.map(item => item.name)).toEqual(['c.txt']); expect(second.next_offset).toBeNull()
    // DSH rejects tool outputs containing undefined; the terminal page omits continuation entirely.
    expect(second).not.toHaveProperty('continuation')
    // A page two request without its snapshot, and a snapshot from another listing, both fail closed.
    await expect(read.execute(read.schema.parse({ kind: 'resource', id: resource.id, offset: 2 }), new AbortController().signal)).rejects.toThrow('Resource pagination requires a snapshot')
    const other = f.resources.register({ projectId: f.project.id, type: 'file', path: join(root, 'a.txt'), purpose: 'context', maxBytes: 64_000 })
    await expect(read.execute(read.schema.parse({ kind: 'resource', id: other.id, snapshot: first.continuation }), new AbortController().signal)).rejects.toThrow('Resource snapshot is stale')
    // Only confirmed knowledge is readable through the tool, whatever id is guessed.
    const proposed = f.knowledge.propose({ projectId: f.project.id, kind: 'note', title: 'Draft', content: 'unconfirmed', source: { kind: 'import' } })
    await expect(read.execute(read.schema.parse({ kind: 'knowledge', id: proposed.id }), new AbortController().signal)).rejects.toThrow('Knowledge entry is unavailable')
    const confirmed = f.knowledge.confirm(f.project.id, proposed.id)
    expect(await read.execute(read.schema.parse({ kind: 'knowledge', id: confirmed.id }), new AbortController().signal)).toMatchObject({ state: 'confirmed', content: 'unconfirmed' })

    // The worker tool exposes the same continuation inputs; both tests page through one browse implementation.
    const w = workerFixture(join(directory, 'worker')); w.prepare()
    const workerRead = projectWorkerTools(w.attempts, w.artifacts, w.reports, w.attempt.sessionId, undefined, new ProjectResources(w.store)).find(item => item.name === 'project_read_resource')!
    expect(Object.keys((workerRead.schema as unknown as { shape: Record<string, unknown> }).shape)).toEqual(expect.arrayContaining(['offset', 'limit', 'snapshot']))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('records each loaded skill page against the execution manifest exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 't7-skill-loads-'))
  try {
    const f = workerFixture(root)
    const page = { id: 'skill-1', name: 'research', version: 'v1', bodyHash: 'a'.repeat(64), offset: 0, nextOffset: 10 }
    const loads = f.attempt.skillLoads ??= []
    expect(recordSkillLoad(loads, page, '2026-11-04T00:00:00.000Z')).toBe(true)
    expect(recordSkillLoad(loads, { ...page, name: 'ignored-repeat' }, '2026-11-04T00:01:00.000Z')).toBe(false)
    f.attempts.save(f.attempt)
    // The manifest survives as durable execution state, so backup/restore carries what was actually loaded.
    expect(new ExecutionAttempts(f.store, root).all().find(item => item.id === f.attempt.id)?.skillLoads).toEqual([{ ...page, at: '2026-11-04T00:00:00.000Z' }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('records a direct /name skill load, not only tool pages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 't7-direct-skill-'))
  try {
    const f = materials(directory)
    f.skills.publish({ name: 'walkthrough', version: '1', description: 'Walk the tree', body: '# Body', roles: ['coordinator'], stages: ['planning'], resources: [], tools: [], enabled: true })
    const candidate = f.skills.candidates({ role: 'coordinator', stage: 'planning' })[0]!
    const pin = f.skills.pin([candidate])[0]!
    let provider: (() => { get: (value: { name: string }) => Promise<{ content: string }> }) | undefined, guard: ((input: unknown, next: () => unknown) => unknown) | undefined
    const agent = { id: 'agent', ctx: { skills: { registerProvider: (factory: typeof provider) => { provider = factory; return () => {} } },
      on: (_event: string, handler: typeof guard) => { guard = handler; return () => {} } } }
    const loaded: unknown[] = []
    const dispose = bindManagedSkills(agent as never, f.skills, [{ candidate, pin }], () => ({ role: 'coordinator', stage: 'planning' }),
      agent.ctx.skills as never, value => { loaded.push(value) })
    // A native `/name` invocation and the pre-step guard both serve the body, so both are observed.
    expect((await provider!()!.get({ name: 'walkthrough' })).content).toBe('# Body')
    guard!({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '/walkthrough' }] }] }, () => undefined)
    expect(loaded).toEqual(Array(2).fill({ id: candidate.id, name: 'walkthrough', version: '1', bodyHash: pin.bodyHash, offset: 0, nextOffset: null }))
    dispose()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
