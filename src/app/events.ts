/** Durable project facts, transactionally appended with business writes and consumed by project lanes. */
import type { Store } from './store.ts'
export const EVENT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS project_event (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, ticket_id TEXT NOT NULL, payload TEXT NOT NULL, consumed_at TEXT); CREATE INDEX IF NOT EXISTS project_event_pending ON project_event(project_id, consumed_at);`
export type ProjectEventKind = 'assignment-ready' | 'report-recorded' | 'artifact-registered' | 'acceptance-changed' | 'question-answered' | 'reconcile'
export interface ProjectEvent { id: string; projectId: string; ticketId: string; assignmentId?: string; kind: ProjectEventKind; version: string; operationId: string; at: string }
/** Persists idempotent project facts inside the caller's transaction and retains pending delivery across restarts. */
export class ProjectEvents {
  constructor(private readonly store: Store) {}
  append(event: ProjectEvent): void {
    const old = this.store.db.prepare('SELECT payload FROM project_event WHERE id=?').get(event.id)
    if (old) { if (String(old.payload) !== JSON.stringify(event)) throw new Error('Event operation id conflict'); return }
    this.store.db.prepare('INSERT INTO project_event (id,project_id,ticket_id,payload) VALUES (?,?,?,?)').run(event.id, event.projectId, event.ticketId, JSON.stringify(event))
  }
  pending(projectId?: string): ProjectEvent[] {
    const rows = projectId ? this.store.db.prepare('SELECT payload FROM project_event WHERE consumed_at IS NULL AND project_id=? ORDER BY rowid').all(projectId) : this.store.db.prepare('SELECT payload FROM project_event WHERE consumed_at IS NULL ORDER BY rowid').all()
    return rows.map(row => JSON.parse(String(row.payload)) as ProjectEvent)
  }
  consume(ids: readonly string[]): void { this.store.atomic(() => { for (const id of ids) this.store.db.prepare('UPDATE project_event SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(new Date().toISOString(), id) }) }
}
