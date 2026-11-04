import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { Delegations } from '../src/app/delegations.ts'
import { SkillCatalog } from '../src/app/skill-catalog.ts'
import { Sessions } from '../src/app/sessions.ts'
import { workerFixture } from './fixtures/project-worker.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('intersects delegated resources and tools with the parent while selecting only role-scoped skills', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-scope-'))); directories.push(directory)
  const f = workerFixture(directory), catalog = new SkillCatalog(f.store)
  catalog.publish({ name: 'research-guide', version: '1', description: 'Research', body: 'research', roles: ['research'], stages: ['execute'],
    resources: ['source'], tools: ['project_read_resource'], enabled: true, scope: 'project', projectId: f.project.id })
  catalog.publish({ name: 'unsafe-guide', version: '1', description: 'Unsafe', body: 'unsafe', roles: ['research'], stages: ['execute'],
    resources: ['outside'], tools: ['bash'], enabled: true, scope: 'project', projectId: f.project.id })
  const scope = catalog.delegationScope({ projectId: f.project.id, parentResources: ['source'], parentTools: ['project_read_resource', 'project_worker_report'],
    role: 'research', stage: 'execute', resources: ['source'], tools: ['project_read_resource'] })
  expect(scope.resources).toEqual(['source']); expect(scope.tools).toEqual(['project_read_resource'])
  expect(scope.skills.map(item => item.candidate.name)).toEqual(['research-guide'])
  expect(() => catalog.delegationScope({ projectId: f.project.id, parentResources: ['source'], parentTools: ['project_read_resource'],
    role: 'research', stage: 'execute', resources: ['outside'] })).toThrow(/exceed the parent grant/)
  expect(() => catalog.delegationScope({ projectId: f.project.id, parentResources: ['source'], parentTools: ['project_read_resource'],
    role: 'research', stage: 'execute', tools: ['bash'] })).toThrow(/exceed the parent grant/)
})

it('installs only the recorded tools for a child and denies an unrecorded child of a managed worker', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-host-scope-'))); directories.push(directory)
  const f = workerFixture(directory), attempt = f.prepare()
  attempt.context = { promptRevision: 1, roleRules: 'rules', projectConventions: '', model: {}, resources: [], skills: [],
    tools: ['project_worker_context', 'web_search', 'bash', 'project_worker_report'] }
  f.attempts.save(attempt)
  const delegations = new Delegations(f.store, f.attempts, new SkillCatalog(f.store))
  const record = delegations.begin(attempt.sessionId, { operationId: 'child', label: 'Research', prompt: 'Read the pinned context only',
    role: 'research', tools: ['project_worker_context'] })
  const agents = new Map<string, Agent>()
  const context = { on: vi.fn(() => () => {}), agents, logger: { warn: vi.fn() } } as unknown as Context
  const sessions = new Sessions({ context, store: f.store, attempts: f.attempts, prompts: {} as never,
    effects: { handle() {}, enqueue() {}, async idle() {}, pending: () => false }, health: { get: () => undefined, set() {}, release() {} },
    masterId: 'main', lifetime: new AbortController().signal, closing: () => false, environment: () => [], tools: () => [], delegations,
  })
  const childContext = (id: string, parentSession: string, origin?: 'subagent') => {
    const restrict = vi.fn(() => () => {}), guard = vi.fn(() => () => {}), register = vi.fn(() => () => {})
    const ctx = { tools: { get: vi.fn(name => ['project_worker_context', 'web_search', 'bash', 'project_worker_report'].includes(name) ? { name } : undefined),
      restrict, guard, register }, systemPrompt: { section: vi.fn(() => () => {}) }, logger: { warn: vi.fn() } }
    return { id, ctx, status: 'running', session: { header: { parentSession, origin }, snapshotEvents: () => [], requestHeader: () => undefined, append: vi.fn() } } as unknown as Agent
  }
  try {
    const child = childContext(record.childSessionId, attempt.sessionId)
    agents.set(child.id, child)
    await (sessions as unknown as { decorate(agent: Agent): Promise<void> }).decorate(child)
    expect(child.ctx.tools.restrict).toHaveBeenCalledWith({ allow: ['project_worker_context'] })
    expect(child.ctx.tools.guard).toHaveBeenCalled()
    expect(child.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ name: 'project-delegation', complete: true,
      text: expect.stringContaining('temporary, server-authorized child') }))

    agents.delete(record.childSessionId)
    const nested = childContext('unrecorded-nested-child', record.childSessionId, 'subagent')
    agents.set(nested.id, nested)
    await (sessions as unknown as { decorate(agent: Agent): Promise<void> }).decorate(nested)
    expect(nested.ctx.tools.restrict).toHaveBeenCalledWith({ allow: [] })

    const unknown = childContext('unknown-ancestry-child', 'missing-parent', 'subagent')
    agents.set(unknown.id, unknown)
    await (sessions as unknown as { decorate(agent: Agent): Promise<void> }).decorate(unknown)
    expect(unknown.ctx.tools.restrict).toHaveBeenCalledWith({ allow: [] })
    expect(unknown.ctx.tools.guard).toHaveBeenCalledWith(expect.any(Function))
  } finally { sessions.dispose(); f.store.close() }
})

