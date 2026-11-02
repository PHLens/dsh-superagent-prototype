import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { workerFixture } from './fixtures/project-worker.ts'
import { projectProgress } from '../src/app/project-progress.ts'

let directory: string, f: ReturnType<typeof workerFixture>
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'project-progress-')); f = workerFixture(directory, { version: 3, mode: 'human-review' }); f.prepare() })
afterEach(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }) })
const facts = () => ({ attempts: f.attempts.all(), reports: f.reports.reports(f.plan.ticketId), decisions: f.reports.decisions(f.plan.ticketId), artifacts: f.artifacts.list(f.project.id), nativeState: () => 'idle' })
const ticket = () => f.store.tickets.get(f.plan.ticketId)!
const ready = () => {
  const artifact = f.write()
  return f.reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }]))
}

it('uses a registered ready report and gate while preserving the historical confirmation receipt', () => {
  const report = ready(), current = ticket()
  current.assignments[0]!.waitingReason = 'worker-idle'
  f.store.tickets.save(current)
  const before = JSON.stringify({ current, facts: facts() })
  const progress = projectProgress(current, facts())
  expect(progress).toMatchObject({ phase: 'semantic-review', workPhase: 'semantic-review', assignments: [{
    assignmentId: current.assignments[0]!.id, reportId: report.id, reportState: 'ready', phase: 'semantic-review', nativeState: 'idle',
  }] })
  expect(current.executionTargets?.[0]?.waitingReason).toBe('executor-unavailable')
  expect(JSON.stringify({ current, facts: facts() })).toBe(before)
})

it('uses the latest report for the current attempt rather than any earlier ready report', () => {
  ready()
  const failed = f.reports.submit(f.attempt.sessionId, f.report([], { operationId: 'later-failed', state: 'failed', completed: 'The verification could not finish' }))
  expect(projectProgress(ticket(), facts()).assignments[0]).toMatchObject({ reportId: failed.id, reportState: 'failed', phase: 'failed' })
})

it('does not transfer an old report or acceptance result to a fresh attempt on the same Assignment', () => {
  ready()
  const current = ticket(), assignment = current.assignments[0]!
  const next = f.attempts.prepare(f.attempts.allocate(current, assignment, { fresh: true }))
  const progress = projectProgress(current, facts())
  expect(progress.assignments[0]).toMatchObject({ attemptId: next.id, phase: 'preparing' })
  expect(progress.assignments[0]?.reportId).toBeUndefined()
  expect(progress.assignments[0]?.decision).toBeUndefined()
})

it('keeps a semantic gate as a work fact while pause and reconciliation remain separate', () => {
  const report = ready(), current = ticket()
  current.lifecycle = { pause: { intent: 'pause', state: 'paused', at: report.at }, stop: { intent: 'none', state: 'running', at: report.at },
    observed: { state: 'unknown', at: report.at }, reconciliation: { state: 'unknown', startedAt: report.at } }
  const progress = projectProgress(current, facts())
  expect(progress.phase).toBe('unknown')
  expect(progress.workPhase).toBe('semantic-review')
  expect(progress.assignments[0]?.reportId).toBe(report.id)
  expect(current.lifecycle.pause.intent).toBe('pause')
})

it('requires the exact current report and condition version for a review conclusion', () => {
  const original = ready()
  f.reports.decide('owner', f.project.id, { ticketId: f.plan.ticketId, operationId: 'changes', reportId: original.id, conclusion: 'changes_required', evidence: 'A second source is required' })
  expect(projectProgress(ticket(), facts()).workPhase).toBe('changes_required')
  const artifact = f.write('# Revised note\nA second source was checked.', 'revised-file')
  const revised = f.reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }], { operationId: 'revised-report' }))
  const progress = projectProgress(ticket(), facts())
  expect(progress.workPhase).toBe('semantic-review')
  expect(progress.assignments[0]).toMatchObject({ reportId: revised.id, conditionsVersion: 3 })
  expect(progress.assignments[0]?.decision).toBeUndefined()
})

it('does not use a foreign project report even when its execution identity fields are copied', () => {
  const report = ready(), input = facts()
  input.reports.push({ ...report, id: 'foreign-report', projectId: 'other-project', state: 'failed' })
  expect(projectProgress(ticket(), input).assignments[0]).toMatchObject({ reportId: report.id, phase: 'semantic-review' })
})
