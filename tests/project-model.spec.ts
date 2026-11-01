import { describe, expect, it } from 'vitest'
import { assertProjectOwnership, projectIds } from '../src/core/index.ts'
import type { Project, ProjectId, TaskId } from '../src/core/index.ts'

// Brands keep independent domain identities distinct even though persistence uses strings.
function checkBrands(projectId: ProjectId, taskId: TaskId) {
  // @ts-expect-error A task identity cannot stand in for a project identity.
  const invalid: ProjectId = taskId
  return [projectId, invalid]
}
void checkBrands

const projectId = projectIds.project('project-seed')

describe('project identities and ownership', () => {
  it('derives stable, namespaced ids from explicit identity seeds', () => {
    const constructors = Object.values(projectIds)
    for (const make of constructors) {
      expect(make('seed')).toBe(make('seed'))
      expect(make('seed')).not.toBe(make('other'))
      expect(() => make('')).toThrow()
      expect(() => make('  ')).toThrow()
    }
    expect(new Set(constructors.map(make => make('seed'))).size).toBe(constructors.length)
  })

  it('preserves a project identity when its display name or workspace changes', () => {
    const project: Project = { id: projectId, name: 'Study', goal: 'Compare results', state: 'active',
      workspaceId: 'workspace-1', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
    const renamed = { ...project, name: 'Renamed study', workspaceId: 'workspace-2' }
    expect(renamed.id).toBe(project.id)
    expect({ ...project, id: projectIds.project('another-seed') }.id).not.toBe(project.id)
  })

  it.each(['Task', 'PlanRevision', 'Authorization', 'Assignment', 'Attempt', 'Lease', 'Resource', 'Artifact'])(
    'requires explicit matching ownership for %s records', kind => {
      expect(() => assertProjectOwnership(projectId, { kind, projectId })).not.toThrow()
      for (const record of [null, undefined, {}, { projectId: '' }, { projectId: ' ' },
        { projectId: projectIds.project('other') }]) {
        expect(() => assertProjectOwnership(projectId, record)).toThrow()
      }
    })

  it('checks every record and rejects a missing server project context', () => {
    expect(() => assertProjectOwnership(projectId, { projectId }, { projectId: projectIds.project('other') })).toThrow()
    expect(() => assertProjectOwnership('' as ProjectId, { projectId: '' })).toThrow()
  })
})
