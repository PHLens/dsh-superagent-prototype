/** Actual Runtime/Sessions decoration and registered guard/tool callbacks in the in-memory DSH fixture. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { workerFixture } from './fixtures/project-worker.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

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
