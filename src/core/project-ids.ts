/** Stable domain identities, derived from identity seeds rather than mutable display names or paths. */
import { key } from './ids.ts'

export type ProjectId = string & { readonly __projectId: unique symbol }
export type TaskId = string & { readonly __taskId: unique symbol }
export type PlanRevisionId = string & { readonly __planRevisionId: unique symbol }
export type AuthorizationId = string & { readonly __authorizationId: unique symbol }
export type AssignmentId = string & { readonly __assignmentId: unique symbol }
export type AttemptId = string & { readonly __attemptId: unique symbol }
export type LeaseId = string & { readonly __leaseId: unique symbol }
export type ArtifactId = string & { readonly __artifactId: unique symbol }
export type ResourceId = string & { readonly __resourceId: unique symbol }

function identity<T extends string>(kind: string, seed: string): T {
  if (typeof seed !== 'string' || !seed.trim()) throw new Error('An identity seed is required')
  return key('project-domain', kind, seed) as T
}

/** Persist the seed/id once; renames must reuse that id. These constructors do not select projects by name. */
export const projectIds = {
  project: (seed: string): ProjectId => identity('project', seed),
  task: (seed: string): TaskId => identity('task', seed),
  planRevision: (seed: string): PlanRevisionId => identity('planRevision', seed),
  authorization: (seed: string): AuthorizationId => identity('authorization', seed),
  assignment: (seed: string): AssignmentId => identity('assignment', seed),
  attempt: (seed: string): AttemptId => identity('attempt', seed),
  lease: (seed: string): LeaseId => identity('lease', seed),
  artifact: (seed: string): ArtifactId => identity('artifact', seed),
  resource: (seed: string): ResourceId => identity('resource', seed),
} as const
