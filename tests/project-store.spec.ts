import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Projects } from '../src/core/index.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'project-store-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('persists two projects and preserves identity across rename, directory changes and restart', () => {
  const path = join(directory, 'db.sqlite')
  let store = new Store(path)
  let projects = new Projects({ repo: store })
  const a = projects.create({ name: 'Research', goal: 'Compare methods' })
  const b = projects.create({ name: 'Writing', goal: 'Draft paper' })
  const draft = projects.createDraft(a.id, { title: 'Compare candidates' })
  expect(a.id).not.toBe(b.id)
  projects.update(a.id, { name: 'Renamed', directory: join(directory, 'moved') })
  expect(projects.get(b.id)).toEqual(b)
  store.close()
  store = new Store(path)
  projects = new Projects({ repo: store })
  expect(projects.get(a.id)).toMatchObject({ id: a.id, name: 'Renamed', directory: join(directory, 'moved') })
  expect(projects.get(b.id)).toEqual(b)
  expect(projects.list().map(project => project.id).sort()).toEqual([a.id, b.id].sort())
  expect(projects.ticket(a.id, draft.id)).toEqual(draft)
  expect(() => projects.ticket(b.id, draft.id)).toThrow()
  store.close()
})

it('rolls back project and ticket writes with the existing transaction and returns detached records', () => {
  const store = new Store(join(directory, 'db.sqlite'))
  const projects = new Projects({ repo: store })
  const a = projects.create({ name: 'A', goal: 'Goal' })
  expect(() => store.atomic(() => {
    projects.update(a.id, { name: 'Changed' })
    projects.create({ name: 'B', goal: 'Another' })
    projects.createDraft(a.id, { title: 'Draft' })
    throw new Error('abort')
  })).toThrow('abort')
  expect(projects.list()).toEqual([a])
  expect(store.tickets.list()).toEqual([])
  const read = projects.get(a.id)
  read.name = 'Mutated locally'
  expect(projects.get(a.id)).toEqual(a)
  store.close()
})

it('enforces durable project and Assignment ownership on SQLite writes', () => {
  const store = new Store(join(directory, 'db.sqlite'))
  const projects = new Projects({ repo: store })
  const a = projects.create({ name: 'A', goal: 'Goal' })
  const b = projects.create({ name: 'B', goal: 'Other' })
  const ticket = projects.createDraft(a.id, { title: 'Draft' })
  expect(() => store.tickets.save({ ...ticket, projectId: b.id })).toThrow(/ownership/i)
  expect(() => store.tickets.save({ ...ticket, id: 'unknown-project-ticket', projectId: 'unknown',
    mandate: { ...ticket.mandate, projectDraft: { projectId: 'unknown' } } })).toThrow(/ownership/i)
  ticket.assignments.push({ id: 'assignment-1', projectId: a.id, ticketId: ticket.id, state: 'pending', createdAt: ticket.createdAt })
  store.tickets.save(ticket)
  const other = projects.createDraft(b.id, { title: 'Other draft' })
  expect(() => store.tickets.save({ ...other, assignments: [{ ...ticket.assignments[0]!, projectId: b.id, ticketId: other.id }] })).toThrow(/another ticket/i)
  expect(() => store.tickets.save({ ...ticket, assignments: [] })).toThrow(/cannot be removed/i)
  expect(() => store.tickets.save({ ...ticket, assignments: [{ ...ticket.assignments[0]!, ticketId: 'another-ticket' }] })).toThrow(/ownership/i)
  const { projectId: _, projectStage: __, ...legacy } = ticket
  legacy.id = 'legacy-ticket'
  legacy.assignments = []
  delete legacy.mandate.projectDraft
  store.tickets.save(legacy)
  expect(() => store.tickets.save({ ...legacy, projectId: a.id, projectStage: 'draft' })).toThrow(/immutable/i)
  expect(projects.ticket(a.id, ticket.id).projectId).toBe(a.id)
  expect(projects.get(b.id)).toEqual(b)
  store.close()
})
