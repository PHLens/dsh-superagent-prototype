import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { workerFixture } from './fixtures/project-worker.ts'
import { projectWorkerTools } from '../src/app/tools/executor.ts'
import { Engine } from '../src/core/engine.ts'
import { githubNamespaceOf, githubThreadId } from '../src/sources/github-namespace.ts'
import { PROJECT_WORKER_RULES } from '../src/app/prompts.ts'
import { z } from 'zod'
import type { FileReport } from '../src/app/report-acceptance.ts'

let directory: string, f: ReturnType<typeof workerFixture> | undefined
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'project-execution-')) })
afterEach(() => { f?.store.close(); f = undefined; rmSync(directory, { recursive: true, force: true }) })

async function reportThroughTool(input: FileReport) {
  const { operationId, prUrl, ...payload } = input
  const tool = projectWorkerTools(f!.attempts, f!.artifacts, f!.reports, f!.attempt.sessionId).find(item => item.name === 'project_worker_report')!
  return tool.execute(tool.schema.parse({ ...payload, operation_id: operationId, ...(prUrl ? { pr_url: prUrl } : {}) }), new AbortController().signal)
}

it('explains ready/unresolved semantics and distinguishes report receipt from independent human acceptance', async () => {
  f = workerFixture(directory, { version: 3, mode: 'human-review' }); f.prepare()
  const artifact = f.write(), input = f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }])
  const tool = projectWorkerTools(f.attempts, f.artifacts, f.reports, f.attempt.sessionId).find(item => item.name === 'project_worker_report')!
  expect(PROJECT_WORKER_RULES).toContain('unresolved=[]')
  expect(z.toJSONSchema(tool.schema)).toMatchObject({ properties: {
    state: { description: expect.stringContaining('ready') }, unresolved: { description: expect.stringContaining('independent acceptance') },
  } })
  const receipt = await reportThroughTool(input), report = f.reports.reports(f.plan.ticketId)[0]!
  expect(receipt).toMatchObject({ received: true, reportId: report.id, currentReportId: report.id, isCurrentReport: true,
    currentStatus: { completed: false, waitingReason: 'semantic-review', unresolved: [] }, nextStep: expect.stringContaining('independent') })
  expect(f.store.tickets.get(f.plan.ticketId)?.ended).toBeUndefined()
  f.reports.decide('owner', f.project.id, { ticketId: f.plan.ticketId, operationId: 'accept', reportId: report.id, conclusion: 'passed', evidence: 'Read this exact note and checked the original request' })
  expect(await reportThroughTool(input)).toMatchObject({ reportId: report.id, isCurrentReport: true, currentStatus: { completed: true, waitingReason: null } })
  expect(f.reports.reports(f.plan.ticketId)).toEqual([report])
})

it('preserves real blockers despite a pass and separates historical receipts from current report completion', async () => {
  f = workerFixture(directory, { version: 2, mode: 'human-review' }); f.prepare()
  const artifact = f.write(), input = f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }], { unresolved: ['缺少第二个来源的原文'] })
  expect(await reportThroughTool(input)).toMatchObject({ currentStatus: { completed: false, waitingReason: 'unresolved-items', unresolved: input.unresolved }, nextStep: expect.stringContaining('Keep every remaining blocker') })
  const original = f.reports.reports(f.plan.ticketId)[0]!
  const pass = { ticketId: f.plan.ticketId, operationId: 'old-pass', reportId: original.id, conclusion: 'passed' as const, evidence: 'Reviewed the available artifact' }
  f.reports.decide('owner', f.project.id, pass)
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]?.waitingReason).toBe('unresolved-items')
  expect(f.store.tickets.get(f.plan.ticketId)?.ended).toBeUndefined()
  const message = f.conversations.listMessages(f.project.id, 'owner').find(item => item.id.startsWith(`worker-result:${original.id}:`))!.text
  expect(message).toContain('缺少第二个来源的原文'); expect(message).toContain('仍有未解决的工作事项'); expect(message).not.toContain('unresolved-items')
  const revised = f.write('# Note\nBoth sources verified.', 'revised-file')
  const nextInput = f.report([{ id: revised.id, contentVersion: revised.contentVersion }], { operationId: 'revised-report' })
  await reportThroughTool(nextInput)
  const current = f.reports.reports(f.plan.ticketId).at(-1)!
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]?.waitingReason).toBe('semantic-review')
  expect(() => f!.reports.decide('owner', f!.project.id, { ...pass, operationId: 'stale-pass' })).toThrow(/Stale/)
  const before = f.store.tickets.get(f.plan.ticketId), messages = f.conversations.listMessages(f.project.id, 'owner')
  expect(await reportThroughTool(input)).toMatchObject({ reportId: original.id, currentReportId: current.id, isCurrentReport: false,
    currentStatus: { completed: false, waitingReason: 'semantic-review', unresolved: [] }, nextStep: expect.stringContaining('historical receipt') })
  expect(f.store.tickets.get(f.plan.ticketId)).toEqual(before)
  expect(f.conversations.listMessages(f.project.id, 'owner')).toEqual(messages)
  f.reports.decide('owner', f.project.id, { ...pass, operationId: 'current-pass', reportId: current.id })
  expect(await reportThroughTool(input)).toMatchObject({ reportId: original.id, currentReportId: current.id, isCurrentReport: false,
    currentStatus: { completed: true, waitingReason: null }, nextStep: expect.stringContaining('historical receipt') })
  expect(f.reports.reports(f.plan.ticketId)).toEqual([original, current])
})

