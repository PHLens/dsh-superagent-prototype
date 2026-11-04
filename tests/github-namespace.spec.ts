import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubFollowId, githubNamespaceKey, githubStateKey, githubThreadId, requireGitHubNamespace, sameGithubThread } from '../src/sources/github-namespace.ts'
import { claimPull } from '../src/sources/github-pull.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { GitHubNamespace } from '../src/sources/github-namespace.ts'

it('keeps the same pull number distinct across projects and repositories', () => {
  const a = { projectId: 'p1', resourceId: 'r1', account: 'alice', repository: 'Org/one' }
  const b = { projectId: 'p2', resourceId: 'r2', account: 'alice', repository: 'Org/two' }
  expect(githubNamespaceKey(a, 7)).not.toBe(githubNamespaceKey(b, 7))
  expect(githubNamespaceKey(a, 7)).toBe(githubNamespaceKey({ ...a, repository: 'org/ONE' }, 7))
})

it('rejects project consumers without an explicit registered namespace', () => {
  expect(() => requireGitHubNamespace(undefined)).toThrow('Project GitHub resource binding')
})

const alice = { projectId: 'p1', resourceId: 'r1', account: 'alice', repository: 'Org/one' }
const bob = { projectId: 'p2', resourceId: 'r2', account: 'alice', repository: 'Org/one' }

it('scopes thread ids, follow ids and polling state once per project namespace', () => {
  // The same repository and PR number in two projects never shares a Thread, a Follow or a cursor.
  expect(githubThreadId(alice, 7)).not.toBe(githubThreadId(bob, 7))
  expect(githubFollowId(alice, 7)).not.toBe(githubFollowId(bob, 7))
  expect(githubStateKey(alice, 'github-cursor:7')).not.toBe(githubStateKey(bob, 'github-cursor:7'))
  // Legacy deployment-wide keys stay readable.
  expect(githubStateKey(undefined, 'github-cursor:7')).toBe('github-cursor:7')
  expect(githubThreadId(undefined, 7)).toBe('github:7')
  // A scoped id is recognised as its own number and is not wrapped a second time.
  expect(sameGithubThread(githubThreadId(alice, 7), alice, 7)).toBe(true)
  expect(sameGithubThread(githubThreadId(bob, 7), alice, 7)).toBe(false)
})

function pullTicket(projectId: string, namespace: GitHubNamespace) {
  return { id: `ticket-${projectId}`, projectId, origin: { triggerId: 'trigger' }, execution: { name: 'p1' },
    follows: [{ thread: githubFollowId(namespace, 7), own: true, closed: false }] } as never
}
const pull = { number: 7, state: 'open', html_url: 'https://example.test/pull/7', user: { login: 'alice' },
  head: { sha: 'sha', ref: 'agent/p1', repo: { full_name: 'Org/one' } } } as never

it('refuses a PR that another project already follows only inside that project\'s namespace', () => {
  const first = pullTicket('p1', alice), second = pullTicket('p2', bob)
  const context = (namespace: GitHubNamespace | undefined, ticket: unknown): SourceContext => ({
    tickets: { get: () => ticket, open: () => [first] }, triggers: { get: () => undefined }, githubNamespace: namespace,
    deployment: { github: { login: 'alice' }, repository: 'Org/one' } } as unknown as SourceContext)
  // In the second project's namespace the first project's Follow is invisible, so binding is allowed.
  expect(claimPull(context(bob, second), 'ticket-p2', pull)).toBeUndefined()
  // Inside one namespace the owner is found by its scoped Follow and a second ticket is refused.
  expect(claimPull(context(alice, second), 'ticket-p2', pull)).toBe('PR already belongs to another active ticket')
  // A project ticket never binds through the deployment-wide (unscoped) source.
  expect(claimPull(context(undefined, second), 'ticket-p2', pull)).toBe('Project GitHub consumers require a registered repository resource binding')
})

function githubContext(store: Store, namespace?: GitHubNamespace): SourceContext {
  return sourceContextOf({ store, outbox: {} as never, engine: {} as never, commands: {} as never,
    sources: { healthEntries: () => [], instance: () => undefined } as never,
    deployment: { github: { login: 'alice' }, repository: 'Org/one' } as never,
    ready: Promise.resolve(), configured: () => true, receive: (() => undefined) as never, githubNamespace: namespace },
  { kind: 'github', health: [] })
}

it('persists a cursor under exactly one namespace suffix through real contexts and a reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 't7-github-state-')), cursor = KV.github.cursor(7)
  const alice = { projectId: 'p1', resourceId: 'r1', account: 'alice', repository: 'Org/one' }
  const bob = { projectId: 'p2', resourceId: 'r2', account: 'alice', repository: 'Org/one' }
  const open = () => { const store = new Store(join(directory, 'db.sqlite')); return { store, context: githubContext(store, alice) } }
  try {
    const first = open()
    first.context.state.set(cursor, '2026-01-01T00:00:00.000Z')
    const single = `${cursor}#${githubNamespaceKey(alice)}`
    // The boundary appends exactly one suffix; the raw key is the only persistence form.
    expect(githubStateKey(alice, githubStateKey(alice, cursor))).toBe(single)
    expect(first.store.keys(cursor)).toEqual([single])
    expect(first.store.get(single)).toBe('2026-01-01T00:00:00.000Z')
    expect(first.context.state.get(cursor)).toBe('2026-01-01T00:00:00.000Z')
    // A second, independently constructed context for another project reads its own cursor.
    githubContext(first.store, bob).state.set(cursor, 'other')
    expect(first.store.keys(cursor).sort()).toEqual([single, `${cursor}#${githubNamespaceKey(bob)}`].sort())
    first.store.close()
    // Reopening the database and building the context again reads the same single-suffix cursor.
    const second = open()
    expect(second.context.state.get(cursor)).toBe('2026-01-01T00:00:00.000Z')
    expect(second.store.keys(cursor)).toEqual([single, `${cursor}#${githubNamespaceKey(bob)}`].sort())
    // Deployment-wide polling keeps the historical unscoped key.
    githubContext(second.store).state.set(cursor, 'legacy')
    expect(second.store.get(cursor)).toBe('legacy')
    second.store.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
