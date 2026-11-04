/** Restricted DSH execution adapter for a project's discussion coordinator. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { realpath, readFile, stat } from 'node:fs/promises'
import { relative, resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { Project } from '../core/index.ts'
import { AgentDelivery } from './delivery.ts'
import { initializeRoleModel } from './role-models.ts'
import type { Store } from './store.ts'
import { ConversationStore } from './conversation-store.ts'
import { projectTools, type ProjectToolsHost } from './tools/main.ts'
import { SkillCatalog } from './skill-catalog.ts'
import { bindManagedSkills, recordSkillLoad, type ManagedSkillSnapshot, type SkillLoadRecord } from './managed-skills.ts'
import { managedSkillTools } from './tools/managed-skill.ts'
import { plainJsonSchema } from './tools/tool.ts'

export const PROJECT_PRESET = 'dsh-superagent-project'
const SKILL_INJECTION_TIMEOUT_MS = 3_000
export interface ProjectSessionMapping { sessionId: string; workspaceId: string; cwd: string; generation: number }
export interface ProjectSessionReply { text: string; sessionId: string; turn: number; dshMessageId: string }
/** A native input was consumed, but no completed turn exists to reconcile. */
export class ProjectSessionInterrupted extends Error {
  readonly code = 'project-session/interrupted' as const
  constructor(readonly requestId: string) { super(`Coordinator input ${requestId} was consumed without a completed turn; retry requires Session reconciliation`) }
}

