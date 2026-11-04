/** Real rc.5 output validation with application SQLite/tool bodies; no provider or browser claim. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { projectWorkerTools } from '../src/app/tools/executor.ts'
import { CodeValidation, codeValidationOperation } from '../src/app/code-validation.ts'
import type { Commands } from '../src/infra/commands.ts'
import { projectTools } from '../src/app/tools/main.ts'
import type { Tool } from '../src/app/tools/tool.ts'
import { workerFixture } from './fixtures/project-worker.ts'

const rcRoot = process.env.DSH_RC5_RUNTIME
const suite = rcRoot ? describe : describe.skip
export async function nativeTools(definitions: Tool[]) {
  const req = createRequire(join(rcRoot!, 'package.json'))
  expect(req('@deepseek-ai/dsh-tools/package.json').version).toBe('0.2.1-rc.5')
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const { ToolRuntime } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href)
  const ctx = new Context()
  ctx.reflect.provide('systemPrompt', { tools: () => () => {} })
  const runtime = new ToolRuntime(ctx)
  const disposers = definitions.map(item => runtime.register({ name: item.name, description: item.description,
    parameters: z.toJSONSchema(item.schema),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args: unknown, exec: { signal: AbortSignal }) => item.execute(item.schema.parse(args), exec.signal) }))
  return { call: (name: string, args = {}) => runtime.execute({ callId: crypto.randomUUID(), name, arguments: args, signal: new AbortController().signal }),
    dispose: () => disposers.forEach(dispose => dispose()) }
}

suite('project application results through actual rc.5 canonical output validation', () => {
  it('returns readable ordinary worker context without inventing an absent review target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-json-')), f = workerFixture(dir, { version: 1, mode: 'registered-files' })
    f.prepare()
    const native = await nativeTools(projectWorkerTools(f.attempts, f.artifacts, f.reports, f.attempt.sessionId))
    try {
      const result = await native.call('project_worker_context')
      expect(result.isError).toBe(false)
      expect(result.value.plan.outputs).toEqual(['note'])
      expect(result.value.originalMessage.text).toContain('Write a sourced note')
      expect(result.value.pinnedInputs).toEqual([])
      expect(result.value).not.toHaveProperty('reviewTarget')
    } finally { native.dispose(); f.store.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('retains a reviewer exact target and pinned artifact versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reviewer-json-'))
    const common = { resources: [], cost: 'One worker', writeScope: 'isolated-directory' as const, retry: { on: [], limit: 0 } }
    const f = workerFixture(dir, { version: 1, mode: 'registered-files' }, [
      { ...common, key: 'producer', goal: 'Produce note', outputs: ['note'], completion: 'Check note', dependencies: [], acceptance: { version: 1, mode: 'human-review' } },
      { ...common, key: 'reviewer', goal: 'Review note', outputs: ['review'], completion: 'Review exact note', dependencies: ['producer'], acceptance: { version: 1, mode: 'registered-files' }, review: { target: 'producer', conditionsVersion: 1 } },
    ])
    f.prepare(); const artifact = f.write(), report = f.reports.submit(f.attempt.sessionId, f.report([artifact]))
    const attempt = f.attempts.allocate(f.store.tickets.get(f.plan.ticketId)!, f.store.tickets.get(f.plan.ticketId)!.assignments[1]!)
    f.attempts.prepare(attempt)
    const native = await nativeTools(projectWorkerTools(f.attempts, f.artifacts, f.reports, attempt.sessionId))
    try {
      const result = await native.call('project_worker_context')
      expect(result.isError).toBe(false)
      expect(result.value.reviewTarget.reportId).toBe(report.id)
      expect(result.value.pinnedInputs).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId: artifact.id, contentVersion: artifact.contentVersion })]))
    } finally { native.dispose(); f.store.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('reads absent/current facts, report pages and draft listings through the native boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-json-')), f = workerFixture(dir, { version: 1, mode: 'registered-files' })
    f.prepare()
    const draft = f.projects.createDraft(f.project.id, { title: 'Unplanned discussion' })
    const native = await nativeTools(projectTools({ plans: f.plans, projectId: f.project.id, actorId: 'owner', authorize() {} }))
    try {
      const list = await native.call('project_list_plans')
      expect(list.isError).toBe(false)
      expect(list.value.items.find((item: { ticketId: string }) => item.ticketId === draft.id)).not.toHaveProperty('currentGraph')
      const empty = await native.call('project_read_assignment_facts', { ticket_id: f.plan.ticketId })
      expect(empty.isError).toBe(false)
      expect(empty.value.assignments[0]).not.toHaveProperty('report')
      expect(empty.value.assignments[0]).not.toHaveProperty('decision')
      const report = f.reports.submit(f.attempt.sessionId, f.report([], { state: 'blocked', unresolved: ['Native context unavailable'] }))
      const facts = await native.call('project_read_assignment_facts', { ticket_id: f.plan.ticketId })
      expect(facts.isError).toBe(false)
      expect(facts.value.assignments[0].report.id).toBe(report.id)
      const page = await native.call('project_read_fact', { ticket_id: f.plan.ticketId, kind: 'report', id: report.id })
      expect(page.isError).toBe(false)
      expect(JSON.parse(page.value.content).id).toBe(report.id)
      const foreign = await native.call('project_read_assignment_facts', { ticket_id: 'unowned-task' })
      expect(foreign.isError).toBe(true)
    } finally { native.dispose(); f.store.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it.each([
    ['passed', { status: 'passed', exitCode: 0, signal: undefined }],
    ['failed', { status: 'failed', exitCode: 1, signal: undefined }],
    ['aborted', { status: 'aborted', exitCode: 143, signal: 'SIGTERM' }],
    ['unknown', { status: 'unknown', signal: undefined, error: 'process range remained occupied' }],
  ] as const)('validates %s code receipts through rc.5 ToolRuntime', async (_label, outcome) => {
    const dir = mkdtempSync(join(tmpdir(), 'code-validation-json-'))
    const check = { command: 'python3', args: ['-c', 'print(1)'], profile: 'python-smoke', sourceVersion: 'src-v1', configVersion: 'cfg-v1' }
    const f = workerFixture(dir, { version: 1, mode: 'registered-files', codeCheck: check }); f.prepare()
    f.attempts.pinIdentity(f.attempt.id, { executionId: f.attempt.id, projectId: f.project.id, repositoryId: 'resource-1', repository: 'owner/repo', accountId: 'owner', accountCli: 'gh', gitAuthorName: 'Owner', gitAuthorEmail: 'owner@example.com', capturedAt: new Date().toISOString() })
    const validation = new CodeValidation(f.store, f.attempts, { run: async () => ({ ...outcome, stdout: 'out\\n', stderr: '' }) })
    const native = await nativeTools(projectWorkerTools(f.attempts, f.artifacts, f.reports, f.attempt.sessionId, undefined, undefined, validation, {} as Commands))
    try {
      const result = await native.call('project_validate_code', { operation_id: codeValidationOperation(f.attempt.id, 1) })
      expect(result.isError).toBe(false)
      expect(JSON.parse(JSON.stringify(result.value))).toMatchObject({ status: outcome.status, operationId: codeValidationOperation(f.attempt.id, 1) })
    } finally { native.dispose(); f.store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
