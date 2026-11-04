import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { KnowledgeStore } from '../src/app/knowledge-store.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('preserves knowledge provenance and immutable confirmation versions across reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 't7-knowledge-')); roots.push(root)
  let store = new Store(join(root, 'db')); let knowledge = new KnowledgeStore(store)
  const proposed = knowledge.propose({ projectId: 'a', kind: 'decision', title: 'Approach', content: 'A', source: { kind: 'message', id: 'm1' } })
  const confirmed = knowledge.confirm('a', proposed.id)
  expect(knowledge.get('a', proposed.id)?.state).toBe('proposed')
  expect(confirmed.version).toBe(2)
  expect(confirmed.supersedes).toBe(proposed.id)
  expect(knowledge.get('b', confirmed.id)).toBeUndefined()
  store.close(); store = new Store(join(root, 'db')); knowledge = new KnowledgeStore(store)
  try { expect(knowledge.restore('a', confirmed.id)).toEqual(confirmed) } finally { store.close() }
})
