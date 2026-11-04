/** Per-execution identity facts exposed to model shell tools and the application-owned git/gh shims. */
import type { ExecutionAttempts } from './execution-attempts.ts'
import type { ProjectResources } from './project-resources.ts'
import { writeExecutionIdentity } from '../infra/environment.ts'

/** The shape `ctx.shellEnv` accepts: trusted DSH_* facts resolved for one shell tool execution. */
export interface ExecutionIdentityContributor {
  name: string
  variables: Readonly<Record<string, { description: string }>>
  resolve(execution: { agent?: { id: unknown } }): Partial<Record<string, string>>
}

/**
 * Shell tools see the identity pinned to the Attempt that owns the calling Agent session. An attempt
 * without a repository identity exposes nothing; a revoked or foreign binding throws, so the shell
 * call fails instead of silently acting as the deployment-wide account.
 */
export function executionIdentityContributor(attempts: Pick<ExecutionAttempts, 'bySession' | 'stateDir'>, resources: Pick<ProjectResources, 'get'>): ExecutionIdentityContributor {
  return {
    name: 'project-execution-identity',
    variables: {
      DSH_EXECUTION_ID: { description: 'The pinned project execution id' },
      DSH_PROJECT_ID: { description: 'The project that owns the current execution' },
      DSH_REPOSITORY: { description: 'The registered repository the current execution is bound to' },
      DSH_GITHUB_ACCOUNT: { description: 'The GitHub account the current execution acts as' },
      DSH_DELIVERY_BRANCH: { description: 'The server-owned branch this execution must deliver from' },
    },
    resolve: execution => {
      const sessionId = execution.agent?.id
      if (sessionId === undefined || sessionId === null) return {}
      const attempt = attempts.bySession(String(sessionId))
      if (!attempt?.identity) return {}
      const identity = attempt.identity
      if (identity.repositoryId) {
        // A revoked or replaced binding leaves no trusted facts for the shell.
        const resource = resources.get(attempt.projectId, identity.repositoryId)
        if (resource.type !== 'repository' || resource.revoked) throw new Error('Execution identity is no longer granted')
        // Every shell use re-reads the persisted Attempt and republishes missing/corrupt files from
        // it. A shim also validates the marker; this is the app-side repair before that boundary.
        writeExecutionIdentity(attempts.stateDir, identity)
      }
      return {
        DSH_EXECUTION_ID: identity.executionId,
        DSH_PROJECT_ID: identity.projectId,
        ...(identity.repository ? { DSH_REPOSITORY: identity.repository } : {}),
        ...(identity.accountId ? { DSH_GITHUB_ACCOUNT: identity.accountId } : {}),
        ...(identity.deliveryBranch ? { DSH_DELIVERY_BRANCH: identity.deliveryBranch } : {}),
      }
    },
  }
}
