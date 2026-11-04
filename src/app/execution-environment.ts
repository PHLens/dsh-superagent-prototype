/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }
/** Immutable server-resolved identity captured when an execution is admitted. */
export interface ExecutionIdentity { executionId: string; projectId: string; repositoryId?: string; repository?: string; accountId?: string; accountCli?: string; gitAuthorName: string; gitAuthorEmail: string; /** Server-owned branch for a project delivery; never accepted from a worker. */ deliveryBranch?: string; capturedAt: string }
/** One stable server-owned branch per Attempt; a reviewer can identify the delivery without trusting model input. */
export const deliveryBranchFor = (executionId: string): string => `agent/project-${executionId}`
export function pinExecutionIdentity(input: Omit<ExecutionIdentity, 'capturedAt'>, now = () => new Date().toISOString()): ExecutionIdentity {
  for (const key of ['executionId', 'projectId', 'gitAuthorName', 'gitAuthorEmail'] as const) if (!input[key].trim()) throw new Error(`Execution identity ${key} is required`)
  for (const key of ['repositoryId', 'repository', 'accountId', 'accountCli'] as const) if (input[key] !== undefined && !input[key].trim()) throw new Error(`Execution identity ${key} is invalid`)
  if (input.deliveryBranch !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.deliveryBranch) || input.deliveryBranch.endsWith('/') || input.deliveryBranch.endsWith('.') || input.deliveryBranch.includes('..') || input.deliveryBranch.includes('//'))) throw new Error('Execution identity deliveryBranch is invalid')
  return { ...input, capturedAt: now() }
}
export function identityVariables(identity: ExecutionIdentity): Variable[] {
  const text = (key: string, value: string) => ({ key, value, owner: 'execution-identity', description: { zh: '本次执行固定的身份', en: 'Identity pinned to this execution' } })
  return [text('DSH_EXECUTION_ID', identity.executionId), ...(identity.repository ? [text('DSH_REPOSITORY', identity.repository)] : []), ...(identity.accountId ? [text('DSH_GITHUB_ACCOUNT', identity.accountId)] : []), ...(identity.deliveryBranch ? [text('DSH_DELIVERY_BRANCH', identity.deliveryBranch)] : []), text('GIT_AUTHOR_NAME', identity.gitAuthorName), text('GIT_AUTHOR_EMAIL', identity.gitAuthorEmail)]
}

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
