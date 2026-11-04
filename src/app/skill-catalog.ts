/** Application-owned skill metadata, candidate filtering, pinned snapshots, and body authorization. */
import { createHash, randomUUID } from 'node:crypto'
import type { Store } from './store.ts'

export type SkillRole = 'coordinator' | 'research' | 'code' | 'experiment' | 'writing' | 'worker'
export interface SkillRecord {
  id: string; name: string; version: string; description: string; body: string; roles: SkillRole[]; stages: string[]
  resources: string[]; tools: string[]; enabled: boolean; source?: string; createdAt: string
  /** `global` is explicitly shared; `project` is readable only inside its owning project. */
  scope: 'global' | 'project'; projectId?: string
}
export interface SkillCandidate { id: string; name: string; version: string; description: string; roles: SkillRole[]; stages: string[]; resources: string[]; tools: string[] }
export interface SkillPin { name: string; version: string; bodyHash: string }
export interface DelegatedSkillScope {
  role: Exclude<SkillRole, 'coordinator'>
  stage: string
  resources: string[]
  tools: string[]
  skills: { candidate: SkillCandidate; pin: SkillPin }[]
}

const digest = (body: string) => createHash('sha256').update(body).digest('hex')
/**
 * Legacy rows may predate both the scope column and the scope fields in their JSON. A confirmed
 * `source: project:<id>` is the only safe private provenance; an explicit global/share marker stays
 * shared; an unmarked old row is ambiguous and is hidden rather than widened to every project.
 */
export function normalizeSkillRecord(value: SkillRecord): SkillRecord {
  if (value.scope === 'project') {
    const sourceId = /^project:([^\s\u0000]+)$/.exec(value.source ?? '')?.[1]
    return { ...value, scope: 'project', ...((value.projectId || sourceId) ? { projectId: value.projectId || sourceId } : {}) }
  }
  if (value.scope === 'global') return { ...value, scope: 'global', projectId: undefined }
  if (value.projectId) return { ...value, scope: 'project', projectId: value.projectId }
  const source = /^project:([^\s\u0000]+)$/.exec(value.source ?? '')?.[1]
  if (source) return { ...value, scope: 'project', projectId: source }
  if (value.source === 'legacy' || value.source === 'shared' || value.source === 'global') return { ...value, scope: 'global', projectId: undefined }
  // An old row with no scope and no confirmed provenance cannot be assigned to a project. Hiding
  // it is the safe outcome; marking it global would disclose one project's private body to all.
  return { ...value, scope: 'global', projectId: undefined, enabled: false }
}
const normalize = normalizeSkillRecord
const allowed = (value: string) => /^[a-z][a-z0-9-]*$/.test(value)
const distinct = (values: readonly string[] | undefined, label: string): string[] => {
  if (!values?.length) return []
  const result = [...new Set(values)]
  if (result.some(value => typeof value !== 'string' || !value.trim() || value.length > 256)) throw new Error(`${label} scope is invalid`)
  return result
}