it.each(['missing-artifacts', 'progress', 'blocked', 'failed'] as const)('returns the actual %s status without claiming receipt completes work', async state => {
  f = workerFixture(directory); f.prepare()
  const artifact = f.write(), input = f.report(state === 'missing-artifacts' ? [] : [{ id: artifact.id, contentVersion: artifact.contentVersion }], { state: state === 'missing-artifacts' ? 'ready' : state })
  expect(await reportThroughTool(input)).toMatchObject({ received: true, isCurrentReport: true, currentStatus: { completed: false, waitingReason: state === 'progress' ? null : state }, nextStep: expect.any(String) })
  expect(f.store.tickets.get(f.plan.ticketId)?.ended).toBeUndefined()
})

it('returns only the effective Assignment authorization original request, even with English plans and other task messages', async () => {
  f = workerFixture(directory); f.prepare()
  const original = f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'chinese-original', text: '请用中文写一份有来源的说明。' })
  const plan = f.plans.save('owner', f.project.id, { expectedRevision: 0, operationId: 'second-plan', plan: { goal: 'English plan for a Chinese request', scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed worker', cost: 'One worker', completion: 'A sourced note' } })
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'second-confirm', text: '按这个方案做' })
  const confirmed = f.plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: plan.ticketId, planRevision: 1, operationId: 'second-confirm', intent: 'execute' })
  const attempt = f.attempts.prepare(f.attempts.allocate(confirmed.ticket, confirmed.assignment))
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'unrelated', text: 'PRIVATE unrelated discussion after both confirmations' })
  const context = (sessionId: string) => projectWorkerTools(f!.attempts, f!.artifacts, f!.reports, sessionId).find(item => item.name === 'project_worker_context')!
  const first = await context(f.attempt.sessionId).execute({}, new AbortController().signal)
  const second = await context(attempt.sessionId).execute({}, new AbortController().signal)
  expect(first).toMatchObject({ originalMessage: f.confirmed.authorization.originalMessage })
  expect(second).toMatchObject({ originalMessage: { id: original.id, text: original.text }, plan: { goal: plan.goal } })
  expect(JSON.stringify(first)).not.toContain(original.text)
  expect(JSON.stringify(second)).not.toContain(f.confirmed.authorization.originalMessage!.text)
  expect(JSON.stringify([first, second])).not.toContain('PRIVATE unrelated discussion')
  expect(context(attempt.sessionId).schema.safeParse({ ticketId: f.plan.ticketId }).success).toBe(false)
})

it('binds authorized Assignment to a server-owned attempt, lease, real cwd and preparation evidence', () => {
  f = workerFixture(directory)
  expect(() => f!.attempts.resolve(f!.attempt.sessionId)).toThrow(/unauthorized/)
  f.prepare()
  const resolved = f.attempts.resolve(f.attempt.sessionId)
  expect(resolved.assignment.id).toBe(f.confirmed.assignment.id)
  expect(resolved.attempt.prepare).toMatchObject({ method: 'managed-empty-directory-v1', realpath: f.attempt.cwd })
  expect(f.attempts.allocate(f.confirmed.ticket, f.confirmed.assignment).id).toBe(f.attempt.id)
  expect(() => f!.attempts.resolve('worker-' + f!.plan.ticketId)).toThrow(/unauthorized/)
  expect(projectWorkerTools(f.attempts, f.artifacts, f.reports, f.attempt.sessionId).map(tool => tool.name)).toEqual(['project_worker_context', 'project_read_input', 'project_write_artifact', 'project_worker_report'])
})

