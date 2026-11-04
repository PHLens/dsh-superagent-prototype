/** Project-private skills stay undiscoverable across projects while explicitly global skills remain shared. */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { SkillCatalog } from '../src/app/skill-catalog.ts'
import { Projects } from '../src/core/index.ts'

let directory: string, store: Store, projectA: string, projectB: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'skill-scope-')); store = new Store(join(directory, 'db.sqlite'))
  const projects = new Projects({ repo: store }); projectA = projects.create({ name: 'A', goal: 'A' }).id; projectB = projects.create({ name: 'B', goal: 'B' }).id })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const skill = (name: string, body = `# ${name}\n`) => ({ name, version: '1', description: name, body, roles: ['worker' as const], stages: ['execute'], resources: [], tools: [], enabled: true })

it('keeps project-private candidates and bodies out of another project while sharing explicit globals', () => {
  const catalog = new SkillCatalog(store)
  const global = catalog.publish({ ...skill('shared-guide'), scope: 'global' })
  const a = catalog.publish({ ...skill('private-guide', 'A only'), scope: 'project', projectId: projectA })
  const b = catalog.publish({ ...skill('private-guide', 'B only'), scope: 'project', projectId: projectB })
  const policy = (projectId: string) => ({ projectId, role: 'worker' as const, stage: 'execute', resources: [], tools: [] })
  expect(catalog.candidates(policy(projectA)).map(item => [item.id, item.name])).toEqual(expect.arrayContaining([[global.id, 'shared-guide'], [a.id, 'private-guide']]))
  expect(catalog.candidates(policy(projectA)).map(item => item.id)).not.toContain(b.id)
  expect(catalog.candidates(policy(projectB)).map(item => item.id)).toEqual(expect.arrayContaining([global.id, b.id]))
  expect(catalog.body(a.id, policy(projectA))).toBe('A only')
  expect(() => catalog.body(a.id, policy(projectB))).toThrow('Skill snapshot is stale or unauthorized')
  expect(catalog.body(b.id, policy(projectB))).toBe('B only')
  expect(catalog.body(global.id, policy(projectB))).toBe('# shared-guide\n')
  // The same name/version is independently addressable in each project.
  expect(catalog.find('private-guide', '1', projectA)?.id).toBe(a.id)
  expect(catalog.find('private-guide', '1', projectB)?.id).toBe(b.id)
  // A project may override a shared name/version for itself without changing what B sees.
  const override = catalog.publish({ ...skill('shared-guide', 'A override'), scope: 'project', projectId: projectA })
  expect(catalog.find('shared-guide', '1', projectA)?.id).toBe(override.id)
  expect(catalog.candidates(policy(projectA)).find(item => item.name === 'shared-guide')!.id).toBe(override.id)
  expect(catalog.body(override.id, policy(projectA))).toBe('A override')
  expect(catalog.find('shared-guide', '1', projectB)?.id).toBe(global.id)
  expect(catalog.body(global.id, policy(projectB))).toBe('# shared-guide\n')
  expect(() => catalog.publish({ ...skill('private-guide', 'A only'), scope: 'project', projectId: projectA })).toThrow()
  expect(() => catalog.publish({ ...skill('private-guide'), scope: 'project' })).toThrow('requires its project scope')
})

it('migrates confirmed project provenance privately and hides ambiguous legacy rows', () => {
  store.close()
  const file = join(directory, 'legacy.sqlite')
  const legacy = new DatabaseSync(file)
  legacy.exec(`CREATE TABLE skill_catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(name, version));
    INSERT INTO skill_catalog (id, name, version, value) VALUES ('legacy', 'legacy-guide', '1', '{"id":"legacy","name":"legacy-guide","version":"1","description":"old","body":"old body","roles":["worker"],"stages":["execute"],"resources":[],"tools":[],"enabled":true,"createdAt":"2026-01-01T00:00:00Z"}');
    INSERT INTO skill_catalog (id, name, version, value) VALUES ('private-a', 'private-a-guide', '1', '{"id":"private-a","name":"private-a-guide","version":"1","description":"private","body":"PRIVATE OLD PROJECT A BODY","roles":["worker"],"stages":["execute"],"resources":[],"tools":[],"enabled":true,"source":"project:${projectA}","createdAt":"2026-01-01T00:00:00Z"}')`)
  legacy.close()
  store = new Store(file)
  const catalog = new SkillCatalog(store)
  const policy = (projectId: string) => ({ projectId, role: 'worker' as const, stage: 'execute', resources: [], tools: [] })
  // The unmarked old row has no confirmed owner: it is hidden instead of becoming shared.
  expect(catalog.get('legacy')).toMatchObject({ scope: 'global', enabled: false, name: 'legacy-guide' })
  expect(catalog.candidates(policy(projectA)).map(item => item.id)).not.toContain('legacy')
  // A confirmed project source is migrated as a project-private row and is unreadable by B.
  expect(catalog.get('private-a')).toMatchObject({ scope: 'project', projectId: projectA, name: 'private-a-guide' })
  expect(catalog.candidates(policy(projectA)).map(item => item.id)).toContain('private-a')
  expect(catalog.candidates(policy(projectB)).map(item => item.id)).not.toContain('private-a')
  expect(catalog.body('private-a', policy(projectA))).toContain('PRIVATE OLD PROJECT A BODY')
  expect(() => catalog.body('private-a', policy(projectB))).toThrow('Skill snapshot is stale or unauthorized')
  const local = catalog.publish({ ...skill('legacy-guide', 'new'), scope: 'project', projectId: projectA })
  expect(catalog.candidates(policy(projectA)).map(item => item.id)).toEqual(expect.arrayContaining([local.id]))
})
