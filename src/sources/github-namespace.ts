/** Project-scoped GitHub identity used by application consumers and durable keys. */
import { createHash } from 'node:crypto'

export interface GitHubNamespace {
  readonly projectId: string
  readonly resourceId: string
  readonly account: string
  readonly repository: string
}

export const githubNamespaceKey = (namespace: GitHubNamespace, number?: number): string => {
  if (!namespace.projectId || !namespace.resourceId || !namespace.account || !namespace.repository) throw new Error('Project GitHub namespace is incomplete')
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 1)) throw new Error('Invalid GitHub object number')
  return createHash('sha256').update(JSON.stringify([namespace.projectId, namespace.resourceId, namespace.account, namespace.repository.toLowerCase(), number ?? null])).digest('hex')
}

/** Derives the immutable scope from a persisted project/resource/Attempt identity. */
export const githubNamespaceOf = (input: { projectId: string; repositoryId?: string; accountId?: string; repository?: string }): GitHubNamespace | undefined => {
  if (!input.repositoryId || !input.accountId || !input.repository) return undefined
  return { projectId: input.projectId, resourceId: input.repositoryId, account: input.accountId, repository: input.repository }
}
/** Numeric GitHub object number from either a legacy thread id/number or a scoped thread id. */
export const githubThreadNumber = (id: string): number | undefined => {
  const raw = id.replace(/^github:/, '')
  if (raw.startsWith('ci:')) return undefined
  const match = /(?:^|:)(\d+)$/.exec(raw)
  return match ? Number(match[1]) : undefined
}
/** Whether a stored Thread key belongs to exactly this namespace, or to the legacy deployment scope. */
export const githubThreadInNamespace = (thread: string, namespace: GitHubNamespace | undefined): boolean => {
  const raw = thread.replace(/^github:/, '')
  if (!namespace) return !/^[a-f0-9]{64}:\d+$/.test(raw) && !/^ci:[a-f0-9]{64}:/.test(raw)
  if (raw.startsWith('ci:')) return raw.startsWith(`ci:${githubNamespaceKey(namespace)}:`)
  const number = githubThreadNumber(raw)
  return number !== undefined && raw === `${githubNamespaceKey(namespace, number)}:${number}`
}
/** Stored Thread key for default-branch CI. */
export const githubBranchCiThread = (namespace: GitHubNamespace | undefined, branch: string): string =>
  namespace ? `github:ci:${githubNamespaceKey(namespace)}:${branch}` : `github:ci:${branch}`
/** Trigger-side Thread id for default-branch CI. */
export const githubBranchCiTriggerThread = (namespace: GitHubNamespace | undefined, branch: string): string =>
  namespace ? `ci:${githubNamespaceKey(namespace)}:${branch}` : `ci:${branch}`
export const requireGitHubNamespace = (namespace: GitHubNamespace | undefined): GitHubNamespace => {
  if (!namespace) throw new Error('Project GitHub resource binding is required')
  githubNamespaceKey(namespace)
  return { ...namespace }
}

/** Thread id for a PR/Issue number. Already scoped ids for this namespace are returned unchanged. */
export const githubThreadId = (namespace: GitHubNamespace | undefined, number: number): string =>
  namespace ? `github:${githubNamespaceKey(namespace, number)}:${number}` : `github:${number}`
/** Follow id (the trigger-side name of a PR Thread) for a number, scoped the same way as the Thread. */
export const githubFollowId = (namespace: GitHubNamespace | undefined, number: number): string =>
  namespace ? `github:${githubNamespaceKey(namespace, number)}:${number}` : `github:${number}`
/** Whether this Thread names the given number inside this namespace, without unwrapping it twice. */
export const sameGithubThread = (thread: string, namespace: GitHubNamespace | undefined, number: number): boolean =>
  thread === githubThreadId(namespace, number) || thread === githubFollowId(namespace, number)

/**
 * Scopes a deployment-wide state key (cursor, retry map, CI baseline) to a project namespace.
 * Deployment-wide operation keeps the historical key so existing deployments keep polling, and an
 * already-scoped key keeps its single suffix: the SourceContext boundary is the only namespacer.
 */
export const githubStateKey = (namespace: GitHubNamespace | undefined, key: string): string => {
  if (!namespace) return key
  const suffix = `#${githubNamespaceKey(namespace)}`
  return key.endsWith(suffix) ? key : `${key}${suffix}`
}
