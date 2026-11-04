/** Owner-bound repository identity: registration, attempt pinning and the shell boundary that enforces it. */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Prompts } from '../src/app/prompts.ts'
import { Store } from '../src/app/store.ts'
import { Projects } from '../src/core/index.ts'
import { ProjectCoordinator } from '../src/app/project-coordinator.ts'
import { executionIdentityContributor } from '../src/app/execution-identity.ts'
import { workerBin, writeEnvironment, writeExecutionIdentity } from '../src/infra/environment.ts'
import type { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import type { ProjectResources } from '../src/app/project-resources.ts'
import type { ExecutionIdentity } from '../src/app/execution-environment.ts'

vi.mock('../src/app/project-session.ts', () => ({
  ProjectSessionInterrupted: class extends Error {},
  ProjectSessions: class { prepare() {} reply() {} completed() {} checkpoint() {} dispose() {} },
}))

let directory: string
let store: Store
let manager: ProjectCoordinator

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'execution-identity-'))
  store = new Store(join(directory, 'db.sqlite'))
  const prompts = { current: () => ({ revision: 7, config: {} }), project: () => 'Discuss only' } as unknown as Prompts
  manager = new ProjectCoordinator({} as Context, store, new Projects({ repo: store }), directory, new AbortController().signal, prompts)
  manager.setAccountProfile({ cli: process.execPath, login: 'fixture-account', repository: 'owner/repo' })
  manager.setRepositoryVerifier(async ({ repository }) => { if (repository.toLowerCase() !== 'owner/repo') throw new Error('The configured GitHub account cannot push to this repository') })
})

afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

it('binds the host account to an owner-registered repository and pins it on the Attempt', async () => {
  const project = manager.create('owner', { name: 'Identity project', goal: 'Run one registered check' })
  const repo = join(directory, 'repo'); mkdirSync(repo); writeFileSync(join(repo, 'test_cpu.py'), 'def test_cpu():\n    assert 2 + 3 == 5\n')
  const registration = { type: 'repository' as const, path: repo, purpose: 'code-source', maxBytes: 100_000,
    identity: { repository: 'owner/repo', gitAuthorName: 'Percy Lee', gitAuthorEmail: 'percy@example.com' } }
  const source = await manager.registerResource('owner', project.id, registration, 'identity')
  expect(manager.identities.get(project.id, source.id)).toMatchObject({ repository: 'owner/repo', accountId: 'fixture-account',
    accountCli: realpathSync(process.execPath), gitAuthorName: 'Percy Lee', gitAuthorEmail: 'percy@example.com' })
  // The same owner operation returns the same registration and rewrites nothing.
  expect((await manager.registerResource('owner', project.id, registration, 'identity')).id).toBe(source.id)
  expect(manager.resources.list(project.id)).toHaveLength(1)
  manager.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Validate the registered repository source' })
  const plan = manager.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'plan', plan: { goal: 'Check', scope: 'One registered source', outputs: ['note'],
    resources: [source.id], environment: 'CPU only', cost: 'One check', completion: 'Passed', acceptance: { version: 1, mode: 'registered-files' } } })
  const confirmed = manager.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  const attempt = manager.attempts.allocate(confirmed.ticket, confirmed.assignment)
  expect(attempt.identity).toMatchObject({ repository: 'owner/repo', accountId: 'fixture-account', gitAuthorName: 'Percy Lee' })
  // A second repository leaves the identity ambiguous; planning must fail closed rather than choose by order.
  const other = await manager.registerResource('owner', project.id, { type: 'repository', path: repo, purpose: 'context', maxBytes: 100_000 })
  const wide = manager.create('owner', { name: 'Ambiguous project', goal: 'Check two sources' })
  manager.conversations.appendUser(wide.id, 'owner', { clientRequestKey: 'original', text: 'Validate both registered repository sources' })
  const spare = await manager.registerResource('owner', wide.id, { type: 'repository', path: repo, purpose: 'code-source', maxBytes: 100_000,
    identity: { repository: 'owner/repo', gitAuthorName: 'Percy Lee', gitAuthorEmail: 'percy@example.com' } })
  const context = await manager.registerResource('owner', wide.id, { type: 'repository', path: repo, purpose: 'context', maxBytes: 100_000 })
  const ambiguous = manager.plans.save('owner', wide.id, { expectedRevision: 0, operationId: 'plan', plan: { goal: 'Check both', scope: 'Two registered sources', outputs: ['note'],
    resources: [spare.id, context.id], environment: 'CPU only', cost: 'One check', completion: 'Passed', acceptance: { version: 1, mode: 'registered-files' } } })
  const second = manager.confirm('owner', wide.id, { ticketId: ambiguous.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  expect(() => manager.attempts.allocate(second.ticket, second.assignment)).toThrow('Repository identity is ambiguous')
  // Requests never choose the account or its CLI.
  await expect(manager.registerResource('owner', project.id, { type: 'file', path: join(repo, 'test_cpu.py'), purpose: 'code-config', maxBytes: 100_000,
    identity: { repository: 'owner/repo', gitAuthorName: 'X', gitAuthorEmail: 'x@example.com' } })).rejects.toThrow('Only a repository resource')
})

