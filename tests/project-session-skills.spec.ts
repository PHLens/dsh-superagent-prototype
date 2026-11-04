/** Coordinators and workers bind managed skills only from the Cordis-injected child scope. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SkillRegistry, type SkillProvider, type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { Store } from '../src/app/store.ts'
import { Projects } from '../src/core/projects.ts'
import { ConversationStore } from '../src/app/conversation-store.ts'
import { SkillCatalog } from '../src/app/skill-catalog.ts'
import { ProjectSessions, type ProjectSessionMapping } from '../src/app/project-session.ts'
import { Sessions } from '../src/app/sessions.ts'
import { Prompts } from '../src/app/prompts.ts'
import { workerFixture } from './fixtures/project-worker.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** A real Cordis service whose registrations retain the fiber that actually called it. */
class RecordingSkills extends SkillRegistry {
  readonly providerFibers: unknown[] = []
  readonly factories: ((control: SkillProviderControl) => SkillProvider)[] = []
  activeProviders = 0
  override registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void {
    this.providerFibers.push(this.ctx.fiber)
    this.factories.push(create)
    const dispose = super.registerProvider(create)
    this.activeProviders++
    return () => { this.activeProviders--; dispose() }
  }
}

it('installs the managed skill provider in the Cordis-injected child, not the parent context', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'project-session-skills-'))); directories.push(directory)
  const store = new Store(join(directory, 'db.sqlite')), projects = new Projects({ repo: store })
  const project = projects.create({ name: 'Coordinator skills', goal: 'Plan a bounded project' })
  const conversations = new ConversationStore(store)
  conversations.claimProject(project.id, 'owner', { newlyCreated: true })
  const catalog = new SkillCatalog(store)
  const planning = catalog.publish({ name: 'planning-guide', version: '1', description: 'Plan carefully', body: '# Plan',
    roles: ['coordinator'], stages: ['planning'], resources: [], tools: [], enabled: true, scope: 'project', projectId: project.id })
  catalog.publish({ name: 'code-only', version: '1', description: 'Code only', body: '# Code',
    roles: ['code'], stages: ['execute'], resources: [], tools: [], enabled: true, scope: 'project', projectId: project.id })
  const sessionId = 'coordinator-session'
  const mapping: ProjectSessionMapping = conversations.saveMapping(project.id, 'owner', { sessionId, workspaceId: 'coordinator-workspace', cwd: directory })

  const root = new Context()
  let skills!: RecordingSkills
  const skillsPlugin = root.plugin({ name: 'recording-skills', apply: ctx => { skills = new RecordingSkills(ctx) } })
  await skillsPlugin
  const agentScope = createScope(root, {})
  const agentCtx = agentScope.ctx
  const tools = new Map<string, { name: string }>()
  agentCtx.reflect.provide('tools', {
    restrict: vi.fn(() => () => {}),
    register: vi.fn((value: { name: string }) => { tools.set(value.name, value); return () => { if (tools.get(value.name) === value) tools.delete(value.name) } }),
  })

  // Wrap the real Cordis inject method only to observe its child scope; the injection itself is unchanged.
  const injectedScopes: Context[] = []
  const inject = agentCtx.inject.bind(agentCtx)
  agentCtx.inject = ((deps: readonly string[], callback: (scope: Context) => void) => inject(deps, scope => {
    injectedScopes.push(scope)
    callback(scope)
  })) as typeof agentCtx.inject

  const authorizations: ProjectSessionMapping[] = []
  const agent = { id: sessionId, status: 'idle', cancel: vi.fn(),
    session: { header: { cwd: directory }, snapshotEvents: () => [], requestHeader: () => undefined, append: vi.fn() }, ctx: agentCtx } as unknown as Agent
  const workspace = { id: 'coordinator-workspace', path: directory, sessionIds: [sessionId] }
  const ctx = {
    on: vi.fn(() => () => {}),
    workspaceRegistry: { get: vi.fn(() => workspace) },
    sessionController: { resolveAgent: vi.fn(async () => ({ agent })) },
    sessionPersistence: { flush: vi.fn(async () => {}) },
    agents: new Map([[sessionId, agent]]),
    logger: { warn: vi.fn() },
  } as unknown as Context
  const sessions = new ProjectSessions(ctx, store, new AbortController().signal, catalog, (value, projectId) => {
    expect(projectId).toBe(project.id); authorizations.push(value)
  })
  try {
    expect(await sessions.prepare(project, mapping)).toBe(agent)
    expect(injectedScopes).toHaveLength(1)
    const child = injectedScopes[0]!
    expect(child !== agentCtx).toBe(true)
    expect(child.fiber !== agentCtx.fiber).toBe(true)
    expect(scopeOf(child) === scopeOf(agentCtx)).toBe(true)
    // The real registry records which Cordis fiber performed the registration.
    expect(skills.providerFibers).toHaveLength(1)
    expect(skills.providerFibers[0] === child.fiber).toBe(true)
    expect(skills.providerFibers[0] !== agentCtx.fiber).toBe(true)
    expect(tools.has('project_read_file')).toBe(true)
    expect(tools.has('project_list_skills')).toBe(true)
    expect(tools.has('project_load_skill')).toBe(true)
    expect(skills.factories).toHaveLength(1)
    const provider = skills.factories[0]!({ signal: new AbortController().signal, invalidate: () => {} })
    const listed = await provider.list({ cwd: directory, signal: new AbortController().signal })
    const candidates = Array.isArray(listed) ? listed : (listed as { candidates: readonly { name: string }[] }).candidates
    expect(candidates.map(item => item.name)).toEqual(['planning-guide'])
    // The provider still loads through the exact pinned/authorized snapshot.
    expect((await provider.get({ name: planning.name } as never, { cwd: directory, signal: new AbortController().signal }))?.content).toBe('# Plan')
    expect(authorizations).toEqual([mapping])

    // A repeated prepare releases the old child and creates a new one; no parent-context provider survives.
    expect(await sessions.prepare(project, mapping)).toBe(agent)
    expect(injectedScopes).toHaveLength(2)
    expect(skills.providerFibers[0] === injectedScopes[0]!.fiber).toBe(true)
    expect(skills.providerFibers[1] === injectedScopes[1]!.fiber).toBe(true)
    expect(skills.activeProviders).toBe(1)

    // An empty planning candidate set succeeds without another injection or direct parent skill read.
    catalog.disable(planning.id)
    expect(await sessions.prepare(project, mapping)).toBe(agent)
    expect(injectedScopes).toHaveLength(2)
    expect(tools.has('project_read_file')).toBe(true)
    expect(tools.has('project_list_skills')).toBe(false)
    expect(tools.has('project_load_skill')).toBe(false)
  } finally {
    sessions.dispose()
    await agentScope.dispose()
    await skillsPlugin.dispose()
  }
})

