import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { SkillCatalog } from '../src/app/skill-catalog.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('filters candidates and reauthorizes pinned body loads', () => {
  const root = mkdtempSync(join(tmpdir(), 't7-skills-')); roots.push(root); const store = new Store(join(root, 'db')); const skills = new SkillCatalog(store)
  const skill = skills.publish({ name: 'code-review', version: '1', description: 'Review code', body: 'trusted body', roles: ['code'], stages: ['review'], resources: [], tools: [], enabled: true })
  const candidate = skills.candidates({ role: 'code', stage: 'review' }); expect(candidate).toHaveLength(1); const [pin] = skills.pin(candidate); expect(skills.body(skill.id, { role: 'code', stage: 'review', pin })).toBe('trusted body')
  expect(() => skills.body(skill.id, { role: 'writing', stage: 'review', pin })).toThrow(); skills.disable(skill.id); expect(() => skills.body(skill.id, { role: 'code', stage: 'review', pin })).toThrow(); store.close()
})
