/** Project GitHub consumers share one repository but never share cursors, Threads or Tickets. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { KV } from '../src/kv.ts'
import { githubFollowId, githubNamespaceOf, githubThreadId, type GitHubNamespace } from '../src/sources/github-namespace.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, issueTrigger } from '../src/sources/github-trigger.ts'
import { pollRound, pollThreads as pollGithubThreads, pollTicketPulls } from '../src/sources/github.ts'
import { Projects, type Ticket } from '../src/core/index.ts'
import { testDeployment } from './fixtures/deployment.ts'

let directory: string, store: Store, projectA: string, projectB: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'github-scope-')); store = new Store(join(directory, 'db.sqlite'))
  const projects = new Projects({ repo: store }); projectA = projects.create({ name: 'Project A', goal: 'A' }).id; projectB = projects.create({ name: 'Project B', goal: 'B' }).id })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const namespaces = (): [GitHubNamespace, GitHubNamespace] => [githubNamespaceOf({ projectId: projectA, repositoryId: 'resource-a', accountId: 'agent-a', repository: 'owner/shared' })!,
  githubNamespaceOf({ projectId: projectB, repositoryId: 'resource-b', accountId: 'agent-b', repository: 'owner/shared' })!]
function context(namespace: GitHubNamespace, bind = vi.fn(), commands: unknown = {}, health = ['github']): { ctx: SourceContext; bind: typeof bind } {
  const deps = { store, outbox: { send: vi.fn() }, engine: { bindThread: bind, threadClosed: vi.fn() }, sources: { instance: () => ({ enabled: true, config: {} }), healthEntries: (names: string[]) => new Map(names.map(name => [name, { set: vi.fn() }])) },
    commands, deployment: testDeployment(), ready: Promise.resolve(), configured: () => true,
    receive: vi.fn(), githubNamespace: namespace } as unknown as SourceContextDeps
  return { ctx: sourceContextOf(deps, { kind: 'github', health }), bind }
}
const ticket = (id: string, projectId: string, number: number, namespace: GitHubNamespace): Ticket => ({ id, projectId, projectStage: 'confirmed', title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], follows: [{ thread: githubFollowId(namespace, number), own: true }],
  origin: { triggerId: `source-${id}`, triggerIds: [] }, createdAt: '', updatedAt: '' })

it('filters subscribed Threads, Tickets and state to one project/resource scope', () => {
  const [a, b] = namespaces()
  for (const [number, key, owner] of [[7, githubThreadId(a, 7), 'ticket-a'], [7, githubThreadId(b, 7), 'ticket-b'], [7, 'github:7', 'ticket']] as const)
    store.threads.save({ key, ref: { source: 'github', id: String(number) }, createdAt: new Date().toISOString(), subscriptions: [owner], correlated: [], pending: [], meta: {} })
  store.tickets.save(ticket('ticket-a', projectA, 7, a)); store.tickets.save(ticket('ticket-b', projectB, 7, b))
  const { ctx: ctxA } = context(a), { ctx: ctxB } = context(b)
  expect(ctxA.threads.subscribed('github').map((thread: { key: string }) => thread.key)).toEqual([githubThreadId(a, 7)])
  expect(ctxB.threads.subscribed('github').map((thread: { key: string }) => thread.key)).toEqual([githubThreadId(b, 7)])
  expect(ctxA.threads.get(githubThreadId(b, 7))).toBeUndefined()
  expect(ctxA.tickets.open().map((item: { id: string }) => item.id)).toEqual(['ticket-a'])
  expect(ctxB.tickets.open().map((item: { id: string }) => item.id)).toEqual(['ticket-b'])
  expect(ctxA.tickets.get('ticket-b')).toBeUndefined()
  // The deployment-wide scope keeps its legacy Threads and Tickets, never a project's.
  const { ctx: global } = context(undefined as never)
  expect(global.threads.subscribed('github').map((thread: { key: string }) => thread.key)).toEqual(['github:7'])
  expect(global.tickets.open()).toEqual([])
  // A typed family enumerates only members of this exact scope.
  ctxA.state.set(KV.github.cursor(7), 'a'); ctxB.state.set(KV.github.cursor(7), 'b')
  const keysA = ctxA.state.keys(KV.github.cursor), keysB = ctxB.state.keys(KV.github.cursor)
  expect(keysA).toHaveLength(1); expect(keysA[0]).toMatch(/^github-cursor:7#[a-f0-9]{64}$/)
  expect(keysB).toHaveLength(1); expect(keysB[0]).not.toBe(keysA[0])
  expect(ctxA.state.get(KV.github.cursor(7))).toBe('a'); expect(ctxB.state.get(KV.github.cursor(7))).toBe('b')
})

it('binds a numeric Thread only inside the consumer scope and rejects a foreign Ticket', () => {
  const [a, b] = namespaces()
  store.tickets.save(ticket('ticket-a', projectA, 7, a)); store.tickets.save(ticket('ticket-b', projectB, 7, b))
  const { ctx, bind } = context(a)
  expect(() => ctx.tickets.bindThread('ticket-b', { source: 'github', id: '7' }, true)).toThrow('outside this project GitHub scope')
  ctx.tickets.bindThread('ticket-a', { source: 'github', id: '7' }, true)
  expect(bind.mock.calls[0]!.slice(0, 2)).toEqual(['ticket-a', { source: 'github', id: githubFollowId(a, 7).replace('github:', '') }])
  // Already-scoped IDs are idempotent, never double-suffixed.
  ctx.tickets.bindThread('ticket-a', { source: 'github', id: githubFollowId(a, 7) }, true)
  expect(bind.mock.calls[1]![1]).toEqual({ source: 'github', id: githubFollowId(a, 7).replace('github:', '') })
  expect(() => context(b).ctx.tickets.bindThread('ticket-a', { source: 'github', id: '7' }, false)).toThrow('outside this project GitHub scope')
})

it('gives same-numbered Triggers and Threads distinct identities across projects and repositories', () => {
  const [a] = namespaces(), shared = githubNamespaceOf({ projectId: projectA, repositoryId: 'resource-c', accountId: 'agent-a', repository: 'owner/other' })!
  const issue = { number: 7, title: 'Fix', body: 'x', user: { login: 'alice' }, html_url: 'https://github.com/owner/shared/pull/7', created_at: '2026-01-01T00:00:00Z' }
  expect(issueTrigger(issue, 'agent', a).id).not.toBe(issueTrigger(issue, 'agent', shared).id)
  expect(issueTrigger(issue, 'agent', a).threads[0]!.id).toBe(`${githubThreadId(a, 7).replace('github:', '')}`)
  const comment = { id: 9, body: 'hello', user: { login: 'alice' }, html_url: 'https://github.com/owner/shared/pull/7#issuecomment-9', updated_at: '2026-01-01T00:00:00Z' }
  expect(commentTrigger(comment, { number: 7, isPr: true, url: issue.html_url }, 'conversation', 'agent', a).id)
    .not.toBe(commentTrigger(comment, { number: 7, isPr: true, url: issue.html_url }, 'conversation', 'agent', shared).id)
  expect(branchCiTrigger('main', 'abc', 1, 'ok', 'u', a).threads[0]!.id).not.toBe(branchCiTrigger('main', 'abc', 1, 'ok', 'u', shared).threads[0]!.id)
  expect(ciTrigger({ number: 7, html_url: issue.html_url, user: { login: 'agent' } }, 1, 'ok', a).id)
    .not.toBe(ciTrigger({ number: 7, html_url: issue.html_url, user: { login: 'agent' } }, 1, 'ok', shared).id)
})


it('polls only Threads subscribed by its own scope and never number-extracts a foreign Thread', async () => {
  const [a, b] = namespaces()
  for (const [key, id, owner] of [[githubThreadId(a, 7), '7', 'ticket-a'], [githubThreadId(b, 7), '7', 'ticket-b']] as const)
    store.threads.save({ key, ref: { source: 'github', id }, createdAt: new Date().toISOString(), subscriptions: [owner], correlated: [], pending: [], meta: { isPr: false, title: 'Issue' } })
  store.tickets.save(ticket('ticket-a', projectA, 7, a))
  const pages = vi.fn(async (_schema: unknown, _path: string, _tally?: unknown) => [] as unknown[])
  const commands = { withSignal: () => commands, pages }
  const { ctx } = context(a, vi.fn(), commands)
  await pollGithubThreads(ctx)
  expect(pages).toHaveBeenCalledTimes(1)
  expect(pages.mock.calls[0]![1]).toContain('issues/7/comments')
  expect(ctx.state.get(KV.github.cursor(7))).toBeTruthy()
})


it('polls only its own bound Threads and Ticket PRs, with no deployment notifications, repository-wide streams or health report', async () => {
  const [a, b] = namespaces()
  store.threads.save({ key: githubThreadId(a, 7), ref: { source: 'github', id: '7' }, createdAt: new Date().toISOString(), subscriptions: ['ticket-a'], correlated: [], pending: [], meta: { isPr: false, title: 'A issue' } })
  store.threads.save({ key: githubThreadId(b, 7), ref: { source: 'github', id: '7' }, createdAt: new Date().toISOString(), subscriptions: [], correlated: [], pending: [], meta: { isPr: false, title: 'B unbound issue' } })
  store.tickets.save(ticket('ticket-a', projectA, 7, a))
  const api = vi.fn(async (_schema: unknown, path: string) => path.startsWith('commits/') ? [] : ({ number: 7, title: 'PR', state: 'open', html_url: 'https://github.com/owner/shared/pull/7', user: { login: 'agent-a' },
    head: { sha: 'a', ref: 'main', repo: { full_name: 'owner/shared' } } }))
  const pages = vi.fn(async (_schema: unknown, _path: string) => [])
  const commands = { withSignal: () => commands, api, pages }
  const { ctx } = context(a, vi.fn(), commands, [])
  await expect(pollRound(ctx)).resolves.toBe(60)
  const paths = pages.mock.calls.map(call => String(call[1] ?? ''))
  expect(paths.some(path => path.includes('issues/7/comments'))).toBe(true)
  expect(paths.some(path => path.includes('notifications'))).toBe(false)
  expect(api.mock.calls.some(call => String(call[1] ?? '').includes('notifications'))).toBe(false)
  // No repository-wide query was sent, so the unbound B issue was never read or turned into a Trigger.
  const apiPaths = api.mock.calls.map(call => String(call[1] ?? ''))
  expect(apiPaths.every(path => path.startsWith('pulls/7') || path.startsWith('commits/'))).toBe(true)
  expect(paths.some(path => path.includes('issues/7') && !path.includes('comments'))).toBe(false)
})


it('polls only PR numbers followed in the watcher resource scope even inside one project', async () => {
  const [a] = namespaces(), other = githubNamespaceOf({ projectId: projectA, repositoryId: 'resource-c', accountId: 'agent-a', repository: 'owner/other' })!
  const source = ticket('ticket-multi-resource', projectA, 7, a)
  store.tickets.save({ ...source, follows: [...source.follows!, { thread: githubFollowId(other, 8), own: true }] })
  const api = vi.fn(async (_schema: unknown, path: string) => path === 'pulls/7'
    ? { number: 7, title: 'A PR', state: 'open', html_url: 'https://github.com/owner/shared/pull/7', user: { login: 'agent-a' }, head: { sha: 'a', ref: 'main', repo: { full_name: 'owner/shared' } } }
    : [])
  const pages = vi.fn(async () => [])
  const commands = { withSignal: () => commands, api, pages }
  const { ctx } = context(a, vi.fn(), commands, [])
  await pollTicketPulls(ctx)
  expect(api.mock.calls.map(call => String(call[1] ?? '')).filter(path => path.startsWith('pulls/'))).toEqual(['pulls/7'])
})
