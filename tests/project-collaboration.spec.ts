import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Delegations, type DelegationInput, type DelegationStart } from '../src/app/delegations.ts'
import { ArtifactStore } from '../src/app/artifact-store.ts'
import { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import { ReportAcceptance } from '../src/app/report-acceptance.ts'
import { SkillCatalog } from '../src/app/skill-catalog.ts'
import { Store } from '../src/app/store.ts'
import { projectWorkerTools } from '../src/app/tools/executor.ts'
import { workerFixture } from './fixtures/project-worker.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function setup(label: string, startNative = vi.fn(async (_input: DelegationStart) => ({ provider: 'spawn' }))) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`))); directories.push(directory)
  const f = workerFixture(directory, { version: 1, mode: 'registered-files' })
  const attempt = f.prepare()
  attempt.context = { toolContractVersion: 1, promptRevision: 1, roleRules: 'Worker rules', projectConventions: '{}', model: {}, resources: [],
    tools: ['project_worker_context', 'project_write_artifact', 'project_worker_report'], skills: [] }
  f.attempts.save(attempt)
  let delegations!: Delegations
  delegations = new Delegations(f.store, f.attempts, new SkillCatalog(f.store), { startNative,
    onChanged: attemptId => { if (attemptId === attempt.id) f.reports.reaggregate(attempt.sessionId) } })
  f.reports.setDelegations(delegations)
  return { directory, f, attempt, delegations, startNative }
}

const request = (overrides: Partial<DelegationInput> = {}): DelegationInput => ({ operationId: 'delegate-review', label: 'Independent review',
  prompt: 'Review only the pinned note and return concrete evidence.', role: 'research', tools: ['project_worker_context', 'project_worker_report'], ...overrides })

it('records one independent child, holds the parent result until its result is processed, then completes without a second child', async () => {
  const startNative = vi.fn(async (_input: DelegationStart) => ({ provider: 'spawn', runId: 'run-1' }))
  const { f, attempt, delegations } = setup('recorded-delegation', startNative)
  const first = await delegations.start(attempt.sessionId, request(), new AbortController().signal)
  expect(first).toMatchObject({ projectId: f.project.id, ticketId: f.plan.ticketId, parentSessionId: attempt.sessionId,
    parentAttemptId: attempt.id, parentLease: attempt.lease, state: 'running', resultProcessing: 'none', provider: 'spawn', runId: 'run-1' })
  expect(first.childSessionId).not.toBe(attempt.sessionId)
  expect(startNative).toHaveBeenCalledOnce()
  expect(startNative.mock.calls[0]![0]).toMatchObject({ parentSessionId: attempt.sessionId, childSessionId: first.childSessionId,
    provider: 'spawn', delivery: 'parent', agentPreset: 'standard', maxDepth: 1,
    prompt: request().prompt, scope: { role: 'research', stage: 'execute', resources: [], tools: request().tools } })

  expect(await delegations.start(attempt.sessionId, request())).toEqual(first)
  expect(startNative).toHaveBeenCalledOnce()
  await expect(delegations.start(attempt.sessionId, request({ prompt: 'Changed task' }))).rejects.toThrow(/operation id conflict/)

  const finished = delegations.finish(first.childSessionId, { stopReason: 'completed', output: [{ type: 'text', text: 'The note has one unresolved source claim.' }] })
  expect(finished).toMatchObject({ state: 'completed', resultProcessing: 'pending', result: { text: 'The note has one unresolved source claim.' } })
  const artifact = f.write()
  const report = f.reports.submit(attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }]))
  expect(report.state).toBe('ready')
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]).toMatchObject({ waitingReason: 'delegation-pending' })
  expect(f.store.tickets.get(f.plan.ticketId)?.ended).toBeUndefined()
  await expect(delegations.start(attempt.sessionId, request({ operationId: 'too-late' }))).rejects.toThrow(/ready Assignment/)

  const processTool = projectWorkerTools(f.attempts, f.artifacts, f.reports, attempt.sessionId, undefined, undefined, undefined, undefined, delegations)
    .find(item => item.name === 'project_process_delegation')!
  expect(await processTool.execute({ child_session_id: first.childSessionId, operation_id: 'consume-review' }, new AbortController().signal))
    .toMatchObject({ delegationId: first.id, resultProcessing: 'processed', result: { text: 'The note has one unresolved source claim.' } })
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'accepted' })
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]?.waitingReason).toBeUndefined()
  expect(f.store.tickets.get(f.plan.ticketId)?.ended?.outcome).toBe('completed')
  expect(startNative).toHaveBeenCalledOnce()
})

