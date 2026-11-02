/** Consistent recovery points and safe, inert restore manifests for T5 acceptance. */
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import type { Store } from './store.ts'

export interface RecoveryFile { path: string; sha256: string; bytes: number }
export interface RecoveryManifest {
  format: 1
  createdAt: string
  schemaVersion: number
  database: { file: string; walIncluded: true; sha256: string }
  files: RecoveryFile[]
  boundaries: { workspaces: string[]; attachments: string[]; externalResources: string[] }
  consistency: 'database-only' | 'declared-files-best-effort' | 'declared-files-quiesced'
  restoredProfile: { execution: 'prohibited'; model: 'prohibited'; outbound: 'prohibited'; isolatedRoot: string }
}
export interface RecoveryOptions {
  databasePath: string
  destination: string
  roots?: { workspaces?: string[]; attachments?: string[]; externalResources?: string[] }
  schemaVersion?: number
  filesQuiesced?: boolean
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
function filesUnder(root: string): RecoveryFile[] {
  const result: RecoveryFile[] = []
  if (!statSafe(root)?.isDirectory()) return result
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = statSync(path)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) result.push({ path, sha256: digest(path), bytes: stat.size })
    }
  }
  visit(root); return result
}
const statSafe = (path: string) => { try { return statSync(path) } catch { return undefined } }
/** Uses SQLite VACUUM INTO, so committed WAL pages are part of the database snapshot. */
export function createRecoveryPoint(store: Store, options: RecoveryOptions): RecoveryManifest {
  const destination = resolve(options.destination), database = join(destination, 'database.sqlite')
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  store.db.prepare('VACUUM INTO ?').run(database); chmodSync(database, 0o600)
  const roots = options.roots ?? {}
  const managed = join(destination, 'managed-files'); mkdirSync(managed, { recursive: true, mode: 0o700 })
  const declared = [...roots.workspaces ?? [], ...roots.attachments ?? []]
  for (const root of declared) if (statSafe(root)?.isDirectory()) cpSync(root, join(managed, basename(root)), { recursive: true })
  const files: RecoveryFile[] = [{ path: relative(destination, database), sha256: digest(database), bytes: statSync(database).size }, ...declared.flatMap(root => filesUnder(join(managed, basename(root))).map(file => ({ ...file, path: relative(destination, file.path) })))]
  const manifest: RecoveryManifest = {
    format: 1, createdAt: new Date().toISOString(), schemaVersion: options.schemaVersion ?? 0,
    consistency: options.filesQuiesced ? 'declared-files-quiesced' : declared.length ? 'declared-files-best-effort' : 'database-only',
    database: { file: relative(destination, database), walIncluded: true, sha256: digest(database) }, files,
    boundaries: { workspaces: roots.workspaces ?? [], attachments: roots.attachments ?? [], externalResources: roots.externalResources ?? [] },
    restoredProfile: { execution: 'prohibited', model: 'prohibited', outbound: 'prohibited', isolatedRoot: '' },
  }
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 }); return manifest
}
/** Restores database and managed files into a new root and writes deny-by-construction settings. */
export function restoreRecoveryPoint(source: string, destination: string): RecoveryManifest {
  const sourceRoot = resolve(source), target = resolve(destination)
  if (target === sourceRoot || target.startsWith(`${sourceRoot}/`) || sourceRoot.startsWith(`${target}/`)) throw new Error('Restore root must be separate')
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8')) as RecoveryManifest
  if (manifest.database.sha256 !== digest(join(sourceRoot, manifest.database.file))) throw new Error('Recovery database hash mismatch')
  mkdirSync(target, { recursive: true, mode: 0o700 })
  cpSync(join(sourceRoot, manifest.database.file), join(target, 'database.sqlite'))
  if (statSafe(join(sourceRoot, 'managed-files'))?.isDirectory()) cpSync(join(sourceRoot, 'managed-files'), join(target, 'managed-files'), { recursive: true })
  writeFileSync(join(target, 'restore-profile.json'), JSON.stringify({ execution: false, model: false, outbound: false, source: 'recovery', root: target }, null, 2), { mode: 0o600 })
  const restored = { ...manifest, restoredProfile: { ...manifest.restoredProfile, isolatedRoot: target } }
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(restored, null, 2), { mode: 0o600 }); return restored
}
export function recoveryFiles(manifestPath: string): RecoveryFile[] { return (JSON.parse(readFileSync(manifestPath, 'utf8')) as RecoveryManifest).files }
