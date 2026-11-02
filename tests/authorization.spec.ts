import { describe, expect, it, vi } from 'vitest'
import { executableTicket, MemoryRepositories, Plans, Projects, type ConfirmPlan, type PlanContent, type PlanAssignmentInput, type TrustedPlanConfirmation } from '../src/core/index.ts'

const plan: PlanContent = { goal: 'Compare methods', scope: 'Local benchmark only', outputs: ['report.md'], resources: [], environment: 'Local Python', cost: '10 minutes', completion: 'Measured results' }
function setup() {
  const repo = new MemoryRepositories(), projects = new Projects({ repo })
  const project = projects.create({ name: 'Research', goal: 'Compare methods' })
  const ticket = projects.createDraft(project.id, { title: 'Run comparison' })
  let actor = 'alice', messageId = 'message-1', allowed = true
  const resolveConfirmation = vi.fn((request: Readonly<ConfirmPlan>): TrustedPlanConfirmation | undefined => allowed ? ({ actor: { source: 'web', id: actor }, message: { id: messageId, text: `Confirm ${request.intent} revision ${request.planRevision}` }, explicit: true, planRevision: request.planRevision, intent: request.intent }) : undefined)
  const plans = new Plans({ repo, resolveConfirmation })
  const scope = { projectId: project.id, ticketId: ticket.id }
  plans.save({ ...scope, expectedRevision: 0, plan })
  const request: ConfirmPlan = { ...scope, operationId: 'confirm-1', planRevision: 1, intent: 'execute' }
  return { repo, projects, plans, scope, request, resolveConfirmation, setActor: (value: string) => { actor = value }, setMessage: (value: string) => { messageId = value }, deny: () => { allowed = false } }
}

