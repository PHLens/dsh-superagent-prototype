import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { workerFixture } from './fixtures/project-worker.ts'
import { Store } from '../src/app/store.ts'
import { ExecutionAttempts } from '../src/app/execution-attempts.ts'
import { ArtifactStore } from '../src/app/artifact-store.ts'
import { ReportAcceptance } from '../src/app/report-acceptance.ts'
import { projectWorkerTools } from '../src/app/tools/executor.ts'

let directory: string, f: ReturnType<typeof workerFixture>, reopened: Store | undefined
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'artifact-recovery-')); f = workerFixture(directory); f.prepare() })
afterEach(() => { vi.restoreAllMocks(); if (reopened) reopened.close(); else f.store.close(); reopened = undefined; rmSync(directory, { recursive: true, force: true }) })

it('reconciles a durable intent interrupted before the file effect after database reopen', () => {
  const fault = vi.spyOn(f.artifacts, 'reconcile').mockImplementationOnce(() => { throw new Error('simulated process interruption') })
  expect(() => f.write()).toThrow(/interruption/)
  const intent = f.artifacts.list(f.project.id)[0]!
  expect(intent.status).toBe('writing'); fault.mockRestore()
  reopened = new Store(join(directory, 'project.sqlite')); f.store.close()
  const attempts = new ExecutionAttempts(reopened, directory), artifacts = new ArtifactStore(reopened, attempts)
  const recovered = artifacts.write(f.attempt.sessionId, { operationId: 'file-1', output: 'note', name: 'note.md', content: intent.content })
  expect(recovered.id).toBe(intent.id); expect(recovered.status).toBe('registered')
  expect(readFileSync(recovered.path, 'utf8')).toBe(intent.content)
  expect(artifacts.list(f.project.id)).toHaveLength(1)
})

it('reconciles a matching file effect interrupted before registration without duplicating or overwriting it', () => {
  const fault = vi.spyOn(f.artifacts, 'reconcile').mockImplementationOnce(() => { throw new Error('interruption') })
  expect(() => f.write()).toThrow(); fault.mockRestore()
  const intent = f.artifacts.list(f.project.id)[0]!
  mkdirSync(join(f.attempt.root, 'artifacts', intent.id), { recursive: true })
  writeFileSync(intent.path, intent.content, { mode: 0o600, flag: 'wx' })
  expect(f.write().id).toBe(intent.id)
  expect(f.artifacts.list(f.project.id)).toHaveLength(1)
  expect(() => f.write('different bytes')).toThrow(/conflict/)
})

it('rejects corrupt, missing, foreign-project and mismatched-version files at read and completion', () => {
  const artifact = f.write()
  expect(() => f.artifacts.read('another-project', artifact.id, artifact.contentVersion)).toThrow(/not found/)
  expect(() => f.artifacts.read(f.project.id, artifact.id, 'unregistered-version')).toThrow(/not found/)
  writeFileSync(artifact.path, 'tampered file')
  expect(() => f.artifacts.read(f.project.id, artifact.id, artifact.contentVersion)).toThrow(/changed/)
  expect(() => f.reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }]))).toThrow(/changed/)
  expect(f.reports.reports(f.plan.ticketId)).toHaveLength(0)
  rmSync(artifact.path)
  expect(() => f.write()).toThrow(/missing/)
})

it('rejects an artifact symlink parent before writing outside its managed root', () => {
  const outside = join(directory, 'outside'); mkdirSync(outside)
  symlinkSync(outside, join(f.attempt.root, 'artifacts'))
  expect(() => f.write()).toThrow(/symlink/)
  expect(readdirSync(outside)).toEqual([])
})

it('pins approved input content versions through confirmation and only lets the consumer read those exact versions', async () => {
  const original = f.write()
  const revised = f.artifacts.write(f.attempt.sessionId, { operationId: 'file-v2', output: 'note', name: 'note.md', content: 'Revised source content' })
  const { projectId: _project, ticketId: _ticket, revision: _revision, createdAt: _at, ...content } = f.plan
  expect(() => f.plans.save('owner', f.project.id, { expectedRevision: 0, operationId: 'bad-input', plan: { ...content, artifactInputs: [{ artifactId: original.id, contentVersion: 'unregistered-version' }] } })).toThrow()
  const plan = f.plans.save('owner', f.project.id, { expectedRevision: 0, operationId: 'consumer-plan', plan: { ...content, artifactInputs: [{ artifactId: original.id, contentVersion: original.contentVersion }] } })
  f.conversations.appendUser(f.project.id, 'owner', { clientRequestKey: 'consumer-confirm', text: '按这个方案做' })
  const result = f.plans.confirm('owner', f.project.id, { projectId: f.project.id, ticketId: plan.ticketId, planRevision: 1, operationId: 'consumer-confirm', intent: 'execute' })
  expect(result.assignment.contract?.inputs).toEqual([{ kind: 'artifact', artifactId: original.id, contentVersion: original.contentVersion }])
  const attempt = f.attempts.prepare(f.attempts.allocate(f.store.tickets.get(plan.ticketId)!, result.assignment))
  const read = projectWorkerTools(f.attempts, f.artifacts, f.reports, attempt.sessionId).find(item => item.name === 'project_read_input')!
  const signal = new AbortController().signal
  expect(await read.execute({ id: original.id, contentVersion: original.contentVersion }, signal)).toMatchObject({ content: original.content })
  await expect(read.execute({ id: revised.id, contentVersion: revised.contentVersion }, signal)).rejects.toThrow(/not pinned/)
  writeFileSync(original.path, 'tampered after approval')
  await expect(read.execute({ id: original.id, contentVersion: original.contentVersion }, signal)).rejects.toThrow(/changed/)
})
it('keeps completed reports, decisions and project conversation returns after reopen', () => {
  const item = f.write(), report = f.reports.submit(f.attempt.sessionId, f.report([{ id: item.id, contentVersion: item.contentVersion }]))
  const decisionInput = { ticketId: f.plan.ticketId, operationId: 'accept', reportId: report.id, conclusion: 'passed' as const, evidence: 'Reviewed content against original request' }
  const decision = f.reports.decide('owner', f.project.id, decisionInput)
  reopened = new Store(join(directory, 'project.sqlite')); f.store.close()
  const attempts = new ExecutionAttempts(reopened, directory), artifacts = new ArtifactStore(reopened, attempts), reports = new ReportAcceptance(reopened, attempts, artifacts)
  expect(reports.decide('owner', f.project.id, decisionInput)).toEqual(decision)
  expect(reports.submit(f.attempt.sessionId, f.report([{ id: item.id, contentVersion: item.contentVersion }]))).toEqual(report)
  expect(reopened.tickets.get(f.plan.ticketId)?.ended?.outcome).toBe('completed')
  expect(artifacts.read(f.project.id, item.id, item.contentVersion).content).toBe(item.content)
  expect(reopened.db.prepare("SELECT id FROM conversation_message WHERE id LIKE 'worker-result:%'").all()).toHaveLength(2)
})