/** Stores skill bodies independently of live sources and authorizes each pinned load. */
export class SkillCatalog {
  constructor(private readonly store: Store, private readonly now: () => string = () => new Date().toISOString()) {}
  publish(input: Omit<SkillRecord, 'id' | 'createdAt' | 'scope' | 'projectId'> & { scope?: 'global' | 'project'; projectId?: string }): SkillRecord {
    if (!allowed(input.name)) throw new Error('Invalid skill name')
    if (!input.body.trim()) throw new Error('Skill body must not be empty')
    const scope = input.scope ?? 'global'
    if (scope === 'project' && !input.projectId) throw new Error('A project skill requires its project scope')
    const value: SkillRecord = { ...input, scope, ...(scope === 'project' ? { projectId: input.projectId } : {}), id: randomUUID(), createdAt: this.now(),
      roles: [...input.roles], stages: [...input.stages], resources: [...input.resources], tools: [...input.tools] }
    this.store.db.prepare('INSERT INTO skill_catalog (id, scope, project_id, name, version, value) VALUES (?, ?, ?, ?, ?, ?)')
      .run(value.id, value.scope, value.scope === 'project' ? value.projectId! : '', value.name, value.version, JSON.stringify(value)); return value
  }
  disable(id: string): void { const value = this.get(id); if (!value) throw new Error('Unknown skill'); value.enabled = false; this.store.db.prepare('UPDATE skill_catalog SET value=? WHERE id=?').run(JSON.stringify(value), id) }
  candidates(input: { projectId?: string; role: SkillRole; stage: string; resources?: readonly string[]; tools?: readonly string[] }): SkillCandidate[] {
    const resources = new Set(input.resources ?? []), tools = new Set(input.tools ?? [])
    return this.all().filter(skill => skill.enabled && (skill.scope !== 'project' || (!!input.projectId && skill.projectId === input.projectId))
      && skill.roles.includes(input.role) && skill.stages.includes(input.stage)
      && skill.resources.every(resource => resources.has(resource)) && skill.tools.every(tool => tools.has(tool)))
      // A project's own skill shadows a global skill with the same name for direct /name loads.
      .sort((left, right) => Number(left.scope !== 'project') - Number(right.scope !== 'project'))
      .map(({ id, name, version, description, roles, stages, resources: requiredResources, tools: requiredTools }) => ({ id, name, version, description, roles, stages, resources: requiredResources, tools: requiredTools }))
  }
  /**
   * A temporary child receives only the exact parent resource/tool grant plus the skills matching its role and stage.
   * The coordinator role is never delegable: project discussion remains the single fenced semantic writer.
   */
  delegationScope(input: {
    projectId: string; parentResources: readonly string[]; parentTools: readonly string[]; role: Exclude<SkillRole, 'coordinator'>
    stage: string; resources?: readonly string[]; tools?: readonly string[]
  }): DelegatedSkillScope {
    if (!input.stage.trim() || input.stage.length > 120) throw new Error('Delegated skill stage is invalid')
    const parentResources = distinct(input.parentResources, 'Parent resource'), parentTools = distinct(input.parentTools, 'Parent tool')
    const resources = distinct(input.resources, 'Delegated resource'), tools = distinct(input.tools, 'Delegated tool')
    const outsideResources = resources.filter(value => !parentResources.includes(value))
    const outsideTools = tools.filter(value => !parentTools.includes(value))
    if (outsideResources.length) throw new Error(`Delegated resources exceed the parent grant: ${outsideResources.join(', ')}`)
    if (outsideTools.length) throw new Error(`Delegated tools exceed the parent grant: ${outsideTools.join(', ')}`)
    const candidates = this.candidates({ projectId: input.projectId, role: input.role, stage: input.stage, resources, tools })
    const pins = this.pin(candidates)
    return { role: input.role, stage: input.stage, resources, tools, skills: candidates.map((candidate, index) => ({ candidate, pin: pins[index]! })) }
  }
  pin(candidates: readonly SkillCandidate[]): SkillPin[] { return candidates.map(item => { const value = this.get(item.id); if (!value || !value.enabled || value.name !== item.name || value.version !== item.version) throw new Error('Skill candidate changed'); return { name: item.name, version: item.version, bodyHash: digest(value.body) } }) }
  body(id: string, authorization: { projectId?: string; role: SkillRole; stage: string; pin?: SkillPin; resources?: readonly string[]; tools?: readonly string[] }): string {
    const value = this.get(id); if (!value || !value.enabled) throw new Error('Skill is unavailable')
    const candidates = this.candidates({ projectId: authorization.projectId, role: authorization.role, stage: authorization.stage, resources: authorization.resources, tools: authorization.tools })
    const candidate = candidates.find(item => item.id === id)
    if (!candidate || (authorization.pin && (authorization.pin.version !== value.version || authorization.pin.bodyHash !== digest(value.body)))) throw new Error('Skill snapshot is stale or unauthorized')
    return value.body
  }
  get(id: string): SkillRecord | undefined { const row = this.store.db.prepare('SELECT value FROM skill_catalog WHERE id=?').get(id); return row ? normalize(JSON.parse(String(row.value)) as SkillRecord) : undefined }
  all(projectId?: string): SkillRecord[] { return this.store.db.prepare('SELECT value FROM skill_catalog ORDER BY rowid').all().map(row => normalize(JSON.parse(String(row.value)) as SkillRecord))
    .filter(skill => projectId === undefined || skill.scope !== 'project' || skill.projectId === projectId) }
  find(name: string, version: string, projectId: string): SkillRecord | undefined {
    const matches = this.all(projectId).filter(skill => skill.enabled && skill.name === name && skill.version === version)
    return matches.find(skill => skill.scope === 'project' && skill.projectId === projectId) ?? matches[0]
  }
}
export interface SkillInvocationPolicy { projectId?: string; role: SkillRole; stage: string; pin?: SkillPin; resources?: readonly string[]; tools?: readonly string[] }
/** Gate for both model tool loads and direct native-user /name loads; body leaves this boundary only after reauthorization. */
export function authorizeSkillBody(catalog: SkillCatalog, id: string, policy: SkillInvocationPolicy): string { return catalog.body(id, policy) }
export const SkillCatalogStore = SkillCatalog