it('shows each Attempt its own pinned facts in a real shell, and denies a revoked binding', async () => {
  const stateDir = join(directory, 'state'); mkdirSync(stateDir)
  await writeEnvironment({ stateDir, repository: '', github: { cli: '/bin/true', login: 'fixture-account', noreply: '' }, feishu: undefined }, [])
  const identity = (executionId: string, name: string, email: string, repository: string): ExecutionIdentity => ({ executionId, projectId: 'project-1', repositoryId: 'resource-1',
    repository, accountId: 'fixture-account', accountCli: '/bin/true', gitAuthorName: name, gitAuthorEmail: email, capturedAt: new Date().toISOString() })
  const one = identity('execution-1', 'First Author', 'first@example.com', 'owner/one'), two = identity('execution-2', 'Second Author', 'second@example.com', 'owner/two')
  writeExecutionIdentity(stateDir, one); writeExecutionIdentity(stateDir, two)
  const shell = (executionId: string): string => execFileSync('/bin/sh', ['-c', 'git config user.name; git config user.email; printf %s "$DSH_EXECUTION_ID"'], {
    encoding: 'utf8', cwd: stateDir, env: { PATH: `${workerBin(stateDir)}:/usr/bin:/bin`, DSH_EXECUTION_ID: executionId, HOME: stateDir } })
  expect(shell('execution-1')).toBe('First Author\nfirst@example.com\nexecution-1')
  expect(shell('execution-2')).toBe('Second Author\nsecond@example.com\nexecution-2')
  const attempt = (value: ExecutionIdentity) => ({ projectId: value.projectId, identity: value })
  const attempts = { stateDir, bySession: (id: string) => [one, two].find(item => item.executionId === id) ? attempt(id === 'execution-1' ? one : two) : undefined } as unknown as Pick<ExecutionAttempts, 'bySession' | 'stateDir'>
  const contributor = executionIdentityContributor(attempts, { get: () => ({ type: 'repository', revoked: false }) } as unknown as Pick<ProjectResources, 'get'>)
  expect(contributor.resolve({ agent: { id: 'execution-1' } })).toEqual({ DSH_EXECUTION_ID: 'execution-1', DSH_PROJECT_ID: 'project-1', DSH_REPOSITORY: 'owner/one', DSH_GITHUB_ACCOUNT: 'fixture-account' })
  expect(contributor.resolve({ agent: { id: 'execution-2' } })).toMatchObject({ DSH_REPOSITORY: 'owner/two' })
  // Revoked or foreign bindings expose no facts and fail the shell instead of falling back.
  const revoked = executionIdentityContributor(attempts, { get: () => { throw new Error('Resource access revoked') } } as unknown as Pick<ProjectResources, 'get'>)
  expect(() => revoked.resolve({ agent: { id: 'execution-1' } })).toThrow('Resource access revoked')
  expect(contributor.resolve({ agent: { id: 'execution-9' } })).toEqual({})
})

