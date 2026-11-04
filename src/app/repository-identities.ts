/** Repository/account identities are namespaced by project and registered Resource. */
import { createHash } from 'node:crypto'
import type { Store } from './store.ts'
import type { ExecutionIdentity } from './execution-environment.ts'
export interface RepositoryIdentity { projectId: string; resourceId: string; repository: string; accountId: string; accountCli: string; gitAuthorName: string; gitAuthorEmail: string }
/** Persists explicit repository bindings and produces stable namespaced references for all consumers. */
export class RepositoryIdentities {
  constructor(private readonly store: Pick<Store, 'get' | 'set'>) {}
  private key(projectId: string, resourceId: string) { return `t7.repository.${JSON.stringify([projectId, resourceId])}` }
  register(value: RepositoryIdentity): void {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)) throw new Error('Invalid repository')
    if (Object.values(value).some(item => !item.trim() || /[\r\n\u0000]/.test(item))) throw new Error('Incomplete repository identity')
    this.store.set(this.key(value.projectId, value.resourceId), { ...value })
  }
  get(projectId: string, resourceId: string): RepositoryIdentity {
    const value = this.store.get<RepositoryIdentity>(this.key(projectId, resourceId))
    if (!value || value.projectId !== projectId || value.resourceId !== resourceId) throw new Error('Repository identity is not registered in this project')
    return { ...value }
  }
  pin(projectId: string, resourceId: string, executionId: string): ExecutionIdentity {
    const value = this.get(projectId, resourceId)
    return { ...value, repositoryId: value.resourceId, executionId, capturedAt: new Date().toISOString() }
  }
  reference(projectId: string, resourceId: string, number: number): string {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid GitHub object number')
    const value = this.get(projectId, resourceId)
    return createHash('sha256').update(JSON.stringify([projectId, resourceId, value.accountId, value.repository.toLowerCase(), number])).digest('hex')
  }
}
