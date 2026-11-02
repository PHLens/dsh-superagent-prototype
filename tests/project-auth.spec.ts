import { describe, expect, it } from 'vitest'
import { authenticateProjectRequest, ProjectAuthError } from '../src/app/project-auth.ts'

describe('project request authentication', () => {
  const request = { headers: { host: '127.0.0.1:0' } }

  it('returns the host fixed owner principal after admission', () => {
    const context = { connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } }
    expect(authenticateProjectRequest(context, request)).toBe('owner')
  })

  it('maps host rejection to the same HTTP status', () => {
    const context = { connection: { admit: () => ({ rejection: 401 as const }) } }
    expect(() => authenticateProjectRequest(context, request)).toThrowError(ProjectAuthError)
    try { authenticateProjectRequest(context, request) } catch (error) {
      expect(error).toMatchObject({ status: 401, message: 'Project authentication required' })
    }
  })

  it('fails closed when the connection service is absent', () => {
    expect(() => authenticateProjectRequest({}, request)).toThrowError(/unavailable/)
  })

  it('rejects non-owner principals', () => {
    const context = { connection: { admit: () => ({ peer: { principal: { kind: 'other' } } }) } }
    expect(() => authenticateProjectRequest(context, request)).toThrowError(/not allowed/)
  })
})
