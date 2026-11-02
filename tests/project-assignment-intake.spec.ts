import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Prompts } from '../src/app/prompts.ts'
import { Store } from '../src/app/store.ts'
import { Projects } from '../src/core/index.ts'
import { ProjectCoordinator } from '../src/app/project-coordinator.ts'

vi.mock('../src/app/project-session.ts', () => ({
  ProjectSessionInterrupted: class extends Error {},
  ProjectSessions: class {
    prepare = vi.fn()
    reply = vi.fn()
    completed = vi.fn()
    checkpoint = vi.fn()
    dispose = vi.fn()
  },
}))

let directory: string
let store: Store
let manager: ProjectCoordinator
const plan = { goal: 'Ship feature', scope: 'one module', outputs: ['code'], resources: [], environment: 'test', cost: 'small', completion: 'tests pass' }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'project-assignment-'))
  store = new Store(join(directory, 'db.sqlite'))
  const prompts = { current: () => ({ revision: 1, config: {} }), project: () => 'Discuss only' } as unknown as Prompts
  manager = new ProjectCoordinator({} as Context, store, new Projects({ repo: store }), directory, new AbortController().signal, prompts)
})
afterEach(async () => { await manager.stop(); store.close(); rmSync(directory, { recursive: true, force: true }) })

it('confirms a unique plan and registers one waiting assignment atomically', () => {
  const project = manager.create('alice', { name: 'A', goal: 'ship' })
  manager.send('alice', project.id, { requestId: 'request-1', text: '请制定一个可执行方案' })
  const revision = manager.plans.save('alice', project.id, { plan, expectedRevision: 0 })
  const result = manager.send('alice', project.id, { requestId: 'confirm-1', text: '按这个方案做', ticketId: manager.view('alice', project.id).tasks[0]!.id, planRevision: 1 })
  if (!('assignment' in result)) throw new Error('confirmation was not accepted')
  expect(result.assignment).toMatchObject({ waitingReason: 'executor-unavailable' })
  expect(result.message.status).toBe('saved')
  expect(manager.view('alice', project.id).tasks).toHaveLength(1)
  expect(revision.revision).toBe(1)
})

it('deduplicates the same confirmation operation across repeated messages', () => {
  const project = manager.create('alice', { name: 'A', goal: 'ship' })
  manager.send('alice', project.id, { requestId: 'request-1', text: '请制定方案' })
  manager.plans.save('alice', project.id, { plan, expectedRevision: 0 })
  const first = manager.send('alice', project.id, { requestId: 'confirm-1', text: 'implement this plan', ticketId: manager.view('alice', project.id).tasks[0]!.id, planRevision: 1 })
  const second = manager.send('alice', project.id, { requestId: 'confirm-1', text: 'implement this plan', ticketId: manager.view('alice', project.id).tasks[0]!.id, planRevision: 1 })
  if (!('assignment' in first) || !('assignment' in second)) throw new Error('confirmation was not accepted')
  expect(second.authorization.id).toBe(first.authorization.id)
  expect(manager.view('alice', project.id).tasks?.[0]?.assignments).toHaveLength(1)
})

it('rejects changed content under a reused save operation and preserves the draft', () => {
  const project = manager.create('alice', { name: 'A', goal: 'ship' })
  const first = manager.plans.save('alice', project.id, { plan, expectedRevision: 0, operationId: 'save-1' })
  expect(() => manager.plans.save('alice', project.id, { plan: { ...plan, goal: 'Changed' }, expectedRevision: 0, operationId: 'save-1' })).toThrowError('Operation id was already used')
  expect(manager.view('alice', project.id).tasks).toHaveLength(1)
  expect(manager.plans.get('alice', project.id, first.ticketId).revision).toBe(1)
})

