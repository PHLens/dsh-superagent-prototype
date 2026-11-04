/** Actual Runtime/Sessions decoration and registered guard/tool callbacks in the in-memory DSH fixture. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { Commands } from '../src/infra/commands.ts'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { Store } from '../src/app/store.ts'
import { Sessions } from '../src/app/sessions.ts'
import { Prompts, PROJECT_WORKER_RULES } from '../src/app/prompts.ts'
import { ExecutionAttempts, type Attempt } from '../src/app/execution-attempts.ts'
import { ArtifactStore } from '../src/app/artifact-store.ts'
import { ReportAcceptance } from '../src/app/report-acceptance.ts'
import { projectWorkerTools } from '../src/app/tools/executor.ts'
import { ProjectPlans } from '../src/app/project-plans.ts'
import { Projects } from '../src/core/projects.ts'
import { key, type Ticket } from '../src/core/index.ts'
import { workerFixture } from './fixtures/project-worker.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { commentTrigger } from '../src/sources/github-trigger.ts'
import { githubFollowId, githubNamespaceOf, githubThreadId } from '../src/sources/github-namespace.ts'
import { ProjectEvents } from '../src/app/events.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
function confirmTask(label: string) {
  const coordinator = h.runtime.projectCoordinator
  const project = coordinator.create('owner', { name: label, goal: 'One file without GitHub' })
  coordinator.conversations.appendUser(project.id, 'owner', { clientRequestKey: `original-${label}`, text: 'Write a Markdown note' })
  const plan = coordinator.plans.save('owner', project.id, { expectedRevision: 0, operationId: `plan-${label}`, plan: {
    goal: label, scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed file worker', cost: 'One worker', completion: 'Nonempty file', acceptance: { version: 1, mode: 'registered-files' },
  } })
  coordinator.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: `confirm-${label}`, intent: 'execute' })
  return { project, plan }
}
const running = () => h.runtime.projectCoordinator.attempts.all().filter(item => item.status === 'running')

function workerSessions(store: Store, attempts: ExecutionAttempts) {
  const prompts = new Prompts(store, () => 100_000, () => [], () => false)
  const artifacts = new ArtifactStore(store, attempts), reports = new ReportAcceptance(store, attempts, artifacts)
  const sessions = new Sessions({ context: h.ctx, store, attempts, prompts,
    effects: { handle() {}, enqueue() {}, async idle() {}, pending: () => false },
    health: { get: () => undefined, set() {}, release() {} }, masterId: 'restore-test-main',
    lifetime: new AbortController().signal, closing: () => false, environment: () => [],
    tools: agent => projectWorkerTools(attempts, artifacts, reports, agent.id),
  })
  return { sessions, prompts }
}
function nativeSession(attempt: Attempt, seed: ReturnType<Session['snapshotEvents']> = []) {
  const id = SessionId(attempt.sessionId)
  return Session.create(id, seed, { ...Session.create(id).header, cwd: attempt.cwd })
}
async function nativeWorker(attempt: Attempt, attempts: ExecutionAttempts, seed: ReturnType<Session['snapshotEvents']> = []) {
  const workspace = await h.ctx.workspaceRegistry.create(attempt.cwd)
  const saved = attempts.bySession(attempt.sessionId)!
  if (!saved.workspaceId) { saved.workspaceId = workspace.id; attempts.save(saved) }
  else expect(saved.workspaceId).toBe(workspace.id)
  await h.controller.create({ sessionId: attempt.sessionId, workspaceId: workspace.id })
  const agent = h.agents.get(attempt.sessionId) as unknown as Agent
  Object.defineProperty(agent, 'session', { value: nativeSession(attempt, seed), configurable: true })
  const section = vi.spyOn(agent.ctx.systemPrompt, 'section')
  return { agent, section }
}

it('reinstalls persisted instructions, revision and capabilities after Store close/reopen while fresh attempts use new settings', async () => {
  const directory = mkdtempSync(join(h.directory, 'restore-')), f = workerFixture(directory)
  const attempt = f.prepare(), oldModel = { provider: 'old-provider', model: 'old-model' }
  const pinned = { promptRevision: 7, roleRules: 'Pinned role rules v1: check sources.', projectConventions: 'Use the saved project citation convention.',
    model: oldModel, tools: ['project_worker_context', 'project_worker_report'], resources: [], skills: [] }
  attempt.context = pinned; attempt.workspaceId = (await h.ctx.workspaceRegistry.create(attempt.cwd)).id; f.attempts.save(attempt)
  const original = nativeSession(attempt)
  original.append('request/header', { header: { config: oldModel }, reason: 'initial' })
  const journal = join(directory, 'native-events.json')
  writeFileSync(journal, JSON.stringify(original.snapshotEvents()))
  const before = workerSessions(f.store, f.attempts)
  for (let i = 0; i < 7; i++) before.prompts.save(before.prompts.current().config, i, 'panel')
  before.sessions.dispose(); f.store.close()

  const store = new Store(join(directory, 'project.sqlite')), attempts = new ExecutionAttempts(store, directory)
  const { sessions, prompts } = workerSessions(store, attempts)
  try {
    prompts.save(prompts.current().config, 7, 'panel')
    const settings = store.settings(), newModel = { provider: 'new-provider', model: 'new-global' }
    store.saveSettings({ ...settings, executor: { ...settings.executor, model: newModel } })
    const { agent, section } = await nativeWorker(attempt, attempts, JSON.parse(readFileSync(journal, 'utf8')))
    // A newly available inherited tool must not enlarge this execution's saved capability range.
    vi.spyOn(agent.ctx.tools, 'get').mockImplementation(name => name === 'web_fetch' ? { name } as never : undefined)
    const resolve = vi.spyOn(h.ctx.llm, 'resolveCallConfig'); resolve.mockClear()
    await sessions.ensure(attempt.sessionId, attempt.cwd, 'Restored worker', 'worker')
    expect(attempts.bySession(attempt.sessionId)?.context).toEqual(pinned)
    expect(resolve).not.toHaveBeenCalled()
    expect(agent.session.requestHeader()?.config).toEqual(oldModel)
    const installed = section.mock.calls.find(([value]) => value.name === 'project-worker')![0]
    expect(installed.text).toContain(pinned.roleRules)
    expect(installed.text).toContain(pinned.projectConventions)
    expect(installed.text).toContain('prompt revision 7')
    expect(installed.text).not.toContain(PROJECT_WORKER_RULES)
    expect([...h.tools.get(attempt.sessionId)!.keys()]).toEqual(pinned.tools)
    expect(agent.ctx.tools.restrict).toHaveBeenLastCalledWith({ allow: [] })
    expect(await h.runGuardedTool(attempt.sessionId, 'project_worker_context', {})).toMatchObject({ context: pinned })
    await expect(h.runGuardedTool(attempt.sessionId, 'web_fetch', {})).rejects.toThrow(/no registered project worker contract/)
    await expect(h.runGuardedTool(attempt.sessionId, 'project_write_artifact', {})).rejects.toThrow(/no registered project worker contract/)

    const plans = new ProjectPlans(store, new Projects({ repo: store }))
    plans.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'fresh', text: '再运行一次' })
    const next = plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: f.plan.ticketId, planRevision: 1, operationId: 'fresh', intent: 'rerun' })
    const fresh = attempts.prepare(attempts.allocate(next.ticket, next.assignment)), freshNative = await nativeWorker(fresh, attempts)
    await sessions.ensure(fresh.sessionId, fresh.cwd, 'Fresh worker', 'worker')
    expect(attempts.bySession(fresh.sessionId)?.context).toMatchObject({ promptRevision: 8, roleRules: PROJECT_WORKER_RULES, model: newModel })
    expect(freshNative.section.mock.calls.find(([value]) => value.name === 'project-worker')![0].text).toContain(PROJECT_WORKER_RULES)
    expect(freshNative.agent.session.snapshotEvents()).toContainEqual(expect.objectContaining({ type: 'model/selection', data: newModel }))
    expect(attempts.bySession(attempt.sessionId)?.context).toEqual(pinned)
  } finally { sessions.dispose(); store.close() }
})

it.each(['tool', 'inherited', 'skill', 'version', 'resources', 'rules', 'missing', 'missing-header'] as const)('requires reconciliation instead of replacing unrestorable pinned %s scope', async kind => {
  const directory = mkdtempSync(join(h.directory, 'unrestorable-')), f = workerFixture(directory)
  const attempt = f.prepare()
  attempt.context = { promptRevision: 7, roleRules: kind === 'rules' ? '' : 'Saved rules', projectConventions: 'Saved conventions', model: null,
    tools: kind === 'tool' ? ['retired_tool'] : kind === 'inherited' ? ['web_fetch'] : ['project_worker_context'], resources: kind === 'resources' ? ['unapproved-resource'] : [], skills: kind === 'skill' ? [{ name: 'retired_skill', version: 'v1' }] : [],
    ...(kind === 'version' ? { toolContractVersion: 99 } : {}) }
  if (kind.startsWith('missing')) { delete attempt.context; if (kind === 'missing') attempt.status = 'running' }
  f.attempts.save(attempt)
  const pinned = structuredClone(attempt.context), { agent, section } = await nativeWorker(attempt, f.attempts)
  if (kind === 'missing-header') agent.session.append('request/header', { header: { config: { provider: 'old', model: 'old' } }, reason: 'initial' })
  const { sessions } = workerSessions(f.store, f.attempts)
  try {
    await expect(sessions.ensure(attempt.sessionId, attempt.cwd, 'Unrestorable worker', 'worker')).rejects.toThrow(/reconciliation.*(tool|skill|version|snapshot|resource|instruction)/i)
    const saved = f.attempts.bySession(attempt.sessionId)!
    expect(saved).toMatchObject({ status: 'reconcile', error: expect.stringMatching(/reconciliation/i) })
    expect(saved.context).toEqual(pinned)
    expect(section).not.toHaveBeenCalled()
    expect(h.tools.get(attempt.sessionId)?.size).toBe(0)
    expect(agent.ctx.tools.restrict).toHaveBeenCalledWith({ allow: [] })
    await expect(h.runGuardedTool(attempt.sessionId, 'web_fetch', {})).rejects.toThrow(/reconciliation/i)
  } finally { sessions.dispose(); f.store.close() }
})

it('stops the actual project Session through POST while retaining its slot until the Agent becomes idle', async () => {
  const { plan } = confirmTask('stop-actual')
  h.runtime.executor.dispatchProjects(); await waitUntil(() => running().length === 1)
  const attempt = running()[0]!, agent = h.agents.get(attempt.sessionId)!
  agent.cancel.mockImplementation(() => {}) // Cancellation requested; the native turn has not drained yet.
  expect(await h.api('POST', `tickets/${plan.ticketId}/stop`)).toMatchObject({ status: 200, body: { stopped: true } })
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  expect(h.runtime.projectCoordinator.attempts.bySession(attempt.sessionId)?.status).toBe('running')
  expect(h.runtime.executor.activeCount()).toBe(1)
  h.runtime.executor.dispatchProjects()
  await expect(h.runGuardedTool(attempt.sessionId, 'project_worker_context', {})).rejects.toThrow(/unauthorized/)
  await expect(h.runGuardedTool(attempt.sessionId, 'project_write_artifact', { operation_id: 'late', output: 'note', name: 'late.md', content: 'late' })).rejects.toThrow(/unauthorized/)
  await expect(h.runGuardedTool(attempt.sessionId, 'project_worker_report', { operation_id: 'late', state: 'ready', completed: 'late', evidence: ['late'], artifacts: [], unresolved: [] })).rejects.toThrow(/unauthorized/)
  agent.status = 'idle'
  await waitUntil(() => h.runtime.projectCoordinator.attempts.bySession(attempt.sessionId)?.status === 'ended')
})

it('holds a paused project until native idle and resumes the same prepared execution', async () => {
  const { plan, project } = confirmTask('pause-resume-native')
  h.runtime.executor.dispatchProjects(); await waitUntil(() => running().length === 1)
  const attempt = running()[0]!, agent = h.agents.get(attempt.sessionId)!
  await h.runGuardedTool(attempt.sessionId, 'project_write_artifact', { operation_id: 'checkpoint-file', output: 'note', name: 'checkpoint.md', content: 'Saved before pause' })
  const file = h.runtime.projectCoordinator.artifacts.list(project.id, plan.ticketId)[0]!
  agent.cancel.mockImplementation(() => {})
  h.runtime.engine.pauseTicket(plan.ticketId)
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => agent.cancel.mock.calls.length > 0)
  expect(h.runtime.store.tickets.get(plan.ticketId)?.lifecycle?.pause.state).toBe('pausing')
  await expect(h.runGuardedTool(attempt.sessionId, 'project_worker_context', {})).rejects.toThrow(/unauthorized/)
  agent.status = 'idle'
  await waitUntil(() => h.runtime.store.tickets.get(plan.ticketId)?.lifecycle?.pause.state === 'paused')
  expect(h.runtime.store.tickets.get(plan.ticketId)?.lifecycle?.checkpoint?.files).toEqual([file.path])
  h.runtime.executor.dispatchProjects()
  expect(h.runtime.projectCoordinator.attempts.all()).toHaveLength(1)
  h.runtime.engine.resumeTicket(plan.ticketId)
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => agent.status === 'running')
  expect(h.runtime.projectCoordinator.attempts.all()).toHaveLength(1)
  expect(h.runtime.projectCoordinator.attempts.bySession(attempt.sessionId)?.cwd).toBe(attempt.cwd)
  agent.status = 'idle'
})

it('does not dispatch a project whose pause or stop intent precedes its first worker', async () => {
  const paused = confirmTask('pause-before-launch'), stopped = confirmTask('stop-before-launch')
  h.runtime.engine.pauseTicket(paused.plan.ticketId)
  h.runtime.engine.stopTicket(stopped.plan.ticketId)
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => h.runtime.store.tickets.get(paused.plan.ticketId)?.lifecycle?.pause.state === 'paused')
  await waitUntil(() => h.runtime.store.tickets.get(stopped.plan.ticketId)?.lifecycle?.stop.state === 'exited')
  expect(h.runtime.projectCoordinator.attempts.all()).toHaveLength(0)
  expect(h.runtime.store.tickets.get(stopped.plan.ticketId)?.ended?.outcome).toBe('stopped')
})

it('never cancels on stop rollback or follows a managed mapping belonging to another Ticket', async () => {
  const { plan } = confirmTask('stop-rollback')
  h.runtime.executor.dispatchProjects(); await waitUntil(() => running().length === 1)
  const attempt = running()[0]!, agent = h.agents.get(attempt.sessionId)!, attempts = h.runtime.projectCoordinator.attempts
  expect(() => h.runtime.store.atomic(() => { h.runtime.engine.stopTicket(plan.ticketId); throw new Error('rollback stop') })).toThrow('rollback stop')
  expect(agent.cancel).not.toHaveBeenCalled()
  expect(h.runtime.store.tickets.get(plan.ticketId)?.ended).toBeUndefined()
  attempts.save({ ...attempt, ticketId: 'another-ticket' })
  expect(await h.api('POST', `tickets/${plan.ticketId}/stop`)).toMatchObject({ status: 200 })
  expect(agent.cancel).not.toHaveBeenCalled()
  attempts.save(attempt)
})

it('cancels each matching unended Assignment Session when a project Ticket has more than one', async () => {
  const { plan, project } = confirmTask('stop-multiple'), c = h.runtime.projectCoordinator
  h.runtime.executor.dispatchProjects(); await waitUntil(() => running().length === 1)
  const first = running()[0]!
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'stop-rerun', text: '再运行一次' })
  const confirmed = c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'stop-rerun', intent: 'rerun' })
  const second = c.attempts.prepare(c.attempts.allocate(confirmed.ticket, confirmed.assignment))
  await nativeWorker(second, c.attempts)
  h.agents.get(second.sessionId)!.status = 'running'; second.status = 'running'; c.attempts.save({ ...c.attempts.bySession(second.sessionId)!, status: 'running' })
  expect(await h.api('POST', `tickets/${plan.ticketId}/stop`)).toMatchObject({ status: 200 })
  for (const attempt of [first, second]) expect(h.agents.get(attempt.sessionId)!.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  await waitUntil(() => [first, second].every(item => c.attempts.bySession(item.sessionId)?.status === 'ended'))
})

it('accepts exact report and artifact receipts through the registered tool guard after completion but rejects new writes', async () => {
  const { plan } = confirmTask('receipt')
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => running().length === 1)
  const attempt = running()[0]!, sessionId = attempt.sessionId
  const artifactInput = { operation_id: 'file', output: 'note', name: 'note.md', content: '# Note\nSource checked.' }
  const artifact = await h.runGuardedTool(sessionId, 'project_write_artifact', artifactInput)
  const input = { operation_id: 'report', state: 'ready', completed: 'Wrote note', evidence: ['Registered and checked file'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] }
  const receipt = await h.runGuardedTool(sessionId, 'project_worker_report', input)
  expect(receipt.received).toBe(true)
  expect(h.runtime.store.tickets.get(plan.ticketId)?.ended?.outcome).toBe('completed')
  // Simulated lost responses: invoke the same registered native guard + tool path again.
  expect(await h.runGuardedTool(sessionId, 'project_worker_report', input)).toEqual(receipt)
  expect(await h.runGuardedTool(sessionId, 'project_write_artifact', artifactInput)).toEqual(artifact)
  await expect(h.runGuardedTool(sessionId, 'project_worker_report', { ...input, operation_id: 'new' })).rejects.toThrow(/unauthorized/)
  await expect(h.runGuardedTool(sessionId, 'project_worker_report', { ...input, completed: 'Changed payload' })).rejects.toThrow(/conflict/)
  await expect(h.runGuardedTool(sessionId, 'project_write_artifact', { ...artifactInput, operation_id: 'new-file' })).rejects.toThrow(/unauthorized/)
  await expect(h.runGuardedTool(sessionId, 'project_write_artifact', { ...artifactInput, content: 'Changed bytes' })).rejects.toThrow(/conflict/)
  await expect(h.runGuardedTool(sessionId, 'project_worker_context', {})).rejects.toThrow(/unauthorized/)
  await expect(h.runGuardedTool(sessionId, 'subagent', {})).rejects.toThrow()
})

it('uses registered repository scope and namespaced receipt ids for terminal PR notices', () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Terminal notice scope', goal: 'Keep PR notices exact' })
  const resource = (repository: string, label: string) => {
    const item = c.resources.register({ projectId: project.id, type: 'repository', path: h.directory, purpose: label, maxBytes: 64_000 })
    c.identities.register({ projectId: project.id, resourceId: item.id, repository, accountId: 'agent', accountCli: '/bin/false', gitAuthorName: 'Agent', gitAuthorEmail: 'agent@example.com' })
    return { item, namespace: githubNamespaceOf({ projectId: project.id, repositoryId: item.id, accountId: 'agent', repository })! }
  }
  const a = resource('owner/a', 'repo-a'), b = resource('owner/b', 'repo-b'), channel = { source: 'feishu' as const, thread: 'feishu:oc_notice', address: { chatId: 'oc_notice', direct: 'true' } }
  const open = (id: string, namespace: ReturnType<typeof githubNamespaceOf>): Ticket => ({ id, projectId: project.id, projectStage: 'confirmed', title: id, decisionId: `d-${id}`,
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'owner' }, scope: '' }, channels: [channel], assignments: [], inputs: [], undelivered: [],
    follows: [{ thread: githubFollowId(namespace, 41), own: true }], origin: { triggerId: `missing-${id}`, triggerIds: [] }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
  h.runtime.store.tickets.save(open('notice-a', a.namespace)); h.runtime.store.tickets.save(open('notice-b', b.namespace))
  for (const namespace of [a.namespace, b.namespace]) h.runtime.engine.threadClosed({ source: 'github', id: githubFollowId(namespace, 41).replace('github:', '') }, 'merged', '2026-01-02T00:00:00Z')
  const ids = [a.namespace, b.namespace].map(namespace => key('pr-terminal', githubFollowId(namespace, 41), 'feishu', JSON.stringify(channel.address), 'merged'))
  expect(new Set(ids).size).toBe(2)
  expect(h.runtime.store.receipts.get(ids[0]!)?.text).toContain('https://github.com/owner/a/pull/41')
  expect(h.runtime.store.receipts.get(ids[1]!)?.text).toContain('https://github.com/owner/b/pull/41')
})

it('keeps a generated worker workspace while generic scheduler occupancy is still unknown', async () => {
  const { plan, project } = confirmTask('cleanup-owner-occupancy')
  h.runtime.executor.dispatchProjects(); await waitUntil(() => running().length === 1)
  const attempt = running()[0]!, agent = h.agents.get(attempt.sessionId)!
  // A durable owner reservation stands in for a native producer whose physical exit is not yet known.
  const lease = h.runtime.scheduler.adopt({ id: `unknown-owner:${attempt.sessionId}`, projectId: project.id, ownerId: attempt.sessionId, kind: 'background' })
  const artifact = await h.runGuardedTool(attempt.sessionId, 'project_write_artifact', { operation_id: 'cleanup-file', output: 'note', name: 'note.md', content: 'Detached material' })
  await h.runGuardedTool(attempt.sessionId, 'project_worker_report', { operation_id: 'cleanup-ready', state: 'ready', completed: 'Completed while an owner reservation remains', evidence: ['Registered artifact'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
  expect(h.runtime.store.tickets.get(plan.ticketId)?.assignments[0]?.state).toBe('ended')
  agent.status = 'idle'; agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0

  const registry = h.ctx.workspaceRegistry as unknown as { archivedSessionIds: string[]; pinnedSessionIds: string[]; archiveSession(id: string): Promise<void>; delete(id: unknown): Promise<boolean>; get(id: unknown): unknown }
  const archived = new Set<string>([attempt.sessionId]), deleted: unknown[] = []
  Object.defineProperty(registry, 'archivedSessionIds', { configurable: true, get: () => [...archived] })
  Object.defineProperty(registry, 'pinnedSessionIds', { configurable: true, get: () => [] })
  registry.archiveSession = async id => { archived.add(id) }
  registry.delete = async id => { deleted.push(id); return true }
  // Simulate a crash after archive and before workspace retirement. The existing fact must not bypass owner exit.
  h.runtime.store.set('worker-ui-cleanup', { [attempt.id]: { sessionId: attempt.sessionId, archivedAt: new Date().toISOString(), workspaceId: attempt.workspaceId } })
  const cleanup = (h.runtime as unknown as { workerCleanup: { consider(id: string): Promise<boolean> } }).workerCleanup
  expect(await cleanup.consider(attempt.id)).toBe(false)
  expect(deleted).toEqual([])
  expect(registry.get(attempt.workspaceId as never)).toBeDefined()
  expect((h.runtime.store.get<Record<string, { workspaceDeletedAt?: string }>>('worker-ui-cleanup') ?? {})[attempt.id]?.workspaceDeletedAt).toBeUndefined()

  lease.release()
  expect(await cleanup.consider(attempt.id)).toBe(true)
  expect(deleted).toEqual([attempt.workspaceId])
})

it('preserves completed confirmation receipts and only reopens for a new explicit authenticated rerun through the coordinator', async () => {
  const { plan, project } = confirmTask('completed-confirmation'), c = h.runtime.projectCoordinator
  const before = h.runtime.store.tickets.get(plan.ticketId)!, originalAssignment = before.assignments[0]!, originalAuthorization = before.authorizations![0]!
  const attempt = c.attempts.prepare(c.attempts.allocate(before, originalAssignment))
  const artifact = c.artifacts.write(attempt.sessionId, { operationId: 'note', output: 'note', name: 'note.md', content: '# Completed note' })
  c.reports.submit(attempt.sessionId, { operationId: 'ready', state: 'ready', completed: 'Wrote note', evidence: ['Registered note'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
  const completed = h.runtime.store.tickets.get(plan.ticketId)!
  expect(completed.ended?.outcome).toBe('completed')
  const request = { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm-completed-confirmation', intent: 'execute' as const }
  // The application receipt path calls core confirm and registerAssignment, both after real completion.
  const replay = c.confirm('owner', project.id, request)
  expect(replay.authorization.id).toBe(originalAuthorization.id)
  expect(replay.assignment.id).toBe(originalAssignment.id)
  expect(replay.ticket.ended).toEqual(completed.ended)
  expect(c.plans.confirm('owner', project.id, { ...request, projectId: project.id }).assignment.id).toBe(originalAssignment.id)
  const duplicate = c.send('owner', project.id, { requestId: 'another-confirmation', text: '按这个方案做', ticketId: plan.ticketId, planRevision: 1 })
  expect(duplicate).toMatchObject({ authorization: { id: originalAuthorization.id }, assignment: { id: originalAssignment.id } })
  expect(c.plans.get('owner', project.id, plan.ticketId)).toEqual(plan)
  expect(() => c.confirm('owner', project.id, { ...request, intent: 'rerun' })).toThrow()
  expect(h.runtime.store.tickets.get(plan.ticketId)?.ended).toEqual(completed.ended)
  c.send('owner', project.id, { requestId: 'discussion', text: 'Tell me why you chose this wording' })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(h.runtime.store.tickets.get(plan.ticketId)?.ended).toEqual(completed.ended)
  expect(c.attempts.all()).toHaveLength(1)
  expect(() => c.confirm('foreign-owner', project.id, { ...request, operationId: 'foreign-rerun', intent: 'rerun' })).toThrow()
  const rerun = c.confirm('owner', project.id, { ...request, operationId: 'explicit-rerun', intent: 'rerun' })
  expect(rerun.assignment.id).not.toBe(originalAssignment.id)
  expect(rerun.authorization.id).not.toBe(originalAuthorization.id)
  const opened = h.runtime.store.tickets.get(plan.ticketId)!
  expect(opened.ended).toBeUndefined()
  expect(opened.assignments).toHaveLength(2)
  expect(opened.assignments[0]).toEqual(completed.assignments[0])
  expect(opened.planRevisions).toEqual(completed.planRevisions)
  expect(c.reports.reports(plan.ticketId)).toHaveLength(1)
  expect(c.artifacts.read(project.id, artifact.id, artifact.contentVersion).content).toBe('# Completed note')
  expect(c.confirm('owner', project.id, { ...request, operationId: 'explicit-rerun', intent: 'rerun' }).assignment.id).toBe(rerun.assignment.id)
  expect(h.runtime.store.tickets.get(plan.ticketId)?.assignments).toHaveLength(2)
})

it('keeps explicit stop and unknown unfinished effects terminal on fresh rerun', () => {
  const { plan, project } = confirmTask('stopped'), c = h.runtime.projectCoordinator
  const ticket = h.runtime.store.tickets.get(plan.ticketId)!
  ticket.ended = { outcome: 'stopped', by: 'human', at: 'now' }
  h.runtime.store.tickets.save(ticket)
  expect(() => c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'rerun-stopped', intent: 'rerun' })).toThrow(/ended/)
  ticket.ended = { outcome: 'completed', by: 'executor', at: 'now' }
  ticket.assignments[0]!.waitingReason = 'preparation-reconciliation'
  h.runtime.store.tickets.save(ticket)
  expect(() => c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'rerun-unknown', intent: 'rerun' })).toThrow(/ended/)
  expect(h.runtime.store.tickets.get(plan.ticketId)?.assignments).toHaveLength(1)
})

it('shares maxWorkers=1 across two project tasks after the first launch reservation is released', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const first = confirmTask('first'), second = confirmTask('second')
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => running().length === 1)
  // Let launchProject finish and free its reservation; the actual running Session still consumes a slot.
  await new Promise<void>(resolve => setImmediate(resolve))
  h.runtime.executor.dispatchProjects()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(running()).toHaveLength(1)
  expect(h.controller.create.mock.calls.filter(([args]) => args.sessionId.startsWith('project-worker-'))).toHaveLength(1)
  const firstAttempt = running()[0]!
  const waitingTask = firstAttempt.ticketId === first.plan.ticketId ? second : first
  expect(h.runtime.store.tickets.get(waitingTask.plan.ticketId)?.assignments[0]?.waitingReason).toBe('worker-slot')
  h.agents.get(firstAttempt.sessionId)!.status = 'idle'
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => h.runtime.projectCoordinator.attempts.all().some(item => item.ticketId === waitingTask.plan.ticketId && item.status === 'running'))
  expect(h.agents.get(firstAttempt.sessionId)?.status).toBe('idle')
  expect([...h.agents.values()].filter(agent => agent.id.startsWith('project-worker-') && agent.status === 'running')).toHaveLength(1)
})

it('records one durable project feedback fact for a human scoped PR follow-up after accepted work, without a false global follow-up', async () => {
  const c = h.runtime.projectCoordinator
  const project = c.create('owner', { name: 'Feedback project', goal: 'One accepted note' })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'feedback-original', text: 'Write one note' })
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'feedback-plan', plan: {
    goal: 'One accepted note', scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed file worker', cost: 'One worker',
    completion: 'Nonempty note', acceptance: { version: 1, mode: 'registered-files' },
  } })
  const confirmed = c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'feedback-confirm', intent: 'execute' })
  const ticket = h.runtime.store.tickets.get(plan.ticketId)!
  const assignment = ticket.assignments[0]!
  const attempt = c.attempts.allocate(confirmed.ticket, assignment)
  c.attempts.prepare(attempt)
  c.attempts.pinIdentity(attempt.id, { executionId: attempt.id, projectId: project.id, repositoryId: 'feedback-resource', repository: 'acme/widgets',
    accountId: 'agent-bot', accountCli: '/bin/false', gitAuthorName: 'Agent', gitAuthorEmail: 'agent@example.com',
    deliveryBranch: 'agent/project-feedback', capturedAt: '2026-11-02T09:59:00Z' })
  const artifact = c.artifacts.write(attempt.sessionId, { operationId: 'feedback-file', output: 'note', name: 'note.md', content: '# Note\nAccepted work.' })
  const namespace = githubNamespaceOf({ projectId: project.id, repositoryId: 'feedback-resource', accountId: 'agent-bot', repository: 'acme/widgets' })!
  const threadKey = githubThreadId(namespace, 41)
  const pull = { number: 41, state: 'open', html_url: 'https://github.com/acme/widgets/pull/41', user: { login: 'agent-bot' },
    head: { sha: 'abc', ref: 'agent/project-feedback', repo: { full_name: 'acme/widgets' } } }
  c.reports.submit(attempt.sessionId, { operationId: 'feedback-report', state: 'ready', completed: 'Wrote the note',
    evidence: ['Read the exact note'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [],
    prUrl: pull.html_url }, pull)
  const accepted = h.runtime.store.tickets.get(ticket.id)!
  expect(accepted.ended).toBeUndefined()
  expect(accepted.assignments[0]?.state).toBe('ended')
  expect(c.attempts.bySession(attempt.sessionId)?.status).toBe('ended')

  const trigger = commentTrigger({ id: 4101, body: 'Please continue this accepted work.', user: { login: 'alice', type: 'User' },
    created_at: '2026-11-02T10:00:00Z', html_url: 'https://github.com/acme/widgets/pull/41#issuecomment-4101' },
    { number: 41, isPr: true, url: 'https://github.com/acme/widgets/pull/41' }, 'conversation', 'agent-bot', namespace)
  expect(h.runtime.receive(trigger)).toBe('stored')
  const persisted = h.runtime.store.tickets.get(ticket.id)!
  const input = persisted.inputs.find(item => item.kind === 'trigger' && item.triggerId === trigger.id)!
  expect(input).not.toHaveProperty('deliveredTo')
  expect(input).not.toHaveProperty('deliveredAt')
  expect(persisted.undelivered).not.toContain(input.id)
  const events = new ProjectEvents(h.runtime.store)
  const pending = events.pending(project.id).filter(event => event.kind === 'project-feedback')
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({ projectId: project.id, ticketId: ticket.id, triggerId: trigger.id, inputId: input.id,
    scope: 'assignment', assignmentId: assignment.id, attemptId: attempt.id, resourceIds: ['feedback-resource'],
    feedback: { triggerId: trigger.id, inputId: input.id,
      text: 'Please continue this accepted work.', threadKeys: [threadKey] } })
  expect(h.runtime.receive(trigger)).toBe('duplicate')
  expect(events.pending(project.id).filter(event => event.kind === 'project-feedback')).toHaveLength(1)
  expect(h.relays(h.runtime.masterId).filter(item => item.kind === 'follow_up' && item.trigger_id === trigger.id)).toEqual([])

  // The Trigger, its Ticket input and the fact are one intake transaction: a fact write failure leaves none of them.
  const rejected = commentTrigger({ id: 4102, body: 'This must roll back.', user: { login: 'alice', type: 'User' },
    created_at: '2026-11-02T10:01:00Z', html_url: 'https://github.com/acme/widgets/pull/41#issuecomment-4102' },
    { number: 41, isPr: true, url: 'https://github.com/acme/widgets/pull/41' }, 'conversation', 'agent-bot', namespace)
  const append = vi.spyOn(ProjectEvents.prototype, 'append').mockImplementationOnce(() => { throw new Error('feedback fact failed') })
  try { expect(() => h.runtime.receive(rejected)).toThrow('feedback fact failed') } finally { append.mockRestore() }
  expect(h.runtime.store.triggers.get(rejected.id)).toBeUndefined()
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs.some(item => item.kind === 'trigger' && item.triggerId === rejected.id)).toBe(false)
  expect(h.runtime.receive(rejected)).toBe('stored')
  const feedback = events.pending(project.id).filter(event => event.kind === 'project-feedback')
  expect(feedback).toHaveLength(2)
  expect(feedback.find(event => event.triggerId === rejected.id)).toMatchObject({ inputId: expect.any(String) })

  // The project lane must not discard the fact as ordinary dependency progress: it wakes and claims it.
  h.runtime.projectCoordinator.pumpEvents()
  await waitUntil(() => events.feedback(project.id) !== undefined)
  expect(events.feedback(project.id)?.events).toContainEqual(expect.objectContaining({ kind: 'project-feedback', triggerId: trigger.id }))
})

it('returns an exact committed PR report through the registered native guard after authorization revocation', async () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Guarded PR replay', goal: 'Exact receipt after revocation' })
  const cli = h.runtime.deployment.github!.cli
  writeFileSync(cli, '#!/bin/sh\nif [ "$1" = api ] && [ "$2" = user ]; then echo agent-bot; exit 0; fi\nif [ "$1" = api ] && [ "$2" = repos/acme/widgets ]; then printf "acme/widgets\\ttrue\\n"; exit 0; fi\nexit 1\n', { mode: 0o700 })
  const repository = mkdtempSync(join(h.directory, 'guarded-replay-repo-'))
  const repo = await c.registerResource('owner', project.id, { type: 'repository', path: repository, purpose: 'repository', maxBytes: 10_000,
    identity: { repository: 'acme/widgets', gitAuthorName: 'Fixture', gitAuthorEmail: 'fixture@example.invalid' } }, 'guarded-replay-repo')
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'guarded-replay-origin', text: 'Deliver a reviewed PR' })
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'guarded-replay-plan', plan: { goal: 'Deliver a reviewed PR',
    scope: 'Registered repository', outputs: ['note'], resources: [repo.id], environment: 'Managed', cost: 'One worker',
    completion: 'Reviewed delivery', acceptance: { version: 1, mode: 'registered-files' } } })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'guarded-replay-confirm', text: '按这个方案做' })
  const confirmed = c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'guarded-replay-confirm', intent: 'execute' })
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => running().length === 1)
  const attempt = running()[0]!
  await h.runtime.sessions.ensure(attempt.sessionId, attempt.cwd, 'Guarded replay worker', 'worker')

  const pr = { number: 7, title: 'Guarded replay', state: 'open', html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'agent-bot' },
    head: { sha: 'a'.repeat(40), ref: attempt.identity!.deliveryBranch!, repo: { full_name: 'acme/widgets' } } }
  let reads = 0
  const api = vi.spyOn(Commands.prototype, 'api').mockImplementation(async function(this: Commands, schema: any, ...args: any[]) {
    const raw = typeof schema === 'string', path = raw ? schema : args[0], value = path === 'pulls/7' ? pr : path.startsWith('notifications?') ? [] : {}
    if (path === 'pulls/7') reads++
    return raw ? (typeof value === 'string' ? value : JSON.stringify(value)) : schema.parse(value)
  } as any)
  const pages = vi.spyOn(Commands.prototype, 'pages').mockResolvedValue([])
  try {
    const artifact = await h.runGuardedTool(attempt.sessionId, 'project_write_artifact', { operation_id: 'guarded-replay-file', output: 'note', name: 'note.md', content: 'Guarded replay evidence' })
    const args = { operation_id: 'guarded-replay-report', state: 'progress' as const, completed: 'Opened the guarded PR', evidence: ['Read the exact PR'],
      artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [], pr_url: pr.html_url }
    const first = await h.runGuardedTool(attempt.sessionId, 'project_worker_report', args)
    expect(first).toMatchObject({ received: true })
    expect(reads).toBe(1)
    const ticket = h.runtime.store.tickets.get(plan.ticketId)!, bind = vi.spyOn(h.runtime.engine, 'bindThread')
    const auth = ticket.authorizations!.find(item => item.id === confirmed.authorization.id)!
    auth.revokedAt = new Date().toISOString(); h.runtime.store.tickets.save(ticket)
    c.revokeResource('owner', project.id, repo.id, 'guarded-replay-revoke')
    api.mockImplementation(async (..._args: any[]) => { reads++; throw new Error('provider unavailable') })
    const owner = vi.spyOn(c.attempts, 'receiptOwner')
    const replay = await h.runGuardedTool(attempt.sessionId, 'project_worker_report', args)
    expect(replay).toEqual(first); expect(owner).toHaveBeenCalled()
    expect(reads).toBe(1); expect(bind).not.toHaveBeenCalled(); expect(c.reports.reports(ticket.id)).toHaveLength(1)
    await expect(h.runGuardedTool(attempt.sessionId, 'project_worker_report', { ...args, completed: 'Changed content' })).rejects.toThrow(/conflict/)
    await expect(h.runGuardedTool(attempt.sessionId, 'project_worker_report', { ...args, operation_id: 'guarded-replay-new' })).rejects.toThrow(/unauthorized|Stale/)
    expect(reads).toBe(1); expect(bind).not.toHaveBeenCalled(); expect(c.reports.reports(ticket.id)).toHaveLength(1)
  } finally { api.mockRestore(); pages.mockRestore(); vi.restoreAllMocks() }
})
