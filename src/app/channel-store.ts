/** Durable inbound channel messages. Native source identity is separate from project routing. */
import type { Store } from './store.ts'
import type { ProjectId, TaskId } from '../core/project-ids.ts'

export interface ChannelMessage {
  readonly id: string
  readonly source: 'web' | 'feishu' | 'github'
  readonly accountId: string
  readonly nativeId?: string
  readonly projectId?: ProjectId
  readonly taskId?: TaskId
  readonly replyToId?: string
  readonly actorId?: string
  readonly text: string
  readonly status: 'unresolved' | 'accepted' | 'ignored'
  readonly at: string
}

export interface ReceivedMessage { message: ChannelMessage; duplicate: boolean }

export const CHANNEL_STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS channel_message (id TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL,
    native_id TEXT, project_id TEXT, value TEXT NOT NULL, UNIQUE(source, account_id, native_id));
  CREATE INDEX IF NOT EXISTS channel_message_project ON channel_message(project_id);
  CREATE TABLE IF NOT EXISTS channel_operation (operation_id TEXT NOT NULL, project_id TEXT NOT NULL, message_id TEXT NOT NULL,
    PRIMARY KEY (project_id, operation_id));
  CREATE INDEX IF NOT EXISTS channel_operation_project ON channel_operation(project_id, operation_id);
`

/** Persists inbound messages and their idempotent operation and routing records. */
export class ChannelStore {
  constructor(private readonly store: Store) {}

  receive(message: ChannelMessage, operationId: string): ReceivedMessage {
    return this.store.atomic(() => {
      this.validate(message)
      if (!operationId.trim()) throw new Error('A channel operation identity is required')
      const operationScope = message.projectId ?? ''
      let operation = this.store.db.prepare('SELECT project_id, message_id FROM channel_operation WHERE project_id = ? AND operation_id = ?').get(operationScope, operationId)
      // An unresolved operation is re-scoped when its message is resolved. Find that same
      // operation by its native identity so a later retry remains idempotent.
      if (!operation && message.projectId === undefined) {
        operation = message.nativeId === undefined
          ? this.store.db.prepare(`SELECT o.project_id, o.message_id FROM channel_operation o
              JOIN channel_message m ON m.id = o.message_id
              WHERE o.operation_id = ? AND m.id = ?`).get(operationId, message.id)
          : this.store.db.prepare(`SELECT o.project_id, o.message_id FROM channel_operation o
              JOIN channel_message m ON m.id = o.message_id
              WHERE o.operation_id = ? AND m.source = ? AND m.account_id = ? AND m.native_id = ?`)
              .get(operationId, message.source, message.accountId, message.nativeId)
      }
      if (operation) {
        const prior = this.get(String(operation.message_id))
        if (!prior) throw new Error('Channel operation references a missing message')
        return { message: prior, duplicate: true }
      }
      const native = message.nativeId === undefined ? undefined : this.store.db.prepare(
        'SELECT value FROM channel_message WHERE source = ? AND account_id = ? AND native_id = ?').get(message.source, message.accountId, message.nativeId)
      if (native) {
        const prior = JSON.parse(String(native.value)) as ChannelMessage
        if (message.projectId !== undefined && prior.projectId !== undefined && message.projectId !== prior.projectId) throw new Error('Native channel event is routed to another project')
        this.store.db.prepare('INSERT INTO channel_operation (operation_id, project_id, message_id) VALUES (?, ?, ?)').run(operationId, prior.projectId ?? operationScope, prior.id)
        return { message: prior, duplicate: true }
      }
      if (message.projectId !== undefined) this.requireProject(message.projectId)
      if (message.taskId !== undefined) {
        if (message.projectId === undefined) throw new Error('A task requires project ownership')
        const task = this.store.db.prepare('SELECT project_id FROM project_task WHERE id = ?').get(message.taskId)
        if (!task || String(task.project_id) !== message.projectId) throw new Error('Channel message task project ownership does not match')
      }
      this.store.db.prepare('INSERT INTO channel_message (id, source, account_id, native_id, project_id, value) VALUES (?, ?, ?, ?, ?, ?)')
        .run(message.id, message.source, message.accountId, message.nativeId ?? null, message.projectId ?? null, JSON.stringify(message))
      this.store.db.prepare('INSERT INTO channel_operation (operation_id, project_id, message_id) VALUES (?, ?, ?)')
        .run(operationId, message.projectId ?? '', message.id)
      return { message, duplicate: false }
    })
  }

  resolveProject(messageId: string, projectId: ProjectId): ChannelMessage {
    return this.store.atomic(() => {
      this.requireProject(projectId)
      const current = this.get(messageId)
      if (!current) throw new Error('Channel message does not exist')
      if (current.projectId !== undefined && current.projectId !== projectId) throw new Error('Channel message project ownership is immutable')
      if (current.projectId === projectId) return current
      this.store.db.prepare('UPDATE channel_message SET project_id = ?, value = json_set(value, \'$.projectId\', ?) WHERE id = ?')
        .run(projectId, projectId, messageId)
      this.store.db.prepare('UPDATE channel_operation SET project_id = ? WHERE message_id = ? AND project_id = \'\'')
        .run(projectId, messageId)
      return this.get(messageId)!
    })
  }

  get(id: string): ChannelMessage | undefined {
    const row = this.store.db.prepare('SELECT value FROM channel_message WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.value)) as ChannelMessage : undefined
  }

  list(projectId?: ProjectId): ChannelMessage[] {
    const rows = projectId === undefined
      ? this.store.db.prepare('SELECT value FROM channel_message ORDER BY rowid DESC').all()
      : this.store.db.prepare('SELECT value FROM channel_message WHERE project_id = ? ORDER BY rowid DESC').all(projectId)
    return rows.map(row => JSON.parse(String(row.value)) as ChannelMessage)
  }

  private requireProject(id: ProjectId): void {
    if (!this.store.db.prepare('SELECT 1 FROM project WHERE id = ?').get(id)) throw new Error('Project does not exist')
  }
  private validate(message: ChannelMessage): void {
    for (const value of [message.id, message.source, message.accountId, message.text, message.at]) if (typeof value !== 'string' || !value.trim()) throw new Error('Channel message has invalid required fields')
    if (!['web', 'feishu', 'github'].includes(message.source)) throw new Error('Channel message source is invalid')
    if (!['unresolved', 'accepted', 'ignored'].includes(message.status)) throw new Error('Channel message status is invalid')
    if (message.nativeId !== undefined && (typeof message.nativeId !== 'string' || !message.nativeId.trim())) throw new Error('Native identity is invalid')
  }
}
