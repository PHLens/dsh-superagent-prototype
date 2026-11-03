import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { workerFixture } from './fixtures/project-worker.ts'
import { assignmentReady, type AssignmentProposal } from '../src/core/index.ts'

let directory: string, f: ReturnType<typeof workerFixture>
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'assignment-dependencies-')) })
afterEach(() => { f?.store.close(); rmSync(directory, { recursive: true, force: true }) })
const node = (key: string, dependencies: string[] = []): AssignmentProposal => ({ key, dependencies, goal: key, outputs: [key === 'a' ? 'note' : key], completion: 'Read and verify sources', resources: [], cost: 'One attempt', writeScope: 'isolated-directory', acceptance: { version: 1, mode: key === 'a' ? 'human-review' : 'registered-files' } })

it('runs a registered reviewer on an unaccepted ready receipt while ordinary downstream waits for a bound pass', () => {
  f = workerFixture(directory, undefined, [node('a'), { ...node('review', ['a']), review: { target: 'a', conditionsVersion: 1 } }, node('synthesis', ['a'])])
  f.prepare()
  const artifact = f.write(), report = f.reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }]))
  let ticket = f.store.tickets.get(f.plan.ticketId)!
  const [target, review, synthesis] = ticket.assignments
  expect(target!.report?.state).toBe('waiting')
  expect(target!.reportReceipt).toMatchObject({ id: report.id, state: 'ready', attemptId: f.attempt.id, lease: f.attempt.lease })
  expect(assignmentReady(ticket, review!).ready).toBe(true)
  expect(assignmentReady(ticket, synthesis!).ready).toBe(false)
  expect(() => f.attempts.allocate(ticket, synthesis!)).toThrow(/not accepted/)
  const judge = f.attempts.prepare(f.attempts.allocate(ticket, review!))
  expect(judge.reviewTarget).toMatchObject({ reportId: report.id, lease: report.lease, artifacts: report.artifacts })
  expect(judge.inputs).toEqual([{ artifactId: artifact.id, contentVersion: artifact.contentVersion, assignmentId: target!.id, reportId: report.id }])
  expect(() => f.reports.decideWorker(f.attempt.sessionId, { reportId: report.id, operationId: 'self', conclusion: 'passed', evidence: 'self review' })).toThrow(/registered target/)
  const decision = f.reports.decideWorker(judge.sessionId, { reportId: report.id, operationId: 'pass', conclusion: 'passed', evidence: 'Read the exact note and verified its sources' })
  expect(decision.judge).toMatchObject({ source: 'registered-worker', attemptId: judge.id, lease: judge.lease })
  ticket = f.store.tickets.get(ticket.id)!
  expect(ticket.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'accepted' })
  expect(assignmentReady(ticket, ticket.assignments[2]!).ready).toBe(true)
  expect(f.attempts.allocate(ticket, ticket.assignments[2]!).inputs).toEqual(judge.inputs)
})

it('rejects a judge of an older report even when artifact bytes are identical', () => {
  f = workerFixture(directory, undefined, [node('a'), { ...node('review', ['a']), review: { target: 'a', conditionsVersion: 1 } }])
  f.prepare()
  const artifact = f.write(), refs = [{ id: artifact.id, contentVersion: artifact.contentVersion }]
  const first = f.reports.submit(f.attempt.sessionId, f.report(refs))
  const ticket = f.store.tickets.get(f.plan.ticketId)!, judge = f.attempts.prepare(f.attempts.allocate(ticket, ticket.assignments[1]!))
  const second = f.reports.submit(f.attempt.sessionId, f.report(refs, { operationId: 'new-report' }))
  expect(second.id).not.toBe(first.id)
  expect(() => f.reports.decideWorker(judge.sessionId, { reportId: first.id, operationId: 'stale-pass', conclusion: 'passed', evidence: 'Old report' })).toThrow(/Stale/)
  expect(f.reports.decisions(ticket.id)).toHaveLength(0)
  expect(f.store.tickets.get(ticket.id)?.assignments[0]?.state).not.toBe('ended')
})
