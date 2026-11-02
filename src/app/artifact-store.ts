/** Task-owned execution artifacts with server-side project checks. */
import type { Store } from './store.ts'
import type { Artifact } from '../core/project-model.ts'
import type { ArtifactId, ProjectId, TaskId } from '../core/project-ids.ts'

export const ARTIFACT_STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS artifact (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, value TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS artifact_task ON artifact(project_id, task_id);
`

/** Persists task-owned execution artifacts. */
export class ArtifactStore {
  constructor(private readonly store: Store) {}

  save(artifact: Artifact): void {
    this.store.atomic(() => {
      this.required(artifact.id); this.required(artifact.projectId); this.required(artifact.taskId)
      const task = this.store.db.prepare('SELECT project_id FROM project_task WHERE id = ?').get(artifact.taskId)
      if (!task || String(task.project_id) !== artifact.projectId) throw new Error('Artifact task project ownership does not match')
      const old = this.get(artifact.id)
      if (old && (old.projectId !== artifact.projectId || old.taskId !== artifact.taskId)) throw new Error('Artifact ownership is immutable')
      this.store.db.prepare(`INSERT INTO artifact (id, project_id, task_id, value) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET value = excluded.value`).run(artifact.id, artifact.projectId, artifact.taskId, JSON.stringify(artifact))
    })
  }
  get(id: ArtifactId): Artifact | undefined {
    const row = this.store.db.prepare('SELECT value FROM artifact WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.value)) as Artifact : undefined
  }
  list(projectId: ProjectId, taskId?: TaskId): Artifact[] {
    const rows = taskId === undefined
      ? this.store.db.prepare('SELECT value FROM artifact WHERE project_id = ? ORDER BY rowid DESC').all(projectId)
      : this.store.db.prepare('SELECT value FROM artifact WHERE project_id = ? AND task_id = ? ORDER BY rowid DESC').all(projectId, taskId)
    return rows.map(row => JSON.parse(String(row.value)) as Artifact)
  }
  private required(value: string): void { if (typeof value !== 'string' || !value.trim()) throw new Error('Artifact identity is required') }
}