it('completes an explicitly confirmed file contract without GitHub or a coordinator call, with durable replay', () => {
  f = workerFixture(directory, { version: 1, mode: 'registered-files' }); f.prepare()
  const artifact = f.write(), input = f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }])
  const receipt = f.reports.submit(f.attempt.sessionId, input)
  expect(f.store.tickets.get(f.plan.ticketId)?.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  expect(f.attempts.bySession(f.attempt.sessionId)?.status).toBe('ended')
  expect(f.reports.submit(f.attempt.sessionId, input)).toEqual(receipt)
  expect(f.write().id).toBe(artifact.id)
  expect(() => f!.reports.submit(f!.attempt.sessionId, { ...input, operationId: 'new-after-end' })).toThrow(/unauthorized/)
  const messages = f.conversations.listMessages(f.project.id, 'owner').filter(message => message.id.startsWith('worker-result:'))
  expect(messages).toHaveLength(1); expect(messages[0]?.status).toBe('saved')
})

it('holds missing artifacts and unresolved matters instead of treating model ready as completion', () => {
  f = workerFixture(directory, { version: 1, mode: 'registered-files' }); f.prepare()
  f.reports.submit(f.attempt.sessionId, f.report([]))
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]?.waitingReason).toBe('missing-artifacts')
  const artifact = f.write()
  f.reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }], { operationId: 'unresolved', unresolved: ['Source still requires review'] }))
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]?.waitingReason).toBe('unresolved-items')
  expect(f.store.tickets.get(f.plan.ticketId)?.ended).toBeUndefined()
})

it('does not let a ready report complete an assignment with an unanswered Attention question', () => {
  f = workerFixture(directory, { version: 1, mode: 'registered-files' }); f.prepare()
  const ticket = f.store.tickets.get(f.plan.ticketId)!
  ticket.attention = { id: 'question-1', version: 1, question: 'Which source should be used?', binding: { assignmentId: f.attempt.assignmentId, attemptId: f.attempt.id, lease: f.attempt.lease, sessionId: f.attempt.sessionId }, answers: [] }
  f.store.tickets.save(ticket)
  const artifact = f.write()
  const report = f.reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }]))
  expect(report.state).toBe('ready')
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]?.waitingReason).toBe('unresolved-question')
  expect(f.store.tickets.get(f.plan.ticketId)?.ended).toBeUndefined()
  expect(f.attempts.bySession(f.attempt.sessionId)?.status).toBe('prepared')
})

it('persists independent semantic decisions against the exact report, artifact and condition versions', () => {
  f = workerFixture(directory, { version: 3, mode: 'human-review' }); f.prepare()
  const artifact = f.write(), input = f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }])
  const report = f.reports.submit(f.attempt.sessionId, input)
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]?.waitingReason).toBe('semantic-review')
  const request = { ticketId: f.plan.ticketId, operationId: 'judge-1', reportId: report.id, conclusion: 'changes_required' as const, evidence: 'Need a second source' }
  expect(() => f!.reports.decide('other-owner', f!.project.id, request)).toThrow(/ownership/)
  const changes = f.reports.decide('owner', f.project.id, request)
  expect(changes).toMatchObject({ conditionsVersion: 3, conclusion: 'changes_required', judge: { actorId: 'owner', generation: f.attempt.lease } })
  expect(f.store.tickets.get(f.plan.ticketId)?.ended).toBeUndefined()
  const revised = f.write('# Revised note\nTwo verified sources.', 'file-2')
  const next = f.reports.submit(f.attempt.sessionId, f.report([{ id: revised.id, contentVersion: revised.contentVersion }], { operationId: 'report-2' }))
  expect(f.store.tickets.get(f.plan.ticketId)?.assignments[0]?.waitingReason).toBe('semantic-review')
  expect(() => f!.reports.decide('owner', f!.project.id, { ...request, operationId: 'stale-gate', conclusion: 'passed' })).toThrow(/Stale/)
  const pass = { ...request, operationId: 'judge-2', reportId: next.id, conclusion: 'passed' as const, evidence: 'Read both references and reviewed the note' }
  const decision = f.reports.decide('owner', f.project.id, pass)
  expect(f.reports.decide('owner', f.project.id, pass)).toEqual(decision)
  expect(decision.targetVersion).not.toBe(changes.targetVersion)
  expect(f.store.tickets.get(f.plan.ticketId)?.ended?.outcome).toBe('completed')
})

