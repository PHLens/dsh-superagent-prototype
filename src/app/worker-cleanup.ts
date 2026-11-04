/** Retires finished worker Sessions from the navigation surface without touching their files or history. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { dirname, join } from 'node:path'
import { runningJobs } from '../executor/background.ts'
import type { Ticket } from '../core/index.ts'
import type { ExecutionAttempts } from './execution-attempts.ts'
import type { Store } from './store.ts'

/** Durable idempotent record of what one finished worker retirements already covered. */
interface CleanupFact { sessionId: string; archivedAt: string; workspaceId?: string; workspaceDeletedAt?: string }

export interface WorkerCleanupHost {
  readonly ctx: Context
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'tickets'>
  readonly attempts: ExecutionAttempts
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Unknown native producers keep occupancy, so absence of a record never certifies exit. */
  ownerExitKnown?(ownerId: string): boolean
}

/**
 * Archives a worker Session only when its Task is semantically terminal and its native work is
 * verifiably quiescent, then retires the generated Workspace registration once every Session in
 * it is archived. Archived Sessions keep their log, artifacts, receipts and accounting slot, and
 * this never stops activity, releases a budget slot, or deletes a directory.
 */
export class WorkerCleanup {
  private readonly key = 'worker-ui-cleanup'
  private readonly active = new Map<string, Promise<boolean>>()
  private readonly scans = new Map<string, number>()
  private readonly releases: Array<() => void> = []
  private sweepTimer?: ReturnType<typeof setInterval>
  constructor(private readonly host: WorkerCleanupHost, private readonly now = () => new Date().toISOString(),
    private readonly options: { scanDelayMs?: number; scanLimit?: number; scanBatch?: number; scanConcurrency?: number } = {}) {
    // A closing host cancels the pending scan; its observations are no longer trustworthy.
    host.lifetime.addEventListener('abort', () => { for (const release of this.releases.splice(0)) release(); this.stopSweep() }, { once: true })
    // Facts can become complete without another onEnded: the agent finishes its turn or an owned job
    // settles. Retrigger that Session's terminal Attempts, then let the same pass decide.
    const refresh = (sessionId: string): void => {
      for (const attempt of host.attempts.all()) if (attempt.sessionId === sessionId) void this.consider(attempt.id).catch(() => {})
    }
    const context = host.ctx as unknown as {
      on?: {
        (name: 'agent/status', listener: (payload: { agent: { id: string }; status: string }) => void): () => void
        (name: 'session/event', listener: (session: { id: string }, event: { type: string }) => void): () => void
      }
    }
    if (context.on) {
      this.releases.push(context.on('agent/status', payload => { if (payload.status === 'idle') refresh(payload.agent.id) }))
      this.releases.push(context.on('session/event', (session, event) => { if (event.type === 'job/settled') refresh(session.id) }))
    }
  }
  /**
   * Starts the durable sweep: one immediate full pass over terminal Attempts with incomplete cleanup
   * facts, then a bounded periodic pass if work remains. Call after startup is ready (restore/backup
   * settled) and whenever reconcile clears, not only after an in-memory onEnded delivery.
   */
  start(): void {
    if (this.host.closing() || this.host.lifetime.aborted) return
    // A new start (process restart or a normal reconcile clear) opens a fresh bounded cycle:
    // an exhausted earlier cycle must not make incomplete facts permanently invisible.
    this.scans.clear()
    this.ensureSweep()
    this.sweep()
  }
  /** A terminal Attempt is eligible while its fact is missing or its generated Workspace was left behind. */
  private eligible(): { id: string; workspaceId?: string }[] {
    const facts = this.facts()
    return this.host.attempts.all().filter(attempt => attempt.status === 'ended' && !attempt.fenced
      && (!facts[attempt.id] || (!!attempt.workspaceId && !facts[attempt.id]!.workspaceDeletedAt)))
  }
  private remaining(): { id: string; workspaceId?: string }[] {
    return this.eligible().filter(attempt => (this.scans.get(attempt.id) ?? 0) < (this.options.scanLimit ?? 30))
  }
  /**
   * Cleanup facts can be incomplete at the instant a Task ends (the native Agent may still be
   * finishing its turn). A bounded automatic scan revisits terminal attempts that have no cleanup
   * fact yet, so retirement does not depend on another external trigger.
   */
  private ensureSweep(): void {
    if (this.sweepTimer || this.host.closing() || this.host.lifetime.aborted) return
    this.sweepTimer = setInterval(() => this.sweep(), this.options.scanDelayMs ?? 5_000)
    this.sweepTimer.unref?.()
  }
  private stopSweep(): void {
    if (!this.sweepTimer) return
    clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }
  private sweep(): void {
    if (this.host.closing() || this.host.lifetime.aborted) { this.stopSweep(); return }
    const candidates = this.remaining()
    if (!candidates.length) { this.stopSweep(); return }
    const batch = candidates.slice(0, this.options.scanBatch ?? 8), concurrency = this.options.scanConcurrency ?? 2
    for (const attempt of batch) {
      if (this.active.size >= concurrency) break
      if (this.active.has(attempt.id)) continue
      void this.consider(attempt.id).catch(() => {})
    }
  }
  private facts(): Record<string, CleanupFact> { return this.host.store.get<Record<string, CleanupFact>>(this.key) ?? {} }
  private remember(attemptId: string, fact: CleanupFact): void {
    this.host.store.atomic(() => { const all = this.facts(); all[attemptId] = fact; this.host.store.set(this.key, all) })
  }
  /** Serializes repeated requests for one attempt so a retry cannot duplicate archive writes. */
  async consider(attemptId: string): Promise<boolean> {
    const pending = this.active.get(attemptId)
    if (pending) return await pending
    let work: Promise<boolean>
    work = this.retire(attemptId).then(retired => {
      // A pass never cancels the sweep while any durable cleanup fact is still incomplete, and one
      // other candidate's success must not stop the remaining candidates. Only an exhausted set stops.
      if (this.eligible().some(attempt => attempt.id === attemptId)) this.scans.set(attemptId, (this.scans.get(attemptId) ?? 0) + 1)
      if (this.remaining().length) this.ensureSweep()
      else this.stopSweep()
      return retired
    }).finally(() => { if (this.active.get(attemptId) === work) this.active.delete(attemptId) })
    this.active.set(attemptId, work)
    return await work
  }
  /**
   * Whether the Attempt's Task still holds or awaits a person, a pause, a stop or an open question.
   * A pause stays visible until the owner resumes. A reviewed stop holds only until the latest Attempt
   * is over and its native exit is observable; after that it is a confirmed stop, not an open one.
   */
  private held(ticket: Ticket, attempt: { id: string; assignmentId: string; sessionId: string }): boolean {
    const lifecycle = ticket.lifecycle
    // Task-wide pause/stop authority always wins over one branch's completion.
    if (lifecycle?.pause.intent === 'pause' || lifecycle?.pause.state === 'paused') return true
    if (lifecycle?.stop.intent === 'stop' || lifecycle?.stop.state === 'exited') {
      if (!(this.host.ownerExitKnown?.(attempt.sessionId) ?? false)) return true
    }
    const bound = (value?: { assignmentId?: string; attemptId?: string; sessionId?: string }): boolean =>
      !value?.assignmentId || (value.assignmentId === attempt.assignmentId && (!value.attemptId || value.attemptId === attempt.id) && (!value.sessionId || value.sessionId === attempt.sessionId))
    // A question, continuation or acceptance hold blocks only the Assignment/Attempt it names.
    const questions = [...ticket.attentionQuestions ?? [], ...ticket.attention ? [ticket.attention] : []]
    if (questions.some(question => !question.resolvedAt && bound(question.binding))) return true
    const continuations = [...lifecycle?.attentionContinuations ?? [], ...lifecycle?.attentionContinuation ? [lifecycle.attentionContinuation] : []]
    if (continuations.some(continuation => !continuation.deliveredAt && bound(continuation))) return true
    // `waitsForPerson` looks only at the latest Assignment; scope the same fact to this branch.
    const report = ticket.assignments.find(item => item.id === attempt.assignmentId)?.report
    if (report?.state !== 'blocked' && report?.state !== 'failed') return false
    return !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > report.at)
  }
  /** Facts can change while a lookup is in flight, so every asynchronous boundary re-reads them. */
  private stillTerminal(attemptId: string): boolean {
    const attempt = this.host.attempts.all().find(item => item.id === attemptId)
    if (!attempt || attempt.status !== 'ended' || attempt.fenced) return false
    const ticket = this.host.store.tickets.get(attempt.ticketId)
    const assignment = ticket?.assignments.find(item => item.id === attempt.assignmentId)
    return !!ticket && !!assignment && assignment.state === 'ended' && !this.held(ticket, attempt)
  }
  /** Every destructive step requires the same current native, semantic and ownership facts. */
  private async quiescent(attemptId: string, sessionId: SessionId): Promise<boolean> {
    const resolved = await this.host.ctx.sessionController.resolveAgent(sessionId)
    // A Session that is gone or unreadable is not evidence of a finished turn.
    if ('error' in resolved) return false
    const agent = resolved.agent
    if (agent.status !== 'idle') return false
    if (agent.inbox.nextTurn.length + agent.inbox.nextStep.length > 0) return false
    if (runningJobs(this.host.ctx, agent.id).length > 0) return false
    if (this.host.ownerExitKnown && !this.host.ownerExitKnown(agent.id)) return false
    // A person pinned this Session, so it stays visible regardless of completion.
    if (this.host.ctx.workspaceRegistry.pinnedSessionIds.includes(sessionId)) return false
    // A pause, stop or newly reconstructed owner reservation may arrive while the Agent lookup is in flight.
    return this.stillTerminal(attemptId)
  }
  private async retire(attemptId: string): Promise<boolean> {
    if (this.host.closing() || this.host.lifetime.aborted) return false
    const attempt = this.host.attempts.all().find(item => item.id === attemptId)
    if (!attempt || attempt.status !== 'ended' || attempt.fenced) return false
    const ticket = this.host.store.tickets.get(attempt.ticketId)
    const assignment = ticket?.assignments.find(item => item.id === attempt.assignmentId)
    if (!ticket || !assignment || assignment.state !== 'ended' || this.held(ticket, attempt)) return false
    const registry = this.host.ctx.workspaceRegistry
    const sessionId = SessionId(attempt.sessionId)
    let fact = this.facts()[attemptId]
    if (!(await this.quiescent(attemptId, sessionId))) return false
    if (!fact) {
      if (!registry.archivedSessionIds.includes(sessionId)) await registry.archiveSession(sessionId)
      if (!(await this.quiescent(attemptId, sessionId))) return false
      this.remember(attemptId, { sessionId: attempt.sessionId, archivedAt: this.now(), ...(attempt.workspaceId ? { workspaceId: attempt.workspaceId } : {}) })
      fact = this.facts()[attemptId]
    }
    // The registration is generated application state, so it retires only when nothing in it is visible.
    if (attempt.workspaceId) {
      const workspace = registry.get(WorkspaceId(attempt.workspaceId))
      if (!workspace) {
        const current = this.facts()[attemptId] ?? fact
        if (current && !current.workspaceDeletedAt) this.remember(attemptId, { ...current, workspaceDeletedAt: this.now() })
        return true
      }
      // Exactly the generated execution directory of this project, never a path that merely starts with it.
      if (workspace.path !== attempt.cwd || dirname(attempt.cwd) !== join(attempt.root, 'executions')) return true
      if (!workspace.sessionIds.every(id => registry.archivedSessionIds.includes(id))) return true
      // Check immediately before deleting generated navigation state, including a pre-existing cleanup fact.
      if (!(await this.quiescent(attemptId, sessionId))) return false
      await registry.delete(WorkspaceId(attempt.workspaceId))
      const current = this.facts()[attemptId] ?? { sessionId: attempt.sessionId, archivedAt: this.now() }
      this.remember(attemptId, { ...current, workspaceDeletedAt: this.now() })
    }
    return true
  }
}
