/** Additive project contracts; legacy Ticket/Assignment persistence and execution semantics remain separate. */
import type { ActorRef } from './model.ts'
import type { ArtifactId, AssignmentId, AuthorizationId, PlanRevisionId, ProjectId, ResourceId, TaskId } from './project-ids.ts'

export interface ProjectOwned { readonly projectId: ProjectId }
export interface TaskOwned extends ProjectOwned { readonly taskId: TaskId }

export interface Project {
  readonly id: ProjectId
  name: string
  goal: string
  state: 'active' | 'archived'
  coordinatorSessionId?: string
  workspaceId: string
  createdAt: string
  updatedAt: string
}

/** Native actor evidence alone is not authorization or a verified identity binding. */
export interface StableActor {
  readonly id: string
  displayName: string
  webIdentity?: string
  feishuOpenId?: string
  sourceEvidence: readonly ActorRef[]
}

export type ProjectTaskState = 'planPending' | 'queued' | 'running' | 'attention' | 'failed' | 'pausing' | 'paused' | 'stopped' | 'completed'
export interface ProjectTask extends ProjectOwned {
  readonly id: TaskId
  title: string
  state: ProjectTaskState
  createdAt: string
  updatedAt: string
}

/** An immutable proposal. Supersession/revocation is tracked separately by the eventual lifecycle/store. */
export interface PlanRevision extends TaskOwned {
  readonly id: PlanRevisionId
  readonly parentId?: PlanRevisionId
  readonly goal: string
  readonly scope: readonly string[]
  readonly outputs: readonly string[]
  readonly resources: readonly ResourceId[]
  readonly completion: readonly string[]
  readonly limits: { readonly modelTokens?: number; readonly wallSeconds?: number }
  readonly createdAt: string
}

export interface Authorization extends TaskOwned {
  readonly id: AuthorizationId
  readonly planRevisionId: PlanRevisionId
  readonly actorId: string
  readonly confirmationIntent: string
  readonly createdAt: string
}

/** The logical assignment is stable across retries; Attempt identifies an individual execution. */
export interface ProjectAssignment extends TaskOwned {
  readonly id: AssignmentId
  readonly authorizationId: AuthorizationId
  readonly scope: readonly string[]
  readonly createdAt: string
}

export interface Resource extends ProjectOwned {
  readonly id: ResourceId
  kind: 'directory' | 'repository' | 'data' | 'service'
  root: string
  version?: string
  state: 'ready' | 'missing' | 'checking'
}

export interface Artifact extends TaskOwned {
  readonly id: ArtifactId
  path: string
  contentVersion: string
  kind: string
  evidence: readonly string[]
  valid: boolean
  createdAt: string
}

/** Validate against a server-resolved project, never one selected by the worker payload. No storage access. */
export function assertProjectOwnership(projectId: ProjectId, ...records: readonly unknown[]): void {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('A server project identity is required')
  for (const record of records) {
    if (!record || typeof record !== 'object' || !('projectId' in record) || record.projectId !== projectId) {
      throw new Error('Missing or mismatched project ownership')
    }
  }
}