it('charges a recorded child model stream to the parent project budget', async () => {
  const h: Host = await startRuntime()
  try {
    const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Budgeted child', goal: 'Use a bounded child' })
    c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Use a bounded child for the note' })
    const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'plan', plan: {
      goal: 'A checked note', scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed worker', cost: 'One worker', completion: 'A note',
      acceptance: { version: 1, mode: 'registered-files' },
    } })
    c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'confirm', text: '按这个方案做' })
    c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
    h.runtime.executor.dispatchProjects()
    await waitUntil(() => c.attempts.all().some(item => item.status === 'running'))
    const parent = c.attempts.all().find(item => item.status === 'running')!
    const child = c.delegations.begin(parent.sessionId, { operationId: 'budget-child', label: 'Budgeted review', prompt: 'Review the pinned context',
      role: 'research' })
    ;(h.agents as unknown as { currentInitiator: () => { id: string } | undefined }).currentInitiator = () => ({ id: child.childSessionId })
    let seen: ReturnType<typeof h.runtime.scheduler.status> = []
    const stream = (h.ctx as any).waterfall(h.ctx.llm, 'llm/stream', { signal: new AbortController().signal }, async function* () {
      seen = h.runtime.scheduler.status(); yield 'child result'
    }) as unknown as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: 'child result', done: false })
    expect(seen).toContainEqual(expect.objectContaining({ id: expect.stringMatching(/^model:/), projectId: project.id,
      ownerId: child.childSessionId, kind: 'model', state: 'running' }))
    expect(await iterator.next()).toMatchObject({ done: true })
    expect(h.runtime.scheduler.status().some(row => row.ownerId === child.childSessionId)).toBe(false)

    const unknownId = 'unrecorded-budget-child'
    ;(h.agents as Map<string, unknown>).set(unknownId, { id: unknownId, status: 'running', session: { header: { parentSession: parent.sessionId } } })
    ;(h.agents as unknown as { currentInitiator: () => { id: string } | undefined }).currentInitiator = () => ({ id: unknownId })
    const unknown = (h.ctx as any).waterfall(h.ctx.llm, 'llm/stream', { signal: new AbortController().signal }, async function* () { yield 'must not run' })
    await expect(unknown[Symbol.asyncIterator]().next()).rejects.toThrow(/no recorded delegation budget owner/)
    ;(h.agents as Map<string, unknown>).set('unknown-ancestor-child', { id: 'unknown-ancestor-child', status: 'running',
      session: { header: { parentSession: 'missing-parent', origin: 'subagent' } } })
    ;(h.agents as unknown as { currentInitiator: () => { id: string } | undefined }).currentInitiator = () => ({ id: 'unknown-ancestor-child' })
    const unknownAncestor = (h.ctx as any).waterfall(h.ctx.llm, 'llm/stream', { signal: new AbortController().signal }, async function* () { yield 'must not run' })
    await expect(unknownAncestor[Symbol.asyncIterator]().next()).rejects.toThrow(/unknown or has no recorded delegation budget owner/)
  } finally { await h.stop() }
})

it('reapplies a processed delegation gate during deterministic project dispatch after the callback is lost', async () => {
  const h = await startRuntime()
  try {
    const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Recovered gate', goal: 'Finish after a lost callback' })
    c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Write the note' })
    const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'plan', plan: {
      goal: 'A checked note', scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed worker', cost: 'One worker', completion: 'A note',
      acceptance: { version: 1, mode: 'registered-files' },
    } })
    c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'confirm', text: '按这个方案做' })
    c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
    h.runtime.executor.dispatchProjects()
    await waitUntil(() => c.attempts.all().some(item => item.status === 'running'))
    const attempt = c.attempts.all().find(item => item.status === 'running')!
    const child = c.delegations.begin(attempt.sessionId, { operationId: 'review', label: 'Review', prompt: 'Review the note', role: 'research' })
    c.delegations.finish(child.childSessionId, { stopReason: 'completed', output: [{ type: 'text', text: 'Review complete' }] })
    const artifact = c.artifacts.write(attempt.sessionId, { operationId: 'note', output: 'note', name: 'note.md', content: '# Checked' })
    c.reports.submit(attempt.sessionId, { operationId: 'ready', state: 'ready', completed: 'Wrote the checked note', evidence: ['Read the files'],
      artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
    expect(h.runtime.store.tickets.get(plan.ticketId)?.assignments[0]?.waitingReason).toBe('delegation-pending')
    h.agents.get(attempt.sessionId)!.status = 'idle'
    h.runtime.executor.dispatchProjects()
    await waitUntil(() => h.deliveries.mock.calls.some(([call]) => call.sessionId === attempt.sessionId && call.text.includes('Required local delegation results are recorded')))

    // A different service instance leaves the ProjectCoordinator's callback unobserved, as if the process died after commit.
    new Delegations(h.runtime.store, c.attempts, c.skills).process(attempt.sessionId, child.childSessionId, 'consume-review')
    expect(h.runtime.store.tickets.get(plan.ticketId)?.ended).toBeUndefined()
    h.runtime.executor.dispatchProjects()
    expect(h.runtime.store.tickets.get(plan.ticketId)?.ended?.outcome).toBe('completed')
    expect(await h.runGuardedTool(attempt.sessionId, 'project_process_delegation', { child_session_id: child.childSessionId, operation_id: 'consume-review' }))
      .toMatchObject({ resultProcessing: 'processed', result: { text: 'Review complete' } })
  } finally { await h.stop() }
})
