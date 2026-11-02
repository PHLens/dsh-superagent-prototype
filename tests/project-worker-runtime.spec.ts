/** Actual Runtime/Sessions decoration and registered guard/tool callbacks in the in-memory DSH fixture. */
import { afterEach, beforeEach, expect, it } from 'vitest'
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
