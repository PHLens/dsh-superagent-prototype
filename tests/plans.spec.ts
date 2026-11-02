import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { MemoryRepositories, Plans, Projects, type PlanContent, type ProjectRepositories } from '../src/core/index.ts'

const plan: PlanContent = { goal: 'Compare methods', scope: 'Local benchmark only', outputs: ['report.md'], resources: ['dataset-v1'], environment: 'Local Python environment', cost: 'At most 10 minutes', completion: 'Report includes measured results' }
function setup(repo: ProjectRepositories = new MemoryRepositories()) {
  let next = 0
  const projects = new Projects({ repo, id: () => `project-${++next}` })
  const project = projects.create({ name: 'Research', goal: 'Compare methods' })
  const ticket = projects.createDraft(project.id, { title: 'Run comparison' })
  const plans = new Plans({ repo, id: () => `plan-${++next}`, now: () => '2026-11-02T00:00:00.000Z', resolveConfirmation: request => ({ actor: { source: 'web', id: 'alice' }, message: { id: 'm1', text: 'Confirm this exact plan' }, explicit: true, planRevision: request.planRevision, intent: request.intent }) })
  const scope = { projectId: project.id, ticketId: ticket.id }
  return { repo, projects, project, ticket, plans, scope }
}

describe('Plans revisions', () => {
  it('attaches immutable complete revisions to the existing project Ticket', () => {
    const { repo, plans, scope } = setup()
    const mutable = structuredClone(plan) as { -readonly [K in keyof PlanContent]: PlanContent[K] }
    const first = plans.save({ ...scope, expectedRevision: 0, plan: mutable })
    mutable.goal = 'Changed outside storage'
    expect(first).toMatchObject({ ...scope, revision: 1, goal: plan.goal })
    expect(plans.get(scope.projectId, scope.ticketId)).toEqual(first)
    const second = plans.save({ ...scope, expectedRevision: 1, plan: { ...plan, cost: 'At most 5 minutes' } })
    expect(second.revision).toBe(2)
    expect(plans.get(scope.projectId, scope.ticketId, 1)).toEqual(first)
    expect(repo.tickets.list()).toHaveLength(1)
    const ticket = repo.tickets.get(scope.ticketId)!
    expect(ticket.projectStage).toBe('awaiting-confirmation')
    expect(ticket.assignments).toEqual([])
    ticket.planRevisions![0] = { ...first, goal: 'tampered' }
    expect(() => repo.tickets.save(ticket)).toThrow(/immutable/i)
  })
  it('checks expected revision and validates the full contract without partial writes', () => {
    const { plans, scope, repo } = setup()
    for (const field of ['goal', 'scope', 'environment', 'cost', 'completion'] as const) {
      expect(() => plans.save({ ...scope, expectedRevision: 0, plan: { ...plan, [field]: ' ' } })).toThrow()
    }
    expect(() => plans.save({ ...scope, expectedRevision: 0, plan: { ...plan, outputs: [] } })).toThrow()
    expect(() => plans.save({ ...scope, expectedRevision: 1, plan })).toThrow(/revision/i)
    expect(repo.tickets.get(scope.ticketId)?.planRevisions).toBeUndefined()
    plans.save({ ...scope, expectedRevision: 0, plan })
    expect(() => plans.save({ ...scope, expectedRevision: 0, plan })).toThrow(/revision/i)
    expect(repo.tickets.get(scope.ticketId)?.planRevisions).toHaveLength(1)
  })
  it('replays save operations before checking stale revisions and rejects changed payloads', () => {
    const { plans, scope } = setup()
    const input = { ...scope, expectedRevision: 0, plan, operationId: 'save-1' }
    const first = plans.save(input)
    plans.save({ ...scope, expectedRevision: 1, plan })
    expect(plans.save(input)).toEqual(first)
    expect(() => plans.save({ ...input, plan: { ...plan, goal: 'Different' } })).toThrow(/Operation/i)
  })
  it('rejects reads and writes across project boundaries and on legacy tickets', () => {
    const { plans, scope, projects, repo } = setup()
    const other = projects.create({ name: 'Other', goal: 'Other goal' })
    expect(() => plans.save({ ...scope, projectId: other.id, expectedRevision: 0, plan })).toThrow(/ownership/i)
    expect(() => plans.get('missing', scope.ticketId)).toThrow(/Unknown project/)
    expect(() => plans.get(scope.projectId, scope.ticketId)).toThrow(/revision/i)
    const draft = repo.tickets.get(scope.ticketId)!
    const legacy = { ...draft, id: 'legacy', mandate: { ...draft.mandate } }
    delete legacy.projectId; delete legacy.projectStage; delete legacy.mandate.projectDraft
    repo.tickets.save(legacy)
    expect(() => plans.save({ ...scope, ticketId: 'legacy', expectedRevision: 0, plan })).toThrow(/ownership/i)
  })
  it('persists revision, authorization, operation and assignment history across SQLite restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plans-'))
    const path = join(directory, 'state.sqlite')
    let store = new Store(path)
    try {
      const { plans, scope } = setup(store)
      plans.save({ ...scope, expectedRevision: 0, plan, operationId: 'save-1' })
      const request = { ...scope, operationId: 'confirm-1', planRevision: 1, intent: 'execute' as const }
      const confirmed = plans.confirm(request)
      const registration = { ...scope, authorizationId: confirmed.authorization.id, targetId: confirmed.target.id, planRevision: 1 }
      const assignment = plans.registerAssignment(registration)
      const expected = store.tickets.get(scope.ticketId)
      store.close()
      store = new Store(path)
      const resumed = new Plans({ repo: store, resolveConfirmation: request => ({ actor: { source: 'web', id: 'alice' }, message: { id: 'm1', text: 'Confirm this exact plan' }, explicit: true, planRevision: request.planRevision, intent: request.intent }) })
      expect(store.tickets.get(scope.ticketId)).toEqual(expected)
      expect(resumed.confirm(request).authorization).toEqual(confirmed.authorization)
      expect(resumed.registerAssignment(registration)).toEqual(assignment)
      expect(store.tickets.list()).toHaveLength(1)
    } finally {
      store.close()
      // This exact directory was created above for this test.
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('rolls back the entire aggregate if persistence fails after a write', () => {
    const memory = new MemoryRepositories()
    let fail = false
    const repo: ProjectRepositories = { atomic: work => memory.atomic(work), projects: memory.projects, tickets: { ...memory.tickets, save: ticket => { memory.tickets.save(ticket); if (fail) throw new Error('storage failed') } } }
    const { plans, scope } = setup(repo)
    fail = true
    expect(() => plans.save({ ...scope, expectedRevision: 0, plan, operationId: 'save-fail' })).toThrow('storage failed')
    expect(memory.tickets.get(scope.ticketId)?.planRevisions).toBeUndefined()
    expect(memory.tickets.get(scope.ticketId)?.planOperations).toBeUndefined()
    fail = false
    plans.save({ ...scope, expectedRevision: 0, plan })
    const confirmation = { ...scope, planRevision: 1, operationId: 'confirm-fail', intent: 'execute' as const }
    fail = true
    expect(() => plans.confirm(confirmation)).toThrow('storage failed')
    expect(memory.tickets.get(scope.ticketId)?.authorizations).toBeUndefined()
    expect(memory.tickets.get(scope.ticketId)?.executionTargets).toBeUndefined()
    fail = false
    const confirmed = plans.confirm(confirmation)
    const registration = { ...scope, authorizationId: confirmed.authorization.id, targetId: confirmed.target.id, planRevision: 1 }
    fail = true
    expect(() => plans.registerAssignment(registration)).toThrow('storage failed')
    expect(memory.tickets.get(scope.ticketId)?.assignments).toEqual([])
    expect(() => plans.revoke({ ...scope, authorizationId: confirmed.authorization.id, operationId: 'revoke-fail' })).toThrow('storage failed')
    expect(memory.tickets.get(scope.ticketId)?.authorizations?.[0]?.revokedAt).toBeUndefined()
    expect(memory.tickets.get(scope.ticketId)?.planOperations?.some(item => item.id === 'revoke-fail')).toBe(false)
  })
})
