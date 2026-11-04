/** Durable local subagent delegations without a second task engine. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Assignment, Ticket } from '../core/index.ts'
import { activePlanAssignments } from '../core/assignment-graphs.ts'
import type { ExecutionAttempts } from './execution-attempts.ts'
import type { SkillCandidate, SkillCatalog, SkillPin, SkillRole } from './skill-catalog.ts'
import type { Store } from './store.ts'

export const DELEGATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_delegation (
  id TEXT PRIMARY KEY,
  parent_attempt_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(parent_attempt_id, operation_id)
);
CREATE INDEX IF NOT EXISTS project_delegation_parent ON project_delegation(parent_attempt_id);
`

export type DelegationRole = Exclude<SkillRole, 'coordinator'>
export type DelegationState = 'requested' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'reconcile'
export type ResultProcessing = 'none' | 'pending' | 'processed'
export interface DelegationInput {
  operationId: string
  label: string
  prompt: string
  role: DelegationRole
  stage?: string
  resources?: string[]
  tools?: string[]
  required?: boolean
}
export interface DelegationScope {
  role: DelegationRole
  stage: string
  resources: string[]
  tools: string[]
  skills: { candidate: SkillCandidate; pin: SkillPin }[]
}
export interface DelegationResult {
  stopReason: string
  text: string
  totalChars: number
  contentHash: string
  diagnostic?: string
  at: string
}
export interface Delegation {
  id: string
  operationId: string
  requestHash: string
  projectId: string
  ticketId: string
  parentAssignmentId: string
  parentAttemptId: string
  parentSessionId: string
  parentLease: string
  childSessionId: string
  provider?: string
  runId?: string
  local?: boolean
  label: string
  context: { prompt: string; promptHash: string }
  scope: DelegationScope
  required: boolean
  state: DelegationState
  resultProcessing: ResultProcessing
  processingOperationId?: string
  result?: DelegationResult
  promotedTo?: string
  skillLoads?: { id: string; name: string; version: string; bodyHash: string; offset: number; nextOffset: number | null; at: string }[]
  createdAt: string
  updatedAt: string
  error?: string
}
export interface DelegationStart {
  parentSessionId: string
  childSessionId: string
  provider: 'spawn'
  delivery: 'parent'
  agentPreset: 'standard'
  maxDepth: 1
  label: string
  prompt: string
  scope: DelegationScope
  signal?: AbortSignal
}
export interface DelegationOptions {
  /** Native start is intentionally absent until a real host proves local spawn, scope, stop and result delivery. */
  startNative?: (input: DelegationStart) => Promise<{ runId?: string; provider?: string }>
  resolveChild?: (sessionId: string) => Promise<{ parentSessionId?: string; local?: boolean } | undefined>
  onChanged?: (parentAttemptId: string) => void
  now?: () => string
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const RESULT_TEXT_LIMIT = 16_000
const terminal = (state: DelegationState) => ['completed', 'failed', 'cancelled'].includes(state)
const normalized = (input: DelegationInput) => ({
  operationId: input.operationId.trim(), label: input.label.trim(), prompt: input.prompt,
  role: input.role, stage: input.stage?.trim() || 'execute', resources: [...new Set(input.resources ?? [])].sort(),
  tools: [...new Set(input.tools ?? [])].sort(), required: input.required !== false,
})
const textOutput = (blocks: readonly unknown[] | undefined): string => (blocks ?? []).flatMap(block => {
  if (!block || typeof block !== 'object' || !('text' in block)) return []
  const value = (block as { text?: unknown }).text
  return typeof value === 'string' ? [value] : []
}).join('\n')

/** Stores the audit edge around an optional native child; Assignments remain the only long-lived work graph. */
export class Delegations {
  private readonly inFlight = new Map<string, Promise<Delegation>>()
  constructor(private readonly store: Store, private readonly attempts: ExecutionAttempts, private readonly skills: SkillCatalog,
    private readonly options: DelegationOptions = {}) {}

