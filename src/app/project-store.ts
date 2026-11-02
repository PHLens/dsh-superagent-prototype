/** Project records and execution ownership; lifecycle policy belongs to the core. */
import type { Store } from './store.ts'
import type { Attempt } from '../core/attempts.ts'
import type { AttemptId, ProjectId, TaskId } from '../core/project-ids.ts'
import type { Project, ProjectTask } from '../core/project-model.ts'

export const PROJECT_STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS project_task (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, value TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS project_task_project ON project_task(project_id);
  CREATE TABLE IF NOT EXISTS execution_attempt (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, value TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS execution_attempt_task ON execution_attempt(project_id, task_id);
`

/** Persists projects and their task and execution-attempt records. */
export class ProjectStore {
  constructor(private readonly store: Store) {}

  create(project: Project): void {
    this.store.atomic(() => {
      this.requireId(project.id)
      this.store.db.prepare('INSERT INTO project (id, value) VALUES (?, ?)').run(project.id, JSON.stringify(project))
    })
  }
  get(id: ProjectId): Project | undefined {
    const row = this.store.db.prepare('SELECT value FROM project WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.value)) as Project : undefined
  }
  save(project: Project): void {
    this.store.atomic(() => {
      this.requireProject(project.id)
      this.store.db.prepare('UPDATE project SET value = ? WHERE id = ?').run(JSON.stringify(project), project.id)
    })
  }
  /** Newest created record first; saving does not change its position. */
  list(): Project[] {
    return this.store.db.prepare('SELECT value FROM project ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.value)) as Project)
  }
  saveTask(task: ProjectTask): void {
    this.store.atomic(() => {
      this.requireId(task.id)
      this.requireProject(task.projectId)
      const existing = this.getTask(task.id)
      if (existing && existing.projectId !== task.projectId) throw new Error('Task project ownership is immutable')
      this.store.db.prepare(`INSERT INTO project_task (id, project_id, value) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET value = excluded.value`).run(task.id, task.projectId, JSON.stringify(task))
    })
  }
  getTask(id: TaskId): ProjectTask | undefined {
    const row = this.store.db.prepare('SELECT value FROM project_task WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.value)) as ProjectTask : undefined
  }
  listTasks(projectId: ProjectId): ProjectTask[] {
    return this.store.db.prepare('SELECT value FROM project_task WHERE project_id = ? ORDER BY rowid DESC').all(projectId)
      .map(row => JSON.parse(String(row.value)) as ProjectTask)
  }
  saveAttempt(attempt: Attempt): void {
    this.store.atomic(() => {
      for (const id of [attempt.id, attempt.assignmentId, attempt.authorizationId, attempt.leaseId]) this.requireId(id)
      this.requireProject(attempt.projectId)
      const task = this.getTask(attempt.taskId)
      if (!task || task.projectId !== attempt.projectId) throw new Error('Attempt task project ownership does not match')
      const existing = this.getAttempt(attempt.id)
      if (existing) for (const field of ['projectId', 'taskId', 'assignmentId', 'authorizationId', 'leaseId'] as const) {
        if (existing[field] !== attempt[field]) throw new Error(`Attempt ${field} ownership is immutable`)
      }
      this.store.db.prepare(`INSERT INTO execution_attempt (id, project_id, task_id, value) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET value = excluded.value`).run(attempt.id, attempt.projectId, attempt.taskId, JSON.stringify(attempt))
    })
  }
  getAttempt(id: AttemptId): Attempt | undefined {
    const row = this.store.db.prepare('SELECT value FROM execution_attempt WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.value)) as Attempt : undefined
  }
  listAttempts(projectId: ProjectId, taskId?: TaskId): Attempt[] {
    const rows = taskId === undefined
      ? this.store.db.prepare('SELECT value FROM execution_attempt WHERE project_id = ? ORDER BY rowid DESC').all(projectId)
      : this.store.db.prepare('SELECT value FROM execution_attempt WHERE project_id = ? AND task_id = ? ORDER BY rowid DESC').all(projectId, taskId)
    return rows.map(row => JSON.parse(String(row.value)) as Attempt)
  }
  private requireProject(id: ProjectId): void {
    this.requireId(id)
    if (!this.get(id)) throw new Error('Project does not exist')
  }
  private requireId(id: string): void {
    if (typeof id !== 'string' || !id.trim()) throw new Error('A record identity is required')
  }
}