it('rejects revoked authorization, stale lease and mismatched directory identities', () => {
  f = workerFixture(directory); f.prepare()
  const forged = { ...f.attempt, id: 'replacement', sessionId: 'replacement-session', lease: 'new-lease' }
  f.attempts.save(forged)
  expect(() => f!.write()).toThrow(/unauthorized/)
  f.attempts.save({ ...forged, cwd: directory })
  expect(() => f!.attempts.resolve(forged.sessionId)).toThrow(/realpath/)
  f.attempts.save(forged)
  f.plans.revoke('owner', f.project.id, { projectId: f.project.id, ticketId: f.plan.ticketId, authorizationId: f.confirmed.authorization.id, operationId: 'revoke' })
  expect(() => f!.attempts.resolve(forged.sessionId)).toThrow(/unauthorized/)
})

it('quarantines unknown prepare leftovers and symlink parents rather than adopting them', () => {
  f = workerFixture(directory)
  mkdirSync(f.attempt.cwd, { recursive: true })
  expect(() => f!.prepare()).toThrow()
  expect(f.attempts.bySession(f.attempt.sessionId)?.status).toBe('reconcile')
  // A separate managed tree checks a symlink before creating files beneath it.
  const otherRoot = join(directory, 'outside'); mkdirSync(otherRoot)
  const parent = join(f.attempt.root, 'artifacts'); symlinkSync(otherRoot, parent)
  expect(() => f!.artifacts.write(f!.attempt.sessionId, { operationId: 'x', output: 'note', name: 'x.md', content: 'x' })).toThrow()
})

it('validates and binds a reported PR inside the Attempt registered repository, idempotently', () => {
  f = workerFixture(directory, { version: 1, mode: 'human-review' }); f.prepare()
  f.attempts.pinIdentity(f.attempt.id, { executionId: f.attempt.id, projectId: f.project.id, repositoryId: 'resource-1', repository: 'acme/widgets', accountId: 'agent-bot', accountCli: '/bin/false', gitAuthorName: 'Agent', gitAuthorEmail: 'agent@example.com', deliveryBranch: 'fix', capturedAt: new Date().toISOString() })
  const bindThread = vi.fn(), patch = vi.fn()
  const github = { deployment: { repository: 'acme/widgets', github: { cli: '/bin/false', login: 'agent-bot', noreply: '' } }, githubNamespace: { projectId: f.project.id, resourceId: 'resource-1', account: 'agent-bot', repository: 'acme/widgets' },
    tickets: { get: (id: string) => f!.store.tickets.get(id), open: () => f!.store.tickets.open(), bindThread, threadClosed: vi.fn() },
    triggers: { get: () => ({ source: 'github', meta: { isPr: true, number: 7 } }) }, threads: { patch }, atomic: <T>(work: () => T): T => f!.store.atomic(work) } as unknown as import('../src/sources/host.ts').SourceContext
  f.reports.setGithubContext(() => github)
  const pull = { number: 7, title: 'Fix', state: 'open', html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'agent-bot' }, head: { sha: 'abc', ref: 'fix', repo: { full_name: 'acme/widgets' } } }
  const input = { operationId: 'pr-report', state: 'ready' as const, completed: 'Opened the PR', evidence: ['Read the PR'], artifacts: [], unresolved: [], prUrl: pull.html_url }
  const report = f.reports.submit(f.attempt.sessionId, input, pull)
  expect(bindThread).toHaveBeenCalledWith(f.plan.ticketId, { source: 'github', id: '7' }, true)
  expect(patch).toHaveBeenCalledWith(expect.stringMatching(/^github:[a-f0-9]{64}:7$/), expect.any(Object))
  expect(f.reports.reports(f.plan.ticketId)[0]).toMatchObject({ id: report.id, prUrl: pull.html_url })
  // A replay of the same report never claims or binds the PR a second time.
  expect(f.reports.submit(f.attempt.sessionId, input, pull).id).toBe(report.id)
  expect(bindThread).toHaveBeenCalledTimes(1)
  // A foreign repository/URL is rejected inside the report transaction.
  expect(() => f!.reports.submit(f!.attempt.sessionId, { ...input, operationId: 'foreign-report', prUrl: 'https://github.com/other/repo/pull/8' },
    { ...pull, number: 8, html_url: 'https://github.com/other/repo/pull/8' })).toThrow('registered repository')
  expect(f.reports.reports(f.plan.ticketId)).toHaveLength(1)
})


