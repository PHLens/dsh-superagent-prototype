import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectResources } from '../src/app/project-resources.ts'
import { ProjectPlans } from '../src/app/project-plans.ts'
import { Projects } from '../src/core/projects.ts'
import { ConversationStore } from '../src/app/conversation-store.ts'
import { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import { ArtifactStore } from '../src/app/artifact-store.ts'
import { Store } from '../src/app/store.ts'
import { resolveCodeCheck } from '../src/app/code-check.ts'
import type { CodeCheck } from '../src/core/model.ts'
import { ProjectScheduler } from '../src/app/scheduler.ts'
import { validationJobPersistence, type ValidationProcessResult } from '../src/app/native-validation-job.ts'
import { CodeValidation, codeValidationOperation } from '../src/app/code-validation.ts'
import { projectWorkerTools } from '../src/app/tools/executor.ts'
import type { Commands } from '../src/infra/commands.ts'
import { ReportAcceptance } from '../src/app/report-acceptance.ts'
import { workerFixture } from './fixtures/project-worker.ts'

// A cold real pytest process plus SQLite/native-job setup can exceed the 5s default.
vi.setConfig({ testTimeout: 30_000 })
it('requires the exact structured receipt and never promotes a label without exit facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 't7-code-check-'))
  try {
    const check = { command: 'python3', args: ['-c', 'print(1)'], profile: 'python-smoke', sourceVersion: 'src-v1', configVersion: 'cfg-v1' }
    const f = workerFixture(root, { version: 1, mode: 'registered-files', codeCheck: check }); f.prepare()
    f.attempts.pinIdentity(f.attempt.id, { executionId: f.attempt.id, projectId: f.project.id, repositoryId: 'resource-1', repository: 'owner/repo', accountId: 'owner', accountCli: 'gh', gitAuthorName: 'Owner', gitAuthorEmail: 'owner@example.com', capturedAt: new Date().toISOString() })
    const validation = new CodeValidation(f.store, f.attempts), reports = new ReportAcceptance(f.store, f.attempts, f.artifacts, validation)
    const artifact = f.write(); const report = reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }]))
    expect(report.state).toBe('ready')
    expect(f.confirmed.ticket.assignments[0]!.state).not.toBe('ended')
    expect(() => validation.requirePassed(f.attempt.id, f.attempt.lease, check, codeValidationOperation(f.attempt.id, 1))).toThrow('missing, stale or failed')
    f.store.close()
    const u = workerFixture(mkdtempSync(join(tmpdir(), 't7-code-unknown-')), { version: 1, mode: 'registered-files', codeCheck: check }); u.prepare()
    u.attempts.pinIdentity(u.attempt.id, { executionId: u.attempt.id, projectId: u.project.id, repositoryId: 'resource-1', repository: 'owner/repo', accountId: 'owner', accountCli: 'gh', gitAuthorName: 'Owner', gitAuthorEmail: 'owner@example.com', capturedAt: new Date().toISOString() })
    const label = new CodeValidation(u.store, u.attempts, { run: async () => ({ status: 'passed', stdout: '', stderr: '' }) })
    const receipt = await label.run(u.attempt.sessionId, codeValidationOperation(u.attempt.id, 1), check, {} as Commands, new AbortController().signal)
    expect(receipt.status).toBe('unknown')
    expect(() => label.requirePassed(u.attempt.id, u.attempt.lease, check, receipt.operationId)).toThrow('missing, stale or failed')
    u.store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('returns a JSON-safe canonical receipt through the registered worker tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 't7-code-tool-'))
  try {
    const check = { command: 'python3', args: ['-c', 'print(1)'], profile: 'python-smoke', sourceVersion: 'src-v1', configVersion: 'cfg-v1' }
    const f = workerFixture(root, { version: 1, mode: 'registered-files', codeCheck: check }); f.prepare()
    f.attempts.pinIdentity(f.attempt.id, { executionId: f.attempt.id, projectId: f.project.id, repositoryId: 'resource-1', repository: 'owner/repo', accountId: 'owner', accountCli: 'gh', gitAuthorName: 'Owner', gitAuthorEmail: 'owner@example.com', capturedAt: new Date().toISOString() })
    const validation = new CodeValidation(f.store, f.attempts, { run: async () => ({ status: 'passed', exitCode: 0, signal: undefined, stdout: 'ok\\n', stderr: '' }) })
    const tool = projectWorkerTools(f.attempts, f.artifacts, f.reports, f.attempt.sessionId, undefined, undefined, validation, {} as Commands).find(item => item.name === 'project_validate_code')!
    const result = await tool.execute({ operation_id: codeValidationOperation(f.attempt.id, 1) }, new AbortController().signal)
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({ status: 'passed', operationId: codeValidationOperation(f.attempt.id, 1) })
    expect(Object.values(result as Record<string, unknown>)).not.toContain(undefined)
    f.store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('never certifies a pass once the lease was replaced or the producer was cancelled', async () => {
  const root = mkdtempSync(join(tmpdir(), 't7-code-authority-'))
  try {
    const check = { command: 'python3', args: ['-c', 'print(1)'], profile: 'python-smoke', sourceVersion: 'src-v1', configVersion: 'cfg-v1' }
    const f = workerFixture(root, { version: 1, mode: 'registered-files', codeCheck: check }); f.prepare()
    f.attempts.pinIdentity(f.attempt.id, { executionId: f.attempt.id, projectId: f.project.id, repositoryId: 'resource-1', repository: 'owner/repo', accountId: 'owner', accountCli: 'gh', gitAuthorName: 'Owner', gitAuthorEmail: 'owner@example.com', capturedAt: new Date().toISOString() })
    const operationId = codeValidationOperation(f.attempt.id, 1)
    const replaced = new CodeValidation(f.store, f.attempts, { run: async () => {
      const current = f.attempts.all().find(item => item.id === f.attempt.id)!
      current.lease = 'replacement-lease'; f.attempts.save(current)
      return { status: 'passed', exitCode: 0, stdout: 'ok\n', stderr: '', physicalExit: true as const }
    } })
    // A replaced lease settles as an aborted receipt instead of an unresolvable reservation.
    const aborted = await replaced.run(f.attempt.sessionId, operationId, check, {} as Commands, new AbortController().signal)
    expect(aborted).toMatchObject({ status: 'aborted', lease: f.attempt.lease })
    expect(replaced.get(f.attempt.id, operationId)?.status).toBe('aborted')
    expect(() => replaced.requirePassed(f.attempt.id, f.attempt.lease, check, operationId)).toThrow('missing, stale or failed')
    const cancelled = workerFixture(mkdtempSync(join(tmpdir(), 't7-code-abort-')), { version: 1, mode: 'registered-files', codeCheck: check }); cancelled.prepare()
    cancelled.attempts.pinIdentity(cancelled.attempt.id, { executionId: cancelled.attempt.id, projectId: cancelled.project.id, repositoryId: 'resource-1', repository: 'owner/repo', accountId: 'owner', accountCli: 'gh', gitAuthorName: 'Owner', gitAuthorEmail: 'owner@example.com', capturedAt: new Date().toISOString() })
    const kill = new CodeValidation(cancelled.store, cancelled.attempts, { run: async () => ({ status: 'aborted', exitCode: 0, stdout: '', stderr: '', physicalExit: true as const, error: 'Validation cancelled' }) })
    const receipt = await kill.run(cancelled.attempt.sessionId, codeValidationOperation(cancelled.attempt.id, 1), check, {} as Commands, new AbortController().signal)
    expect(receipt).toMatchObject({ status: 'aborted', exitCode: 0 })
    expect(() => kill.requirePassed(cancelled.attempt.id, cancelled.attempt.lease, check, receipt.operationId)).toThrow('missing, stale or failed')
    cancelled.store.close()
    f.store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function projectStore(directory: string) {
  const store = new Store(join(directory, 'db.sqlite')), projects = new Projects({ repo: store }), conversations = new ConversationStore(store)
  const project = projects.create({ name: 'Materials', goal: 'Run the approved check' })
  conversations.claimProject(project.id, 'owner', { newlyCreated: true })
  const resources = new ProjectResources(store)
  return { store, projects, conversations, project, resources }
}

/** The same resolution the coordinator uses: plan time and admission capture exact content versions. */
function materials(directory: string, runtimePath?: string, interpreter: (resource: { path: string }) => string = runtime => runtime.path) {
  const m = projectStore(directory)
  const source = join(directory, 'source'), configFile = join(directory, 'pytest.ini')
  mkdirSync(source); writeFileSync(join(source, 'sample.py'), 'VALUE = 1\n')
  writeFileSync(configFile, '[pytest]\ntestpaths = .\n')
  const sourceResource = m.resources.register({ projectId: m.project.id, type: 'repository', path: source, purpose: 'code-source', maxBytes: 64_000 })
  const configResource = m.resources.register({ projectId: m.project.id, type: 'file', path: configFile, purpose: 'code-config', maxBytes: 64_000 })
  // Every executable profile is owner-registered; the fixture supplies its own launcher, never PATH.
  const defaultRuntime = join(directory, 'python')
  writeFileSync(defaultRuntime, '#!/bin/sh\nexec /usr/bin/env python3 "$@"\n', { mode: 0o755 })
  const runtimeResource = m.resources.register({ projectId: m.project.id, type: 'file', path: runtimePath ?? defaultRuntime, purpose: 'code-runtime', maxBytes: 16_000_000 })
  const plans = new ProjectPlans(m.store, m.projects, m.conversations, (projectId, plan, check) =>
    resolveCodeCheck(m.resources, projectId, plan.resources, check, interpreter).check)
  const admission = (projectId: string, assignment: { contract?: { plan: { resources: string[]; acceptance?: { codeCheck?: CodeCheck } } } }) => {
    const check = assignment.contract?.plan.acceptance?.codeCheck
    if (!check) return undefined
    const resolved = resolveCodeCheck(m.resources, projectId, assignment.contract!.plan.resources, check, interpreter)
    if (resolved.check.sourceVersion !== check.sourceVersion || resolved.check.configVersion !== check.configVersion) throw new Error('Code check material changed since review')
    if (resolved.check.runtimeVersion !== check.runtimeVersion) throw new Error('Code check runtime changed since review')
    return { sourceResourceId: resolved.source.id, sourceVersion: resolved.check.sourceVersion, configResourceId: resolved.config.id, configVersion: resolved.check.configVersion,
      ...(resolved.runtime ? { runtimeResourceId: resolved.runtime.id, runtimeVersion: resolved.runtimeVersion } : {}), profile: check.profile, argv: resolved.argv }
  }
  const attempts = new ExecutionAttempts(m.store, directory, undefined, undefined, admission as never)
  return { ...m, source, configFile, sourceResource, configResource, runtimeResource, plans, attempts }
}

/** Production validation runs as a durable native job; this registry starts it and acknowledges settlement. */
function durable(validation: CodeValidation, store: Store) {
  const jobs = new Map<string, { owner: string; handle: { done: Promise<unknown>; cancel(reason?: string): void } }>()
  let serial = 0
  validation.setScheduler(new ProjectScheduler({ limits: () => ({ model: 1, worker: 1, background: 1, perProject: { worker: 1 } }) }), { persistence: validationJobPersistence(store),
    jobs: { start: spec => { const id = `job-${++serial}`; jobs.set(id, { owner: String(spec.owner), handle: spec.run({ id }) }); return id },
      wait: async id => { const job = jobs.get(String(id))!; return { owner: job.owner, status: (await job.handle.done as { status: string }).status } },
      kill: id => jobs.get(String(id))?.handle.cancel('killed') },
    inspectExit: async () => true })
}

it('runs the reviewed plan end to end without a repository identity: allocation, staged validation and report acceptance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 't7-production-check-'))
  try {
    const m = materials(directory)
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'original', text: 'Validate the registered source' })
    const saved = m.plans.save('owner', m.project.id, { expectedRevision: 0, operationId: 'materials-plan', plan: {
      goal: 'Validate the registered source', scope: 'One registered repository', outputs: ['note'], resources: [m.sourceResource.id, m.configResource.id, m.runtimeResource.id],
      environment: 'Managed', cost: 'Bounded', completion: 'Checked output',
      acceptance: { version: 1, mode: 'registered-files', codeCheck: { command: 'python3', args: [], profile: 'python-smoke', sourceVersion: 'unresolved', configVersion: 'unresolved' } } } })
    // The confirmed contract references the exact captured versions, not registration metadata.
    const reviewed = m.plans.get('owner', m.project.id, saved.ticketId)!
    const check = reviewed.acceptance!.codeCheck!
    expect(check.sourceResourceId).toBe(m.sourceResource.id); expect(check.sourceVersion).toBe(m.resources.capture(m.project.id, m.sourceResource.id).version)
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'go', text: '按这个方案做' })
    const confirmed = m.plans.confirm('owner', m.project.id, { projectId: m.project.id, ticketId: saved.ticketId, planRevision: 1, operationId: 'go', intent: 'execute' })
    const attempt = m.attempts.allocate(confirmed.ticket, confirmed.assignment)
    m.attempts.prepare(attempt)
    expect(attempt.identity).toBeUndefined()
    expect(attempt.codeCheckBinding).toMatchObject({ sourceResourceId: m.sourceResource.id, configResourceId: m.configResource.id, profile: 'python-smoke' })
    const seen: string[] = []
    const produced: ValidationProcessResult = { status: 'passed', exitCode: 0, stdout: 'validated 1 source files\n', stderr: '', physicalExit: true }
    const validation = new CodeValidation(m.store, m.attempts, { run: async argv => { seen.push(...argv); return produced } }, undefined, undefined, m.resources)
    durable(validation, m.store)
    const receipt = await validation.run(attempt.sessionId, codeValidationOperation(attempt.id, 1), check, {} as Commands, new AbortController().signal)
    expect(receipt.status).toBe('passed')
    // The executed argv names the app-owned staging tree, never the original resource path.
    expect(seen[0]).toBe(m.runtimeResource.path); expect(seen.some(item => item.includes('/staging/'))).toBe(true)
    expect(seen.some(item => item.includes(m.source))).toBe(false)
    expect(validation.requirePassed(attempt.id, attempt.lease, check, codeValidationOperation(attempt.id, 1))).toMatchObject({ status: 'passed' })
    // Retrying the completed operation returns its receipt instead of colliding with the staging tree.
    expect(await validation.run(attempt.sessionId, codeValidationOperation(attempt.id, 1), check, {} as Commands, new AbortController().signal)).toEqual(receipt)
    // The receipt names the reviewed check; only argv names the resolved interpreter and staged trees.
    expect(receipt.command).toBe('python3'); expect(receipt.args).toEqual([])
    const artifacts = new ArtifactStore(m.store, m.attempts), reports = new ReportAcceptance(m.store, m.attempts, artifacts, validation)
    const written = artifacts.write(attempt.sessionId, { operationId: 'file-1', output: 'note', name: 'note.md', content: '# Note' })
    reports.submit(attempt.sessionId, { operationId: 'report-1', state: 'ready', completed: 'Checked', evidence: ['Receipt passed'], artifacts: [{ id: written.id, contentVersion: written.contentVersion }], unresolved: [] })
    expect(m.attempts.all().find(item => item.id === attempt.id)?.status).toBe('ended')
    expect(m.store.tickets.get(confirmed.ticket.id)!.assignments[0]!.endedReason).toBe('accepted')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('normalises top-level and nested Assignment code checks to one captured material boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 't7-nested-code-check-'))
  try {
    const m = materials(directory)
    const registeredSourceVersion = m.sourceResource.version, registeredConfigVersion = m.configResource.version, registeredRuntimeVersion = m.runtimeResource.version
    const modelCheck = { command: 'python3', args: [], profile: 'python-smoke', sourceResourceId: m.sourceResource.id, configResourceId: m.configResource.id,
      runtimeResourceId: m.runtimeResource.id, sourceVersion: registeredSourceVersion, configVersion: registeredConfigVersion }
    const resources = [m.sourceResource.id, m.configResource.id, m.runtimeResource.id]
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'original-nested', text: 'Validate the nested contract' })
    const saved = m.plans.save('owner', m.project.id, { expectedRevision: 0, operationId: 'nested-plan', plan: {
      goal: 'Validate the nested contract', scope: 'One registered repository', outputs: ['note'], resources,
      environment: 'Managed', cost: 'Bounded', completion: 'Checked output',
      acceptance: { version: 1, mode: 'registered-files', codeCheck: modelCheck },
      assignments: [{ key: 'work', goal: 'Validate the nested contract', outputs: ['note'], completion: 'Checked output', resources,
        cost: 'Bounded', dependencies: [], writeScope: 'isolated-directory', acceptance: { version: 1, mode: 'registered-files', codeCheck: modelCheck } }] } })
    const reviewed = m.plans.get('owner', m.project.id, saved.ticketId)!
    const top = reviewed.acceptance!.codeCheck!, nested = reviewed.assignments![0]!.acceptance.codeCheck!
    const currentSource = m.resources.capture(m.project.id, m.sourceResource.id).version
    const currentConfig = m.resources.capture(m.project.id, m.configResource.id).version
    expect(top).toEqual(nested)
    expect(top).toMatchObject({ sourceResourceId: m.sourceResource.id, configResourceId: m.configResource.id, runtimeResourceId: m.runtimeResource.id,
      sourceVersion: currentSource, configVersion: currentConfig, runtimeVersion: m.resources.executable(m.project.id, m.runtimeResource.id).version })
    expect(top.sourceVersion).not.toBe(registeredSourceVersion); expect(top.configVersion).not.toBe(registeredConfigVersion)
    expect(top.runtimeVersion).not.toBe(registeredRuntimeVersion)

    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'go-nested', text: '按这个方案做' })
    const confirmed = m.plans.confirm('owner', m.project.id, { projectId: m.project.id, ticketId: saved.ticketId, planRevision: 1, operationId: 'go-nested', intent: 'execute' })
    expect(confirmed.assignment.contract!.plan.acceptance!.codeCheck).toEqual(top)
    const attempt = m.attempts.allocate(confirmed.ticket, confirmed.assignment)
    expect(attempt.codeCheckBinding).toMatchObject({ sourceResourceId: top.sourceResourceId, sourceVersion: top.sourceVersion,
      configResourceId: top.configResourceId, configVersion: top.configVersion, runtimeResourceId: top.runtimeResourceId, runtimeVersion: top.runtimeVersion, profile: 'python-smoke' })

    // A model-supplied foreign ID is outside this Assignment's reviewed inventory and gains no authority.
    mkdirSync(join(directory, 'foreign-source')); writeFileSync(join(directory, 'foreign-source', 'sample.py'), 'VALUE = 2\n')
    const foreign = m.resources.register({ projectId: m.project.id, type: 'repository', path: join(directory, 'foreign-source'), purpose: 'code-source', maxBytes: 64_000 })
    expect(() => m.plans.save('owner', m.project.id, { ticketId: saved.ticketId, expectedRevision: 1, operationId: 'foreign-plan', plan: {
      goal: 'Validate the nested contract', scope: 'One registered repository', outputs: ['note'], resources, environment: 'Managed', cost: 'Bounded', completion: 'Checked output',
      acceptance: { version: 1, mode: 'registered-files', codeCheck: modelCheck },
      assignments: [{ key: 'work', goal: 'Validate the nested contract', outputs: ['note'], completion: 'Checked output', resources, cost: 'Bounded', dependencies: [], writeScope: 'isolated-directory',
        acceptance: { version: 1, mode: 'registered-files', codeCheck: { ...modelCheck, sourceResourceId: foreign.id } } }] } })).toThrow('Code check resource is outside the confirmed plan')
    expect(m.plans.get('owner', m.project.id, saved.ticketId)!.revision).toBe(1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('resolves only the reviewed material, ignoring unrelated or wrongly typed resources', () => {
  const directory = mkdtempSync(join(tmpdir(), 't7-selection-'))
  try {
    const m = materials(directory)
    // Two resources on the plan that are irrelevant to the check: one revoked after registration.
    const contextFile = join(directory, 'context.md'); writeFileSync(contextFile, 'context')
    const unrelated = m.resources.register({ projectId: m.project.id, type: 'file', path: contextFile, purpose: 'context', maxBytes: 64_000 })
    const untouchedVersion = unrelated.version
    m.resources.revoke(m.project.id, unrelated.id)
    const save = (operationId: string, codeCheck: Partial<CodeCheck>, resources: string[]) => m.plans.save('owner', m.project.id, { expectedRevision: 0,
      operationId, plan: { goal: 'Validate', scope: 'One check', outputs: ['note'], resources, environment: 'Managed', cost: 'Bounded', completion: 'Checked',
        acceptance: { version: 1, mode: 'registered-files', codeCheck: { command: 'python3', args: [], profile: 'python-smoke', sourceVersion: 'unresolved', configVersion: 'unresolved', ...codeCheck } } } })
    // An unrelated revoked resource is metadata only; planning resolves the named source and config.
    const saved = save('selection-ok', {}, [m.sourceResource.id, m.configResource.id, m.runtimeResource.id, unrelated.id])
    const reviewed = m.plans.get('owner', m.project.id, saved.ticketId)!.acceptance!.codeCheck!
    expect(reviewed.sourceResourceId).toBe(m.sourceResource.id)
    expect(m.resources.list(m.project.id).find(item => item.id === unrelated.id)!.version).toBe(untouchedVersion)
    // A deliberately mistyped explicit resource fails closed at resolution, not later.
    mkdirSync(join(directory, 'fake-config'))
    const fileAsSource = m.resources.register({ projectId: m.project.id, type: 'file', path: contextFile, purpose: 'code-source', maxBytes: 64_000 })
    const directoryAsConfig = m.resources.register({ projectId: m.project.id, type: 'directory', path: join(directory, 'fake-config'), purpose: 'code-config', maxBytes: 64_000 })
    expect(() => save('selection-wrong-source', { sourceResourceId: fileAsSource.id }, [m.sourceResource.id, m.configResource.id, m.runtimeResource.id, fileAsSource.id])).toThrow('Code source must be a registered directory or repository')
    expect(() => save('selection-wrong-config', { configResourceId: directoryAsConfig.id }, [m.sourceResource.id, m.configResource.id, m.runtimeResource.id, directoryAsConfig.id])).toThrow('Code config must be a registered file')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('stops a replaced or revoked interpreter before any producer starts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 't7-runtime-revoked-'))
  try {
    const m = materials(directory)
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'original', text: 'Validate the registered source' })
    const saved = m.plans.save('owner', m.project.id, { expectedRevision: 0, operationId: 'revoked-plan', plan: {
      goal: 'Validate', scope: 'One check', outputs: ['note'], resources: [m.sourceResource.id, m.configResource.id, m.runtimeResource.id],
      environment: 'Managed', cost: 'Bounded', completion: 'Checked',
      acceptance: { version: 1, mode: 'registered-files', codeCheck: { command: 'python3', args: [], profile: 'python-smoke', sourceVersion: 'unresolved', configVersion: 'unresolved' } } } })
    const check = m.plans.get('owner', m.project.id, saved.ticketId)!.acceptance!.codeCheck!
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'go', text: '按这个方案做' })
    const confirmed = m.plans.confirm('owner', m.project.id, { projectId: m.project.id, ticketId: saved.ticketId, planRevision: 1, operationId: 'go', intent: 'execute' })
    const attempt = m.attempts.allocate(confirmed.ticket, confirmed.assignment)
    m.attempts.pinIdentity(attempt.id, { executionId: attempt.id, projectId: m.project.id, repositoryId: m.sourceResource.id, repository: 'owner/repo', accountId: 'owner', accountCli: 'gh', gitAuthorName: 'Owner', gitAuthorEmail: 'owner@example.com', capturedAt: new Date().toISOString() })
    m.attempts.prepare(attempt)
    expect(attempt.codeCheckBinding).toMatchObject({ runtimeResourceId: m.runtimeResource.id })
    // A replaced interpreter body invalidates the captured binding before any producer starts.
    appendFileSync(m.runtimeResource.path, '\n# replaced\n')
    let starts = 0
    const validation = new CodeValidation(m.store, m.attempts, { run: async () => { starts++; return { status: 'passed', exitCode: 0, stdout: '', stderr: '', physicalExit: true } } }, undefined, undefined, m.resources)
    await expect(validation.run(attempt.sessionId, codeValidationOperation(attempt.id, 1), check, {} as Commands, new AbortController().signal)).rejects.toThrow(/stale|runtime binding changed/)
    expect(starts).toBe(0)
    // Revoking it after admission also stops before start.
    m.resources.revoke(m.project.id, m.runtimeResource.id)
    await expect(validation.run(attempt.sessionId, codeValidationOperation(attempt.id, 1), check, {} as Commands, new AbortController().signal)).rejects.toThrow('revoked')
    expect(starts).toBe(0)
    expect(validation.get(attempt.id, codeValidationOperation(attempt.id, 1))).toBeUndefined()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it.skipIf(!process.env.DSH_T7_PYTEST)('runs the owner-registered pytest profile on the staged material', async () => {
  const python = process.env.DSH_T7_PYTEST!
  const directory = mkdtempSync(join(tmpdir(), 't7-pytest-'))
  try {
    // Owners register a real launcher file, never a symlink into a virtual environment.
    const launcher = join(directory, 'pytest-python')
    writeFileSync(launcher, `#!/bin/sh\nexec ${python} "$@"\n`, { mode: 0o755 })
    const m = materials(directory, launcher)
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'original', text: 'Run the approved tests' })
    mkdirSync(join(m.source, 'tests'))
    writeFileSync(join(m.source, 'tests', 'test_sample.py'), 'from sample import VALUE\n\ndef test_value():\n    assert VALUE == 1\n')
    writeFileSync(m.configFile, '[pytest]\ntestpaths = tests\n')
    const saved = m.plans.save('owner', m.project.id, { expectedRevision: 0, operationId: 'pytest-plan', plan: {
      goal: 'Run the approved tests', scope: 'One registered repository', outputs: ['note'], resources: [m.sourceResource.id, m.configResource.id, m.runtimeResource!.id],
      environment: 'Managed', cost: 'Bounded', completion: 'Tests pass',
      acceptance: { version: 1, mode: 'registered-files', codeCheck: { command: 'pytest', args: [], profile: 'pytest', sourceVersion: 'unresolved', configVersion: 'unresolved' } } } })
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'go', text: '按这个方案做' })
    const confirmed = m.plans.confirm('owner', m.project.id, { projectId: m.project.id, ticketId: saved.ticketId, planRevision: 1, operationId: 'go', intent: 'execute' })
    const attempt = m.attempts.allocate(confirmed.ticket, confirmed.assignment)
    m.attempts.prepare(attempt)
    m.attempts.pinIdentity(attempt.id, { executionId: attempt.id, projectId: m.project.id, repositoryId: 'resource-1', repository: 'owner/repo', accountId: 'owner', accountCli: 'gh', gitAuthorName: 'Owner', gitAuthorEmail: 'owner@example.com', capturedAt: new Date().toISOString() })
    const check = confirmed.assignment.contract!.plan.acceptance!.codeCheck!
    // The binding version is the captured content version, never a stat stamp.
    expect(attempt.codeCheckBinding!.runtimeVersion).toBe(m.resources.executable(m.project.id, m.runtimeResource!.id).version)
    const validation = new CodeValidation(m.store, m.attempts, { run: async (argv, cwd) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' } })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
      const exitCode = await new Promise<number>(resolve => child.on('close', code => resolve(code ?? 1)))
      return { status: exitCode === 0 ? 'passed' : 'failed', exitCode, stdout, stderr, physicalExit: true as const }
    } }, undefined, undefined, m.resources)
    durable(validation, m.store)
    const receipt = await validation.run(attempt.sessionId, codeValidationOperation(attempt.id, 1), check, {} as Commands, new AbortController().signal)
    expect({ status: receipt.status, exitCode: receipt.exitCode }).toEqual({ status: 'passed', exitCode: 0 })
    expect(receipt.output).toContain('1 passed')
    expect(receipt.command).toBe('pytest'); expect(receipt.args).toEqual([])
    // A valid pytest pass certifies the Task even though the resolved argv is an absolute interpreter.
    expect(validation.requirePassed(attempt.id, attempt.lease, check, codeValidationOperation(attempt.id, 1))).toMatchObject({ status: 'passed' })
    expect(receipt.argv?.[0]).toBe(realpathSync(launcher))
    // A replaced interpreter cannot keep running or passing after admission.
    appendFileSync(launcher, '\n')
    await expect(validation.run(attempt.sessionId, codeValidationOperation(attempt.id, 2), check, {} as Commands, new AbortController().signal)).rejects.toThrow(/stale|runtime binding changed/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('settles a pre-producer material failure as retryable instead of a permanent running receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 't7-code-recover-'))
  try {
    const m = materials(directory)
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'original', text: 'Validate the registered source' })
    const saved = m.plans.save('owner', m.project.id, { expectedRevision: 0, operationId: 'recover-plan', plan: {
      goal: 'Validate', scope: 'One check', outputs: ['note'], resources: [m.sourceResource.id, m.configResource.id, m.runtimeResource.id],
      environment: 'Managed', cost: 'Bounded', completion: 'Checked',
      acceptance: { version: 1, mode: 'registered-files', codeCheck: { command: 'python3', args: [], profile: 'python-smoke', sourceVersion: 'unresolved', configVersion: 'unresolved' } } } })
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'go', text: '按这个方案做' })
    const confirmed = m.plans.confirm('owner', m.project.id, { projectId: m.project.id, ticketId: saved.ticketId, planRevision: 1, operationId: 'go', intent: 'execute' })
    const attempt = m.attempts.allocate(confirmed.ticket, confirmed.assignment)
    m.attempts.prepare(attempt)
    const check = m.plans.get('owner', m.project.id, saved.ticketId)!.acceptance!.codeCheck!
    let starts = 0
    const validation = new CodeValidation(m.store, m.attempts, { run: async () => { starts++; return { status: 'passed', exitCode: 0, stdout: '', stderr: '', physicalExit: true } } }, undefined, undefined, m.resources)
    durable(validation, m.store)
    const operationId = codeValidationOperation(attempt.id, 1), materialize = vi.spyOn(m.resources, 'materialize').mockImplementationOnce(() => { throw new Error('staged material unavailable') })
    await expect(validation.run(attempt.sessionId, operationId, check, {} as Commands, new AbortController().signal)).rejects.toThrow('staged material unavailable')
    expect(starts).toBe(0)
    expect(validation.get(attempt.id, operationId)).toBeUndefined()
    // The same operation retries after the known-not-started material failure without a native journal row.
    expect(await validation.run(attempt.sessionId, operationId, check, {} as Commands, new AbortController().signal)).toMatchObject({ status: 'passed' })
    expect(starts).toBe(1)
    materialize.mockRestore()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('rejects an interpreter that changed between review and admission instead of recapturing it', () => {
  const directory = mkdtempSync(join(tmpdir(), 't7-runtime-review-'))
  try {
    const m = materials(directory)
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'original', text: 'Validate the registered source' })
    const saved = m.plans.save('owner', m.project.id, { expectedRevision: 0, operationId: 'review-runtime', plan: {
      goal: 'Validate', scope: 'One check', outputs: ['note'], resources: [m.sourceResource.id, m.configResource.id, m.runtimeResource.id],
      environment: 'Managed', cost: 'Bounded', completion: 'Checked',
      acceptance: { version: 1, mode: 'registered-files', codeCheck: { command: 'python3', args: [], profile: 'python-smoke', sourceVersion: 'unresolved', configVersion: 'unresolved' } } } })
    const reviewed = m.plans.get('owner', m.project.id, saved.ticketId)!.acceptance!.codeCheck!
    expect(reviewed.runtimeVersion).toBe(m.resources.executable(m.project.id, m.runtimeResource.id).version)
    appendFileSync(m.runtimeResource.path, '\n# replaced after review\n')
    m.conversations.appendUser(m.project.id, 'owner', { clientRequestKey: 'go', text: '按这个方案做' })
    const confirmed = m.plans.confirm('owner', m.project.id, { projectId: m.project.id, ticketId: saved.ticketId, planRevision: 1, operationId: 'go', intent: 'execute' })
    expect(() => m.attempts.allocate(confirmed.ticket, confirmed.assignment)).toThrow('Code check runtime changed since review')
    expect(m.attempts.all()).toHaveLength(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


it('clears a running validation reservation whose process died before a native record existed, allowing the same operation again', () => {
  const root = mkdtempSync(join(tmpdir(), 't7-code-orphan-'))
  try {
    const check = { command: 'python3', args: ['-c', 'print(1)'], profile: 'python-smoke', sourceVersion: 'src-v1', configVersion: 'cfg-v1' }
    const f = workerFixture(root, { version: 1, mode: 'registered-files', codeCheck: check }); f.prepare()
    const operationId = codeValidationOperation(f.attempt.id, 1)
    f.store.db.prepare('INSERT INTO code_validation (id, attempt_id, operation_id, value) VALUES (?,?,?,?)').run('orphan', f.attempt.id, operationId,
      JSON.stringify({ status: 'running', attemptId: f.attempt.id, lease: f.attempt.lease, operationId }))
    const validation = new CodeValidation(f.store, f.attempts, { run: async () => ({ status: 'passed', exitCode: 0, stdout: 'ok\n', stderr: '' }) })
    durable(validation, f.store)
    expect(validation.get(f.attempt.id, operationId)).toBeUndefined()
    // The same operation id is no longer a UNIQUE reservation, so a retry can write its own receipt.
    expect(() => f.store.db.prepare('INSERT INTO code_validation (id, attempt_id, operation_id, value) VALUES (?,?,?,?)').run('retry', f.attempt.id, operationId,
      JSON.stringify({ status: 'passed', attemptId: f.attempt.id, lease: f.attempt.lease, operationId }))).not.toThrow()
    f.store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
