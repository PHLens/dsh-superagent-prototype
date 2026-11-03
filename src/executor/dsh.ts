/** DSH executor: manages one persistent worker session and workspace directory per ticket. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { activePlanAssignments, isActivePlanAssignment, executableTicket, key, latestAssignment, latestReport, liveTicket, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import type { ExecutionAttempts, Attempt } from '../app/execution-attempts.ts'
import type { ProjectScheduler, BudgetLease } from '../app/scheduler.ts'
import { Later, type Effects } from '../app/effects.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import type { Sessions } from '../app/sessions.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import { cancelled, collectJob, killJobs, runningJobs, stopBackground, stopSubagents, until, untilQuiet } from './background.ts'

const now = (): string => new Date().toISOString()
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** Maximum runtime for a workspace prepare command. */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** How long a worker's background work may run on after its turn ended before it is stopped and the worker reported waiting. */
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** How long a host stop waits for the workers' background work to stop. */
const SHUTDOWN_STOP_MS = 1_000
/** How long a worker that goes on after a passing failure waits for a worker slot, or for processing to resume, between looks. */
const SLOT_WAIT_MS = 5000
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/**
 * Internal error thrown when a ticket's workspace prepare command fails during launch.
 * DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
 */
class PrepareFailed extends Error {}
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * True when an error represents a transient network or model-provider failure: an HTTP 408, 429, or 5xx status, or a
 * connection that was refused, reset, timed out, or could not resolve its host.
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Host dependencies used by `DshExecutor`. */
export interface ExecutorHost {
  readonly scheduler?: ProjectScheduler
  readonly attempts?: ExecutionAttempts
  readonly masterId?: string
  checkpointFiles?(ticket: Ticket): readonly string[]
  reportReady?(ticket: Ticket, assignment: Assignment, attempt: Attempt): boolean
  /** Verifies durable artifact bytes and writing-journal state for a reported attempt. */
  evidenceReady?(ticket: Ticket, assignment: Assignment, attempt: Attempt): boolean
  /** Returns true when an outbound receipt has an unresolved external result for this ticket. */
  outboundUnknown?(ticket: Ticket): boolean
  /** Verifies producer acknowledgements; terminal JobViews alone cannot certify physical exit. */
  ownerExitKnown?(ownerId: string): boolean
  /** DSH Cordis context: agents and their events, and the subprocess service used to run prepare commands. */
  readonly context: Context
  /** Where the Executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted' | 'observeTicket' | 'checkpointTicket'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** Durable effect queue through which launches and input deliveries run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** Session manager for worker sessions and for relaying worker reports to the main Session. */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds'>
  closing(): boolean
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** Looks up a ticket's origin trigger in Store. */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** Resource path under which a worker session reads the full text of a ticket input. */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
 * a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
 * Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
 * and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
export class WorkerSlots {
  /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
   * @param max - Returns the configured maximum number of concurrent worker slots.
   */
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** Number of slots currently in use across running workers and starting reservations. */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
   * A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
   * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
   * @throws Later when no slot is free.
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/**
 * Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
 * `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
 * Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
 */
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly projectLaunching = new Map<string, Promise<void>>()
  private readonly projectObserved = new Set<string>()
  private readonly reconciling = new Set<string>()
  private readonly pendingAttention = new Map<string, Promise<boolean>>()
  private held(ticket: Ticket): boolean {
    return ticket.lifecycle?.pause.intent === 'pause' || ticket.lifecycle?.stop.intent === 'stop'
  }
  /** Deterministic server-owned recovery check; callers cannot submit an outcome. */
  async reconcileTicket(ticketId: string, operationId: string): Promise<{ state: 'checking' | 'clear' | 'unknown'; operationId: string }> {
    if (!operationId.trim()) throw new Error('Reconciliation operation id is required')
    const initial = this.host.store.tickets.get(ticketId)
    if (!initial) throw new Error('Ticket not found')
    const previous = initial.lifecycle?.reconciliationHistory?.findLast(item => item.operationId === operationId)
    if (previous) return { state: previous.state, operationId }
    if (this.reconciling.has(ticketId)) return { state: this.host.store.tickets.get(ticketId)?.lifecycle?.reconciliation?.state ?? 'checking', operationId }
    this.reconciling.add(ticketId)
    const startedAt = now(), lifecycle = initial.lifecycle
    const intentAt = { pause: lifecycle?.pause.at ?? startedAt, stop: lifecycle?.stop.at ?? startedAt }
    const intent = { pause: lifecycle?.pause.intent ?? 'none' as const, stop: lifecycle?.stop.intent ?? 'none' as const }
    const allAttempts = this.host.attempts?.all().filter(item => item.ticketId === ticketId) ?? []
    const assignments = initial.assignments.filter(item => item.contract && item.state !== 'ended')
     const assignment = assignments.find(item => {
       const attempt = allAttempts.findLast(candidate => candidate.assignmentId === item.id)
       return !!attempt
     }) ?? assignments[0]
    const attempt = assignment ? allAttempts.findLast(item => item.assignmentId === assignment.id) : undefined
    const scopedAttempts = allAttempts
    const ownerIds = [...new Set([...scopedAttempts.map(item => item.sessionId), ...(!initial.projectId ? [workerSessionId(ticketId)] : [])])].sort()
    const attemptLeases = scopedAttempts.map(item => `${item.id}:${item.lease}`).sort()
    const checking = { state: 'checking' as const, operationId, startedAt, ownerIds, attemptLeases, pauseIntent: intent.pause, stopIntent: intent.stop,
      ...(assignment ? { assignmentId: assignment.id } : {}), ...(attempt ? { attemptId: attempt.id, lease: attempt.lease, sessionId: attempt.sessionId } : {}) }
    initial.lifecycle = { ...(lifecycle ?? { pause: { intent: 'none', state: 'running', at: startedAt }, stop: { intent: 'none', state: 'running', at: startedAt }, observed: { state: 'unknown', at: startedAt } }), reconciliation: checking }
    this.host.store.tickets.save(initial)
    const persistUnknown = (reason: string): void => {
      const current = this.host.store.tickets.get(ticketId)
      if (!current || current.lifecycle?.reconciliation?.operationId !== operationId) return
      const observedAt = now()
      current.lifecycle.reconciliation = { ...checking, state: 'unknown', observedAt, reason }
      const history = current.lifecycle.reconciliationHistory ?? []
      current.lifecycle.reconciliationHistory = [...history.filter(item => item.operationId !== operationId), { ...checking, state: 'unknown', observedAt, reason }]
      this.host.store.tickets.save(current)
    }
    try {
      let state: 'clear' | 'unknown' = 'clear', reason: string | undefined
      for (const ownerId of ownerIds) {
        const resolved = await this.host.context.sessionController.resolveAgent(ownerId as SessionId)
        // Read jobs after the await: a job registered while native state was being read is still active evidence.
        const jobs = runningJobs(this.host.context, ownerId)
        if (jobs.length) { state = 'unknown'; reason = 'owner-jobs-still-running'; break }
         if (this.host.ownerExitKnown && !this.host.ownerExitKnown(ownerId)) { state = 'unknown'; reason = 'producer-exit-unacknowledged'; break }
        if ('error' in resolved && resolved.error.code !== 'session/not-found') { state = 'unknown'; reason = `session-error:${resolved.error.code}`; break }
        if ('agent' in resolved) {
          const agent = resolved.agent
          const ownerAttempt = scopedAttempts.find(item => item.sessionId === ownerId)
          const inbox = agent.inbox.nextTurn.length + agent.inbox.nextStep.length
          if (agent.status !== 'idle') { state = 'unknown'; reason = `session-status:${agent.status}`; break }
          if (inbox) { state = 'unknown'; reason = 'session-inbox-pending'; break }
          if (ownerAttempt && (agent.id !== ownerAttempt.sessionId || agent.session.header.cwd !== ownerAttempt.cwd)) { state = 'unknown'; reason = 'session-cwd-mismatch'; break }
        }
      }
      for (const branch of scopedAttempts) {
        if (state !== 'clear') break
        const owner = initial.assignments.find(item => item.id === branch.assignmentId)
        try { this.host.attempts?.validateDirectory(branch) } catch { state = 'unknown'; reason = 'prepare-evidence-mismatch' }
        if (state === 'clear' && owner && this.host.reportReady?.(initial, owner, branch) && !this.host.evidenceReady?.(initial, owner, branch)) {
          state = 'unknown'; reason = 'artifact-evidence-mismatch'
        }
      }
      if (state === 'clear' && this.host.outboundUnknown?.(initial)) { state = 'unknown'; reason = 'outbound-receipt-unknown' }
      const current = this.host.store.tickets.get(ticketId)
      const currentAttempts = this.host.attempts?.all().filter(item => item.ticketId === ticketId) ?? []
      const currentScope = [...new Set([...currentAttempts.map(item => item.sessionId), ...(!initial.projectId ? [workerSessionId(ticketId)] : [])])].sort()
      const currentLeases = currentAttempts.map(item => `${item.id}:${item.lease}`).sort()
      const unchanged = !!current && current.lifecycle?.reconciliation?.operationId === operationId
        && current.lifecycle.pause.at === intentAt.pause && current.lifecycle.stop.at === intentAt.stop
        && current.lifecycle.pause.intent === intent.pause && current.lifecycle.stop.intent === intent.stop
        && JSON.stringify(currentScope) === JSON.stringify(ownerIds) && JSON.stringify(currentLeases) === JSON.stringify(attemptLeases)
      if (!unchanged) { persistUnknown('reconciliation-facts-changed'); return { state: 'unknown', operationId } }
      const observedAt = now()
      current!.lifecycle!.reconciliation = { ...checking, state, observedAt, ...(reason ? { reason } : {}) }
      if (state === 'clear') for (const branch of scopedAttempts) {
        if (branch.status === 'reconcile' && branch.prepare) { branch.status = 'prepared'; this.host.attempts!.save(branch) }
      }
      const history = current!.lifecycle!.reconciliationHistory ?? []
      current!.lifecycle!.reconciliationHistory = [...history.filter(item => item.operationId !== operationId), { ...checking, state, observedAt, ...(reason ? { reason } : {}) }]
      this.host.store.tickets.save(current!)
      if (state === 'clear' && current!.lifecycle) this.host.engine.observeTicket(ticketId, current!.lifecycle.stop.intent === 'stop' ? 'exited' : 'idle', 'reconciled')
      return { state, operationId }
    } catch (error) {
      persistUnknown(`reconcile-error:${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      this.reconciling.delete(ticketId)
    }
  }
  /** Cancellation requests become observations only after the actual native workers drain. */
  private reconcileLifecycle(ticket: Ticket): void {
    const lifecycle = ticket.lifecycle
    if (!lifecycle || !this.held(ticket) || ticket.assignments.some(item => this.projectLaunching.has(item.id))) return
    const stopping = lifecycle.stop.intent === 'stop'
    if (stopping ? lifecycle.stop.state === 'exited' : lifecycle.pause.state === 'paused') return
    const intentKey = `${stopping ? 'stop' : 'pause'}:${stopping ? lifecycle.stop.at : lifecycle.pause.at}`
    if (this.lifecycleSettling.get(ticket.id) === intentKey) return
    this.lifecycleSettling.set(ticket.id, intentKey)
    const attempts = this.host.attempts?.all().filter(item => item.ticketId === ticket.id) ?? []
    for (const attempt of attempts) this.projectObserved.delete(attempt.id)
    const ids = ticket.projectId ? attempts.map(item => item.sessionId) : [workerSessionId(ticket.id)]
    const settle = async () => {
      const pendingStop = this.stopping.get(ticket.id)
      if (pendingStop) await pendingStop
      for (const assignment of ticket.assignments.filter(item => item.contract)) {
        const mapped = this.host.attempts?.all().findLast(item => item.assignmentId === assignment.id)
        if (mapped && (mapped.ticketId !== ticket.id || mapped.projectId !== ticket.projectId)) throw new Error('Lifecycle requires reconciliation: foreign execution mapping')
      }
      for (const id of ids) {
        const resolved = await this.host.context.sessionController.resolveAgent(id as SessionId)
        const attempt = attempts.find(item => item.sessionId === id)
        if ('error' in resolved) {
          if (resolved.error.code !== 'session/not-found') throw resolved.error
          // A missing native Session does not prove that its owner jobs ended. Reconcile those jobs first.
          const hadJobs = runningJobs(this.host.context, id).length > 0
           if (hadJobs && !await stopBackground(this.host.context, id, stopping ? 'stopped' : 'paused', !stopping)) throw new Error('Lifecycle requires reconciliation: owner jobs are still running')
          continue
        }
        const agent = resolved.agent
        if (agent.id !== id || (attempt && agent.session.header.cwd !== attempt.cwd)) throw new Error('Lifecycle requires reconciliation: Worker Session/cwd mapping mismatch')
        agent.cancel({ kind: 'user' }, { keepInbox: !stopping })
        const hadJobs = runningJobs(this.host.context, id).length > 0
        const backgroundStopped = await stopBackground(this.host.context, id, stopping ? 'stopped' : 'paused', !stopping)
        if (agent.status !== 'idle') await agent.whenIdle()
        if ((hadJobs && !backgroundStopped) || agent.status !== 'idle') throw new Error('Lifecycle requires reconciliation: native worker is still active')
      }
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || current.lifecycle?.pause.at !== lifecycle.pause.at || current.lifecycle.stop.at !== lifecycle.stop.at) return
      if (stopping) for (const attempt of attempts) {
        const latest = this.host.attempts!.bySession(attempt.sessionId)
        if (latest?.lease === attempt.lease && latest.status !== 'reconcile') { latest.status = 'ended'; this.host.attempts!.save(latest) }
      }
      const files = this.host.checkpointFiles?.(current) ?? []
      if (files.length) this.host.engine.checkpointTicket(ticket.id, files)
      this.host.engine.observeTicket(ticket.id, stopping ? 'exited' : 'idle', stopping ? 'worker-stopped' : 'worker-paused')
    }
    this.track(ticket.id, settle())
  }
  private continuations(ticket?: Ticket) {
    const values = [...ticket?.lifecycle?.attentionContinuations ?? [], ...ticket?.lifecycle?.attentionContinuation ? [ticket.lifecycle.attentionContinuation] : []]
    return [...new Map(values.map(item => [item.answerId, item])).values()]
  }
  /** Only the persisted answer may continue its exact question's execution. Serialize before any await. */
  async continueAfterAttention(ticketId: string, answerId: string, _answerText: string): Promise<boolean> {
    const pending = this.pendingAttention.get(answerId)
    if (pending) { await pending; return this.continuations(this.host.store.tickets.get(ticketId)).some(item => item.answerId === answerId && !!item.deliveredAt) }
    const work = Promise.resolve().then(() => this.deliverAttention(ticketId, answerId))
    this.pendingAttention.set(answerId, work)
    try { return await work } finally { if (this.pendingAttention.get(answerId) === work) this.pendingAttention.delete(answerId) }
  }
  private async deliverAttention(ticketId: string, answerId: string): Promise<boolean> {
    const initial = this.continuations(this.host.store.tickets.get(ticketId)).find(item => item.answerId === answerId)
    if (!initial || initial.answerId !== answerId || !initial.assignmentId || !initial.attemptId || !initial.lease || !initial.sessionId) return false
    const sessionId = initial.sessionId
    const validate = () => {
      const { ticket, assignment, attempt } = this.host.attempts!.resolve(sessionId)
      const current = this.continuations(ticket).find(item => item.answerId === answerId)
      const history = ticket.attentionHistory?.find(item => item.id === initial.questionId && item.version === initial.version)
      const answer = history?.answers.find(item => item.id === answerId && !item.conflict)
      const binding = history?.binding
      if (this.host.closing() || this.host.paused() || this.stopping.has(ticketId) || ticket.id !== ticketId || [...ticket.attentionQuestions ?? [], ...ticket.attention ? [ticket.attention] : []].some(item => item.binding?.assignmentId === assignment.id)
        || current?.answerId !== answerId || current.questionId !== initial.questionId || current.version !== initial.version
        || current.assignmentId !== initial.assignmentId || current.attemptId !== initial.attemptId || current.lease !== initial.lease || current.sessionId !== sessionId
        || assignment.id !== initial.assignmentId || !isActivePlanAssignment(ticket, assignment.id)
        || attempt.id !== initial.attemptId || attempt.lease !== initial.lease || !['prepared', 'running'].includes(attempt.status)
        || binding?.assignmentId !== assignment.id || binding.attemptId !== attempt.id || binding.lease !== attempt.lease || binding.sessionId !== sessionId
        || !answer || answer.text !== current.answerText || (ticket.lifecycle?.reconciliation?.state !== 'clear' && ticket.lifecycle?.reconciliation?.assignmentId === assignment.id)) throw new Later('Attention continuation binding or lifecycle changed')
      return { ticket, assignment, attempt, current, answer }
    }
    let reserved = false
    try {
      const state = validate()
      if (state.current.deliveredAt) return true
      let agent = this.host.context.agents.get(sessionId as SessionId)
      if (!agent) {
        const attempt = this.host.attempts!.bySession(sessionId)!
        agent = await this.host.sessions.ensure(sessionId, attempt.cwd, `Project worker: ${state.ticket.title}`, 'worker')
        validate()
      }
      if (agent.id !== sessionId || agent.session.header.cwd !== this.host.attempts!.bySession(sessionId)?.cwd) return false
      const requestId = `attention-continuation:${ticketId}:${answerId}:${initial.attemptId}:${initial.lease}`
      const held = await this.host.sessions.holds(sessionId, requestId)
      validate()
      if (!held) {
        if (!this.host.scheduler) { this.slots.reserve(initial.assignmentId, 'wake'); reserved = true }
        await this.admitWake(state.attempt, requestId, () => { validate() }, () => this.host.sessions.prompt(sessionId, requestId,
          `A person answered the pending Attention question with: ${state.answer.text}. Continue the confirmed work using that answer and submit the next durable result.`,
          'queue', () => { validate() }))
      }
      // A held native message also completes a crash-interrupted application receipt.
      const latest = validate()
      latest.current.deliveredAt = now()
      latest.attempt.status = 'running'
      latest.assignment.state = 'running'; latest.assignment.startedAt ??= now(); latest.assignment.waitingReason = 'worker-running'
      this.host.store.atomic(() => { this.host.attempts!.save(latest.attempt); this.host.store.tickets.save(latest.ticket) })
      this.projectObserved.add(latest.attempt.id)
      this.host.engine.observeTicket(ticketId, 'running', 'attention-answered')
      return true
    } catch {
      // Keep the durable answer pending. The next pass retries the same native request id.
      return false
    } finally { if (reserved) this.slots.free(initial.assignmentId) }
  }
  /** Called by the existing pass loop; project workers use the same slots as legacy workers. */
  dispatchProjects(): void {
     if (this.host.closing()) return
     for (const ticket of this.host.store.tickets.list()) {
       for (const continuation of this.continuations(ticket).filter(item => !item.deliveredAt)) void this.continueAfterAttention(ticket.id, continuation.answerId, continuation.answerText)
     }
    if (this.host.closing()) return
    for (const ticket of this.host.store.tickets.list()) {
      if (ticket.ended) continue
      const recovery = ticket.lifecycle?.reconciliation
      if (recovery && (recovery.state === 'unknown' || recovery.state === 'checking') && recovery.operationId) {
        void this.reconcileTicket(ticket.id, recovery.operationId).catch(() => {})
      }
      this.reconcileLifecycle(ticket)
      if (!ticket.projectId && ticket.lifecycle?.pause.intent === 'resume' && ticket.lifecycle.observed.reason === 'resume-requested'
        && runningAssignment(ticket) && !['failed', 'blocked'].includes(ticket.assignments.find(item => item.state !== 'ended')?.waitingReason ?? '') && !this.stopping.has(ticket.id) && !this.host.paused()) {
        try { this.slots.reserve(ticket.id, 'wake') } catch { continue }
        const work = this.host.sessions.prompt(workerSessionId(ticket.id), `lifecycle-resume:${ticket.id}:${ticket.lifecycle.pause.at}`,
          'A person resumed this ticket. Continue the assignment from the saved workspace and conversation.', 'queue', () => {
            const current = this.host.store.tickets.get(ticket.id)
            if (!current || this.held(current) || !liveTicket(current)) throw new Later('Ticket execution is paused or stopping')
          }).then(() => { this.host.engine.observeTicket(ticket.id, 'running', 'worker-resumed') })
          .finally(() => { this.slots.free(ticket.id) })
        this.track(ticket.id, work)
      }
    }
    const attempts = this.host.attempts
    if (!attempts) return
    this.syncWorkerBudgets()
    this.host.scheduler?.cancelQueued(row => {
      if (row.kind !== 'worker') return false
      const ticket = this.host.store.tickets.list().find(item => item.assignments.some(branch => row.id.startsWith(`worker:${branch.id}:`)))
      return !ticket || !!ticket.ended || this.held(ticket) || this.host.paused() || this.host.closing()
    })
    for (const attempt of attempts.all().filter(item => item.status === 'settling')) {
      const agent = this.host.context.agents.get(attempt.sessionId as SessionId)
      if (!agent) { attempt.status = 'reconcile'; attempt.error = 'Retry owner is unloaded; physical exit requires reconciliation'; attempts.save(attempt); continue }
      if (agent.id !== attempt.sessionId || agent.session.header.cwd !== attempt.cwd) { attempt.status = 'reconcile'; attempt.error = 'Retry owner/cwd mismatch'; attempts.save(attempt); continue }
      if (agent.status !== 'idle' || runningJobs(this.host.context, attempt.sessionId).length) {
        if (!attempt.fenced) this.stopProject(attempt.ticketId, attempt.assignmentId)
        continue
      }
      attempt.status = 'ended'; attempt.fenced = true; attempts.save(attempt)
      this.projectObserved.delete(attempt.id)
    }
    for (const ticket of this.host.store.tickets.list().filter(item => item.projectId && !item.ended)) {
      if (this.held(ticket) || this.stopping.has(ticket.id)) continue
      for (const assignment of activePlanAssignments(ticket).filter(item => item.state !== 'ended')) {
        const orphanedLiveOwner = attempts.all().some(item => item.ticketId !== ticket.id && !this.host.context.agents.get(item.sessionId as SessionId) && runningJobs(this.host.context, item.sessionId).length > 0)
         if (orphanedLiveOwner) { assignment.waitingReason = 'worker-slot'; this.host.store.tickets.save(ticket); continue }
         const existing = attempts.all().findLast(item => item.assignmentId === assignment.id)
        const continuation = this.continuations(ticket).find(item => item.assignmentId === assignment.id && !item.deliveredAt)
        if (continuation && !continuation.deliveredAt && existing && !existing.fenced && ['prepared', 'running', 'reconcile'].includes(existing.status)
          && continuation.assignmentId === assignment.id && continuation.attemptId === existing.id && continuation.lease === existing.lease && continuation.sessionId === existing.sessionId) continue
        // A delivered answer already covers the current wake. A later explicit
        // pause/resume sets a new resume-requested observation and may wake again.
        const resumeAgent = existing && ticket.lifecycle?.pause.intent === 'resume' && ticket.lifecycle.observed.reason === 'resume-requested'
          ? this.host.context.agents.get(existing.sessionId as SessionId) : undefined
        if (existing && resumeAgent?.status === 'idle' && ['worker-idle', 'worker-running'].includes(assignment.waitingReason ?? '') && !this.host.reportReady?.(ticket, assignment, existing)) {
          if (!this.host.scheduler) { try { this.slots.reserve(assignment.id, 'wake') } catch { continue } }
          const requestId = `project-execute:${existing.id}:${existing.lease}:resume:${ticket.lifecycle!.pause.at}`
          const work = this.admitWake(existing, requestId, () => { attempts.resolve(existing.sessionId); if (this.held(this.host.store.tickets.get(ticket.id)!)) throw new Later('Worker resume held') }, () => this.host.sessions.prompt(existing.sessionId, requestId, 'Continue the confirmed project execution from the saved workspace.', 'queue', () => { attempts.resolve(existing.sessionId) }))
            .then(() => { this.projectObserved.add(existing.id); this.host.engine.observeTicket(ticket.id, 'running', 'worker-resumed') })
            .finally(() => { this.slots.free(assignment.id) })
          this.track(ticket.id, work)
          continue
        }
        if (existing && this.projectObserved.has(existing.id) && assignment.waitingReason !== 'retrying') {
          try { attempts.resolve(existing.sessionId) } catch { this.host.context.agents.get(existing.sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false }); continue }
          if (existing.status === 'running' && this.host.context.agents.get(existing.sessionId as SessionId)?.status === 'idle' && assignment.waitingReason === 'worker-running') {
            assignment.waitingReason = 'worker-idle'; this.host.store.tickets.save(ticket)
          }
          continue
        }
        if (existing?.status === 'reconcile' || existing?.status === 'settling' || this.projectLaunching.has(assignment.id)) continue
         if (['failed', 'blocked'].includes(assignment.waitingReason ?? '')) continue
        // A ready report with an independent semantic gate is durable evidence. Resume may continue the judgment,
        // but must not re-submit the completed worker prompt or redo file actions.
        if (existing && this.host.reportReady?.(ticket, assignment, existing) && ['semantic-review', 'needs_judgment', 'unresolved-items', 'changes_required'].includes(assignment.waitingReason ?? '')) continue
        if (this.host.paused()) { assignment.waitingReason = 'processing-paused'; this.host.store.tickets.save(ticket); continue }
        if (!assignment.contract!.inputs.every(input => input.kind !== 'dependency' || this.host.store.tickets.get(input.ticketId)?.assignments.some(item => item.id === input.assignmentId && (assignment.contract?.proposal?.review?.target === item.contract?.assignmentKey ? item.reportReceipt?.state === 'ready' : item.state === 'ended' && item.endedReason === 'accepted')))) {
          assignment.waitingReason = 'dependency'; this.host.store.tickets.save(ticket); continue
        }
        if (!this.host.scheduler) { try { this.slots.reserve(assignment.id, 'launch') } catch { assignment.waitingReason = 'worker-slot'; this.host.store.tickets.save(ticket); continue } }
        const operation = this.admitProject(ticket.id, assignment.id).finally(() => { this.projectLaunching.delete(assignment.id); if (!this.host.scheduler) this.slots.free(assignment.id) })
        this.projectLaunching.set(assignment.id, operation)
      }
    }
  }
  private readonly workerBudgets = new Map<string, BudgetLease>()
  private readonly pendingWorkerBudgets = new Map<string, BudgetLease>()
  private async admitWake(attempt: Attempt, requestId: string, validate: () => void, run: () => Promise<unknown>): Promise<void> {
    const scheduler = this.host.scheduler
    if (!scheduler) { await run(); return }
    this.syncWorkerBudgets()
    let lease = this.workerBudgets.get(attempt.id)
    if (!lease) {
      lease = await scheduler.acquire({ id: `worker:${attempt.assignmentId}:wake:${requestId}`, projectId: attempt.projectId, ownerId: attempt.sessionId, kind: 'worker', signal: this.host.lifetime, validate })
      this.workerBudgets.set(attempt.id, lease)
    }
    validate()
    await run()
  }
  /** Restore every live historical owner before queued work can receive capacity. Unknown owners retain their leases. */
  private syncWorkerBudgets(): void {
    const scheduler = this.host.scheduler
    if (!scheduler) return
    for (const ticket of this.host.store.tickets.list().filter(item => !item.projectId)) {
      const id = `legacy:${ticket.id}`
      if (this.running(ticket)) {
        if (!this.workerBudgets.has(id)) this.workerBudgets.set(id, scheduler.adopt({ id: `worker-owner:${id}`, projectId: 'legacy', ownerId: workerSessionId(ticket.id), kind: 'worker' }))
      } else { const lease = this.workerBudgets.get(id); this.workerBudgets.delete(id); lease?.release() }
    }
    for (const attempt of this.host.attempts?.all() ?? []) {
      if (this.pendingWorkerBudgets.has(attempt.assignmentId)) continue
      const agent = this.host.context.agents.get(attempt.sessionId as SessionId)
      const physicalJobs = runningJobs(this.host.context, attempt.sessionId).length
      const busy = agent?.status === 'running' || physicalJobs > 0
        || scheduler.status().some(row => row.ownerId === attempt.sessionId && row.state === 'running' && row.kind !== 'worker')
      const unknown = attempt.status === 'reconcile'
      const terminal = ['ended', 'settling'].includes(attempt.status)
      if (busy || unknown || (!terminal && !agent) || (!agent && terminal && physicalJobs > 0)) {
        if (!this.workerBudgets.has(attempt.id)) this.workerBudgets.set(attempt.id, scheduler.adopt({ id: `worker-owner:${attempt.id}`, projectId: attempt.projectId, ownerId: attempt.sessionId, kind: 'worker' }))
      } else if (agent?.status === 'idle') {
        const lease = this.workerBudgets.get(attempt.id)
        this.workerBudgets.delete(attempt.id); lease?.release()
      }
    }
  }
  private async admitProject(ticketId: string, assignmentId: string): Promise<void> {
    const scheduler = this.host.scheduler
    if (!scheduler) return this.launchProject(ticketId, assignmentId)
    const original = this.host.store.tickets.get(ticketId)!
    const branch = original.assignments.find(item => item.id === assignmentId)!
    const authorization = branch.contract!.authorizationId
    const previous = this.host.attempts!.all().findLast(item => item.assignmentId === assignmentId)
    const validate = () => {
      const ticket = this.host.store.tickets.get(ticketId), assignment = ticket?.assignments.find(item => item.id === assignmentId)
      if (!ticket || ticket.ended || !assignment?.contract || assignment.state === 'ended' || !isActivePlanAssignment(ticket, assignmentId) || assignment.contract.authorizationId !== authorization
        || this.held(ticket) || this.host.closing() || this.host.paused()
        || this.host.attempts!.all().findLast(item => item.assignmentId === assignmentId)?.id !== previous?.id) throw new Error('Worker admission authority changed')
    }
    let lease: BudgetLease | undefined, assigned = false
    try {
      lease = previous && previous.status !== 'ended' ? this.workerBudgets.get(previous.id) : undefined
      if (branch.waitingReason === 'executor-unavailable') { branch.waitingReason = 'worker-slot'; this.host.store.tickets.save(original) }
      lease ??= await scheduler.acquire({ id: `worker:${assignmentId}:${previous?.id ?? 'initial'}`, projectId: original.projectId!, kind: 'worker', signal: this.host.lifetime, validate })
      validate()
      if (lease) this.pendingWorkerBudgets.set(assignmentId, lease)
      await this.launchProject(ticketId, assignmentId)
      this.pendingWorkerBudgets.delete(assignmentId)
      const current = this.host.attempts!.all().findLast(item => item.assignmentId === assignmentId)
      if (current && (current.id !== previous?.id || current.status !== 'ended')) { this.workerBudgets.set(current.id, lease); assigned = true }
    } catch { /* Cancellation or stale authority cannot launch work. Durable branches reconstruct the queue. */ }
    finally { this.pendingWorkerBudgets.delete(assignmentId); if (!assigned) lease?.release() }
  }
  private async launchProject(ticketId: string, assignmentId: string): Promise<void> {
    const attempts = this.host.attempts!
    let attempt: Attempt | undefined
    try {
      let ticket = this.host.store.tickets.get(ticketId)!, assignment = ticket.assignments.find(item => item.id === assignmentId)!
      if (this.held(ticket) || this.host.closing() || this.host.paused() || !isActivePlanAssignment(ticket, assignmentId)) return
      await this.stopped(ticketId)
      ticket = this.host.store.tickets.get(ticketId)!; assignment = ticket.assignments.find(item => item.id === assignmentId)!
      if (this.held(ticket) || this.host.closing() || this.host.paused() || !isActivePlanAssignment(ticket, assignmentId)) return
      attempt = attempts.prepare(attempts.allocate(ticket, assignment, { fresh: (attempts.all().findLast(item => item.assignmentId === assignment.id)?.status === 'ended' || !!attempts.all().findLast(item => item.assignmentId === assignment.id)?.fenced) }))
      const agent = await this.host.sessions.ensure(attempt.sessionId, attempt.cwd, `Project worker: ${ticket.title}`, 'worker')
      attempts.resolve(agent.id)
      if (this.host.closing() || this.host.paused() || this.held(this.host.store.tickets.get(ticketId)!)) return
      ticket = this.host.store.tickets.get(ticketId)!; assignment = ticket.assignments.find(item => item.id === assignmentId)!
      assignment.state = 'running'; assignment.startedAt ??= now(); assignment.waitingReason = 'worker-running'
      attempt = attempts.bySession(agent.id)!; attempt.status = 'running'
      this.host.store.atomic(() => { attempts.save(attempt!); this.host.store.tickets.save(ticket) })
      const continuation = ticket.lifecycle?.pause.intent === 'resume' ? `:resume:${ticket.lifecycle.pause.at}` : ''
      const requestId = `project-execute:${attempt.id}:${attempt.lease}${continuation}`
      if (!await this.host.sessions.holds(agent.id, requestId)) await this.host.sessions.prompt(agent.id, requestId,
        `Execute exactly the confirmed plan returned by project_worker_context. Create its named file outputs and submit a versioned report.`, 'queue', () => { attempts.resolve(agent.id) })
      this.projectObserved.add(attempt.id)
    } catch (error) {
      const ticket = this.host.store.tickets.get(ticketId), assignment = ticket?.assignments.find(item => item.id === assignmentId)
      if (this.host.closing() || this.host.paused() || (ticket && this.held(ticket))) return
      if (ticket?.ended || assignment?.state === 'ended') {
        this.host.store.afterCommit(() => this.stopProject(ticketId, assignmentId))
        return
      }
      if (attempt) { attempt = attempts.bySession(attempt.sessionId) ?? attempt; attempt.status = 'reconcile'; attempt.error = String(error); attempts.save(attempt) }
      if (ticket && assignment) { assignment.waitingReason = 'preparation-reconciliation'; assignment.report = { state: 'failed', summary: String(error), at: now() }; this.host.store.tickets.save(ticket) }
    }
  }
  private readonly slots: WorkerSlots
  /** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
  private readonly transient = new Map<string, number>()
  /** Assignment IDs currently waiting on a transient-failure backoff timer before resuming their worker turn. */
  private readonly resuming = new Set<string>()
  /**
   * The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
   * runs again or its Assignment ends.
   */
  private readonly settling = new Map<string, AbortController>()
  /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** One native settle operation per ticket and current pause/stop intent. */
  private readonly lifecycleSettling = new Map<string, string>()
  /** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
  /** When a person's message typed into a worker's Session last started a turn, by ticket. */
  private readonly personal = new Map<string, string>()
  /** The timers of workers that go on after a passing failure, which dispose clears. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => [...new Set([...host.store.tickets.open().filter(ticket => !ticket.projectId && this.running(ticket)).map(ticket => ticket.id), ...host.attempts?.all().filter(item => (host.context.agents.get(item.sessionId as SessionId)?.status === 'running' || runningJobs(host.context, item.sessionId).length > 0)).map(item => item.assignmentId) ?? []])],
      () => host.store.settings().executor.maxWorkers)
    // Each launch reserves a worker slot so launches run concurrently while slots are free.
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // Failed input deliveries are recorded on the ticket itself rather than reported through the `delivery` effect health entry (`quiet: true`).
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /**
   * Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
   * execution environment variables, then verifies the directory as the worker sees it.
   * A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
   * @throws PrepareFailed with the command's output when the prepare command fails.
   */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    // Enforce a timeout so a hung prepare command (such as on a credential prompt) fails the ticket instead of holding a worker slot indefinitely.
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
        await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which the output explains. */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  start(ticket: Ticket, assignment: Assignment): void {
    if (!executableTicket(ticket)) return
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  deliver(ticket: Ticket, _assignment: Assignment): void {
    if (executableTicket(ticket)) this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
  }
  /** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !executableTicket(ticket) || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      // Shutdown or pause re-queues the launch for resume, and transient network/provider errors retry with backoff.
      // A failed prepare command is not retried automatically because an existing directory counts as prepared, so retrying
      // would treat whatever a failed prepare command left behind in the directory as a prepared workspace; instead the
      // ticket is marked failed and waits until new human input or an explicit retry arrives.
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    // A stop of the worker's background work ends with a cancel, which would drop what is delivered meanwhile.
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && executableTicket(first) && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && executableTicket(ticket) && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // Waking an idle worker reserves a slot (including the extra slot reserved for human follow-ups).
        const sessionId = workerSessionId(ticketId)
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          // Recreate the worker session if it was externally deleted.
          if (!this.host.context.agents.get(sessionId as SessionId)) {
            await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker')
          }
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Re-check right before session delivery because the ticket may have ended while awaiting `sourceLink`.
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (current && this.held(current)) throw new Later('Ticket execution is paused or stopping')
      if (!current || !executableTicket(current) || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended, lacks execution authorization or another Assignment took it over')
      // A stop of the worker's background work that started meanwhile ends with a cancel, which would drop the Input.
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
  }
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work, cancels its turn unless its last word was a `ready` or `dropped`
   * report with no Input delivered since, and stops its shell jobs and subagents, including jobs it left to a person.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    if (assignment.contract) {
      this.host.store.afterCommit(() => this.stopProject(ticket.id, assignment.id))
      return
    }
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = workerSessionId(ticket.id)
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      if (!ownTurn) this.host.context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
      // Its shell jobs and subagents stop with it, also those of a worker that ends its own turn.
      this.stopWork(ticket.id, reason)
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
      this.reconcileLifecycle(this.host.store.tickets.get(ticket.id) ?? ticket)
    })
  }
  /** Follow only the server-owned Assignment mapping; cancellation is not proof the native turn has drained. */
  private stopProject(ticketId: string, assignmentId: string): void {
    const attempts = this.host.attempts, ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    const attempt = attempts?.all().findLast(item => item.assignmentId === assignmentId)
    if (!attempts || !ticket?.projectId || !assignment?.contract || assignment.ticketId !== ticket.id || assignment.projectId !== ticket.projectId
      || !attempt || attempt.ticketId !== ticket.id || attempt.projectId !== ticket.projectId) return
    const agent = this.host.context.agents.get(attempt.sessionId as SessionId)
    if (!agent) return // A concurrent ensure is fenced by resolve and stopped in launchProject's catch.
    if (agent.id !== attempt.sessionId || agent.session.header.cwd !== attempt.cwd) {
      attempt.status = 'reconcile'; attempt.error = 'Stop requires reconciliation: Worker Session/cwd mapping mismatch'; attempts.save(attempt)
      return
    }
    if (['preparing', 'prepared', 'running', 'settling'].includes(attempt.status)) { attempt.fenced = true; attempts.save(attempt) }
    agent.cancel({ kind: 'user' }, { keepInbox: false })
    this.projectObserved.delete(attempt.id)
    this.stopWork(ticketId, 'stopped', false, attempt.sessionId)
    this.left.get(ticketId)?.collect.abort(); this.left.delete(ticketId); this.personal.delete(ticketId)
    this.track(ticketId, agent.whenIdle().then(() => {
      const current = attempts.bySession(attempt.sessionId)
      if (current?.id === attempt.id && current.lease === attempt.lease && current.ticketId === ticket.id && current.assignmentId === assignmentId
        && ['preparing', 'prepared', 'running'].includes(current.status)) { delete current.fenced; current.status = 'ended'; attempts.save(current) }
      queueMicrotask(() => this.reconcileLifecycle(this.host.store.tickets.get(ticket.id) ?? ticket))
    }))
  }
  /** Stop what a ticket's worker runs in the background (see `stopBackground`). */
  private stopWork(ticketId: string, reason: string, keepInbox = false, sessionId?: string): void {
    this.track(ticketId, stopBackground(this.host.context, sessionId ?? workerSessionId(ticketId), reason, keepInbox).then(() => {}))
  }
  /** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  /** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /**
   * On a host stop, for a bounded time: stop each loaded worker's background work, keeping its inbox; then end the collecting
   * of the jobs left to a person, which were killed, and cancel a worker turn that started meanwhile, keeping its inbox.
   */
  async shutdown(): Promise<boolean> {
    await Promise.allSettled(this.projectLaunching.values())
    const ids = [...new Set([...(this.host.masterId ? [this.host.masterId] : []), ...this.host.store.tickets.list().filter(ticket => !ticket.projectId).map(ticket => workerSessionId(ticket.id)), ...this.host.attempts?.all().map(item => item.sessionId) ?? []])]
    const agents = ids.map(id => this.host.context.agents.get(id as SessionId))
      .filter((agent): agent is Agent => agent !== undefined)
    const stop = async () => {
      // Jobs remain stoppable after their Session is unloaded; use the durable owner mapping, not loaded Agents only.
      const drained = await Promise.all(ids.map(async id => {
        const hadJobs = runningJobs(this.host.context, id).length > 0
        const result = await stopBackground(this.host.context, id, 'dsh-superagent stopped', true).catch(() => false)
        return !hadJobs || result
      }))
      if (drained.some(value => !value)) return false
      for (const { collect } of this.left.values()) collect.abort()
      const running = agents.filter(agent => agent.status !== 'idle')
      for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(running.map(agent => agent.whenIdle()))
    }
    return await until(stop(), undefined, SHUTDOWN_STOP_MS) !== false
  }
  /** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => !ticket.projectId && this.running(ticket)).length + (this.host.attempts?.all().filter(item => (this.host.context.agents.get(item.sessionId as SessionId)?.status === 'running' || runningJobs(this.host.context, item.sessionId).length > 0)).length ?? 0) }
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    const sessionId = workerSessionId(ticket.id)
    const except = this.left.get(ticket.id)?.jobs
    return this.host.context.agents.get(sessionId as SessionId)?.status === 'running' || runningJobs(this.host.context, sessionId, except).length > 0 || this.settling.has(ticket.id)
  }
  /** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      if (stored && this.held(stored)) throw new Later('Ticket execution is paused or stopping')
      return !!stored && executableTicket(stored) && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    // Prepare the workspace directory once; an existing directory counts as already prepared, including worktrees created before `prepare` commands existed.
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
    if (!current()) return
    // The background work of the Assignment this one replaces stops first, so its end does not clear this one's message.
    await this.stopped(ticket.id)
    if (!current()) return
    // A message put back for this Assignment may still wait in the Session, kept by a restart's cancel or persisted across a
    // crash, where this launch's message would take it into a step beside the copy delivered next: that copy is the only one.
    for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new, unless the
    // Session lost the first, such as when someone deleted it.
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.host.sessions.prompt(sessionId, requestId, text, 'queue',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
      () => { this.host.engine.assignmentStarted(ticket.id, assignment.id) })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** Returns the stored ticket for `agent` when it is a worker session, or undefined otherwise. */
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup. */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // A turn that starts ends the look at its worker's background work; the turn's own idle looks afresh.
      if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
      // The turn a stop of the worker's subagents woke and cancelled is no turn of the worker's.
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment, agent))
    }))
    // A person's message typed into a worker's Session, which the ticket does not record.
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
    }))
    // The Inputs a message of dsh-superagent's carries, which its worker reads once the Session took the message into its
    // history: a step that claimed it may be cancelled or fail before, which drops it.
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const ticketId = ticketOfSession(session.id)
      if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || this.host.closing()) return
      const message = event.data
      void this.background(Promise.resolve().then(() => {
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
          && this.host.sessions.promptedId(input.id) === message.id).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error)) }))
    }))
  }
  /** Unsubscribes from host agent events and clears any pending transient-retry timers. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  /**
   * Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
   * running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
   * while failed launches (`waitsForPerson`) wait for a person's message or a retry.
   */
  resume(): void {
    // Launch pending tickets oldest first (in acceptance order).
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      // Project attempts survive restart in the execution store, but their native Session and
      // filesystem effects do not. Quarantine an attempt that was preparing or running so
      // dispatchProjects cannot silently replay work with an unknown external outcome.
      if (ticket.projectId && this.host.attempts) {
        for (const assignment of activePlanAssignments(ticket).filter(item => item.state !== 'ended')) {
          const attempt = this.host.attempts.all().findLast(item => item.assignmentId === assignment.id)
          if (attempt && (attempt.status === 'preparing' || attempt.status === 'running')) {
            attempt.status = 'reconcile'; attempt.error = 'Host restarted during project execution; explicit reconciliation is required'
            assignment.waitingReason = 'preparation-reconciliation'
            assignment.report = { state: 'failed', summary: attempt.error, at: now() }
            this.host.store.atomic(() => { this.host.attempts!.save(attempt); this.host.store.tickets.save(ticket) })
          }
        }
      }
      if (this.held(ticket)) { this.reconcileLifecycle(ticket); continue }
      // T1 persists project drafts, but only T3 can introduce project execution authorization.
      if (!executableTicket(ticket)) continue
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        // A restart within this process left DSH's Sessions, jobs and subagents running: they stop first. The inbox keeps an
        // Input that was handed over but not yet taken.
        this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
        this.stopWork(ticket.id, 'dsh-superagent restarted', true)
        this.host.engine.assignmentInterrupted(ticket.id, running.id)
      }
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  private background(work: Promise<unknown>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !executableTicket(ticket) || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      // Wait while processing is paused or no wake slot is free.
      if (ticket.lifecycle?.stop.intent === 'stop') { this.resuming.delete(assignmentId); return }
      if (this.host.paused() || this.held(ticket)) { this.after(SLOT_WAIT_MS, go); return }
      const sessionId = workerSessionId(ticketId)
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, 'queue')
      void this.background(sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
        .catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  /** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
   * collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
   */
  private handOff(ticketId: string, agent: Agent): void {
    this.track(ticketId, stopSubagents(this.host.context, agent, true))
    const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() }
    this.left.set(ticketId, left)
    for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
      left.jobs.add(job.id)
      void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async ended => {
        if (!ended) return
        const note = `Your background job ${ended.name} ended: ${ended.status}.`
        await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
      }))
    }
  }
  private async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
    await agent.whenIdle()
    // A turn that failed for a passing reason goes on after its backoff, which is no end of the turn.
    if (this.resuming.has(idle.id) || agent.status !== 'idle') return
    // A turn that ended as turns do starts the count of passing failures again.
    this.transient.delete(idle.id)
    // The ticket while the Assignment that went idle runs it.
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a person;
    // an Input delivered after its result or question is new work.
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // A turn a person started in the Session is the person's work, which goes on in the background as any turn's does.
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // The worker read what reached it before a turn that ended: one it handed off with, or one whose background work ended.
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      return
    }
    // Its turn ends once nothing runs for it in the background, which holds its slot meanwhile: at most for the limit from
    // this idle, and until the worker runs again or the Assignment ends.
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticket.id, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    const left = this.left.get(ticket.id)?.jobs
    try { quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal, limit.signal]), left) }
    finally { clearTimeout(timer); if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.resuming.has(idle.id)) return
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      // Its shell jobs that ran past the limit are killed, which it is told at its next turn; its subagents, whose stop would
      // wake it, go on.
      const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60_000
      const jobs = runningJobs(this.host.context, sessionId, left).map(job => job.name)
      if (jobs.length) {
        void this.background(killJobs(this.host.context, sessionId, 'The job ran past its limit', left))
        const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`
        void this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(',')}`, note, { inject: 'Background jobs killed' }))
      }
      stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
        : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
    }
    // The worker may have reported while its turn ended; a blocked or failed report a person's message has lifted is stale.
    if (handedOff(current)) return
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
  }
}