it('reports a real persisted PR claim, keeps an open Follow, then completes when that Follow closes', async () => {
  f = workerFixture(directory, { version: 1, mode: 'registered-files' }); f.prepare()
  f.attempts.pinIdentity(f.attempt.id, { executionId: f.attempt.id, projectId: f.project.id, repositoryId: 'resource-1', repository: 'acme/widgets',
    accountId: 'agent-bot', accountCli: '/bin/false', gitAuthorName: 'Agent', gitAuthorEmail: 'agent@example.com', deliveryBranch: 'agent/project-real', capturedAt: new Date().toISOString() })
  const namespace = githubNamespaceOf({ projectId: f.project.id, repositoryId: 'resource-1', accountId: 'agent-bot', repository: 'acme/widgets' })!
  const threadKey = githubThreadId(namespace, 7)
  const thread = { source: 'github' as const, id: threadKey.replace(/^github:/, '') }
  const pull = { number: 7, title: 'Fix', state: 'open', html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'agent-bot' },
    head: { sha: 'abc', ref: 'agent/project-real', repo: { full_name: 'acme/widgets' } } }
  const commands = { withSignal: () => commands, api: async () => pull }
  const engine = new Engine({ repo: f.store, scope: {}, policy: () => ({}), assessor: {}, executor: {}, outbox: {} } as never)
  const bindThread = vi.fn((id: string, _ref: typeof thread, own: boolean) => engine.bindThread(id, thread, own))
  const github = { deployment: { repository: 'acme/widgets', github: { cli: '/bin/false', login: 'agent-bot', noreply: '' } }, githubNamespace: namespace, commands,
    tickets: { get: (id: string) => f!.store.tickets.get(id), open: () => f!.store.tickets.open(), bindThread,
      threadClosed: (_ref: typeof thread, outcome: 'merged' | 'closed', at: string) => engine.threadClosed(thread, outcome, at) },
    triggers: { get: () => ({ source: 'github', meta: { isPr: true, number: 7 } }) },
    threads: { patch: (key: string, meta: unknown) => f!.store.threads.patchMeta(key, meta as never) },
    atomic: <T>(work: () => T): T => f!.store.atomic(work) } as unknown as import('../src/sources/host.ts').SourceContext
  f.reports.setGithubContext(() => github)
  const artifact = f.write()
  const input = { operationId: 'real-pr', state: 'ready' as const, completed: 'Opened the PR', evidence: ['Read the PR'], artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [], prUrl: pull.html_url }
  const receipt = await reportThroughTool({ ...input, prUrl: pull.html_url })
  const report = f.reports.reports(f.plan.ticketId)[0]!
  expect(receipt).toMatchObject({ reportId: report.id, isCurrentReport: true })
  const claimed = f.store.tickets.get(f.plan.ticketId)!
  expect(claimed.ended).toBeUndefined()
  expect(claimed.follows).toContainEqual(expect.objectContaining({ thread: threadKey, own: true }))
  expect(claimed.follows?.find(item => item.thread === threadKey)).not.toHaveProperty('closed')
  expect(f.store.threads.get(threadKey)?.subscriptions).toContain(f.plan.ticketId)
  expect(f.reports.reports(f.plan.ticketId)[0]).toMatchObject({ id: report.id, prUrl: pull.html_url })
  // The Executor reporting done does not end a Ticket that still follows its open PR.
  engine.threadClosed(thread, 'merged', '2026-09-09T00:00:00Z')
  expect(f.store.tickets.get(f.plan.ticketId)?.ended).toMatchObject({ by: 'executor', outcome: 'merged' })
  expect(f.store.tickets.get(f.plan.ticketId)?.follows?.find(item => item.thread === threadKey)?.closed).toBeTruthy()
})