it('installs a worker managed skill provider in the Cordis-injected child, not the parent context', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'worker-session-skills-'))); directories.push(directory)
  const f = workerFixture(directory), catalog = new SkillCatalog(f.store)
  const published = catalog.publish({ name: 'worker-guide', version: '1', description: 'Worker guide', body: '# Work',
    roles: ['worker'], stages: ['execute'], resources: [], tools: [], enabled: true, scope: 'project', projectId: f.project.id })
  const candidate = catalog.candidates({ projectId: f.project.id, role: 'worker', stage: 'execute' })[0]!
  const pin = catalog.pin([candidate])[0]!
  const attempt = f.prepare()
  attempt.skillSnapshot = [{ candidate, pin }]
  f.attempts.save(attempt)

  const root = new Context()
  let skills!: RecordingSkills
  const skillsPlugin = root.plugin({ name: 'recording-skills', apply: ctx => { skills = new RecordingSkills(ctx) } })
  await skillsPlugin
  const agentScope = createScope(root, {})
  const agentCtx = agentScope.ctx
  const tools = new Map<string, { name: string }>()
  agentCtx.reflect.provide('tools', {
    get: vi.fn(() => undefined),
    restrict: vi.fn(() => () => {}),
    guard: vi.fn(() => () => {}),
    register: vi.fn((value: { name: string }) => { tools.set(value.name, value); return () => { if (tools.get(value.name) === value) tools.delete(value.name) } }),
  })
  agentCtx.reflect.provide('systemPrompt', { section: vi.fn(() => () => {}) })
  expect(() => (agentCtx as unknown as { skills: unknown }).skills).toThrow()

  const injectedScopes: Context[] = []
  const inject = agentCtx.inject.bind(agentCtx)
  agentCtx.inject = ((deps: readonly string[], callback: (scope: Context) => void) => inject(deps, scope => {
    injectedScopes.push(scope)
    callback(scope)
  })) as typeof agentCtx.inject

  const agent = { id: attempt.sessionId, status: 'idle', cancel: vi.fn(),
    session: { header: { cwd: attempt.cwd }, snapshotEvents: () => [], requestHeader: () => undefined, append: vi.fn() }, ctx: agentCtx } as unknown as Agent
  const ctx = {
    on: vi.fn(() => () => {}), agents: new Map([[agent.id, agent]]), logger: { warn: vi.fn() },
  } as unknown as Context
  const prompts = new Prompts(f.store, () => 100_000, () => [], () => false)
  const sessions = new Sessions({ context: ctx, store: f.store, attempts: f.attempts, prompts,
    effects: { handle() {}, enqueue() {}, async idle() {}, pending: () => false },
    health: { get: () => undefined, set() {}, release() {} }, masterId: 'restore-test-main',
    lifetime: new AbortController().signal, closing: () => false, environment: () => [], tools: () => [], skillCatalog: catalog,
    resources: { granted: () => true },
  })
  try {
    await (sessions as unknown as { decorate(agent: Agent): Promise<void> }).decorate(agent)
    expect(injectedScopes).toHaveLength(1)
    const child = injectedScopes[0]!
    expect(child !== agentCtx).toBe(true)
    expect(skills.providerFibers).toHaveLength(1)
    expect(skills.providerFibers[0] === child.fiber).toBe(true)
    expect(skills.providerFibers[0] !== agentCtx.fiber).toBe(true)
    expect(skills.activeProviders).toBe(1)
    expect(tools.has('project_list_skills')).toBe(true)
    expect(tools.has('project_load_skill')).toBe(true)
    const provider = skills.factories[0]!({ signal: new AbortController().signal, invalidate: () => {} })
    const listed = await provider.list({ cwd: attempt.cwd, signal: new AbortController().signal })
    const candidates = Array.isArray(listed) ? listed : (listed as { candidates: readonly { name: string }[] }).candidates
    expect(candidates.map(item => item.name)).toEqual([published.name])
    expect((await provider.get({ name: published.name } as never, { cwd: attempt.cwd, signal: new AbortController().signal }))?.content).toBe('# Work')

    sessions.dispose()
    expect(skills.activeProviders).toBe(0)
    expect(tools.has('project_list_skills')).toBe(false)
  } finally {
    sessions.dispose()
    await agentScope.dispose()
    await skillsPlugin.dispose()
  }
})
