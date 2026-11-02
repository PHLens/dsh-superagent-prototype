/** SQLite adapter for stable project records; lifecycle and validation live in the core Projects service. */
import type { DatabaseSync } from 'node:sqlite'
import type { Project, ProjectRepository } from '../core/index.ts'

/** Records have independent ids; names and directories are mutable metadata, never lookup keys. */
export function projectRepository(db: DatabaseSync): ProjectRepository {
  return {
    get(id) {
      const row = db.prepare('SELECT value FROM project WHERE id = ?').get(id)
      return row ? JSON.parse(String(row.value)) as Project : undefined
    },
    save(project) {
      db.prepare('INSERT INTO project (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value')
        .run(project.id, JSON.stringify(project))
    },
    list() {
      return db.prepare('SELECT value FROM project ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Project)
    },
  }
}