it('persists a verified non-deployment repository and rejects an unverifiable claim without creating a resource', async () => {
  const project = manager.create('owner', { name: 'Multi repository', goal: 'Use a second repository' })
  const repo = join(directory, 'multi-repo'); mkdirSync(repo)
  const seen: string[] = []
  manager.setRepositoryVerifier(async input => { seen.push(input.repository) })
  const registration = { type: 'repository' as const, path: repo, purpose: 'repository', maxBytes: 100_000,
    identity: { repository: 'owner/other', gitAuthorName: 'Percy Lee', gitAuthorEmail: 'percy@example.com' } }
  const created = await manager.registerResource('owner', project.id, registration, 'other')
  expect(seen).toEqual(['owner/other'])
  expect(manager.identities.get(project.id, created.id)).toMatchObject({ repository: 'owner/other', accountId: 'fixture-account' })
  manager.setRepositoryVerifier(async () => { throw new Error('The configured GitHub account cannot push to this repository') })
  mkdirSync(join(directory, 'foreign-repo'))
  await expect(manager.registerResource('owner', project.id, { ...registration, path: join(directory, 'foreign-repo'),
    identity: { ...registration.identity, repository: 'owner/foreign' } }, 'foreign')).rejects.toThrow('cannot push')
  expect(manager.resources.list(project.id)).toHaveLength(1)
  expect(() => manager.identities.get(project.id, 'missing')).toThrow()
})

it('fails closed with a partial project identity instead of invoking the deployment account', async () => {
  const stateDir = join(directory, 'partial-state'); mkdirSync(stateDir)
  const sentinel = join(stateDir, 'gh-was-invoked')
  const cli = join(stateDir, 'fake-gh'); writeFileSync(cli, `#!/bin/sh\ntouch ${sentinel}\nexit 0\n`); chmodSync(cli, 0o755)
  await writeEnvironment({ stateDir, repository: '', github: { cli, login: 'fixture-account', noreply: '' }, feishu: undefined }, [])
  const identity: ExecutionIdentity = { executionId: 'partial-execution', projectId: 'project-1', repositoryId: 'resource-1', repository: 'owner/repo',
    accountId: 'fixture-account', accountCli: cli, gitAuthorName: 'Percy Lee', gitAuthorEmail: 'percy@example.com', capturedAt: new Date().toISOString() }
  writeExecutionIdentity(stateDir, identity)
  writeFileSync(join(stateDir, 'executions', identity.executionId, 'git-email'), '')
  const run = (id: string): string => execFileSync('/bin/sh', ['-c', 'gh api user'], { encoding: 'utf8', cwd: stateDir,
    env: { PATH: `${workerBin(stateDir)}:/usr/bin:/bin`, DSH_EXECUTION_ID: id, HOME: stateDir } })
  expect(() => run(identity.executionId)).toThrow()
  expect(existsSync(sentinel)).toBe(false)
  // A file whose bytes no longer match the committed marker is corrupt, not a usable identity.
  writeExecutionIdentity(stateDir, identity)
  writeFileSync(join(stateDir, 'executions', identity.executionId, 'git-name'), 'Mallory')
  expect(() => run(identity.executionId)).toThrow()
  expect(existsSync(sentinel)).toBe(false)
  // A marker committed for another execution id cannot be borrowed.
  writeFileSync(join(stateDir, 'executions', identity.executionId, '.complete.json'), JSON.stringify({ version: 1, executionId: 'another-execution', files: {} }))
  expect(() => run(identity.executionId)).toThrow()
  expect(existsSync(sentinel)).toBe(false)
  // Missing marker or identity file also fails closed.
  rmSync(join(stateDir, 'executions', identity.executionId, '.complete.json'))
  expect(() => run(identity.executionId)).toThrow()
  expect(existsSync(sentinel)).toBe(false)
  // A missing execution directory cannot fall back to the deployment default either.
  expect(() => run('missing-execution')).toThrow()
  expect(existsSync(sentinel)).toBe(false)
  // Regenerating the complete pinned files restores the exact execution identity.
  writeExecutionIdentity(stateDir, identity)
  expect(run(identity.executionId)).toBe('')
  expect(existsSync(sentinel)).toBe(true)
})

