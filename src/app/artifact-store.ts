/** Durable, immutable UTF-8 file versions with an intent journal for interrupted writes. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Store } from './store.ts'
import { contained, managedDirectory, ExecutionAttempts, type Attempt } from './execution-attempts.ts'

export interface Artifact {
  id: string; projectId: string; ticketId: string; assignmentId: string; attemptId: string; lease: string
  operationId: string; output: string; name: string; contentVersion: string; bytes: number
  status: 'writing' | 'registered'; path: string; content: string; createdAt: string
}
export const digest = (content: string): string => createHash('sha256').update(content).digest('hex')
/** Registers managed writes and verifies every read against immutable project content versions. */
export class ArtifactStore {
  constructor(readonly store: Store, readonly attempts: ExecutionAttempts) {}
  list(projectId: string, ticketId?: string): Artifact[] {
    return this.store.db.prepare('SELECT value FROM worker_artifact ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Artifact)
      .filter(item => item.projectId === projectId && (!ticketId || item.ticketId === ticketId))
  }
  private save(item: Artifact): void {
    this.store.db.prepare('INSERT INTO worker_artifact VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(item.id, item.attemptId, item.operationId, JSON.stringify(item))
  }
  write(sessionId: string, input: { operationId: string; output: string; name: string; content: string }): Artifact {
    const { attempt, assignment } = this.attempts.resolve(sessionId, true)
    if (!input.operationId.trim() || !assignment.contract!.plan.outputs.includes(input.output) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(input.name)
      || !input.content.trim() || Buffer.byteLength(input.content) > 2_000_000) throw new Error('Invalid artifact output, filename or content')
    let artifact = this.list(attempt.projectId, attempt.ticketId).find(item => item.attemptId === attempt.id && item.operationId === input.operationId)
    if (artifact && (artifact.output !== input.output || artifact.name !== input.name || artifact.contentVersion !== digest(input.content))) throw new Error('Artifact operation id conflict')
    if (!artifact) {
      this.attempts.resolve(sessionId)
      const id = randomUUID()
      artifact = { id, projectId: attempt.projectId, ticketId: attempt.ticketId, assignmentId: attempt.assignmentId, attemptId: attempt.id, lease: attempt.lease,
        ...input, contentVersion: digest(input.content), bytes: Buffer.byteLength(input.content), status: 'writing', path: join(attempt.root, 'artifacts', id, input.name), createdAt: new Date().toISOString() }
      // The intent precedes any file effect. It contains the exact bytes to reconcile after an interruption.
      this.store.atomic(() => this.save(artifact!))
    }
    this.reconcile(artifact, attempt)
    return artifact
  }
  reconcile(item: Artifact, attempt: Attempt): void {
    this.attempts.resolve(attempt.sessionId, item.status === 'registered')
    if (item.attemptId !== attempt.id || item.lease !== attempt.lease || item.projectId !== attempt.projectId) throw new Error('Artifact execution identity mismatch')
    const parent = dirname(item.path)
    managedDirectory(attempt.root, parent)
    if (existsSync(item.path) && realpathSync(item.path) !== item.path) throw new Error('Artifact file is a symlink')
    if (realpathSync(parent) !== parent || !contained(attempt.root, parent)) throw new Error('Artifact directory escaped project')
    let existing: Buffer | undefined
    try { existing = readFileSync(item.path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (existing) {
      if (realpathSync(item.path) !== item.path || createHash('sha256').update(existing).digest('hex') !== item.contentVersion) throw new Error('Artifact effect differs; reconciliation required')
    } else {
      if (item.status === 'registered') throw new Error('Registered artifact is missing; reconciliation required')
      writeFileSync(item.path, item.content, { flag: 'wx', mode: 0o600 })
    }
    const fd = openSync(item.path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
    const dir = openSync(parent, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
    if (digest(readFileSync(item.path, 'utf8')) !== item.contentVersion) throw new Error('Artifact checksum failed')
    item.status = 'registered'; this.store.atomic(() => this.save(item))
  }
  read(projectId: string, id: string, contentVersion: string): Artifact {
    const item = this.list(projectId).find(value => value.id === id && value.contentVersion === contentVersion && value.status === 'registered')
    if (!item || realpathSync(item.path) !== item.path || digest(readFileSync(item.path, 'utf8')) !== contentVersion) throw new Error('Artifact not found or content version changed')
    return item
  }
  /** Client metadata never exposes machine paths or file bytes until the versioned content endpoint is requested. */
  view(projectId: string) { return this.list(projectId).filter(item => item.status === 'registered').map(({ path: _path, content: _content, lease: _lease, ...item }) => item) }
}