describe('Plan authorization', () => {
  it('requires trusted original-user intent and ignores model-supplied actor fields', () => {
    const { plans, request, deny, resolveConfirmation, repo, scope } = setup()
    deny()
    expect(() => plans.confirm({ ...request, actor: { id: 'forged' }, explicit: true } as ConfirmPlan)).toThrow(/trusted actor/i)
    expect(resolveConfirmation.mock.calls[0]![0]).toEqual(request)
    expect(repo.tickets.get(scope.ticketId)?.authorizations).toBeUndefined()
    const wrong = new Plans({ repo, resolveConfirmation: () => ({ actor: { source: 'web', id: 'alice' }, message: { id: 'original', text: 'Yes' }, explicit: true, planRevision: 2, intent: 'execute' }) })
    expect(() => wrong.confirm(request)).toThrow(/exact revision/i)
  })
  it('preserves trusted original request provenance separately from confirmation evidence', () => {
    const { repo, request, scope } = setup()
    const originalMessage = { id: 'original-request', text: 'Please compare these methods' }
    const message = { id: 'actual-confirmation', text: 'Implement this plan' }
    const plans = new Plans({ repo, resolveConfirmation: input => ({ actor: { source: 'web', id: 'alice' }, message, originalMessage, explicit: true, planRevision: input.planRevision, intent: input.intent }) })
    const confirmed = plans.confirm(request)
    expect(confirmed.authorization.message).toEqual(message)
    expect(confirmed.authorization.originalMessage).toEqual(originalMessage)
    expect(plans.confirm(request).authorization).toEqual(confirmed.authorization)
    originalMessage.text = 'Mutated outside storage'
    expect(repo.tickets.get(scope.ticketId)?.authorizations?.[0]?.originalMessage?.text).toBe('Please compare these methods')
    const stored = repo.tickets.get(scope.ticketId)!
    stored.authorizations![0] = { ...stored.authorizations![0]!, originalMessage: { id: 'forged', text: 'Changed request' } }
    expect(() => repo.tickets.save(stored)).toThrow(/immutable/i)
    expect(() => plans.confirm(request)).toThrow(/Operation/i)
  })
  it('rejects malformed optional original request provenance', () => {
    const { repo, request } = setup()
    const plans = new Plans({ repo, resolveConfirmation: input => ({ actor: { source: 'web', id: 'alice' }, message: { id: 'confirmation', text: 'Implement this plan' }, originalMessage: { id: '', text: 'Request' }, explicit: true, planRevision: input.planRevision, intent: input.intent }) })
    expect(() => plans.confirm(request)).toThrow(/trusted actor/i)
  })
  it('deduplicates a different message with the same plan actor and intent', () => {
    const { plans, request, setMessage, repo, scope } = setup()
    const first = plans.confirm(request)
    setMessage('message-2')
    const second = plans.confirm({ ...request, operationId: 'confirm-2' })
    expect(second.authorization).toEqual(first.authorization)
    expect(second.target).toEqual(first.target)
    const ticket = repo.tickets.get(scope.ticketId)!
    expect(ticket.authorizations).toHaveLength(1)
    expect(ticket.executionTargets).toHaveLength(1)
    expect(ticket.assignments).toHaveLength(0)
    expect(ticket.projectStage).toBe('confirmed')
    expect(executableTicket(ticket)).toBe(false)
  })
  it('returns the same operation result and rejects reuse with a changed message or payload', () => {
    const { plans, request, setMessage } = setup()
    const first = plans.confirm(request)
    expect(plans.confirm(request)).toEqual(first)
    expect(() => plans.confirm({ ...request, intent: 'rerun' })).toThrow(/Operation/i)
    setMessage('changed-message')
    expect(() => plans.confirm(request)).toThrow(/Operation/i)
    expect(() => plans.save({ projectId: request.projectId, ticketId: request.ticketId, expectedRevision: 1, plan, operationId: request.operationId })).toThrow(/Operation/i)
  })
  it('isolates actors and creates a new target for each explicit rerun operation in the same Ticket', () => {
    const { plans, request, setActor, repo, scope } = setup()
    expect(() => plans.confirm({ ...request, operationId: 'early-rerun', intent: 'rerun' })).toThrow(/rerun/i)
    const first = plans.confirm(request)
    setActor('bob')
    const other = plans.confirm({ ...request, operationId: 'bob-confirm' })
    expect(other.authorization.id).not.toBe(first.authorization.id)
    setActor('alice')
    const rerun = plans.confirm({ ...request, operationId: 'rerun-1', intent: 'rerun' })
    expect(rerun.target.id).not.toBe(first.target.id)
    expect(plans.confirm({ ...request, operationId: 'rerun-1', intent: 'rerun' }).target).toEqual(rerun.target)
    const again = plans.confirm({ ...request, operationId: 'rerun-2', intent: 'rerun' })
    expect(again.target.id).not.toBe(rerun.target.id)
    expect(repo.tickets.list()).toHaveLength(1)
    expect(repo.tickets.get(scope.ticketId)?.executionTargets).toHaveLength(4)
  })
  it('rejects stale confirmations and registration against superseded revisions', () => {
    const { plans, request, scope } = setup()
    const first = plans.confirm(request)
    plans.save({ ...scope, expectedRevision: 1, plan: { ...plan, cost: '5 minutes' } })
    expect(() => plans.confirm({ ...request, operationId: 'stale' })).toThrow(/revision/i)
    expect(() => plans.registerAssignment({ ...scope, authorizationId: first.authorization.id, targetId: first.target.id, planRevision: 1 })).toThrow(/revision/i)
    expect(plans.confirm(request).authorization).toEqual(first.authorization)
  })
  it('revokes monotonically, checks revoke operations and refuses registration and reconfirmation', () => {
    const { plans, request, scope, repo } = setup()
    const first = plans.confirm(request)
    const revoke = { ...scope, authorizationId: first.authorization.id, operationId: 'revoke-1' }
    const revoked = plans.revoke(revoke)
    expect(revoked.revokedAt).toBeTruthy()
    expect(plans.revoke(revoke)).toEqual(revoked)
    expect(() => plans.revoke({ ...revoke, authorizationId: 'another' })).toThrow(/Operation/i)
    expect(() => plans.registerAssignment({ ...scope, authorizationId: revoked.id, targetId: first.target.id, planRevision: 1 })).toThrow(/revoked/i)
    expect(() => plans.confirm({ ...request, operationId: 'reconfirm' })).toThrow(/revoked/i)
    const ticket = repo.tickets.get(scope.ticketId)!
    delete ticket.authorizations![0]!.revokedAt
    expect(() => repo.tickets.save(ticket)).toThrow(/immutable/i)
  })
})