it('regenerates complete identity files when an existing committed Attempt is allocated again after a write crash', async () => {
  const project = manager.create('owner', { name: 'Crash boundary', goal: 'Recover identity files' })
  const repo = join(directory, 'crash-repo'); mkdirSync(repo); writeFileSync(join(repo, 'a.txt'), 'a')
  const source = await manager.registerResource('owner', project.id, { type: 'repository', path: repo, purpose: 'code-source', maxBytes: 100_000,
    identity: { repository: 'owner/repo', gitAuthorName: 'Percy Lee', gitAuthorEmail: 'percy@example.com' } }, 'crash-source')
  manager.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Validate the registered repository source' })
  const plan = manager.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'crash-plan', plan: { goal: 'Check', scope: 'One registered source', outputs: ['note'],
    resources: [source.id], environment: 'CPU only', cost: 'One check', completion: 'Passed', acceptance: { version: 1, mode: 'registered-files' } } })
  const confirmed = manager.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'crash-confirm', intent: 'execute' })
  // A file at the identity directory's parent makes the post-commit publication fail with ENOTDIR.
  writeFileSync(join(directory, 'executions'), 'obstacle')
  expect(() => manager.attempts.allocate(confirmed.ticket, confirmed.assignment)).toThrow()
  expect(manager.attempts.all()).toHaveLength(1)
  rmSync(join(directory, 'executions'))
  const recovered = manager.attempts.allocate(confirmed.ticket, confirmed.assignment)
  expect(existsSync(join(directory, 'executions', recovered.id, '.complete.json'))).toBe(true)
  expect(existsSync(join(directory, 'executions', recovered.id, 'gh-cli'))).toBe(true)
  expect(manager.attempts.allocate(confirmed.ticket, confirmed.assignment).id).toBe(recovered.id)
})


it('rejects a repository grant when the verified account profile changed before the commit transaction', async () => {
  const project = manager.create('owner', { name: 'Changed profile', goal: 'Register a repository' })
  const repo = join(directory, 'changed-profile-repo'); mkdirSync(repo); writeFileSync(join(repo, 'a.txt'), 'a')
  manager.setRepositoryVerifier(async () => {
    manager.setAccountProfile({ cli: process.execPath, login: 'different-account', repository: 'owner/repo' })
  })
  await expect(manager.registerResource('owner', project.id, { type: 'repository', path: repo, purpose: 'code-source', maxBytes: 100_000,
    identity: { repository: 'owner/repo', gitAuthorName: 'Percy Lee', gitAuthorEmail: 'percy@example.com' } }, 'profile-changed'))
    .rejects.toThrow('account changed during verification')
  expect(manager.resources.list(project.id)).toEqual([])
  expect(() => manager.identities.get(project.id, 'missing')).toThrow()
})

it('runs repository verification asynchronously outside the write transaction and retries a failed operation without a partial grant', async () => {
  const project = manager.create('owner', { name: 'Async verification', goal: 'Register a repository' })
  const repo = join(directory, 'async-repo'); mkdirSync(repo); writeFileSync(join(repo, 'a.txt'), 'a')
  const registration = { type: 'repository' as const, path: repo, purpose: 'code-source', maxBytes: 100_000,
    identity: { repository: 'owner/repo', gitAuthorName: 'Percy Lee', gitAuthorEmail: 'percy@example.com' } }
  let accept = false
  manager.setRepositoryVerifier(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    if (!accept) throw new Error('The configured GitHub account cannot push to this repository')
  })
  let controlRan = false
  const control = new Promise<void>(resolve => setTimeout(() => { controlRan = true; resolve() }, 0))
  const pending = manager.registerResource('owner', project.id, registration, 'outside-transaction')
  // A control action scheduled behind the verifier runs while verification is still pending; a
  // verifier called inside the SQLite transaction would hold the event loop and leave this false.
  await control
  expect(controlRan).toBe(true)
  await expect(pending).rejects.toThrow('cannot push')
  expect(manager.resources.list(project.id)).toEqual([])
  expect(() => manager.identities.get(project.id, 'missing')).toThrow()
  accept = true
  const created = await manager.registerResource('owner', project.id, registration, 'outside-transaction')
  expect(manager.resources.list(project.id)).toEqual([created])
  expect(manager.identities.get(project.id, created.id)).toMatchObject({ repository: 'owner/repo', accountId: 'fixture-account' })
})
