/** Managed Sessions never delegate body authorization to the ambient native registry. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillCandidate as NativeSkillCandidate } from '@deepseek-ai/dsh-skill'
import type { SkillCatalog, SkillInvocationPolicy, SkillCandidate, SkillPin } from './skill-catalog.ts'
export interface ManagedSkillSnapshot { candidate: SkillCandidate; pin: SkillPin }
/** One body page actually handed to a model or a direct `/name` user, for the execution's durable manifest. */
export interface SkillLoadRecord { id: string; name: string; version: string; bodyHash: string; offset: number; nextOffset: number | null; at: string }
/** Appends a load once per body page; repeated reads of the same page are the same observed fact. */
export function recordSkillLoad(loads: SkillLoadRecord[], value: Omit<SkillLoadRecord, 'at'>, at: string): boolean {
  if (loads.some(item => item.id === value.id && item.version === value.version && item.bodyHash === value.bodyHash && item.offset === value.offset)) return false
  loads.push({ ...value, at })
  return true
}
export type OnSkillLoaded = (value: { id: string; name: string; version: string; bodyHash: string; offset: number; nextOffset: number | null }) => void | Promise<void>
/** `skills` must be the service from an injected child context; parent Agent contexts deliberately do not expose it. */
export function bindManagedSkills(agent: Agent, catalog: SkillCatalog, snapshots: readonly ManagedSkillSnapshot[], authorize: () => Omit<SkillInvocationPolicy, 'pin'>, skills: Context['skills'], onLoaded?: OnSkillLoaded): () => void {
  const disposers: (() => void)[] = []
  const load = (name: string) => {
    const snapshot = snapshots.find(item => item.candidate.name === name)
    if (!snapshot) throw new Error(`Skill ${name} is outside this execution snapshot`)
    const body = catalog.body(snapshot.candidate.id, { ...authorize(), pin: snapshot.pin })
    // A direct `/name` load gets the whole body; record it exactly like a page read.
    void onLoaded?.({ id: snapshot.candidate.id, name: snapshot.pin.name, version: snapshot.pin.version, bodyHash: snapshot.pin.bodyHash, offset: 0, nextOffset: null })
    return body
  }
  // A scoped provider shadows an allowed name, but does not remove globals. The
  // independent pre-step guard below is therefore required for direct users.
  try {
    disposers.push(skills.registerProvider(() => ({ name: `managed-${agent.id}`, list: async () => snapshots.map(({ candidate }) => ({ name: candidate.name, description: candidate.description, source: 'runtime' as const, provider: `managed-${agent.id}`, rank: 0, locator: candidate.id, invocation: { modelInvocable: true, userInvocable: true } } as NativeSkillCandidate)), get: async candidate => ({ name: candidate.name, description: candidate.description, source: 'runtime' as const, provider: `managed-${agent.id}`, content: load(candidate.name), invocation: { modelInvocable: true, userInvocable: true } }) })))
    disposers.push(agent.ctx.on('agent/pre-step', async ({ agent: current, messages }, next) => {
      if (current !== agent) return next()
      authorize()
      for (const message of messages) {
        if (message.source?.kind !== 'user') continue
        for (const part of message.content) {
          if (part.type !== 'text') continue
          for (const match of part.text.matchAll(/(?:^|\s)\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?=\s|$)/g)) {
            try { load(match[1]!) } catch { return { kind: 'reject' as const } }
          }
        }
      }
      return next()
    }))
  } catch (error) {
    disposers.reverse().forEach(dispose => dispose())
    throw error
  }
  return () => disposers.reverse().forEach(dispose => dispose())
}