it('allows one native start for concurrent calls of the same operation', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const startNative = vi.fn(async (_input: DelegationStart) => { await gate; return { provider: 'spawn' } })
  const { attempt, delegations } = setup('delegation-concurrent-start', startNative)
  const first = delegations.start(attempt.sessionId, request()), second = delegations.start(attempt.sessionId, request())
  await vi.waitFor(() => expect(startNative).toHaveBeenCalledOnce())
  expect(delegations.listForAttempt(attempt.id)).toMatchObject([{ state: 'starting' }])
  release()
  const [left, right] = await Promise.all([first, second])
  expect(left.id).toBe(right.id)
  expect(left.state).toBe('running')
  expect(startNative).toHaveBeenCalledOnce()
})

it('does not start again after an ambiguous native start has entered reconciliation', async () => {
  const startNative = vi.fn(async (_input: DelegationStart): Promise<{ provider: string }> => { throw new Error('native outcome unknown') })
  const { attempt, delegations } = setup('delegation-reconcile-no-retry', startNative)
  expect(await delegations.start(attempt.sessionId, request())).toMatchObject({ state: 'reconcile' })
  expect(await delegations.start(attempt.sessionId, request())).toMatchObject({ state: 'reconcile' })
  expect(startNative).toHaveBeenCalledOnce()
})

it('never turns a non-local child lifecycle into a processable result', () => {
  const { attempt, delegations } = setup('delegation-nonlocal')
  const record = delegations.begin(attempt.sessionId, request())
  const info = { id: record.childSessionId, runId: 'external-run', provider: 'external', local: false }
  delegations.observeStart(attempt.sessionId, info)
  expect(delegations.get(record.id)).toMatchObject({ state: 'reconcile', local: false })
  delegations.observeEnd(attempt.sessionId, { ...info, local: true, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'forged' }] })
  expect(delegations.get(record.id)).toMatchObject({ state: 'reconcile', local: false })
  expect(delegations.get(record.id)?.result).toBeUndefined()
  expect(() => delegations.process(attempt.sessionId, record.childSessionId, 'consume-external')).toThrow(/not been received/)
})

it('preserves the delegation result gate across Store reopen and replay of the processing operation', () => {
  const { directory, f, attempt, delegations } = setup('delegation-restart')
  const record = delegations.begin(attempt.sessionId, request())
  delegations.finish(record.childSessionId, { stopReason: 'completed', output: [{ type: 'text', text: 'Restart-safe review' }] })
  const artifact = f.write()
  f.reports.submit(attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }]))
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]?.waitingReason).toBe('delegation-pending')
  f.store.close()

  const store = new Store(join(directory, 'project.sqlite'))
  const attempts = new ExecutionAttempts(store, directory), artifacts = new ArtifactStore(store, attempts)
  const reports = new ReportAcceptance(store, attempts, artifacts)
  const reopened = new Delegations(store, attempts, new SkillCatalog(store), { onChanged: attemptId => {
    if (attemptId === attempt.id) reports.reaggregate(attempt.sessionId)
  } })
  reports.setDelegations(reopened)
  try {
    expect(reopened.byChildSession(record.childSessionId)?.result).toMatchObject({ text: 'Restart-safe review' })
    reopened.process(attempt.sessionId, record.childSessionId, 'consume-after-restart')
    expect(reopened.process(attempt.sessionId, record.childSessionId, 'consume-after-restart')).toMatchObject({ resultProcessing: 'processed' })
    expect(store.tickets.get(f.plan.ticketId)?.ended?.outcome).toBe('completed')
    expect(() => reopened.process(attempt.sessionId, record.childSessionId, 'another-consume')).toThrow(/another operation/)
  } finally { store.close() }
})

