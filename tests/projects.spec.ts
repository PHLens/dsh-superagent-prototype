import { describe, expect, it } from 'vitest'
import { MemoryRepositories, Projects } from '../src/core/index.ts'

describe('Projects', () => {
  it('keeps duplicate names isolated and identity stable across rename and directory changes', () => {
    const repo = new MemoryRepositories()
    const service = new Projects({ repo })
    const a = service.create({ name: 'Research', goal: 'First', directory: '/one' })
    const b = service.create({ name: 'Research', goal: 'Second', directory: '/one' })
    expect(a.id).not.toBe(b.id)
    expect(service.update(a.id, { name: 'Renamed', directory: '/two' }).id).toBe(a.id)
    expect(new Projects({ repo }).get(a.id)?.directory).toBe('/two')
    expect(service.get(b.id)?.goal).toBe('Second')
    expect(service.update(a.id, { directory: null }).directory).toBeUndefined()
  })
  it('creates drafts in the same Ticket aggregate with scoped reads and immutable ownership', () => {
    const repo = new MemoryRepositories()
    const service = new Projects({ repo })
    const a = service.create({ name: 'A', goal: 'First' })
    const b = service.create({ name: 'B', goal: 'Second' })
    const ticket = service.createDraft(a.id, { title: 'Study' })
    expect(repo.tickets.get(ticket.id)?.projectStage).toBe('draft')
    expect(ticket.assignments).toEqual([])
    expect(() => service.ticket(b.id, ticket.id)).toThrow()
    expect(() => repo.tickets.save({ ...ticket, projectId: b.id })).toThrow()
    expect(() => repo.tickets.save({ ...ticket, assignments: [{ id: 'a', projectId: b.id, ticketId: ticket.id, state: 'pending', createdAt: ticket.createdAt }] })).toThrow()
    expect(service.awaitConfirmation(a.id, ticket.id).projectStage).toBe('awaiting-confirmation')
  })
  it('rejects invalid inputs and missing project without partial writes', () => {
    const repo = new MemoryRepositories(); const service = new Projects({ repo })
    expect(() => service.create({ name: ' ', goal: 'Goal' })).toThrow()
    expect(() => service.createDraft('missing', { title: 'Task' })).toThrow()
    expect(service.list()).toEqual([])
    expect(repo.tickets.list()).toEqual([])
  })
})