/** Each adapter exposes only project records and small reads inside its verified working directory. */
export class ProjectSessions {
  private readonly delivery: AgentDelivery
  private readonly bindings = new Map<Agent, (() => void)[]>()
  private readonly skillBindings = new Map<string, { agent: Agent; fiber: ReturnType<Context['inject']>; child: Context; dispose: () => void }>()
  private readonly prompts = new Map<Agent, () => void>()
  private disposed = false
  constructor(private readonly ctx: Context, private readonly store: Store, private readonly signal: AbortSignal, private readonly skillCatalog?: SkillCatalog, private readonly authorizeSkills?: (mapping: ProjectSessionMapping, projectId: string) => void) {
    this.delivery = new AgentDelivery(ctx)
  }
  async prepare(project: Project, mapping: ProjectSessionMapping): Promise<Agent> {
    const check = () => {
      this.signal.throwIfAborted()
      if (this.disposed) throw new Error('Project Sessions are disposed')
      const current = new ConversationStore(this.store).currentMapping(project.id)
      if (!current || current.sessionId !== mapping.sessionId || current.generation !== mapping.generation || current.cwd !== mapping.cwd || current.workspaceId !== mapping.workspaceId) {
        throw new Error('Stale project coordinator mapping')
      }
    }
    check()
    const cwd = await realpath(mapping.cwd)
    check()
    if (cwd !== mapping.cwd || !(await stat(cwd)).isDirectory()) throw new Error('Project coordinator directory changed; reconciliation is required')
    check()
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(mapping.workspaceId))
    if (!workspace || workspace.path !== cwd) throw new Error('Project coordinator workspace does not match its saved mapping')
    let result = await this.ctx.sessionController.resolveAgent(SessionId(mapping.sessionId))
    check()
    if ('error' in result && result.error.code === 'session/not-found') {
      await this.ctx.sessionController.create({ sessionId: SessionId(mapping.sessionId), workspaceId: workspace.id, agentPreset: PROJECT_PRESET })
      check()
      result = await this.ctx.sessionController.resolveAgent(SessionId(mapping.sessionId))
      check()
    }
    if ('error' in result) throw result.error
    const agent = result.agent
    if (agent.id !== mapping.sessionId || !agent.session.header.cwd || await realpath(agent.session.header.cwd) !== cwd || !workspace.sessionIds.includes(agent.id)) {
      throw new Error('Project coordinator Session has a different workspace or cwd; reconciliation is required')
    }
    check()
    await initializeRoleModel(this.ctx, agent, this.store.settings().eval.model)
    check()
    if (!this.bindings.has(agent)) {
      const dispose: (() => void)[] = []
      this.bindings.set(agent, dispose)
      dispose.push(agent.ctx.tools.restrict({ allow: [] }))
      // Custom registrations remain available despite the inherited-tool restriction.
      const schema = z.object({ path: z.string().max(1024) })
      dispose.push(agent.ctx.tools.register({ name: 'project_read_file', description: 'Read up to 16000 characters of a UTF-8 file inside this project workspace. No writes or shell access.',
        parameters: plainJsonSchema(schema), output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async args => {
          check()
          const { path } = schema.parse(args)
          const target = await realpath(resolve(cwd, path)), within = relative(cwd, target)
          if (within === '..' || within.startsWith('../') || isAbsolute(within)) throw new Error('File is outside this project workspace')
          const info = await stat(target)
          if (!info.isFile() || info.size > 64_000) throw new Error('Only small project text files can be read')
          const text = (await readFile(target, 'utf8')).slice(0, 16_000)
          check()
          return { path: within, text }
        } }))
    }
    await this.releaseSkills(agent.id)
    const catalog = this.skillCatalog
    if (catalog) {
      const candidates = catalog.candidates({ projectId: project.id, role: 'coordinator', stage: 'planning' }), snapshots: ManagedSkillSnapshot[] = candidates.map(candidate => { const pin = catalog.pin([candidate])[0]; if (!pin) throw new Error('Skill candidate could not be pinned'); return { candidate, pin } })
      if (snapshots.length) {
        const authorizeSkills = () => { check(); if (!this.authorizeSkills) throw new Error('Coordinator has no active skill lease'); this.authorizeSkills(mapping, project.id); return { projectId: project.id, role: 'coordinator' as const, stage: 'planning' as const, resources: [], tools: [] } }
        const recordLoad = (value: { id: string; name: string; version: string; bodyHash: string; offset: number; nextOffset: number | null }) => {
          const loads = this.store.get<SkillLoadRecord[]>(`t7.skill-loads:${project.id}:${mapping.generation}` as never) ?? []
          if (recordSkillLoad(loads, value, new Date().toISOString())) this.store.set(`t7.skill-loads:${project.id}:${mapping.generation}` as never, loads)
        }
        const binding = await this.bindSkillScope(agent, scope => {
          check()
          const disposers: (() => void)[] = []
          try {
            // The injected callback's child context owns the required skills service; the parent never becomes readable.
            disposers.push(bindManagedSkills(agent, catalog, snapshots, authorizeSkills, scope.skills, recordLoad))
            for (const item of managedSkillTools({ catalog, snapshots, authorize: authorizeSkills, onLoaded: recordLoad })) disposers.push(scope.tools.register({ name: item.name, description: item.description,
              parameters: plainJsonSchema(item.schema), output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async args => item.execute(item.schema.parse(args), this.signal) }))
          } catch (error) {
            disposers.reverse().forEach(dispose => dispose())
            throw error
          }
          return () => disposers.reverse().forEach(dispose => dispose())
        })
        try { check() } catch (error) {
          try { binding.dispose() } catch (cause) { this.logSkillDisposal(cause) }
          await binding.fiber.dispose().catch(cause => this.logSkillDisposal(cause))
          throw error
        }
        this.skillBindings.set(agent.id, { agent, ...binding })
      }
    }
    return agent
  }
  /** Install project model tools for exactly one fenced turn. */
  installProjectTools(agent: Agent, host: ProjectToolsHost): () => void {
    const disposers = projectTools(host).map(item => agent.ctx.tools.register({ name: item.name, description: item.description,
      parameters: plainJsonSchema(item.schema), output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async args => item.execute(item.schema.parse(args), this.signal) }))
    return () => disposers.forEach(dispose => dispose())
  }
  /** Apply the durable input's prompt snapshot only at an idle, pre-turn checkpoint. */
  checkpoint(agent: Agent, text: string): void {
    this.signal.throwIfAborted()
    if (this.disposed) throw new Error('Project Sessions are disposed')
    if (agent.status !== 'idle') throw new Error('Project prompt checkpoint requires an idle Session')
    this.prompts.get(agent)?.()
    this.prompts.set(agent, agent.ctx.systemPrompt.section({ name: 'project-coordinator', order: 9999, interpolate: false, complete: true, text }))
  }
  /** Reconcile the durable turn for an input; never infer completion from a draft or idle alone. */
  completed(events: readonly SessionEvent[], requestId: string): ProjectSessionReply | undefined {
    const id = `dsh-superagent:${requestId}`
    const index = events.findIndex(event => event.type === 'user/message' && event.data.id === id)
    if (index < 0) return undefined
    const start = events.slice(0, index + 1).findLast(event => event.type === 'turn/start')
    if (!start || start.type !== 'turn/start') return undefined
    const turn = start.data.turn
    const end = events.slice(index + 1).find(event => event.type === 'turn/end' && event.data.turn === turn)
    if (!end || end.type !== 'turn/end') return undefined
    if (end.data.reason.kind !== 'completed') throw new Error(`Coordinator turn ${end.data.reason.kind}; retry is available`)
    const messages = events.slice(index + 1).filter(event => event.type === 'assistant/message' && event.data.turn === turn && !event.data.interrupted)
    const last = messages.at(-1)
    if (!last || last.type !== 'assistant/message') throw new Error('Coordinator completed without a reply')
    const text = last.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    if (!text.trim()) throw new Error('Coordinator completed without a visible reply')
    return { text, sessionId: '', turn: turn, dshMessageId: String(last.data.message.id) }
  }
  /** Wake a durable pending message without creating a second message identity. */
  private wakePending(agent: Agent, requestId: string, authorize?: () => void): boolean {
    const id = `dsh-superagent:${requestId}`
    const turnIndex = agent.inbox.nextTurn.findIndex(message => String(message.id) === id)
    const stepIndex = agent.inbox.nextStep.findIndex(message => String(message.id) === id)
    const target = turnIndex >= 0 ? 'next-turn' as const : stepIndex >= 0 ? 'next-step' as const : undefined
    if (!target || agent.status !== 'idle') return false
    authorize?.()
    const message = target === 'next-turn' ? agent.inbox.nextTurn[turnIndex] : agent.inbox.nextStep[stepIndex]
    if (!message) return false
    // Move the existing durable item out and submit that same object with wakeup.
    // Both operations are synchronous, so no await can observe a missing item.
    agent.inbox.remove(message.id)
    agent.send(message, target, true)
    return true
  }
  async reply(agent: Agent, requestId: string, text: string, authorize?: () => void): Promise<ProjectSessionReply> {
    const check = () => {
      this.signal.throwIfAborted()
      if (this.disposed) throw new Error('Project Sessions are disposed')
      if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Project coordinator was disposed')
      authorize?.()
    }
    check()
    const events = agent.session.snapshotEvents()
    const id = `dsh-superagent:${requestId}`
    const consumed = events.some(event => event.type === 'user/message' && String(event.data.id) === id)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => String(message.id) === id)
    let existing: ProjectSessionReply | undefined
    try { existing = this.completed(events, requestId) } catch (error) {
      if (consumed && !pending && agent.status === 'idle') throw new ProjectSessionInterrupted(requestId)
      throw error
    }
    if (existing) {
      await this.ctx.sessionPersistence.flush()
      check()
      return { ...existing, sessionId: agent.id }
    }
    // A resumed host closes interrupted turns but cannot drive a consumed input
    // again through its public API without duplicating that native user message.
    if (consumed && !pending && agent.status === 'idle') throw new ProjectSessionInterrupted(requestId)
    if (!this.prompts.has(agent)) throw new Error('Project prompt checkpoint is required before delivery')
    await this.delivery.send(agent, requestId, text, 'queue', this.signal, check)
    check()
    this.wakePending(agent, requestId, check)
    await agent.whenIdle()
    check()
    await this.ctx.sessionPersistence.flush()
    check()
    const reply = this.completed(agent.session.snapshotEvents(), requestId)
    if (!reply) throw new Error('Coordinator turn has not completed')
    return { ...reply, sessionId: agent.id }
  }
  /** Start and await one Cordis skill scope, binding only from inside its injected child context. */
  private async bindSkillScope(agent: Agent, bind: (scope: Context) => () => void): Promise<{ fiber: ReturnType<Context['inject']>; child: Context; dispose: () => void }> {
    let child: Context | undefined, dispose: (() => void) | undefined
    // A reload reruns the callback; all callers retain this stable releaser so they release the current registration.
    const release = () => { const current = dispose; dispose = undefined; current?.() }
    const fiber = agent.ctx.inject(['skills'], scope => {
      try { release() } catch (error) { this.logSkillDisposal(error) }
      child = scope
      dispose = bind(scope)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.resolve(fiber), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Coordinator skills capability did not become available; reconciliation is required')), SKILL_INJECTION_TIMEOUT_MS)
      })])
      if (!child || !dispose) throw new Error('Coordinator skills capability is unavailable; reconciliation is required')
    } catch (error) {
      try { release() } catch (cause) { this.logSkillDisposal(cause) }
      await fiber.dispose().catch(cause => this.logSkillDisposal(cause))
      throw error
    } finally { if (timer !== undefined) clearTimeout(timer) }
    return { fiber, child, dispose: release }
  }
  /** Release a coordinator's managed provider, managed tools and injected skill scope before replacing it. */
  private async releaseSkills(sessionId: string): Promise<void> {
    const binding = this.skillBindings.get(sessionId)
    if (!binding) return
    this.skillBindings.delete(sessionId)
    try { binding.dispose() } catch (error) { this.logSkillDisposal(error) }
    try { await binding.fiber.dispose() } catch (error) { this.logSkillDisposal(error) }
  }
  private logSkillDisposal(error: unknown): void {
    try { this.ctx.logger.warn('dsh-superagent could not release a coordinator skill scope: %s', String(error)) } catch { /* logger unavailable */ }
  }
  dispose(): void {
    this.disposed = true
    for (const [agent, disposers] of this.bindings) { agent.cancel({ kind: 'user' }, { keepInbox: true }); disposers.forEach(dispose => dispose()) }
    this.bindings.clear()
    for (const binding of this.skillBindings.values()) {
      try { binding.dispose() } catch (error) { this.logSkillDisposal(error) }
      void binding.fiber.dispose().catch(error => this.logSkillDisposal(error))
    }
    this.skillBindings.clear()
    for (const dispose of this.prompts.values()) dispose()
    this.prompts.clear()
  }
}
