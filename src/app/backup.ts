/** Consistent recovery points and safe, inert restore manifests for T5 acceptance. */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SCHEMA_VERSION, type Store } from './store.ts'
import { OLDEST_SCHEMA } from './migration.ts'

export const RECOVERY_DATABASE = 'orchestrator.sqlite'
export interface RecoveryFile { path: string; sha256: string; bytes: number }
export interface RecoveryMapping { source: string; path: string; kind: 'file' | 'directory' }
export interface NativeSessionArchive { id: string; header: unknown; inheritedEventCount: number; events: readonly unknown[]; revision?: unknown }
export interface RecoveryManifest {
  format: 1
  createdAt: string
  schemaVersion: number
  database: { file: string; walIncluded: true; sha256: string }
  files: RecoveryFile[]
  mappings: RecoveryMapping[]
  directories: string[]
  nativeSessions: Array<{ id: string; path: string; revision?: unknown }>
  boundaries: { workspaces: string[]; attachments: string[]; nativeState: string[]; externalResources: string[] }
  missing: string[]
  excluded: { path: string; reason: string }[]
  incomplete: string[]
  consistency: 'database-only' | 'declared-files-best-effort' | 'declared-files-quiesced'
  restoredProfile: { execution: 'prohibited'; model: 'prohibited'; outbound: 'prohibited'; autoResume?: false; isolatedRoot: string; nativeArchiveRoot?: string }
}
export interface RecoveryOptions {
  databasePath: string
  destination: string
  roots?: { workspaces?: string[]; attachments?: string[]; nativeState?: string[]; externalResources?: string[] }
  /** Session event logs captured through the native persistence API, never by guessing a filesystem path. */
  nativeSessions?: NativeSessionArchive[]
  /** Additional credential/config roots to omit, even when nested in a declared file root. */
  credentialPaths?: string[]
  schemaVersion?: number
  consistency?: 'database-only' | 'declared-files-best-effort' | 'declared-files-quiesced'
  /** Leave INCOMPLETE until the service validates every material and promotes the point. */
  complete?: boolean
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const statSafe = (path: string) => { try { return lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
const managedName = (path: string) => `${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 12)}-${basename(path)}`
const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`)
// Never export conventional account stores or environment secrets via broad workspace/native roots.
const credentialName = (name: string) => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.credentials(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|hosts\.yml|id_(?:rsa|ed25519)(?:\.pub)?|.*\.(?:pem|key))$/i.test(name)
function canonicalDestination(path: string): string {
  let ancestor = resolve(path)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)))
}
function freshRoot(path: string): void {
  if (existsSync(path)) throw new Error(`Recovery destination must not exist: ${path}`)
  mkdirSync(path, { recursive: true, mode: 0o700 })
}
/** Uses SQLite VACUUM INTO, so committed WAL pages are part of the database snapshot. */
export function createRecoveryPoint(store: Store, options: RecoveryOptions): RecoveryManifest {
  const destination = canonicalDestination(options.destination), database = join(destination, RECOVERY_DATABASE)
  const roots = options.roots ?? {}
  const declared = [...new Set([...roots.workspaces ?? [], ...roots.attachments ?? [], ...roots.nativeState ?? []].map(root => resolve(root)))]
  const databasePath = resolve(options.databasePath)
  const openedPath = store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
  if (typeof openedPath !== 'string' || realpathSync(databasePath) !== realpathSync(openedPath)) throw new Error('Recovery databasePath must identify the open Store database')
  for (const root of declared) {
    const canonicalRoot = canonicalDestination(root)
    if (within(canonicalRoot, destination) || within(destination, canonicalRoot)) throw new Error('Recovery destination must be separate from declared roots')
  }
  freshRoot(destination)
  const marker = join(destination, 'INCOMPLETE')
  writeFileSync(marker, 'Recovery point creation has not completed.\n', { mode: 0o600 })
  store.db.prepare('VACUUM INTO ?').run(database); chmodSync(database, 0o600)
  const files: RecoveryFile[] = [{ path: RECOVERY_DATABASE, sha256: digest(database), bytes: statSync(database).size }]
  const manifest: RecoveryManifest = {
    format: 1, createdAt: new Date().toISOString(), schemaVersion: options.schemaVersion ?? SCHEMA_VERSION,
    consistency: options.consistency ?? (declared.length || options.nativeSessions?.length ? 'declared-files-best-effort' : 'database-only'),
    database: { file: RECOVERY_DATABASE, walIncluded: true, sha256: files[0]!.sha256 }, files, mappings: [], directories: [], nativeSessions: [],
    boundaries: { workspaces: roots.workspaces ?? [], attachments: roots.attachments ?? [], nativeState: roots.nativeState ?? [], externalResources: roots.externalResources ?? [] },
    missing: [], excluded: [], incomplete: [],
    restoredProfile: { execution: 'prohibited', model: 'prohibited', outbound: 'prohibited', isolatedRoot: '' },
  }
  const credentialRoots = (options.credentialPaths ?? []).map(path => resolve(path))
  const copy = (source: string, target: string) => {
    if (source === databasePath || source.startsWith(`${databasePath}-`) || credentialRoots.some(root => within(root, source)) || source.split(sep).some(credentialName)) {
      manifest.excluded.push({ path: source, reason: 'Database sidecar or credential material' }); return
    }
    const stat = statSafe(source)
    if (!stat) { manifest.missing.push(source); return }
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) {
      manifest.incomplete.push(source); manifest.excluded.push({ path: source, reason: 'Symbolic link or unsupported file type' }); return
    }
    if (stat.isDirectory()) {
      mkdirSync(target, { recursive: true, mode: 0o700 }); manifest.directories.push(relative(destination, target))
      for (const name of readdirSync(source).sort()) copy(join(source, name), join(target, name))
    } else {
      const before = digest(source)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); copyFileSync(source, target); chmodSync(target, 0o600)
      const hash = digest(target)
      files.push({ path: relative(destination, target), sha256: hash, bytes: statSync(target).size })
      if (before !== hash || digest(source) !== hash) manifest.incomplete.push(source)
    }
  }
  for (const root of declared) {
    const stat = statSafe(root)
    if (!stat) { manifest.missing.push(root); continue }
    const path = join('managed-files', managedName(root))
    copy(root, join(destination, path))
    if (statSafe(join(destination, path))) manifest.mappings.push({ source: root, path, kind: stat.isDirectory() ? 'directory' : 'file' })
  }
  for (const session of options.nativeSessions ?? []) {
    if (!session.id || !Number.isSafeInteger(session.inheritedEventCount) || session.inheritedEventCount < 0 || !Array.isArray(session.events)) {
      manifest.incomplete.push(`native-session:${session.id || 'unknown'}`); continue
    }
    const path = join('native-sessions', `${managedName(`session:${session.id}`)}.json`)
    mkdirSync(dirname(join(destination, path)), { recursive: true, mode: 0o700 })
    writeFileSync(join(destination, path), JSON.stringify(session), { mode: 0o600 })
    const entry = { path, sha256: digest(join(destination, path)), bytes: statSync(join(destination, path)).size }
    files.push(entry); manifest.mappings.push({ source: `native-session:${session.id}`, path, kind: 'file' })
    manifest.nativeSessions.push({ id: session.id, path, ...(session.revision === undefined ? {} : { revision: session.revision }) })
  }
  if (manifest.missing.length || manifest.incomplete.length) {
    if (manifest.consistency === 'declared-files-quiesced') manifest.consistency = 'declared-files-best-effort'
  }
  writeFileSync(join(destination, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  renameSync(join(destination, 'manifest.json.tmp'), join(destination, 'manifest.json'))
  if (options.complete !== false && !manifest.missing.length && !manifest.incomplete.length) unlinkSync(marker)
  return manifest
}
/** Promotes an already verified point after every asynchronous material check has passed. */
export function finalizeRecoveryPoint(destination: string, manifest: RecoveryManifest): void {
  if (manifest.missing.length || manifest.incomplete.length) throw new Error('Cannot finalize an incomplete recovery point')
  unlinkSync(join(destination, 'INCOMPLETE'))
}
/** Verifies a recovery point before it becomes visible to retention or restore. */
export function verifyRecoveryPoint(source: string, expected?: RecoveryManifest, options: { allowIncompleteMarker?: boolean } = {}): RecoveryManifest {
  const root = realpathSync(resolve(source))
  if (!options.allowIncompleteMarker && existsSync(join(root, 'INCOMPLETE'))) throw new Error('Recovery point is incomplete')
  const manifest = JSON.parse(readFileSync(confined(root, 'manifest.json'), 'utf8')) as RecoveryManifest
  if (manifest.format !== 1 || manifest.schemaVersion < OLDEST_SCHEMA || manifest.schemaVersion > SCHEMA_VERSION || manifest.missing.length || manifest.incomplete.length || !manifest.database?.walIncluded) {
    throw new Error('Invalid or incomplete recovery manifest')
  }
  if (expected && JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error('Recovery manifest changed during verification')
  for (const file of manifest.files) {
    const path = confined(root, file.path)
    if (!statSafe(path)?.isFile() || statSync(path).size !== file.bytes || digest(path) !== file.sha256) throw new Error(`Recovery file hash mismatch: ${file.path}`)
  }
  const database = manifest.files.find(file => file.path === manifest.database.file)
  if (!database || database.sha256 !== manifest.database.sha256 || !['database.sqlite', RECOVERY_DATABASE].includes(database.path)) throw new Error('Recovery database must have a matching file hash')
  return manifest
}
function confined(root: string, path: string): string {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe recovery path: ${path}`)
  const target = resolve(root, path)
  if (!within(root, target) || target === root) throw new Error(`Unsafe recovery path: ${path}`)
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    if (statSafe(current)?.isSymbolicLink()) throw new Error(`Recovery symbolic link is prohibited: ${path}`)
  }
  return target
}
/** Restores only validated files into a fresh root and writes deny-by-construction settings. */
export function restoreRecoveryPoint(source: string, destination: string): RecoveryManifest {
  const sourceRoot = realpathSync(resolve(source)), target = resolve(destination)
  const targetParent = realpathSync(dirname(target)), targetReal = join(targetParent, basename(target))
  if (within(sourceRoot, targetReal) || within(targetReal, sourceRoot)) throw new Error('Restore root must be separate')
  if (existsSync(target)) throw new Error('Restore destination must not exist')
  if (existsSync(join(sourceRoot, 'INCOMPLETE'))) throw new Error('Recovery point is incomplete')
  const manifestPath = confined(sourceRoot, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RecoveryManifest
  if (manifest.format !== 1 || !Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < OLDEST_SCHEMA || manifest.schemaVersion > SCHEMA_VERSION || !Array.isArray(manifest.files) || !Array.isArray(manifest.mappings) || !Array.isArray(manifest.missing) || !Array.isArray(manifest.incomplete) || manifest.missing.length || manifest.incomplete.length || !manifest.database || manifest.database.walIncluded !== true) throw new Error('Invalid or incomplete recovery manifest')
  const paths = new Set<string>()
  for (const file of manifest.files) {
    const path = confined(sourceRoot, file.path)
    if (paths.has(file.path) || file.path.split('/').some(credentialName) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid recovery file: ${file.path}`)
    paths.add(file.path)
    if (!statSafe(path)?.isFile() || statSync(path).size !== file.bytes || digest(path) !== file.sha256) throw new Error(`Recovery file hash mismatch: ${file.path}`)
  }
  const database = manifest.files.find(file => file.path === manifest.database.file)
  if (!database || database.sha256 !== manifest.database.sha256 || !['database.sqlite', RECOVERY_DATABASE].includes(database.path)) throw new Error('Recovery database must have a matching file hash')
  const mapped = new Set<string>()
  for (const mapping of manifest.mappings) {
    const path = confined(sourceRoot, mapping.path)
    if ((!mapping.path.startsWith('managed-files/') && !mapping.path.startsWith('native-sessions/')) || mapping.path.split('/').some(credentialName) || mapping.source.split(sep).some(credentialName) || mapped.has(mapping.path) || !['file', 'directory'].includes(mapping.kind)) throw new Error('Invalid recovery file mapping')
    mapped.add(mapping.path)
    if (mapping.kind === 'file' ? !paths.has(mapping.path) : !statSafe(path)?.isDirectory()) throw new Error('Missing recovery file mapping')
  }
  for (const file of manifest.files) if (file !== database && !manifest.mappings.some(mapping => mapping.kind === 'file' ? file.path === mapping.path : file.path.startsWith(`${mapping.path}/`))) throw new Error(`Unmapped recovery file: ${file.path}`)
  for (const directory of manifest.directories ?? []) {
    const path = confined(sourceRoot, directory)
    if (!statSafe(path)?.isDirectory() || !manifest.mappings.some(mapping => mapping.kind === 'directory' && (directory === mapping.path || directory.startsWith(`${mapping.path}/`)))) throw new Error('Invalid recovery directory mapping')
  }
  freshRoot(target)
  writeFileSync(join(target, 'restore-profile.json'), JSON.stringify({ execution: false, model: false, outbound: false, source: 'recovery', root: target }, null, 2), { mode: 0o600 })
  writeFileSync(join(target, 'INCOMPLETE'), 'Restore has not completed.\n', { mode: 0o600 })
  for (const directory of manifest.directories ?? manifest.mappings.filter(mapping => mapping.kind === 'directory').map(mapping => mapping.path)) mkdirSync(join(target, directory), { recursive: true, mode: 0o700 })
  for (const file of manifest.files) {
    const path = join(target, file.path === database.path ? RECOVERY_DATABASE : file.path)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); copyFileSync(join(sourceRoot, file.path), path); chmodSync(path, 0o600)
    if (statSync(path).size !== file.bytes || digest(path) !== file.sha256) throw new Error(`Recovery file changed during restore: ${file.path}`)
  }
  const restoredDb = new DatabaseSync(join(target, RECOVERY_DATABASE))
  try {
    const destinationRoot = realpathSync(target)
    const sourceCandidates = (source: string) => {
      const resolved = resolve(source)
      if (resolved.startsWith('/private/var/') || resolved.startsWith('/private/tmp/')) return [resolved, resolved.slice('/private'.length)]
      if (resolved.startsWith('/var/') || resolved.startsWith('/tmp/')) return [resolved, `/private${resolved}`]
      return [resolved]
    }
    const relocate = (value: string): string => {
      if (!isAbsolute(value)) return value
      for (const mapping of manifest.mappings) {
        if (mapping.source.startsWith('native-session:')) continue
        const matchedSource = sourceCandidates(mapping.source).find(candidate => within(candidate, resolve(value)))
        if (!matchedSource) continue
        return join(destinationRoot, mapping.path, mapping.kind === 'directory' ? relative(matchedSource, resolve(value)) : '')
      }
      return value
    }
    const rewrite = (value: unknown, key = ''): unknown => {
      if (typeof value === 'string' && ['path', 'directory', 'cwd', 'root', 'realpath'].includes(key)) return relocate(value)
      if (Array.isArray(value)) return value.map(item => rewrite(item, key))
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rewrite(item, name)]))
      return value
    }
    const rewriteRows = (table: string) => {
      const rows = restoredDb.prepare(`SELECT id, value FROM ${table}`).all() as { id: string; value: string }[]
      const update = restoredDb.prepare(`UPDATE ${table} SET value = ? WHERE id = ?`)
      for (const row of rows) update.run(JSON.stringify(rewrite(JSON.parse(row.value))), row.id)
    }
    for (const table of ['worker_artifact', 'worker_report', 'execution_attempt', 'ticket', 'project']) rewriteRows(table)
    const mappings = restoredDb.prepare('SELECT project_id, generation, cwd FROM conversation_mapping').all() as { project_id: string; generation: number; cwd: string }[]
    const updateMapping = restoredDb.prepare('UPDATE conversation_mapping SET cwd = ? WHERE project_id = ? AND generation = ?')
    for (const mapping of mappings) updateMapping.run(relocate(mapping.cwd), mapping.project_id, mapping.generation)
    for (const session of manifest.nativeSessions ?? []) {
      const archivePath = join(target, session.path)
      const archive = JSON.parse(readFileSync(archivePath, 'utf8')) as { header: unknown }
      archive.header = rewrite(archive.header)
      writeFileSync(archivePath, JSON.stringify(archive), { mode: 0o600 })
    }
  } finally { restoredDb.close() }
  const restored: RecoveryManifest = { ...manifest, restoredProfile: { execution: 'prohibited', model: 'prohibited', outbound: 'prohibited', isolatedRoot: target,
    ...(manifest.nativeSessions?.length ? { autoResume: false as const, nativeArchiveRoot: join(target, 'native-sessions') } : {}) } }
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(restored, null, 2), { mode: 0o600 }); unlinkSync(join(target, 'INCOMPLETE'))
  return restored
}
export function recoveryFiles(manifestPath: string): RecoveryFile[] { return (JSON.parse(readFileSync(manifestPath, 'utf8')) as RecoveryManifest).files }
