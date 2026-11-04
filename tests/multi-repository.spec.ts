import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { RepositoryIdentities } from '../src/app/repository-identities.ts'
it('isolates same-number objects across projects, repositories and accounts and restores immutable execution pins', () => {
  const root = mkdtempSync(join(tmpdir(), 't7-repos-')), file = join(root, 'db')
  let store = new Store(file), registry = new RepositoryIdentities(store)
  try {
    const base = { projectId: 'p1', resourceId: 'r1', repository: 'owner/repo', accountId: 'alice', accountCli: '/approved/alice-gh', gitAuthorName: 'Alice', gitAuthorEmail: 'alice@example.test' }
    registry.register(base)
    const pin = registry.pin('p1', 'r1', 'execution-1'), first = registry.reference('p1', 'r1', 42)
    registry.register({ ...base, resourceId: 'r2', repository: 'owner/other' })
    registry.register({ ...base, projectId: 'p2' })
    registry.register({ ...base, resourceId: 'r3', accountId: 'bob' })
    expect(new Set([first, registry.reference('p1', 'r2', 42), registry.reference('p2', 'r1', 42), registry.reference('p1', 'r3', 42)]).size).toBe(4)
    expect(() => registry.get('p3', 'r1')).toThrow('not registered')
    registry.register({ ...base, accountId: 'changed', accountCli: '/approved/new-gh' })
    expect(pin.accountId).toBe('alice'); expect(pin.accountCli).toBe('/approved/alice-gh')
    store.close(); store = new Store(file); registry = new RepositoryIdentities(store)
    expect(registry.get('p2', 'r1')).toEqual(base.projectId === 'p2' ? base : { ...base, projectId: 'p2' })
    expect(registry.reference('p1', 'r1', 42)).not.toBe(first)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
