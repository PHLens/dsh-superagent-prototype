/** Durable project conversation storage and coordinator fencing. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
export const CONVERSATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_owner (
  project_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, claimed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_state (
  project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversation_message (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  client_request_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  actor_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','answered','error','saved')),
  user_message_id TEXT,
  mapping_generation INTEGER,
  expected_state_version INTEGER,
  session_id TEXT,
  turn TEXT,
  dsh_message_id TEXT,
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_user_request ON conversation_message(project_id, client_request_key) WHERE role='user';
CREATE INDEX IF NOT EXISTS conversation_message_project ON conversation_message(project_id);
CREATE TABLE IF NOT EXISTS conversation_mapping (
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','retired')),
  error TEXT,
  replacement_reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_active_mapping ON conversation_mapping(project_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS conversation_prompt (
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  input_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (project_id, generation, input_id)
);
`
export type ConversationStoreHost = {
  db: DatabaseSync
  atomic<T>(work: () => T): T
}
export type Owner = {
  projectId: string
  actorId: string
  claimedAt: string
}
export type MessageStatus = 'queued' | 'running' | 'answered' | 'error' | 'saved'
export type ConversationMessage = {
  id: string
  projectId: string
  clientRequestKey: string
  role: 'user' | 'assistant'
  actorId: string
  text: string
  createdAt: string
  status: MessageStatus
  userMessageId?: string
  error?: string
  mappingGeneration?: number
  expectedStateVersion?: number
  sessionId?: string
  turn?: string
  dshMessageId?: string
}
export type Mapping = {
  projectId: string
  sessionId: string
  workspaceId: string
  cwd: string
  generation: number
  version: number
  status: 'active' | 'retired'
  error?: string
  replacementReason?: string
  createdAt: string
}
export type ClaimedInput = {
  input: ConversationMessage
  mapping: Mapping
  stateVersion: number
}
const now = (): string => new Date().toISOString()
const rowMessage = (row: Record<string, unknown>): ConversationMessage => ({
  id: String(row.id),
  projectId: String(row.project_id),
  clientRequestKey: String(row.client_request_key),
  role: row.role as ConversationMessage['role'],
  actorId: String(row.actor_id),
  text: String(row.text),
  createdAt: String(row.created_at),
  status: row.status as MessageStatus,
  ...(row.user_message_id == null ? {} : { userMessageId: String(row.user_message_id) }),
  ...(row.error == null ? {} : { error: String(row.error) }),
  ...(row.mapping_generation == null ? {} : { mappingGeneration: Number(row.mapping_generation) }),
  ...(row.expected_state_version == null ? {} : { expectedStateVersion: Number(row.expected_state_version) }),
  ...(row.session_id == null ? {} : { sessionId: String(row.session_id) }),
  ...(row.turn == null ? {} : { turn: String(row.turn) }),
  ...(row.dsh_message_id == null ? {} : { dshMessageId: String(row.dsh_message_id) }),
})
const rowMapping = (row: Record<string, unknown>): Mapping => ({
  projectId: String(row.project_id),
  sessionId: String(row.session_id),
  workspaceId: String(row.workspace_id),
  cwd: String(row.cwd),
  generation: Number(row.generation),
  version: Number(row.version),
  status: row.status as Mapping['status'],
  createdAt: String(row.created_at),
  ...(row.error == null ? {} : { error: String(row.error) }),
  ...(row.replacement_reason == null ? {} : { replacementReason: String(row.replacement_reason) }),
})
/** Durable project conversation records, prompt checkpoints, mappings, and fenced coordinator turns. */
export class ConversationStore {
  /** The host initializes CONVERSATION_SCHEMA_SQL inside its atomic schema migration. */
  constructor(private readonly store: ConversationStoreHost) {}
  claimProject(
    projectId: string,
    actorId: string,
    options: {
      newlyCreated: boolean
    },
  ): Owner {
    return this.store.atomic(() => {
      const row = this.store.db
        .prepare('SELECT project_id, actor_id, claimed_at FROM conversation_owner WHERE project_id=?')
        .get(projectId) as Record<string, unknown> | undefined
      if (row) {
        if (String(row.actor_id) !== actorId) throw new Error('Project conversation ownership does not match')
        return { projectId, actorId, claimedAt: String(row.claimed_at) }
      }
      if (!options.newlyCreated) throw new Error('Existing unowned project must be explicitly claimed')
      const claimedAt = now()
      this.store.db.prepare('INSERT INTO conversation_owner VALUES (?,?,?)').run(projectId, actorId, claimedAt)
      this.store.db.prepare('INSERT OR IGNORE INTO conversation_state VALUES (?,0)').run(projectId)
      return { projectId, actorId, claimedAt }
    })
  }
  getOwner(projectId: string): Owner | undefined {
    const row = this.store.db.prepare('SELECT * FROM conversation_owner WHERE project_id=?').get(projectId) as
      Record<string, unknown> | undefined
    return row && { projectId, actorId: String(row.actor_id), claimedAt: String(row.claimed_at) }
  }
  listOwners(): Owner[] {
    return this.store.db
      .prepare('SELECT * FROM conversation_owner ORDER BY rowid')
      .all()
      .map((row) => this.getOwnerFromRow(row as Record<string, unknown>))
  }
  private getOwnerFromRow(row: Record<string, unknown>): Owner {
    return { projectId: String(row.project_id), actorId: String(row.actor_id), claimedAt: String(row.claimed_at) }
  }
  private owned(projectId: string, actorId: string): void {
    const owner = this.getOwner(projectId)
    if (!owner || owner.actorId !== actorId) throw new Error('Project conversation ownership does not match')
  }
  appendUser(
    projectId: string,
    actorId: string,
    input: {
      clientRequestKey: string
      text: string
      createdAt?: string
    },
  ): ConversationMessage {
    return this.store.atomic(() => {
      this.owned(projectId, actorId)
      const existing = this.store.db
        .prepare('SELECT * FROM conversation_message WHERE project_id=? AND client_request_key=?')
        .get(projectId, input.clientRequestKey) as Record<string, unknown> | undefined
      if (existing) {
        const message = rowMessage(existing)
        if (message.role !== 'user' || message.text !== input.text || message.actorId !== actorId)
          throw new Error('Client request key was already used with different content')
        return message
      }
      const message: ConversationMessage = {
        id: randomUUID(),
        projectId,
        clientRequestKey: input.clientRequestKey,
        role: 'user',
        actorId,
        text: input.text,
        createdAt: input.createdAt ?? now(),
        status: 'queued',
      }
      this.store.db
        .prepare(
          'INSERT INTO conversation_message (id,project_id,client_request_key,role,actor_id,text,created_at,status) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(message.id, projectId, input.clientRequestKey, 'user', actorId, input.text, message.createdAt, 'queued')
      return message
    })
  }
  getMessage(projectId: string, actorId: string, id: string): ConversationMessage | undefined {
    this.owned(projectId, actorId)
    const row = this.store.db
      .prepare('SELECT * FROM conversation_message WHERE project_id=? AND id=?')
      .get(projectId, id) as Record<string, unknown> | undefined
    return row && rowMessage(row)
  }
  listMessages(projectId: string, actorId: string): ConversationMessage[] {
    this.owned(projectId, actorId)
    return this.store.db
      .prepare('SELECT * FROM conversation_message WHERE project_id=? ORDER BY rowid')
      .all(projectId)
      .map((row) => rowMessage(row as Record<string, unknown>))
  }
  saveMapping(
    projectId: string,
    actorId: string,
    input: {
      sessionId: string
      workspaceId: string
      cwd: string
      expectedGeneration?: number
      reason?: string
      reconciled?: boolean
    },
  ): Mapping {
    return this.store.atomic(() => {
      this.owned(projectId, actorId)
      const active = this.currentMapping(projectId)
      const running = this.store.db
        .prepare("SELECT id FROM conversation_message WHERE project_id=? AND role='user' AND status='running'")
        .get(projectId)
      if (running && !input.reconciled)
        throw new Error('Cannot replace mapping while an input is running without reconciliation')
      if (active && input.expectedGeneration !== undefined && active.generation !== input.expectedGeneration)
        throw new Error('Stale mapping generation')
      const generation = (active?.generation ?? 0) + 1
      const at = now()
      if (active)
        this.store.db
          .prepare(
            "UPDATE conversation_mapping SET status='retired', replacement_reason=? WHERE project_id=? AND generation=?",
          )
          .run(input.reason ?? 'replaced', projectId, active.generation)
      if (running)
        this.store.db
          .prepare("UPDATE conversation_message SET status='error', error=? WHERE project_id=? AND status='running'")
          .run(input.reason ?? 'mapping replaced', projectId)
      this.store.db
        .prepare('INSERT INTO conversation_mapping VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(projectId, generation, input.sessionId, input.workspaceId, input.cwd, 1, 'active', null, null, at)
      return this.currentMapping(projectId)!
    })
  }
  currentMapping(projectId: string): Mapping | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM conversation_mapping WHERE project_id=? AND status='active'")
      .get(projectId) as Record<string, unknown> | undefined
    return row && rowMapping(row)
  }
  listMappings(projectId?: string): Mapping[] {
    const rows =
      projectId === undefined
        ? this.store.db.prepare('SELECT * FROM conversation_mapping ORDER BY project_id,generation').all()
        : this.store.db
            .prepare('SELECT * FROM conversation_mapping WHERE project_id=? ORDER BY generation')
            .all(projectId)
    return rows.map((row) => rowMapping(row as Record<string, unknown>))
  }
  stateVersion(projectId: string): number {
    return Number(
      (
        this.store.db.prepare('SELECT version FROM conversation_state WHERE project_id=?').get(projectId) as
          Record<string, unknown> | undefined
      )?.version ?? 0,
    )
  }
  claimNext(
    projectId: string,
    actorId: string,
    expectedMapping: { generation: number; sessionId: string },
  ): ClaimedInput | undefined {
    return this.store.atomic(() => {
      this.owned(projectId, actorId)
      const mapping = this.currentMapping(projectId)
      if (!mapping) return undefined
      if (
        expectedMapping &&
        (mapping.generation !== expectedMapping.generation || mapping.sessionId !== expectedMapping.sessionId)
      )
        throw new Error('Stale conversation mapping')
      if (
        this.store.db
          .prepare("SELECT 1 FROM conversation_message WHERE project_id=? AND role='user' AND status='running'")
          .get(projectId)
      )
        return undefined
      const row = this.store.db
        .prepare(
          "SELECT * FROM conversation_message WHERE project_id=? AND role='user' AND status='queued' ORDER BY rowid LIMIT 1",
        )
        .get(projectId) as Record<string, unknown> | undefined
      if (!row) return undefined
      const version = this.stateVersion(projectId) + 1
      this.store.db.prepare('UPDATE conversation_state SET version=? WHERE project_id=?').run(version, projectId)
      this.store.db
        .prepare(
          "UPDATE conversation_message SET status='running',mapping_generation=?,expected_state_version=? WHERE id=?",
        )
        .run(mapping.generation, version, String(row.id))
      const input = rowMessage(
        this.store.db.prepare('SELECT * FROM conversation_message WHERE id=?').get(String(row.id)) as Record<
          string,
          unknown
        >,
      )
      return { input, mapping, stateVersion: version }
    })
  }
  complete(
    projectId: string,
    actorId: string,
    input: {
      inputId: string
      mappingGeneration: number
      expectedStateVersion: number
      text: string
      createdAt?: string
      sessionId: string
      turn?: string
      dshMessageId?: string
    },
  ): ConversationMessage {
    return this.store.atomic(() => {
      this.owned(projectId, actorId)
      this.fence(projectId, input.inputId, input.mappingGeneration, input.expectedStateVersion, input.sessionId)
      const user = this.getRaw(input.inputId)!
      const id = `${input.inputId}:assistant`
      const message: ConversationMessage = {
        id,
        projectId,
        clientRequestKey: id,
        role: 'assistant',
        actorId,
        text: input.text,
        createdAt: input.createdAt ?? now(),
        status: 'saved',
        userMessageId: input.inputId,
        mappingGeneration: input.mappingGeneration,
        expectedStateVersion: input.expectedStateVersion,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.turn ? { turn: input.turn } : {}),
        ...(input.dshMessageId ? { dshMessageId: input.dshMessageId } : {}),
      }
      this.store.db.prepare("UPDATE conversation_message SET status='answered' WHERE id=?").run(input.inputId)
      this.store.db
        .prepare(
          'INSERT INTO conversation_message (id,project_id,client_request_key,role,actor_id,text,created_at,status,user_message_id,mapping_generation,expected_state_version,session_id,turn,dsh_message_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          projectId,
          id,
          'assistant',
          actorId,
          input.text,
          message.createdAt,
          'saved',
          input.inputId,
          input.mappingGeneration,
          input.expectedStateVersion,
          input.sessionId ?? null,
          input.turn ?? null,
          input.dshMessageId ?? null,
        )
      this.store.db.prepare('UPDATE conversation_state SET version=version+1 WHERE project_id=?').run(projectId)
      return message
    })
  }
  fail(
    projectId: string,
    actorId: string,
    input: {
      inputId: string
      mappingGeneration: number
      expectedStateVersion: number
      sessionId: string
      error: string
    },
  ): ConversationMessage {
    return this.store.atomic(() => {
      this.owned(projectId, actorId)
      this.fence(projectId, input.inputId, input.mappingGeneration, input.expectedStateVersion, input.sessionId)
      this.store.db
        .prepare("UPDATE conversation_message SET status='error',error=? WHERE id=?")
        .run(input.error, input.inputId)
      this.store.db.prepare('UPDATE conversation_state SET version=version+1 WHERE project_id=?').run(projectId)
      return this.getRaw(input.inputId)!
    })
  }
  retry(projectId: string, actorId: string): ConversationMessage | undefined {
    return this.store.atomic(() => {
      this.owned(projectId, actorId)
      const row = this.store.db
        .prepare(
          "SELECT * FROM conversation_message WHERE project_id=? AND role='user' AND status='error' ORDER BY rowid DESC LIMIT 1",
        )
        .get(projectId) as Record<string, unknown> | undefined
      if (!row) return undefined
      this.store.db.prepare("UPDATE conversation_message SET status='queued',error=NULL WHERE id=?").run(String(row.id))
      return this.getRaw(String(row.id))
    })
  }
  /** Freeze the exact versioned prompt for a claimed input before invoking the model. */
  savePrompt(
    projectId: string,
    actorId: string,
    input: {
      generation: number
      inputId: string
      revision: number
      text: string
    },
  ): {
    revision: number
    text: string
  } {
    return this.store.atomic(() => {
      this.owned(projectId, actorId)
      const message = this.getRaw(input.inputId)
      if (
        !message ||
        message.projectId !== projectId ||
        message.role !== 'user' ||
        message.status !== 'running' ||
        message.mappingGeneration !== input.generation ||
        this.currentMapping(projectId)?.generation !== input.generation
      )
        throw new Error('Stale prompt checkpoint')
      this.store.db
        .prepare('INSERT OR IGNORE INTO conversation_prompt VALUES (?,?,?,?,?)')
        .run(projectId, input.generation, input.inputId, input.revision, input.text)
      const row = this.store.db
        .prepare('SELECT revision,text FROM conversation_prompt WHERE project_id=? AND generation=? AND input_id=?')
        .get(projectId, input.generation, input.inputId) as {
        revision: number
        text: string
      }
      return { revision: Number(row.revision), text: String(row.text) }
    })
  }
  getPrompt(
    projectId: string,
    inputId: string,
  ):
    | {
        revision: number
        text: string
      }
    | undefined {
    const row = this.store.db
      .prepare(
        'SELECT revision,text FROM conversation_prompt WHERE project_id=? AND input_id=? ORDER BY generation DESC LIMIT 1',
      )
      .get(projectId, inputId) as
      | {
          revision: number
          text: string
        }
      | undefined
    return row && { revision: Number(row.revision), text: String(row.text) }
  }
  private getRaw(id: string): ConversationMessage | undefined {
    const row = this.store.db.prepare('SELECT * FROM conversation_message WHERE id=?').get(id) as
      Record<string, unknown> | undefined
    return row && rowMessage(row)
  }
  private fence(projectId: string, id: string, generation: number, version: number, sessionId: string): void {
    const row = this.store.db
      .prepare("SELECT * FROM conversation_message WHERE id=? AND project_id=? AND role='user' AND status='running'")
      .get(id, projectId) as Record<string, unknown> | undefined
    const active = this.currentMapping(projectId)
    if (
      !row ||
      Number(row.mapping_generation) !== generation ||
      Number(row.expected_state_version) !== version ||
      this.stateVersion(projectId) !== version ||
      !active ||
      active.generation !== generation ||
      (sessionId !== undefined && active.sessionId !== sessionId)
    )
      throw new Error('Stale conversation completion')
  }
}
