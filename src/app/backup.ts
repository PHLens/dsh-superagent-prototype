/** Consistent SQLite snapshots and explicitly isolated, paused recovery copies. No runtime services are started here. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { KV } from '../kv.ts'
import { Store } from './store.ts'

export interface MigrationSnapshot {
  file: string
  schema: number
  createdAt: string
}

/** VACUUM INTO includes committed WAL contents; reserve a private empty destination before writing any bytes. */
export function snapshotDatabase(db: DatabaseSync, path: string, schema: number): MigrationSnapshot {
  const file = `${path}.schema-${schema}-${randomUUID()}.snapshot.sqlite`
  closeSync(openSync(file, 'wx', 0o600))
  db.prepare('VACUUM INTO ?').run(file)
  chmodSync(file, 0o600)
  const snapshot = { file, schema, createdAt: new Date().toISOString() }
  writeFileSync(`${file}.json`, JSON.stringify({ ...snapshot, file: basename(file), complete: true }), { mode: 0o600, flag: 'wx' })
  return snapshot
}

/** The failed schema transaction was rolled back; its independent snapshot remains available for recovery. */
export class MigrationError extends Error {
  readonly rollback = 'rolledBack' as const
  constructor(version: number, target: number, readonly snapshot: MigrationSnapshot, cause: unknown) {
    super(`The orchestrator database is unchanged at schema ${version}: its migration to schema ${target} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

/**
 * Restore only into a newly created directory. The original database is never overwritten.
 * The copy is offline-only: Runtime refuses its recovery marker. Store can inspect retained data.
 * Settings also start paused with every configured Source disabled.
 * This is a database recovery copy, not a full backup of workspaces, attachments or host Session state.
 */
export function restoreSnapshot(snapshot: MigrationSnapshot, directory: string): { database: string; outboundDisabled: true } {
  const destination = resolve(directory)
  mkdirSync(destination, { mode: 0o700 })
  const database = join(destination, '.recovery-incomplete.sqlite')
  const source = new DatabaseSync(snapshot.file, { readOnly: true })
  try {
    const schema = source.prepare('SELECT value FROM kv WHERE key = ?').get(KV.store.schema)
    if (Number(schema?.value) !== snapshot.schema) throw new Error('Snapshot schema does not match its metadata')
    if (source.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('Snapshot integrity check failed')
    source.prepare('VACUUM INTO ?').run(database)
  } finally { source.close() }
  chmodSync(database, 0o600)
  // Persist the offline guard before migrations: a failed migration must not leave a runnable copy.
  const copy = new DatabaseSync(database)
  try {
    copy.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KV.store.recovery, JSON.stringify({ outboundDisabled: true, restoredAt: new Date().toISOString(), schema: snapshot.schema }))
  } finally { copy.close() }
  const restored = new Store(database)
  try {
    restored.atomic(() => {
      const settings = restored.settings()
      restored.saveSettings({ ...settings, paused: true, sources: Object.fromEntries(Object.entries(settings.sources).map(([id, source]) => [id, { ...source, enabled: false }])) })
      restored.set(KV.store.recovery, { outboundDisabled: true, restoredAt: new Date().toISOString(), schema: snapshot.schema })
    })
  } finally { restored.close() }
  const published = join(destination, 'orchestrator.sqlite')
  renameSync(database, published)
  return { database: published, outboundDisabled: true }
}