  private rows(): Delegation[] { return this.store.db.prepare('SELECT value FROM project_delegation ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Delegation) }
  private save(value: Delegation): void {
    value.updatedAt = this.now()
    this.store.db.prepare('UPDATE project_delegation SET value=? WHERE id=?').run(JSON.stringify(value), value.id)
  }
  private now(): string { return this.options.now?.() ?? new Date().toISOString() }
  get(id: string): Delegation | undefined { return this.rows().find(item => item.id === id) }
  byChildSession(sessionId: string): Delegation | undefined { return this.rows().find(item => item.childSessionId === sessionId) }
  listForAttempt(parentAttemptId: string): Delegation[] { return this.rows().filter(item => item.parentAttemptId === parentAttemptId) }
  promotedForAssignment(assignmentId: string): Delegation[] { return this.rows().filter(item => item.promotedTo === assignmentId && terminal(item.state) && (item.resultProcessing === 'processed' || !item.required)) }
  childSessions(): string[] { return this.rows().filter(item => !!item.provider || terminal(item.state)).map(item => item.childSessionId) }
  activeChildSessions(): string[] { return this.rows().filter(item => ['requested', 'starting', 'running', 'reconcile'].includes(item.state)).map(item => item.childSessionId) }
  contextForAttempt(parentAttemptId: string) {
    return this.listForAttempt(parentAttemptId).slice(-16).map(item => ({ id: item.id, childSessionId: item.childSessionId, label: item.label,
      role: item.scope.role, stage: item.scope.stage, resources: item.scope.resources, tools: item.scope.tools, state: item.state,
      resultProcessing: item.resultProcessing, ...(item.result ? { result: { stopReason: item.result.stopReason, text: item.result.text.slice(0, 4_000),
        totalChars: item.result.totalChars, truncated: item.result.text.length < item.result.totalChars } } : {}) }))
  }
  pendingResults(parentAttemptId: string): Delegation[] {
    return this.listForAttempt(parentAttemptId).filter(item => item.required && terminal(item.state) && item.resultProcessing === 'pending')
  }

  /** Persist the stable child identity before any external side effect, then return an existing exact request unchanged. */
  begin(parentSessionId: string, input: DelegationInput): Delegation {
    const request = normalized(input)
    if (!request.operationId || request.operationId.length > 256 || !request.label || request.label.length > 200 || !request.prompt.trim() || request.prompt.length > 64_000
      || (request.role as string) === 'coordinator') throw new Error('Delegation request is incomplete')
    const requestHash = hash(request)
    return this.store.atomic(() => {
      const { attempt, ticket, assignment } = this.attempts.resolve(parentSessionId)
      const previous = this.rows().find(item => item.parentAttemptId === attempt.id && item.operationId === request.operationId)
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Error('Delegation operation id conflict')
        return previous
      }
      if (!attempt.context) throw new Error('Delegation requires a pinned parent capability snapshot')
      if (assignment.reportReceipt?.state === 'ready') throw new Error('A ready Assignment cannot start new delegation')
      if (!attempt.context.resources.every(resource => this.attempts.resourceAuthority?.granted(attempt.projectId, resource) ?? true)) throw new Error('Parent resource grant was revoked')
      const scope = this.skills.delegationScope({ projectId: attempt.projectId, parentResources: attempt.context.resources,
        parentTools: attempt.context.tools, role: request.role, stage: request.stage, resources: request.resources, tools: request.tools })
      const at = this.now(), id = randomUUID()
      const value: Delegation = { id, operationId: request.operationId, requestHash, projectId: attempt.projectId, ticketId: ticket.id,
        parentAssignmentId: assignment.id, parentAttemptId: attempt.id, parentSessionId, parentLease: attempt.lease,
        childSessionId: `project-delegation-${randomUUID()}`, label: request.label, context: { prompt: request.prompt, promptHash: hash(request.prompt) },
        scope, required: request.required, state: 'requested', resultProcessing: 'none', createdAt: at, updatedAt: at }
      this.store.db.prepare('INSERT INTO project_delegation VALUES (?,?,?,?,?)').run(value.id, attempt.id, value.childSessionId, value.operationId, JSON.stringify(value))
      return value
    })
  }

  /** Start once for this parent Attempt/operation. A crash after admission is reconciled by the reserved child Session. */
  async start(parentSessionId: string, input: DelegationInput, signal?: AbortSignal): Promise<Delegation> {
    if (!this.options.startNative) throw new Error('Native subagent delegation is disabled until its host contract passes admission')
    signal?.throwIfAborted()
    const record = this.begin(parentSessionId, input)
    if (record.state === 'running' || record.state === 'reconcile' || terminal(record.state)) return record
    const active = this.inFlight.get(record.id)
    if (active) return active
    const operation = this.launch(parentSessionId, record, signal)
    this.inFlight.set(record.id, operation)
    try {
      return await operation
    } finally {
      if (this.inFlight.get(record.id) === operation) this.inFlight.delete(record.id)
    }
  }

  private async launch(parentSessionId: string, record: Delegation, signal?: AbortSignal): Promise<Delegation> {
    const claimed = this.store.atomic(() => {
      const current = this.get(record.id)!
      if (current.state !== 'requested') return false
      current.state = 'starting'; this.save(current); return true
    })
    if (!claimed) return await this.adoptStarting(parentSessionId, record)
    const parent = this.attempts.resolve(parentSessionId)
    if (parent.attempt.id !== record.parentAttemptId || parent.attempt.lease !== record.parentLease) throw new Error('Stale delegated parent execution')
    let started: { runId?: string; provider?: string }
    try {
      started = await this.options.startNative!({ parentSessionId, childSessionId: record.childSessionId, provider: 'spawn', delivery: 'parent',
        agentPreset: 'standard', maxDepth: 1, label: record.label, prompt: record.context.prompt, scope: record.scope, signal })
    } catch (error) {
      const child = await this.options.resolveChild?.(record.childSessionId).catch(() => undefined)
      return this.store.atomic(() => {
        const current = this.get(record.id)!
        if (terminal(current.state) || current.state === 'running' && current.local) return current
        if (child?.local !== false && child?.parentSessionId === parentSessionId) { current.state = 'running'; current.local = true; current.provider ??= 'spawn'; delete current.error }
        else { current.state = 'reconcile'; current.error = String(error) }
        this.save(current); return current
      })
    }
    return this.store.atomic(() => {
      this.attempts.resolve(parentSessionId)
      const current = this.get(record.id)!
      if (!terminal(current.state) && current.local !== false) {
        current.state = 'running'; current.local = true; current.runId ??= started.runId; current.provider = started.provider ?? current.provider ?? 'spawn'; delete current.error; this.save(current)
      }
      return current
    })
  }

  /** A starting/reconcile row is never re-run automatically; only an exact local child can recover it. */
  private async adoptStarting(parentSessionId: string, record: Delegation): Promise<Delegation> {
    const child = await this.options.resolveChild?.(record.childSessionId).catch(() => undefined)
    return this.store.atomic(() => {
      const current = this.get(record.id)!
      if (terminal(current.state) || current.state === 'running') return current
      if (child && child.local !== false && child.parentSessionId === parentSessionId) {
        current.state = 'running'; current.local = true; current.provider ??= 'spawn'; delete current.error
      } else {
        current.state = 'reconcile'; current.error = 'Delegation start outcome is unknown; explicit reconciliation is required'
      }
      this.save(current); return current
    })
  }

  /** Restart never invents a result: present children stay running, absent children require explicit reconciliation. */
  async reconcile(): Promise<void> {
    if (!this.options.resolveChild) return
    for (const record of this.rows().filter(item => ['requested', 'starting', 'running', 'reconcile'].includes(item.state))) {
      const child = await this.options.resolveChild(record.childSessionId).catch(() => undefined)
      this.store.atomic(() => {
        const current = this.get(record.id)
        if (!current || terminal(current.state)) return
        if (child && child.local !== false && child.parentSessionId === current.parentSessionId) { current.state = 'running'; current.local = true; current.provider ??= 'spawn'; delete current.error }
        else { current.state = 'reconcile'; current.error = 'Child Session was not found after restart; result delivery requires reconciliation' }
        this.save(current)
      })
    }
  }

  /** Observe the native lifecycle pair under the exact recorded parent; unrelated children are ignored. */
  observeStart(parentSessionId: string, info: { id: string; runId: string; provider: string; local: boolean }): void {
    const record = this.byChildSession(info.id)
    if (!record || record.parentSessionId !== parentSessionId) return
    this.store.atomic(() => {
      const current = this.get(record.id)!
      if (terminal(current.state)) return
      if (current.runId && current.runId !== info.runId) throw new Error('Delegation run identity changed')
      current.local = info.local
      if (!info.local) { current.state = 'reconcile'; current.error = 'Recorded delegation started as a non-local child'; this.save(current); return }
      current.state = 'running'; current.runId = info.runId; current.provider = info.provider; delete current.error; this.save(current)
    })
  }
  observeEnd(parentSessionId: string, info: { id: string; runId: string; provider: string; local: boolean; stopReason: string; lastAssistantMessage?: readonly unknown[]; diagnostic?: string }): void {
    const record = this.byChildSession(info.id)
    if (!record || record.parentSessionId !== parentSessionId) return
    this.store.atomic(() => {
      const current = this.get(record.id)!
      if (current.runId && current.runId !== info.runId) throw new Error('Delegation run identity changed')
      if (!info.local || current.local === false) {
        if (!terminal(current.state)) { current.state = 'reconcile'; current.local = false; current.error = 'A non-local delegation result requires explicit reconciliation'; this.save(current) }
        return
      }
      const fullText = textOutput(info.lastAssistantMessage), result: DelegationResult = { stopReason: info.stopReason, text: fullText.slice(0, RESULT_TEXT_LIMIT), totalChars: fullText.length,
        contentHash: hash(info.lastAssistantMessage ?? []), ...(info.diagnostic ? { diagnostic: info.diagnostic } : {}), at: this.now() }
      const state: DelegationState = info.stopReason === 'completed' ? 'completed' : info.stopReason === 'aborted' ? 'cancelled' : 'failed'
      if (current.result) {
        const { at: _at, ...previous } = current.result
        const { at: _next, ...next } = result
        if (current.state !== state || !isDeepStrictEqual(previous, next)) throw new Error('Delegation result changed on replay')
        return
      }
      current.state = state; current.local = true; current.runId ??= info.runId; current.provider = info.provider; current.result = result
      current.resultProcessing = current.required ? 'pending' : 'none'; delete current.error; this.save(current)
      this.store.afterCommit(() => this.options.onChanged?.(current.parentAttemptId))
    })
  }
  /** Test/host adapter seam for a child backend that returns its result without a lifecycle event pair. */
  finish(childSessionId: string, result: { stopReason: string; output?: readonly unknown[]; diagnostic?: string }, runId?: string): Delegation {
    const record = this.byChildSession(childSessionId)
    if (!record) throw new Error('Unknown delegation child Session')
    this.observeEnd(record.parentSessionId, { id: childSessionId, runId: runId ?? record.runId ?? 'direct-result', provider: record.provider ?? 'spawn', local: true,
      stopReason: result.stopReason, lastAssistantMessage: result.output, diagnostic: result.diagnostic })
    return this.get(record.id)!
  }

  /** Mark one terminal result consumed by the parent. The child never completes an Assignment by itself. */
  process(parentSessionId: string, childSessionId: string, operationId: string): Delegation {
    if (!operationId.trim() || operationId.length > 256) throw new Error('Result processing operation id is required')
    return this.store.atomic(() => {
      const record = this.byChildSession(childSessionId)
      if (!record) throw new Error('Delegation child does not belong to this parent execution')
      const owner = record.resultProcessing === 'processed' ? this.attempts.receiptOwner(parentSessionId) : this.attempts.resolve(parentSessionId)
      const { attempt } = owner
      if (record.parentAttemptId !== attempt.id || record.parentLease !== attempt.lease) throw new Error('Delegation child does not belong to this parent execution')
      if (!terminal(record.state)) throw new Error('Delegation result has not been received')
      if (record.resultProcessing === 'processed') {
        if (record.processingOperationId !== operationId) throw new Error('Delegation result is already processed under another operation')
        return record
      }
      if (!record.required) return record
      record.resultProcessing = 'processed'; record.processingOperationId = operationId; this.save(record)
      this.store.afterCommit(() => this.options.onChanged?.(record.parentAttemptId))
      return record
    })
  }

  /** Records actually loaded by the child stay attached to the parent-owned delegation audit. */
  recordSkillLoad(childSessionId: string, value: { id: string; name: string; version: string; bodyHash: string; offset: number; nextOffset: number | null }): void {
    const record = this.byChildSession(childSessionId)
    if (!record || !['requested', 'starting', 'running'].includes(record.state)) throw new Error('Delegation child is not running')
    const loads = record.skillLoads ??= []
    if (loads.some(item => item.id === value.id && item.name === value.name && item.version === value.version && item.bodyHash === value.bodyHash
      && item.offset === value.offset && item.nextOffset === value.nextOffset)) return
    loads.push({ ...value, at: this.now() }); this.save(record)
  }

  authorizeChild(childSessionId: string): { delegation: Delegation; parent: ReturnType<ExecutionAttempts['resolve']> } {
    const delegation = this.byChildSession(childSessionId)
    if (!delegation || !['requested', 'starting', 'running'].includes(delegation.state)) throw new Error('Subagent has no live application delegation record')
    const parent = this.attempts.resolve(delegation.parentSessionId)
    if (parent.attempt.id !== delegation.parentAttemptId || parent.attempt.lease !== delegation.parentLease) throw new Error('Delegated parent execution is stale')
    if (!delegation.scope.resources.every(resource => this.attempts.resourceAuthority?.granted(delegation.projectId, resource) ?? true)) throw new Error('Delegated resource grant was revoked')
    return { delegation, parent }
  }

  blocking(parentAttemptId: string): Delegation[] {
    return this.listForAttempt(parentAttemptId).filter(item => item.required && (item.resultProcessing !== 'processed'))
  }
  assertReady(parentAttemptId: string): void {
    const blocked = this.blocking(parentAttemptId)
    if (blocked.length) throw new Error(`Required delegation results are not processed: ${blocked.map(item => item.id).join(', ')}`)
  }

  /** A durable child can become an Assignment input without starting the same work again. */
  promote(delegationId: string, assignmentId: string): { delegation: Delegation; assignment: Assignment; ticket: Ticket } {
    return this.store.atomic(() => {
      const delegation = this.get(delegationId)
      if (!delegation || !terminal(delegation.state)) throw new Error('Only a settled delegation can be promoted')
      if (delegation.resultProcessing !== 'processed' && delegation.required) throw new Error('Delegation result must be processed before promotion')
      const ticket = this.store.tickets.get(delegation.ticketId)
      const assignment = ticket && activePlanAssignments(ticket).find(item => item.id === assignmentId)
      const parent = ticket?.assignments.find(item => item.id === delegation.parentAssignmentId)
      if (!ticket || !assignment || assignment.state === 'ended' || ticket.projectId !== delegation.projectId || assignment.contract?.authorizationId === undefined
        || !parent?.contract || parent.contract.authorizationId !== assignment.contract.authorizationId
        || delegation.scope.resources.some(resource => !assignment.contract!.plan.resources.includes(resource))) throw new Error('Delegation promotion requires an open Assignment in the same Task and authorization scope')
      if (delegation.promotedTo && delegation.promotedTo !== assignment.id) throw new Error('Delegation is already promoted to another Assignment')
      delegation.promotedTo = assignment.id; this.save(delegation)
      return { delegation, assignment, ticket }
    })
  }
}
