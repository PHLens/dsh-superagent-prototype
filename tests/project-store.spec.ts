import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { ChannelMessage } from '../src/app/channel-store.ts'
import { projectIds } from '../src/core/project-ids.ts'
import type { Artifact, Project, ProjectTask } from '../src/core/project-model.ts'
import type { Attempt } from '../src/core/attempts.ts'

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'project-store-')); store = new Store(join(directory, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const project = (seed: string): Project => ({ id: projectIds.project(seed), name: seed, goal: 'goal', state: 'active', workspaceId: `workspace-${seed}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
const task = (p: Project, seed = 'task'): ProjectTask => ({ id: projectIds.task(`${p.id}:${seed}`), projectId: p.id, title: seed, state: 'queued', createdAt: p.createdAt, updatedAt: p.updatedAt })
const attempt = (p: Project, t: ProjectTask): Attempt => ({ id: projectIds.attempt('attempt'), projectId: p.id, taskId: t.id, assignmentId: projectIds.assignment('assignment'), authorizationId: projectIds.authorization('authorization'), leaseId: projectIds.lease('lease'), state: 'preparing', createdAt: p.createdAt })
const message = (id: string, accountId = 'account-a', projectId?: Project['id']): ChannelMessage => ({ id, source: 'feishu', accountId, nativeId: id, projectId, text: id, status: projectId ? 'accepted' : 'unresolved', at: '2026-01-01T00:00:00Z' })
function setup() {
  const one = project('one'), two = project('two'); store.projects.create(one); store.projects.create(two)
  const first = task(one), second = task(two); store.projects.saveTask(first); store.projects.saveTask(second)
  return { one, two, first, second }
}

it('persists records across reopen, preserving project identity through renames', () => {
  const { one, first } = setup(); const execution = attempt(one, first); store.projects.saveAttempt(execution)
  store.projects.save({ ...one, name: 'renamed' }); store.close(); store = new Store(join(directory, 'db.sqlite'))
  expect(store.projects.get(one.id)?.name).toBe('renamed'); expect(store.projects.list()).toHaveLength(2)
  expect(store.projects.listTasks(one.id)).toEqual([first]); expect(store.projects.getAttempt(execution.id)).toEqual(execution)
  expect(store.projects.listAttempts(one.id, first.id)).toEqual([execution])
  expect(() => store.projects.create(one)).toThrow()
  expect(() => store.projects.save(project('missing'))).toThrow('exist')
})

it('rejects missing project records and immutable task and attempt ownership changes', () => {
  const { one, two, first } = setup(); const execution = attempt(one, first); store.projects.saveAttempt(execution)
  expect(() => store.projects.saveTask({ ...first, projectId: projectIds.project('missing') })).toThrow('exist')
  expect(() => store.projects.saveTask({ ...first, projectId: two.id })).toThrow('ownership')
  expect(() => store.projects.saveAttempt({ ...execution, projectId: two.id })).toThrow('ownership')
  for (const patch of [{ taskId: task(one, 'another').id }, { assignmentId: projectIds.assignment('other') }, { authorizationId: projectIds.authorization('other') }, { leaseId: projectIds.lease('other') }]) {
    expect(() => store.projects.saveAttempt({ ...execution, ...patch })).toThrow()
  }
  store.projects.saveAttempt({ ...execution, state: 'running' }); expect(store.projects.getAttempt(execution.id)?.state).toBe('running')
})

it('deduplicates native events across message IDs while distinguishing accounts and sources', () => {
  const { one, two } = setup(); const original = message('native', 'account-a', one.id)
  expect(store.channels.receive(original, 'op-1').duplicate).toBe(false)
  expect(store.channels.receive({ ...original, id: 'redelivery' }, 'op-2')).toEqual({ message: original, duplicate: true })
  expect(store.channels.receive({ ...original, id: 'other-account', accountId: 'account-b', projectId: two.id }, 'op-1').duplicate).toBe(false)
  expect(store.channels.receive({ ...original, id: 'other-source', source: 'web' }, 'op-3').duplicate).toBe(false)
  expect(() => store.channels.receive({ ...original, id: 'cross-project', projectId: two.id }, 'new-op')).toThrow('another project')
  expect(store.channels.get('cross-project')).toBeUndefined()
})

it('makes project-scoped operations idempotent without inserting a second message', () => {
  const { one, two } = setup(); const original = message('native', 'account-a', one.id)
  store.channels.receive(original, 'same-op')
  expect(store.channels.receive(message('retry', 'account-a', one.id), 'same-op')).toEqual({ message: original, duplicate: true })
  expect(store.channels.get('retry')).toBeUndefined()
  expect(store.channels.receive(message('another-project', 'account-a', two.id), 'same-op').duplicate).toBe(false)
  expect(store.channels.list(one.id)).toEqual([original])
})

it('resolves a native event once, and accepts unresolved retries after routing', () => {
  const { one, two } = setup(); const original = message('unresolved'); store.channels.receive(original, 'route-op')
  expect(store.channels.resolveProject(original.id, one.id).projectId).toBe(one.id)
  expect(store.channels.resolveProject(original.id, one.id).projectId).toBe(one.id)
  expect(store.channels.receive(original, 'route-op').duplicate).toBe(true)
  expect(store.channels.receive(original, 'another-op').message.projectId).toBe(one.id)
  expect(() => store.channels.resolveProject(original.id, two.id)).toThrow('ownership')
})

it('rolls back routing if moving an unresolved operation conflicts with a project operation', () => {
  const { one } = setup(); const pending = message('pending'); store.channels.receive(pending, 'collision')
  store.channels.receive(message('already-routed', 'account-a', one.id), 'collision')
  expect(() => store.channels.resolveProject(pending.id, one.id)).toThrow()
  expect(store.channels.get(pending.id)).toEqual(pending)
  expect(store.channels.receive(pending, 'collision').duplicate).toBe(true)
})

it('rejects channel task ownership mismatches and invalid native identities', () => {
  const { one, second } = setup()
  expect(() => store.channels.receive({ ...message('cross-task', 'account-a', one.id), taskId: second.id }, 'op')).toThrow('ownership')
  expect(() => store.channels.receive({ ...message('no-project'), taskId: second.id }, 'op')).toThrow('ownership')
  expect(() => store.channels.receive({ ...message('empty-native'), nativeId: '' }, 'op')).toThrow('identity')
  expect(store.channels.list()).toEqual([])
})

it('saves task-owned artifacts and rejects reassignment to any other task or project', () => {
  const { one, two, first, second } = setup()
  const sameProjectTask = { ...second, id: projectIds.task('same-project-second'), projectId: one.id }
  store.projects.saveTask(sameProjectTask)
  const artifact: Artifact = { id: projectIds.artifact('artifact'), projectId: one.id, taskId: first.id, path: 'out.txt', contentVersion: 'v1', kind: 'text', evidence: [], valid: true, createdAt: one.createdAt }
  store.artifacts.save(artifact); store.artifacts.save({ ...artifact, contentVersion: 'v2' })
  expect(store.artifacts.get(artifact.id)?.contentVersion).toBe('v2'); expect(store.artifacts.list(one.id, first.id)).toHaveLength(1)
  expect(store.artifacts.list(two.id)).toEqual([])
  expect(() => store.artifacts.save({ ...artifact, projectId: two.id })).toThrow('ownership')
  expect(() => store.artifacts.save({ ...artifact, taskId: sameProjectTask.id })).toThrow('immutable')
  expect(() => store.artifacts.save({ ...artifact, taskId: projectIds.task('missing') })).toThrow('ownership')
})

it('rolls back project, task, attempt, artifact and operation writes as a unit', () => {
  const p = project('transaction'); const t = task(p); const m = message('transaction', 'account-a', p.id)
  expect(() => store.atomic(() => {
    store.projects.create(p); store.projects.saveTask(t); store.projects.saveAttempt(attempt(p, t))
    store.channels.receive(m, 'atomic-op')
    store.artifacts.save({ id: projectIds.artifact('rollback'), projectId: p.id, taskId: t.id, path: 'out.txt', contentVersion: 'v1', kind: 'text', evidence: [], valid: true, createdAt: p.createdAt })
    throw new Error('injected failure')
  })).toThrow('injected failure')
  expect(store.projects.get(p.id)).toBeUndefined(); expect(store.projects.getTask(t.id)).toBeUndefined()
  expect(store.projects.listAttempts(p.id)).toEqual([]); expect(store.artifacts.list(p.id)).toEqual([]); expect(store.channels.get(m.id)).toBeUndefined()
  store.projects.create(p); expect(store.channels.receive(m, 'atomic-op').duplicate).toBe(false)
})
