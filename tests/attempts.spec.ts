import { describe, expect, it } from 'vitest'
import { createExecutionReport, isLeaseFresh, projectIds, validateExecutionReport } from '../src/core/index.ts'
import type { Attempt, ExecutionReport, Lease } from '../src/core/index.ts'

const start = '2026-11-01T00:00:00Z'
const now = '2026-11-01T00:01:00Z'
const end = '2026-11-01T00:02:00Z'
function context() {
  const identity = { projectId: projectIds.project('p'), taskId: projectIds.task('t'),
    assignmentId: projectIds.assignment('a'), authorizationId: projectIds.authorization('auth') }
  const attempt: Attempt = { ...identity, id: projectIds.attempt('try-1'), leaseId: projectIds.lease('lease-1'),
    state: 'running', createdAt: start }
  const lease: Lease = { ...identity, id: attempt.leaseId, attemptId: attempt.id, issuedAt: start, expiresAt: end }
  const report: ExecutionReport = { ...identity, attemptId: attempt.id, leaseId: lease.id, operationId: 'operation-1',
    createdAt: now, effects: [{ kind: 'ready', summary: 'Results available', artifactIds: [projectIds.artifact('result')], evidence: ['analysis checked'] }] }
  return { attempt, lease, report }
}

describe('execution lease and report contracts', () => {
  it('accepts a live lease and a report bound to the current server context', () => {
    const { attempt, lease, report } = context()
    expect(isLeaseFresh(lease, now)).toBe(true)
    expect(() => validateExecutionReport(report, attempt, lease, now)).not.toThrow()
  })

  it('uses instants, including offset timestamps and exclusive expiry', () => {
    const { lease } = context()
    expect(isLeaseFresh(lease, start)).toBe(true)
    expect(isLeaseFresh(lease, '2026-11-01T08:01:00+08:00')).toBe(true)
    for (const time of ['2026-10-31T23:59:59Z', end, 'invalid']) expect(isLeaseFresh(lease, time)).toBe(false)
    for (const invalid of [{ endedAt: now }, { issuedAt: 'invalid' }, { expiresAt: 'invalid' }, { expiresAt: start }]) {
      expect(isLeaseFresh({ ...lease, ...invalid }, now)).toBe(false)
    }
  })

  it.each(['projectId', 'taskId', 'assignmentId', 'authorizationId', 'attemptId', 'leaseId'] as const)(
    'rejects reports with a different %s', field => {
      const { attempt, lease, report } = context()
      expect(() => validateExecutionReport({ ...report, [field]: 'other' }, attempt, lease, now)).toThrow()
    })

  it.each(['projectId', 'taskId', 'assignmentId', 'authorizationId', 'attemptId', 'id'] as const)(
    'rejects leases with a different %s', field => {
      const { attempt, lease, report } = context()
      expect(() => validateExecutionReport(report, attempt, { ...lease, [field]: 'other' }, now)).toThrow()
    })

  it('rejects old attempts, rotated leases and ended execution', () => {
    const { attempt, lease, report } = context()
    expect(() => validateExecutionReport(report, { ...attempt, id: projectIds.attempt('try-2') }, lease, now)).toThrow()
    expect(() => validateExecutionReport(report, { ...attempt, leaseId: projectIds.lease('lease-2') }, lease, now)).toThrow()
    for (const state of ['preparing', 'paused', 'stopped', 'failed', 'completed'] as const) {
      expect(() => validateExecutionReport(report, { ...attempt, state }, lease, now)).toThrow()
    }
    expect(() => validateExecutionReport(report, { ...attempt, endedAt: now }, lease, now)).toThrow()
    expect(() => validateExecutionReport(report, attempt, { ...lease, endedAt: now }, now)).toThrow()
    expect(() => validateExecutionReport(report, attempt, lease, end)).toThrow()
  })

  it('requires a stable operation id, bounded report time and valid effects', () => {
    const { attempt, lease, report } = context()
    for (const invalid of [{ operationId: '' }, { createdAt: 'invalid' }, { createdAt: end },
      { createdAt: '2026-10-31T23:59:59Z' }, { effects: [] },
      { effects: [{ kind: 'complete-task', summary: 'bypass', artifactIds: [], evidence: [] }] },
      { effects: [{ kind: 'progress', summary: '', artifactIds: [], evidence: [] }] },
      { effects: [{ kind: 'ready', summary: 'done', artifactIds: [''], evidence: [] }] }]) {
      expect(() => validateExecutionReport({ ...report, ...invalid } as ExecutionReport, attempt, lease, now)).toThrow()
    }
  })

  it('creates a detached, deeply frozen report without mutating the supplied data', () => {
    const { attempt, lease, report } = context()
    const input = { ...report, effects: report.effects.map(effect => ({ ...effect,
      artifactIds: [...effect.artifactIds], evidence: [...effect.evidence] })) }
    const saved = createExecutionReport(input, attempt, lease, now)
    input.effects[0]!.summary = 'changed'
    input.effects[0]!.evidence.push('changed')
    input.effects[0]!.artifactIds.length = 0
    expect(saved.effects[0]).toEqual(report.effects[0])
    expect(saved.operationId).toBe(input.operationId)
    expect(Object.isFrozen(input)).toBe(false)
    for (const value of [saved, saved.effects, saved.effects[0], saved.effects[0]!.artifactIds, saved.effects[0]!.evidence]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    expect(() => { (saved as { operationId: string }).operationId = 'overwritten' }).toThrow()
  })

  it('allows a ready report without a PR or artifacts without completing its task', () => {
    const { attempt, lease, report } = context()
    const saved = createExecutionReport({ ...report, effects: [{ kind: 'ready', summary: 'Discussion delivered', artifactIds: [], evidence: [] }] }, attempt, lease, now)
    expect(saved.effects[0]!.kind).toBe('ready')
    expect(attempt.state).toBe('running')
  })
})
