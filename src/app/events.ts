/** Durable project facts, transactionally appended with business writes and consumed by project lanes. */
import type { Store } from './store.ts'
import { randomUUID } from 'node:crypto'
export type FeedbackBatch = { id: string; projectId: string; events: ProjectEvent[]; prompt: string; generation: number; stateVersion: number; inputId: string; lease: string; phase: 'claimed' | 'replied' | 'committed' | 'abandoned'; sessionId?: string; turn?: string; dshMessageId?: string; replyText?: string }
export const EVENT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS project_event (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, ticket_id TEXT NOT NULL, payload TEXT NOT NULL, consumed_at TEXT); CREATE INDEX IF NOT EXISTS project_event_pending ON project_event(project_id, consumed_at);
CREATE TABLE IF NOT EXISTS project_event_delivery (event_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL, error TEXT, generation INTEGER);`
export type ProjectEventKind = 'assignment-ready' | 'report-recorded' | 'artifact-registered' | 'acceptance-changed' | 'question-answered' | 'reconcile'
export interface ProjectEvent { id: string; projectId: string; ticketId: string; assignmentId?: string; kind: ProjectEventKind; version: string; operationId: string; at: string }
/** Persists idempotent project facts inside the caller's transaction and retains pending delivery across restarts. */
export class ProjectEvents {
  constructor(private readonly store: Store) {}
  feedback(projectId: string): FeedbackBatch | undefined {
    const batch = this.store.get<FeedbackBatch>(`project-feedback:${projectId}`)
    return batch && batch.phase !== 'committed' ? batch : undefined
  }
  feedbackReady(batch: FeedbackBatch): boolean {
    return Number(this.store.get<{ retryAt: number }>(`project-feedback-backoff:${batch.projectId}`)?.retryAt ?? 0) <= Date.now()
      && batch.events.every(event => Number(this.store.db.prepare('SELECT retry_at FROM project_event_delivery WHERE event_id=?').get(event.id)?.retry_at ?? 0) <= Date.now())
  }
  claimFeedback(projectId: string, events: ProjectEvent[], prompt: string, generation: number, stateVersion: number): FeedbackBatch {
    return this.store.atomic(() => {
      const old = this.feedback(projectId)
      if (old && old.phase !== 'abandoned') return old
      if (old) {
        const renewed = { ...old, events, prompt, generation, stateVersion, inputId: `feedback:${old.id}`, lease: randomUUID(), phase: 'claimed' as const }
        this.store.set(`project-feedback:${projectId}`, renewed)
        return renewed
      }
      const id = randomUUID()
      const batch: FeedbackBatch = { id, projectId, events, prompt, generation, stateVersion, inputId: `feedback:${id}`, lease: randomUUID(), phase: 'claimed' }
      this.store.set(`project-feedback:${projectId}`, batch)
      return batch
    })
  }
  validateFeedback(batch: FeedbackBatch, phase: FeedbackBatch['phase'] = 'claimed'): void {
    const current = this.feedback(batch.projectId)
    if (!current || current.phase !== phase || current.id !== batch.id || current.lease !== batch.lease || current.generation !== batch.generation) throw new Error('Stale feedback lease')
  }
  recordReply(batch: FeedbackBatch, reply: { sessionId: string; turn: string | number; dshMessageId: string; text: string }): FeedbackBatch {
    this.validateFeedback(batch)
    const recorded: FeedbackBatch = { ...batch, phase: 'replied', sessionId: reply.sessionId, turn: String(reply.turn), dshMessageId: reply.dshMessageId, replyText: reply.text }
    this.store.set(`project-feedback:${batch.projectId}`, recorded)
    this.store.set(`project-feedback-operation:${batch.id}`, recorded)
    return recorded
  }
  reviveForReconcile(batch: FeedbackBatch, generation: number): FeedbackBatch {
    if (batch.phase !== 'abandoned') throw new Error('Feedback operation is not abandoned')
    const revived = { ...batch, phase: 'claimed' as const, generation, lease: randomUUID() }
    this.store.set(`project-feedback:${batch.projectId}`, revived)
    return revived
  }
  bindFeedback(batch: FeedbackBatch, sessionId: string): FeedbackBatch {
    this.validateFeedback(batch)
    const bound = { ...batch, sessionId }
    this.store.set(`project-feedback:${batch.projectId}`, bound)
    return bound
  }
  abandon(projectId: string): void {
    const batch = this.feedback(projectId)
    if (batch?.phase === 'claimed') this.store.set(`project-feedback:${projectId}`, { ...batch, phase: 'abandoned' })
  }
  completeFeedback(batch: FeedbackBatch): void {
    this.store.atomic(() => { this.validateFeedback(batch, 'replied'); this.consume(batch.events.map(event => event.id)); this.store.set(`project-feedback:${batch.projectId}`, { ...batch, phase: 'committed' }) })
  }
  append(event: ProjectEvent): void {
    const old = this.store.db.prepare('SELECT payload FROM project_event WHERE id=?').get(event.id)
    if (old) { if (String(old.payload) !== JSON.stringify(event)) throw new Error('Event operation id conflict'); return }
    this.store.db.prepare('INSERT INTO project_event (id,project_id,ticket_id,payload) VALUES (?,?,?,?)').run(event.id, event.projectId, event.ticketId, JSON.stringify(event))
  }
  pending(projectId?: string): ProjectEvent[] {
    const rows = projectId ? this.store.db.prepare('SELECT payload FROM project_event WHERE consumed_at IS NULL AND project_id=? ORDER BY rowid').all(projectId) : this.store.db.prepare('SELECT payload FROM project_event WHERE consumed_at IS NULL ORDER BY rowid').all()
    return rows.map(row => JSON.parse(String(row.payload)) as ProjectEvent)
  }
  due(projectId?: string): ProjectEvent[] {
    return this.pending(projectId).filter(event => Number(this.store.get<{ retryAt: number }>(`project-feedback-backoff:${event.projectId}`)?.retryAt ?? 0) <= Date.now()
      && Number(this.store.db.prepare('SELECT retry_at FROM project_event_delivery WHERE event_id=?').get(event.id)?.retry_at ?? 0) <= Date.now())
  }
  failure(projectId: string): string | undefined {
    const row = this.store.db.prepare(`SELECT d.error FROM project_event_delivery d JOIN project_event e ON e.id=d.event_id WHERE e.project_id=? AND e.consumed_at IS NULL AND d.error IS NOT NULL ORDER BY d.attempts DESC LIMIT 1`).get(projectId) as { error?: string } | undefined
    return row?.error
  }
  failed(ids: readonly string[], error: string, generation?: number): void {
    this.store.atomic(() => {
      const projects = new Set(ids.flatMap(id => {
        const row = this.store.db.prepare('SELECT project_id FROM project_event WHERE id=?').get(id)
        return row ? [String(row.project_id)] : []
      }))
      for (const projectId of projects) {
        this.abandon(projectId)
        const attempts = (this.store.get<{ attempts: number }>(`project-feedback-backoff:${projectId}`)?.attempts ?? 0) + 1
        this.store.set(`project-feedback-backoff:${projectId}`, { attempts, retryAt: Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 9)) })
      }
      for (const id of ids) {
      const attempts = Number(this.store.db.prepare('SELECT attempts FROM project_event_delivery WHERE event_id=?').get(id)?.attempts ?? 0) + 1
      this.store.db.prepare('INSERT INTO project_event_delivery VALUES (?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET attempts=excluded.attempts,retry_at=excluded.retry_at,error=excluded.error,generation=excluded.generation')
        .run(id, attempts, Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 9)), error, generation ?? null)
    } })
  }
  consume(ids: readonly string[]): void { this.store.atomic(() => { for (const id of ids) this.store.db.prepare('UPDATE project_event SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(new Date().toISOString(), id) }) }
}