it('keeps an active child unresolved after restart when its native Session is not found', async () => {
  const { directory, f, attempt, delegations } = setup('delegation-restart-unknown')
  const record = await delegations.start(attempt.sessionId, request())
  f.store.close()
  const store = new Store(join(directory, 'project.sqlite')), attempts = new ExecutionAttempts(store, directory)
  const reopened = new Delegations(store, attempts, new SkillCatalog(store), { resolveChild: async () => undefined })
  try {
    await reopened.reconcile()
    expect(reopened.byChildSession(record.childSessionId)).toMatchObject({ state: 'reconcile', error: expect.stringMatching(/not found after restart/) })
    expect(reopened.blocking(attempt.id)).toHaveLength(1)
  } finally { store.close() }
})

it.each(['pause', 'stop'] as const)('refuses a new child after a durable %s intent', intent => {
  const { f, attempt, delegations } = setup(`delegation-${intent}`)
  const ticket = f.store.tickets.get(f.plan.ticketId)!, at = new Date().toISOString()
  ticket.lifecycle = { pause: { intent: intent === 'pause' ? 'pause' : 'none', state: intent === 'pause' ? 'pausing' : 'running', at },
    stop: { intent: intent === 'stop' ? 'stop' : 'none', state: intent === 'stop' ? 'stopping' : 'running', at }, observed: { state: 'running', at } }
  f.store.tickets.save(ticket)
  expect(() => delegations.begin(attempt.sessionId, request())).toThrow(/unauthorized/)
})

it('promotes a settled local result to the already-authorized Task Assignment without starting it again', async () => {
  const { f, attempt, delegations, startNative } = setup('delegation-promotion')
  const record = await delegations.start(attempt.sessionId, request())
  delegations.finish(record.childSessionId, { stopReason: 'completed', output: [{ type: 'text', text: 'Reusable review' }] })
  delegations.process(attempt.sessionId, record.childSessionId, 'consume-promotion')
  const promoted = delegations.promote(record.id, attempt.assignmentId)
  expect(promoted.assignment.id).toBe(attempt.assignmentId)
  expect(promoted.delegation).toMatchObject({ promotedTo: attempt.assignmentId, result: { text: 'Reusable review' } })
  const contextTool = projectWorkerTools(f.attempts, f.artifacts, f.reports, attempt.sessionId, undefined, undefined, undefined, undefined, delegations)
    .find(item => item.name === 'project_worker_context')!
  expect(await contextTool.execute({}, new AbortController().signal)).toMatchObject({ promotedDelegations: [{ id: record.id, result: { text: 'Reusable review' } }] })
  expect((await delegations.start(attempt.sessionId, request())).id).toBe(record.id)
  expect(startNative).toHaveBeenCalledOnce()
})

it('leaves native admission explicitly closed when no proven host starter is configured', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'delegation-closed-'))); directories.push(directory)
  const f = workerFixture(directory, { version: 1, mode: 'registered-files' }), attempt = f.prepare()
  attempt.context = { promptRevision: 1, roleRules: 'rules', projectConventions: '', model: {}, resources: [], tools: ['project_worker_context'], skills: [] }
  f.attempts.save(attempt)
  const delegations = new Delegations(f.store, f.attempts, new SkillCatalog(f.store))
  await expect(delegations.start(attempt.sessionId, request({ tools: ['project_worker_context'] }))).rejects.toThrow(/disabled until its host contract/)
})
