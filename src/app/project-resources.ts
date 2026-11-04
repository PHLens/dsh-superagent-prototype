/** Registered filesystem authority. Draft path labels never reach this service. */
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants, writeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Store } from './store.ts'

export interface Resource { id: string; projectId: string; type: 'directory' | 'file' | 'repository' | 'attachment'; path: string; purpose: string; revoked: boolean; version: string; maxBytes: number; createdAt: string }
export interface ResourceEntry { name: string; path: string; kind: 'file' | 'directory'; bytes: number; version: string }
export interface ResourceSnapshot { projectId: string; resourceId: string; path: string; version: string; entries: ResourceEntry[]; expiresAt: string; offset?: number; total?: number; next_offset?: number | null }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const inside = (root: string, target: string) => target === root || target.startsWith(`${root}${sep}`)
const stamp = (stat: NonNullable<ReturnType<typeof lstatSync>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`

/** Checks registered filesystem resources on every access. Callers resolve actor
 * and execution authority before supplying the project; this store checks the
 * live grant, filesystem boundary, permissions, size and version. */
export class ProjectResources {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now, private readonly ttlMs = 60_000) {}
  register(input: Omit<Resource, 'id' | 'path' | 'revoked' | 'version' | 'createdAt'> & { path: string }): Resource {
    if (!this.store.projects.get(input.projectId)) throw new Error('Unknown project')
    if (!['directory', 'file', 'repository', 'attachment'].includes(input.type) || !isAbsolute(input.path) || !input.purpose.trim() || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 16_000_000) throw new Error('Invalid resource registration')
    const raw = resolve(input.path), real = realpathSync(raw), stat = lstatSync(raw)
    if (stat.isSymbolicLink() || ((input.type === 'directory' || input.type === 'repository') ? !stat.isDirectory() : !stat.isFile())) throw new Error('Resource path is not a permitted type')
    accessSync(real, constants.R_OK)
    const value: Resource = { ...input, id: randomUUID(), path: real, revoked: false, version: '', createdAt: new Date(this.now()).toISOString() }
    value.version = digest(stamp(stat))
    this.store.db.prepare('INSERT INTO project_resource (id, project_id, value) VALUES (?, ?, ?)').run(value.id, value.projectId, JSON.stringify(value)); return value
  }
  private contentVersion(resource: Resource): string {
    let total = 0, entries = 0
    const manifest: { path: string; kind: string; hash?: string }[] = []
    const visit = (path: string): void => {
      if (++entries > 10_000) throw new Error('Registered resource exceeds entry limit')
      const name = relative(resource.path, path)
      const target = this.target(resource, name), stat = lstatSync(target)
      if (stat.isDirectory()) {
        manifest.push({ path: name, kind: 'directory' })
        const directory = opendirSync(target), children: string[] = []
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (children.length + entries >= 10_000) throw new Error('Registered resource exceeds entry limit')
            children.push(entry.name)
          }
        } finally { directory.closeSync() }
        for (const child of children.sort()) visit(join(target, child))
        if (stamp(lstatSync(target)) !== stamp(stat)) throw new Error('Resource changed during capture')
      } else if (stat.isFile()) {
        if (stat.size > resource.maxBytes || total + stat.size > resource.maxBytes) throw new Error('Registered resource exceeds byte limit')
        const data = this.download(resource.projectId, resource.id, name)
        total += data.length
        if (total > resource.maxBytes) throw new Error('Registered resource exceeds byte limit')
        manifest.push({ path: name, kind: 'file', hash: digest(data) })
      } else throw new Error('Resource contains an unsupported filesystem entry')
    }
    visit(resource.path)
    return digest(JSON.stringify(manifest))
  }
  capture(projectId: string, id: string): Resource {
    const resource = this.get(projectId, id), version = this.contentVersion(resource)
    if (this.contentVersion(resource) !== version) throw new Error('Resource changed during capture')
    resource.version = version
    this.store.db.prepare('UPDATE project_resource SET value=? WHERE project_id=? AND id=?').run(JSON.stringify(resource), projectId, id)
    return resource
  }
  get(projectId: string, id: string): Resource {
    const row = this.store.db.prepare('SELECT value FROM project_resource WHERE project_id=? AND id=?').get(projectId, id)
    if (!row) throw new Error('Unknown project resource')
    const value = JSON.parse(String(row.value)) as Resource
    if (value.revoked) throw new Error('Resource access revoked')
    return value
  }
  /** Live grant probe for consumers that must intersect pinned capabilities with the current grant. */
  granted(projectId: string, id: string): boolean { try { this.get(projectId, id); return true } catch { return false } }
  /** Admission-only live authority check; read paths may intentionally refresh a changed snapshot. */
  /**
   * Live identity of a registered executable program. Its version is the captured content version,
   * never a stat stamp: callers may compare it with a binding that was reviewed against content.
   */
  executable(projectId: string, id: string): { resource: Resource; version: string } {
    const value = this.assertCurrent(projectId, id)
    const stat = lstatSync(value.path)
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(value.path) !== value.path) throw new Error('Code runtime must be a registered executable file')
    accessSync(value.path, constants.X_OK)
    this.target(value, '')
    return { resource: value, version: value.version }
  }
  assertCurrent(projectId: string, id: string): Resource {
    const value = this.get(projectId, id)
    if (this.contentVersion(value) !== value.version) throw new Error('Registered resource version is stale; refresh required')
    return value
  }
  list(projectId: string): Resource[] { return this.store.db.prepare('SELECT value FROM project_resource WHERE project_id=?').all(projectId).map(row => JSON.parse(String(row.value)) as Resource) }
  revoke(projectId: string, id: string): void { const value = this.get(projectId, id); if (value.revoked) return; value.revoked = true; this.store.db.prepare('UPDATE project_resource SET value=? WHERE project_id=? AND id=?').run(JSON.stringify(value), projectId, id) }
  private target(resource: Resource, path: string): string {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\0')) throw new Error('Resource path escaped its root')
    const target = path ? resolve(resource.path, path) : resource.path
    if (!inside(resource.path, target) || realpathSync(resource.path) !== resource.path || realpathSync(target) !== target) throw new Error('Resource boundary changed or symlink encountered')
    // Check every component within the grant, including mode bits for operator
    // accounts that could otherwise bypass a revoked directory's permissions.
    let component = resource.path
    const parts = relative(resource.path, target).split(sep).filter(Boolean)
    for (let index = 0; index <= parts.length; index++) {
      if (index) component = join(component, parts[index - 1]!)
      const stat = lstatSync(component)
      if (stat.isSymbolicLink()) throw new Error('Resource boundary changed or symlink encountered')
      if (!(stat.mode & 0o444) || (stat.isDirectory() && !(stat.mode & 0o111))) throw new Error('Resource permission denied')
      accessSync(component, constants.R_OK | (stat.isDirectory() ? constants.X_OK : 0))
    }
    return target
  }
  private recheck(resource: Resource, path: string, stat: NonNullable<ReturnType<typeof lstatSync>>): void {
    const current = this.get(resource.projectId, resource.id)
    if (current.path !== resource.path || current.version !== resource.version || current.maxBytes !== resource.maxBytes) throw new Error('Resource grant changed; refresh required')
    const target = this.target(current, path)
    if (stamp(lstatSync(target)) !== stamp(stat)) throw new Error('Resource changed during read')
  }
  snapshot(projectId: string, id: string, path = ''): ResourceSnapshot {
    const resource = this.get(projectId, id), target = this.target(resource, path), stat = lstatSync(target)
    const paths: string[] = []
    if (stat.isDirectory()) {
      const directory = opendirSync(target)
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (paths.length >= 10_000) throw new Error('Resource directory exceeds browse limit')
          paths.push(join(target, entry.name))
        }
      } finally { directory.closeSync() }
      paths.sort()
    } else paths.push(target)
    const entries: ResourceEntry[] = paths.flatMap(entry => {
      const info = lstatSync(entry)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) return []
      return [{ name: basename(entry), path: relative(resource.path, entry), kind: info.isDirectory() ? 'directory' : 'file', bytes: info.isFile() ? info.size : 0, version: digest(stamp(info)) }]
    })
    this.recheck(resource, path, stat)
    // A directory's mtime does not change when an existing child is rewritten.
    // Verify every entry again before exposing one versioned listing.
    for (const entry of entries) {
      const current = lstatSync(resolve(resource.path, entry.path))
      if (current.isSymbolicLink() || digest(stamp(current)) !== entry.version) throw new Error('Resource snapshot changed; refresh required')
    }
    const version = digest(JSON.stringify([resource.version, path, stamp(stat), entries]))
    return { projectId, resourceId: id, path, version, entries, expiresAt: new Date(this.now() + this.ttlMs).toISOString() }
  }
  browse(projectId: string, id: string, path = '', snapshot?: ResourceSnapshot, offset = 0, limit = 100): ResourceSnapshot {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid resource page')
    const result = this.snapshot(projectId, id, path)
    if (offset && !snapshot) throw new Error('Resource pagination requires a snapshot')
    if (snapshot && (snapshot.projectId !== projectId || snapshot.path !== path || snapshot.resourceId !== id || snapshot.version !== result.version || !Number.isFinite(Date.parse(snapshot.expiresAt)) || Date.parse(snapshot.expiresAt) <= this.now())) throw new Error('Resource snapshot is stale; refresh required')
    const entries = result.entries.slice(offset, offset + limit)
    return { ...result, expiresAt: snapshot?.expiresAt ?? result.expiresAt, entries, offset, total: result.entries.length, next_offset: offset + entries.length < result.entries.length ? offset + entries.length : null }
  }
  download(projectId: string, id: string, path: string, expectedVersion?: string): Buffer {
    const resource = this.get(projectId, id), target = this.target(resource, path), inspected = lstatSync(target)
    if (!inspected.isFile() || inspected.size > resource.maxBytes) throw new Error('Resource file is unavailable or too large')
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.size > resource.maxBytes || stamp(before) !== stamp(inspected)) throw new Error('Resource changed during open')
      if (expectedVersion && expectedVersion !== digest(stamp(before))) throw new Error('Resource version changed; refresh required')
      // One extra byte detects growth without an unbounded read/allocation.
      const content = Buffer.allocUnsafe(before.size + 1)
      let length = 0
      while (length < content.length) {
        const count = readSync(fd, content, length, content.length - length, null)
        if (!count) break
        length += count
      }
      if (length !== before.size || length > resource.maxBytes || stamp(fstatSync(fd)) !== stamp(before)) throw new Error('Resource changed during read')
      this.recheck(resource, path, before)
      return content.subarray(0, length)
    } finally { closeSync(fd) }
  }
  /**
   * Copies a resource into a fresh app-owned destination. The destination must not exist: material is
   * staged once per attempt, so anything already there is an unknown effect and fails closed.
   */
  materialize(projectId: string, id: string, destination: string): void {
    const resource = this.assertCurrent(projectId, id)
    if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error('Code material staging destination already exists')
    const write = (target: string, bytes: Buffer): void => {
      const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      try { writeSync(fd, bytes) } finally { closeSync(fd) }
    }
    const copy = (source: string, target: string, created = false): void => {
      const stat = lstatSync(source)
      if (stat.isSymbolicLink()) throw new Error('Resource materialization encountered a symlink')
      if (stat.isDirectory()) {
        if (!created) mkdirSync(target, { mode: 0o700 })
        const directory = opendirSync(source), names: string[] = []
        try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) names.push(entry.name) } finally { directory.closeSync() }
        for (const name of names.sort()) copy(join(source, name), join(target, name))
      } else if (stat.isFile()) write(target, this.download(projectId, id, relative(resource.path, source)))
      else throw new Error('Resource materialization encountered an unsupported entry')
    }
    mkdirSync(resolve(destination, '..'), { recursive: true, mode: 0o700 })
    const rootStat = lstatSync(resource.path)
    if (rootStat.isSymbolicLink()) throw new Error('Resource materialization encountered a symlink')
    if (rootStat.isFile()) write(destination, this.download(projectId, id, ''))
    else { mkdirSync(destination, { mode: 0o700 }); copy(resource.path, destination, true) }
  }
  preview(projectId: string, id: string, path: string, version?: string): { content: string; truncated: boolean } {
    const data = this.download(projectId, id, path, version)
    if (data.includes(0)) throw new Error('Binary resources require download')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { throw new Error('Binary resources require download') }
    let content = text.slice(0, 16_000)
    const last = content.charCodeAt(content.length - 1)
    if (content.length < text.length && last >= 0xd800 && last <= 0xdbff) content = content.slice(0, -1)
    return { content, truncated: content.length < text.length }
  }
}
/** Input a reader passes back to request the next page of the same immutable listing. */
export interface ResourcePage { path: string; version: string; expiresAt: string }
export const ResourceStore = ProjectResources