it('replays an exact committed PR report from its durable receipt when the provider is unavailable, without a read or claim', async () => {
  f = workerFixture(directory, { version: 1, mode: 'registered-files' }); f.prepare()
  f.attempts.pinIdentity(f.attempt.id, { executionId: f.attempt.id, projectId: f.project.id, repositoryId: 'resource-1', repository: 'acme/widgets',
    accountId: 'agent-bot', accountCli: '/bin/false', gitAuthorName: 'Agent', gitAuthorEmail: 'agent@example.com', deliveryBranch: 'agent/project-replay', capturedAt: new Date().toISOString() })
  const namespace = githubNamespaceOf({ projectId: f.project.id, repositoryId: 'resource-1', accountId: 'agent-bot', repository: 'acme/widgets' })!
  const threadKey = githubThreadId(namespace, 8)
  const thread = { source: 'github' as const, id: threadKey.replace(/^github:/, '') }
  const pull = { number: 8, title: 'Fix', state: 'open', html_url: 'https://github.com/acme/widgets/pull/8', user: { login: 'agent-bot' },
    head: { sha: 'abc', ref: 'agent/project-replay', repo: { full_name: 'acme/widgets' } } }
  const commands = { withSignal: () => commands, api: vi.fn(async () => pull) }
  const engine = new Engine({ repo: f.store, scope: {}, policy: () => ({}), assessor: {}, executor: {}, outbox: {} } as never)
  const bindThread = vi.fn((id: string, _ref: typeof thread, own: boolean) => engine.bindThread(id, thread, own))
  const github = { deployment: { repository: 'acme/widgets', github: { cli: '/bin/false', login: 'agent-bot', noreply: '' } }, githubNamespace: namespace, commands,
    tickets: { get: (id: string) => f!.store.tickets.get(id), open: () => f!.store.tickets.open(), bindThread,
      threadClosed: (_ref: typeof thread, outcome: 'merged' | 'closed', at: string) => engine.threadClosed(thread, outcome, at) },
    triggers: { get: () => ({ source: 'github', meta: { isPr: true, number: 8 } }) },
    threads: { patch: (key: string, meta: unknown) => f!.store.threads.patchMeta(key, meta as never) },
    atomic: <T>(work: () => T): T => f!.store.atomic(work) } as unknown as import('../src/sources/host.ts').SourceContext
  f.reports.setGithubContext(() => github)
  const artifact = f.write()
  const input: FileReport = { operationId: 'replay-pr', state: 'ready', completed: 'Opened the PR', evidence: ['Read the PR'],
    artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [], prUrl: pull.html_url }
  const first = await reportThroughTool(input) as { reportId: string; currentReportId: string }
  expect(first).toMatchObject({ received: true, isCurrentReport: true })
  expect(f.reports.reports(f.plan.ticketId)).toHaveLength(1)
  expect(commands.api).toHaveBeenCalledTimes(1)
  expect(bindThread).toHaveBeenCalledTimes(1)

  // Losing the provider after the commit must not turn an exact retry into a provider read, a claim, or a second report.
  commands.api.mockRejectedValue(new Error('provider unavailable'))
  const replay = await reportThroughTool(input)
  expect(replay).toMatchObject({ reportId: first.reportId, currentReportId: first.currentReportId, isCurrentReport: true })
  expect(commands.api).toHaveBeenCalledTimes(1)
  expect(bindThread).toHaveBeenCalledTimes(1)
  expect(f.reports.reports(f.plan.ticketId)).toHaveLength(1)

  // The same operation with changed content fails explicitly before the provider is read.
  await expect(reportThroughTool({ ...input, completed: 'Changed content' })).rejects.toThrow('Report operation id conflict')
  expect(commands.api).toHaveBeenCalledTimes(1)
  // A genuinely new operation still takes the full validation path, which now fails at the unavailable provider.
  await expect(reportThroughTool({ ...input, operationId: 'replay-pr-2' })).rejects.toThrow('provider unavailable')
  expect(commands.api).toHaveBeenCalledTimes(2)
  expect(f.reports.reports(f.plan.ticketId)).toHaveLength(1)

  // An exact committed receipt also survives authorization revocation; it must not be reauthorized or re-read.
  const revoked = f.store.tickets.get(f.plan.ticketId)!
  revoked.authorizations![0]!.revokedAt = new Date().toISOString()
  f.store.tickets.save(revoked)
  const afterRevocation = await reportThroughTool(input)
  expect(afterRevocation).toMatchObject({ reportId: first.reportId, currentReportId: first.currentReportId, isCurrentReport: true })
  expect(commands.api).toHaveBeenCalledTimes(2)
  expect(f.reports.reports(f.plan.ticketId)).toHaveLength(1)
})
