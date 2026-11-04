/** Model-visible application skills; native ambient registrations confer no access here. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ManagedSkillSnapshot } from '../managed-skills.ts'
import type { SkillCatalog, SkillInvocationPolicy } from '../skill-catalog.ts'
import { tool, type Tool } from './tool.ts'

export const MANAGED_SKILL_TOOL_NAMES = ['project_list_skills', 'project_load_skill'] as const
export interface ManagedSkillToolsHost {
  readonly catalog: Pick<SkillCatalog, 'candidates' | 'body'>
  /** Already admitted by the server; old empty contracts remain empty. */
  readonly snapshots: readonly ManagedSkillSnapshot[]
  /** Resolves the current lease, role/stage and still-authorized dependency intersection. */
  readonly authorize: () => Omit<SkillInvocationPolicy, 'pin'>
  /** Runs before durable load provenance is recorded; production leaves it undefined. */
  readonly beforeRecord?: () => void | Promise<void>
  readonly onLoaded?: (value: { id: string; name: string; version: string; bodyHash: string; offset: number; nextOffset: number | null }) => void | Promise<void>
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Supplies only pinned application metadata and reauthorizes every body page. */
export function managedSkillTools(host: ManagedSkillToolsHost): Tool[] {
  const snapshots = structuredClone([...host.snapshots])
  if (!snapshots.length) return []
  const ids = new Set<string>()
  for (const { candidate, pin } of snapshots) {
    if (!candidate.id || candidate.id.length > 256 || !candidate.name || candidate.name.length > 256 || !candidate.version || candidate.version.length > 256
      || typeof candidate.description !== 'string' || pin.name !== candidate.name || pin.version !== candidate.version || !/^[a-f0-9]{64}$/.test(pin.bodyHash) || ids.has(candidate.id)) throw new Error('Invalid admitted skill snapshot')
    ids.add(candidate.id)
  }
  const policy = (signal: AbortSignal) => { signal.throwIfAborted(); return host.authorize() }
  const available = (current: Omit<SkillInvocationPolicy, 'pin'>) => {
    const live = new Map(host.catalog.candidates(current).map(row => [row.id, row]))
    return snapshots.filter(({ candidate }) => { const row = live.get(candidate.id); return row?.name === candidate.name && row.version === candidate.version })
  }
  const metadataVersion = (allowed: readonly ManagedSkillSnapshot[]) => digest(JSON.stringify(allowed.map(({ candidate, pin }) => [candidate.id, candidate.name, pin.version, pin.bodyHash, candidate.description])))
  return [
    tool({ name: MANAGED_SKILL_TOOL_NAMES[0], description: 'List currently available skills from this execution snapshot. Metadata and read references grant no additional tools or resources. Bodies are loaded only with project_load_skill.',
      schema: z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(8).default(4), content_version: z.string().optional() }).strict(),
      execute: async (args, signal) => {
        const allowed = available(policy(signal)), contentVersion = metadataVersion(allowed)
        if ((args.offset > 0 && !args.content_version) || (args.content_version && args.content_version !== contentVersion)) throw new Error('Skill metadata changed; restart at offset 0')
        const skills = allowed.slice(args.offset, args.offset + args.limit).map(({ candidate, pin }) => ({ id: candidate.id, name: candidate.name, version: pin.version, bodyHash: pin.bodyHash,
          description: { text: candidate.description.slice(0, 500), totalChars: candidate.description.length, truncated: candidate.description.length > 500 },
          read: { tool: MANAGED_SKILL_TOOL_NAMES[1], skill_id: candidate.id, version: pin.version, body_hash: pin.bodyHash, offset: 0 } }))
        if (metadataVersion(available(policy(signal))) !== contentVersion) throw new Error('Skill metadata changed; restart at offset 0')
        return { skills, contentVersion, offset: args.offset, total: allowed.length, next_offset: args.offset + skills.length < allowed.length ? args.offset + skills.length : null }
      } }),
    tool({ name: MANAGED_SKILL_TOOL_NAMES[1], description: 'Read the exact admitted application skill body/version. Each page rechecks the current execution lease, role, stage, dependencies and immutable body hash. Skill text never expands authorization.',
      schema: z.object({ skill_id: z.string().min(1).max(256), version: z.string().optional(), body_hash: z.string().optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(12000).default(6000) }).strict(),
      execute: async (args, signal) => {
        const current = policy(signal), snapshot = snapshots.find(row => row.candidate.id === args.skill_id)
        if (!snapshot || (args.version && args.version !== snapshot.pin.version) || (args.body_hash && args.body_hash !== snapshot.pin.bodyHash)) throw new Error('Skill is outside this snapshot or its version changed')
        const body = host.catalog.body(snapshot.candidate.id, { ...current, pin: snapshot.pin })
        if (digest(body) !== snapshot.pin.bodyHash) throw new Error('Skill body does not match its pinned hash')
        if (args.offset > body.length) throw new Error('Skill page offset exceeds the body')
        const end = Math.min(body.length, args.offset + args.limit), content = body.slice(args.offset, end), nextOffset = end < body.length ? end : null
        await host.beforeRecord?.()
        const checked = host.catalog.body(snapshot.candidate.id, { ...policy(signal), pin: snapshot.pin })
        if (checked !== body || digest(checked) !== snapshot.pin.bodyHash) throw new Error('Skill body changed during load')
        await host.onLoaded?.({ id: snapshot.candidate.id, name: snapshot.pin.name, version: snapshot.pin.version, bodyHash: snapshot.pin.bodyHash, offset: args.offset, nextOffset })
        return { id: snapshot.candidate.id, name: snapshot.pin.name, version: snapshot.pin.version, bodyHash: snapshot.pin.bodyHash, content,
          offset: args.offset, totalChars: body.length, truncated: nextOffset !== null, next_offset: nextOffset }
      } }),
  ]
}