it('conflicts when a confirmation request reuses its id with a changed anchor', () => {
  const project = manager.create('alice', { name: 'A', goal: 'ship' })
  manager.plans.save('alice', project.id, { plan, expectedRevision: 0 })
  const ticket = manager.view('alice', project.id).tasks[0]!
  manager.plans.save('alice', project.id, { ticketId: ticket.id, plan: { ...plan, goal: 'updated' }, expectedRevision: 1 })
  const first = manager.send('alice', project.id, { requestId: 'confirm-anchor', text: '按这个方案做', ticketId: ticket.id, planRevision: 1 })
  if (!('clarification' in first)) throw new Error('expected stale confirmation clarification')
  expect(() => manager.send('alice', project.id, { requestId: 'confirm-anchor', text: '按这个方案做', ticketId: ticket.id, planRevision: 2 })).toThrowError('plan anchor')
  expect(manager.view('alice', project.id).tasks[0]?.authorizations ?? []).toHaveLength(0)
})

it('rejects wrong actor and stale plan generation before authorization', () => {
  const project = manager.create('alice', { name: 'A', goal: 'ship' })
  manager.send('alice', project.id, { requestId: 'request-1', text: '请制定方案' })
  manager.plans.save('alice', project.id, { plan, expectedRevision: 0 })
  const ticket = manager.view('alice', project.id).tasks[0]!
  expect(() => manager.confirm('bob', project.id, { ticketId: ticket.id, planRevision: 1, operationId: 'x', intent: 'execute' })).toThrow()
  expect(() => manager.plans.save('alice', project.id, { ticketId: ticket.id, plan: { ...plan, goal: 'new' }, expectedRevision: 0 })).toThrowError('Plan revision changed')
})

it('reruns a confirmed plan with a new operation and target', () => {
  const project = manager.create('alice', { name: 'A', goal: 'ship' })
  manager.send('alice', project.id, { requestId: 'request-1', text: '请制定方案' })
  manager.plans.save('alice', project.id, { plan, expectedRevision: 0 })
  const first = manager.send('alice', project.id, { requestId: 'confirm-1', text: '按这个方案做', ticketId: manager.view('alice', project.id).tasks[0]!.id, planRevision: 1 })
  const second = manager.send('alice', project.id, { requestId: 'rerun-1', text: 'run it again', ticketId: manager.view('alice', project.id).tasks[0]!.id, planRevision: 1 })
  if (!('assignment' in first) || !('assignment' in second)) throw new Error('confirmation was not accepted')
  expect(second.authorization.id).not.toBe(first.authorization.id)
  expect(second.target.id).not.toBe(first.target.id)
  expect(manager.view('alice', project.id).tasks?.[0]?.assignments).toHaveLength(2)
})

it('rejects an explicitly unknown ticket instead of creating a draft', () => {
  const project = manager.create('alice', { name: 'A', goal: 'ship' })
  expect(() => manager.plans.save('alice', project.id, { ticketId: 'missing-ticket', plan, expectedRevision: 0 })).toThrowError('Unknown ticket')
  expect(manager.view('alice', project.id).tasks).toHaveLength(0)
})

it('persists deterministic clarification and completes the handled input', () => {
  const project = manager.create('alice', { name: 'A', goal: 'ship' })
  const result = manager.send('alice', project.id, { requestId: 'ambiguous', text: '按这个方案做' })
  if (!('clarification' in result)) throw new Error('clarification was not returned')
  const messages = manager.view('alice', project.id).messages
  expect(messages.at(-1)).toMatchObject({ role: 'assistant', status: 'saved', text: result.clarification })
  expect(messages.find(message => message.clientRequestKey === 'ambiguous')).toMatchObject({ status: 'answered' })
})

it('does not dispatch a strict confirmation when multiple current plans exist', () => {
  const project = manager.create('alice', { name: 'A', goal: 'ship' })
  manager.plans.save('alice', project.id, { plan, expectedRevision: 0 })
  manager.plans.save('alice', project.id, { plan: { ...plan, goal: 'Second' }, expectedRevision: 0 })
  const result = manager.send('alice', project.id, { requestId: 'ambiguous', text: '执行这个方案' })
  expect(result).toHaveProperty('clarification')
  expect(manager.view('alice', project.id).tasks?.every(task => !task.authorizations?.length)).toBe(true)
})
