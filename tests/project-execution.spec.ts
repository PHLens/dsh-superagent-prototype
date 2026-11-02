import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { workerFixture } from './fixtures/project-worker.ts'
import { projectWorkerTools } from '../src/app/tools/executor.ts'

let directory: string, f: ReturnType<typeof workerFixture> | undefined
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'project-execution-')) })
afterEach(() => { f?.store.close(); f = undefined; rmSync(directory, { recursive: true, force: true }) })

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