describe('Plan Assignment registration', () => {
  it('registers one pending inert Assignment with the exact contract for each confirmed target', () => {
    const { plans, request, scope, repo } = setup()
    const confirmed = plans.confirm(request)
    const input = { ...scope, authorizationId: confirmed.authorization.id, targetId: confirmed.target.id, planRevision: 1 }
    const assignment = plans.registerAssignment(input)
    expect(assignment).toMatchObject({ ...scope, state: 'pending', waitingReason: 'executor-unavailable', report: { state: 'waiting' }, contract: { authorizationId: input.authorizationId, targetId: input.targetId, planRevision: 1, plan, inputs: [] } })
    expect(plans.registerAssignment(input)).toEqual(assignment)
    expect(repo.tickets.get(scope.ticketId)?.assignments).toHaveLength(1)
    expect(executableTicket(repo.tickets.get(scope.ticketId)!)).toBe(false)
    const rerun = plans.confirm({ ...request, operationId: 'rerun', intent: 'rerun' })
    const next = plans.registerAssignment({ ...input, authorizationId: rerun.authorization.id, targetId: rerun.target.id })
    expect(next.id).not.toBe(assignment.id)
    expect(repo.tickets.get(scope.ticketId)?.assignments).toHaveLength(2)
  })
  it('requires a registered Assignment on the exact same Ticket for dependencies', () => {
    const { plans, request, scope, repo, projects } = setup()
    const otherDraft = projects.createDraft(scope.projectId, { title: 'Same project, different task' })
    const otherProject = projects.create({ name: 'Other', goal: 'Other' })
    const foreign = projects.createDraft(otherProject.id, { title: 'Private' })
    const confirmed = plans.confirm(request)
    const input = { ...scope, authorizationId: confirmed.authorization.id, targetId: confirmed.target.id, planRevision: 1 }
    const invalid: unknown[] = [
      { kind: 'dependency', ticketId: foreign.id, assignmentId: 'missing' },
      { kind: 'dependency', ticketId: otherDraft.id, assignmentId: 'missing' },
      { kind: 'dependency', ticketId: otherDraft.id },
      { kind: 'dependency', ticketId: scope.ticketId },
      { kind: 'dependency', ticketId: scope.ticketId, assignmentId: '' },
      { kind: 'dependency', ticketId: scope.ticketId, assignmentId: 'missing' },
      null,
    ]
    for (const ref of invalid) expect(() => plans.registerAssignment({ ...input, inputs: [ref as PlanAssignmentInput] })).toThrow(/same ticket/i)
    const first = plans.registerAssignment(input)
    const rerun = plans.confirm({ ...request, operationId: 'dependent-rerun', intent: 'rerun' })
    const nextInput = { ...input, authorizationId: rerun.authorization.id, targetId: rerun.target.id }
    // A real registered Assignment is still invalid when referenced through a different task id.
    expect(() => plans.registerAssignment({ ...nextInput, inputs: [{ kind: 'dependency', ticketId: otherDraft.id, assignmentId: first.id }] })).toThrow(/same ticket/i)
    const inputs: PlanAssignmentInput[] = [{ kind: 'dependency', ticketId: scope.ticketId, assignmentId: first.id }]
    const next = plans.registerAssignment({ ...nextInput, inputs })
    expect(next.contract?.inputs).toEqual(inputs)
    expect(plans.registerAssignment({ ...nextInput, inputs })).toEqual(next)
    expect(() => plans.registerAssignment(nextInput)).toThrow(/different contract/i)
    const stored = repo.tickets.get(scope.ticketId)!
    stored.assignments[1]!.contract = { ...next.contract!, inputs: [] }
    expect(() => repo.tickets.save(stored)).toThrow(/immutable/i)
  })
  it('rejects every artifact reference until a trusted registry can resolve its version', () => {
    const { plans, request, scope, repo } = setup()
    const ticket = repo.tickets.get(scope.ticketId)!
    ticket.inputs.push({ id: 'note-1', kind: 'note', text: 'Untrusted artifact description', at: ticket.createdAt })
    repo.tickets.save(ticket)
    const confirmed = plans.confirm(request)
    const input = { ...scope, authorizationId: confirmed.authorization.id, targetId: confirmed.target.id, planRevision: 1 }
    const artifacts: unknown[] = [
      { kind: 'artifact', ticketId: scope.ticketId, inputId: 'note-1' },
      { kind: 'artifact', artifactId: 'note-1' },
      { kind: 'artifact', artifactId: 'note-1', contentVersion: '' },
      { kind: 'artifact', artifactId: 'artifact-1', contentVersion: 'sha256:original' },
      { kind: 'artifact', artifactId: 'artifact-1', contentVersion: 'sha256:changed' },
    ]
    for (const artifact of artifacts) expect(() => plans.registerAssignment({ ...input, inputs: [artifact as PlanAssignmentInput] })).toThrow(/T4 trusted registry/i)
    expect(repo.tickets.get(scope.ticketId)?.assignments).toEqual([])
  })
  it('enforces the same dependency and artifact rules on direct durable writes', () => {
    const { plans, request, scope, repo, projects } = setup()
    const confirmed = plans.confirm(request)
    const first = plans.registerAssignment({ ...scope, authorizationId: confirmed.authorization.id, targetId: confirmed.target.id, planRevision: 1 })
    const other = projects.createDraft(scope.projectId, { title: 'Another task' })
    const rerun = plans.confirm({ ...request, operationId: 'durable-rerun', intent: 'rerun' })
    const base = repo.tickets.get(scope.ticketId)!
    const next = { ...first, id: 'new-assignment', contract: { ...first.contract!, authorizationId: rerun.authorization.id, targetId: rerun.target.id } }
    const invalid: unknown[] = [
      { kind: 'dependency', ticketId: other.id, assignmentId: first.id },
      { kind: 'dependency', ticketId: scope.ticketId },
      { kind: 'dependency', ticketId: scope.ticketId, assignmentId: 'missing' },
      { kind: 'artifact', artifactId: 'note-1', contentVersion: 'sha256:original' },
      { kind: 'artifact', ticketId: scope.ticketId, inputId: 'note-1' },
    ]
    for (const ref of invalid) {
      const forged = structuredClone(base)
      forged.assignments.push({ ...next, contract: { ...next.contract, inputs: [ref as PlanAssignmentInput] } })
      expect(() => repo.tickets.save(forged)).toThrow(/same ticket|registered project content version/i)
    }
    const valid = structuredClone(base)
    valid.assignments.push({ ...next, contract: { ...next.contract, inputs: [{ kind: 'dependency', ticketId: scope.ticketId, assignmentId: first.id }] } })
    expect(() => repo.tickets.save(valid)).not.toThrow()
  })
  it('refuses mismatched authorization, target and revision bindings', () => {
    const { plans, request, scope } = setup()
    const confirmed = plans.confirm(request)
    const input = { ...scope, authorizationId: confirmed.authorization.id, targetId: confirmed.target.id, planRevision: 1 }
    expect(() => plans.registerAssignment({ ...input, authorizationId: 'unknown' })).toThrow(/authorization/i)
    expect(() => plans.registerAssignment({ ...input, targetId: 'unknown' })).toThrow(/authorization/i)
    expect(() => plans.registerAssignment({ ...input, planRevision: 2 })).toThrow(/revision/i)
  })
})
