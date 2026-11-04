/** Durable, versioned project knowledge with explicit provenance and confirmation state. */
import { createHash, randomUUID } from 'node:crypto'
import type { Store } from './store.ts'

export type KnowledgeKind = 'goal' | 'assumption' | 'decision' | 'rule' | 'note'
export type KnowledgeState = 'proposed' | 'confirmed' | 'rejected'
export interface KnowledgeVersion {
  id: string; projectId: string; kind: KnowledgeKind; title: string; content: string; version: number
  state: KnowledgeState; source: { kind: 'message' | 'file' | 'import' | 'system'; id?: string; path?: string }
  contentHash: string; createdAt: string; supersedes?: string
}

const hash = (content: string) => createHash('sha256').update(content).digest('hex')
const clean = (value: string, label: string) => { const result = value.trim(); if (!result) throw new Error(`${label} must not be empty`); return result }

/** Appends immutable project knowledge revisions and restores their original provenance. */
export class KnowledgeStore {
  constructor(private readonly store: Store, private readonly now: () => string = () => new Date().toISOString()) {}
  propose(input: Omit<KnowledgeVersion, 'id' | 'version' | 'state' | 'contentHash' | 'createdAt'> & { state?: KnowledgeState }): KnowledgeVersion {
    const projectId = clean(input.projectId, 'projectId'), title = clean(input.title, 'title'), content = input.content
    return this.store.atomic(() => {
    const current = this.latest(projectId, input.kind, title)
    const value: KnowledgeVersion = { ...input, projectId, title, content, id: randomUUID(), version: (current?.version ?? 0) + 1,
      state: input.state ?? 'proposed', contentHash: hash(content), createdAt: this.now(), ...(current ? { supersedes: current.id } : {}) }
    this.store.db.prepare('INSERT INTO project_knowledge (id, project_id, kind, title, version, value) VALUES (?, ?, ?, ?, ?, ?)').run(value.id, projectId, input.kind, title, value.version, JSON.stringify(value))
    return value
    })
  }
  confirm(projectId: string, id: string): KnowledgeVersion {
    const value = this.get(projectId, id); if (!value) throw new Error('Unknown project knowledge')
    return this.propose({ projectId, kind: value.kind, title: value.title, content: value.content, source: value.source, state: 'confirmed' })
  }
  reject(projectId: string, id: string): KnowledgeVersion {
    const value = this.get(projectId, id); if (!value) throw new Error('Unknown project knowledge')
    return this.propose({ projectId, kind: value.kind, title: value.title, content: value.content, source: value.source, state: 'rejected' })
  }
  get(projectId: string, id: string): KnowledgeVersion | undefined { const row = this.store.db.prepare('SELECT value FROM project_knowledge WHERE project_id=? AND id=?').get(projectId, id); return row ? JSON.parse(String(row.value)) as KnowledgeVersion : undefined }
  latest(projectId: string, kind?: KnowledgeKind, title?: string): KnowledgeVersion | undefined {
    const rows = this.list(projectId, { kind, title }); return rows[0]
  }
  list(projectId: string, filter: { kind?: KnowledgeKind; title?: string; confirmedOnly?: boolean } = {}): KnowledgeVersion[] {
    const rows = this.store.db.prepare('SELECT value FROM project_knowledge WHERE project_id=? ORDER BY version DESC, rowid DESC').all(projectId).map(row => JSON.parse(String(row.value)) as KnowledgeVersion)
    const filtered = rows.filter(item => (!filter.kind || item.kind === filter.kind) && (!filter.title || item.title === filter.title))
    if (!filter.confirmedOnly) return filtered
    const seen = new Set<string>(); return filtered.filter(item => { const key = `${item.kind}\u0000${item.title}`; if (item.state !== 'confirmed' || seen.has(key)) return false; seen.add(key); return true })
  }
  restore(projectId: string, id: string): KnowledgeVersion { const value = this.get(projectId, id); if (!value) throw new Error('Knowledge version is unavailable after restore'); return value }
}
