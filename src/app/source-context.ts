/** Scoped runtime context exposed to each Source kind, isolating Sources from direct Store or Engine access. */
import { threadKey, type EngineForSources, type ReceiveResult, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SetupProblem } from '../setup.ts'
import type { SourceContext } from '../sources/host.ts'
import { githubNamespaceKey, githubStateKey, githubThreadInNamespace, githubThreadNumber, type GitHubNamespace } from '../sources/github-namespace.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

export interface SourceContextDeps {
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'threads' | 'tickets' | 'triggers' | 'read'>
  readonly outbox: Pick<Outbox, 'send'>
  readonly engine: Pick<EngineForSources, 'bindThread' | 'threadClosed'>
  readonly commands: Commands
  readonly sources: SourceRegistry
  /** Throws when accessed before initial setup completes. */
  readonly deployment: Deployment
  readonly ready: Promise<void>
  configured(): boolean
  /** Setup problem whose `place` matches the Source kind receives it on `context.problem`. */
  readonly setupProblem?: SetupProblem | undefined
  /** Why setup could not resolve the GitHub resource; base instance readiness may still succeed. */
  readonly githubProblem?: SetupProblem | undefined
  /** Explicit project GitHub identity for project-facing consumers. */
  readonly githubNamespace?: GitHubNamespace
  /** Why setup found no Feishu bot even though the Feishu Source names a CLI. */
  readonly feishuProblem?: SetupProblem | undefined
  /** Hands a Trigger to the Engine and schedules the pass that assesses it. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}

/**
 * Builds the context for one Source kind. Health reports are restricted to entries declared by the kind and
 * bound to the active registration, becoming no-ops once unregistered.
 */
export function sourceContextOf(deps: SourceContextDeps, kind: { kind: string; health: readonly string[] }): SourceContext {
  const { store } = deps
  const health = deps.sources.healthEntries(kind.health)
  const namespaced = kind.kind === 'github' && deps.githubNamespace !== undefined
  const stateKey = (name: string): string => namespaced ? githubStateKey(deps.githubNamespace, name) : name
  const inScope = (key: string): boolean => kind.kind !== 'github' || githubThreadInNamespace(key, deps.githubNamespace)
  const githubThread = (thread: { source: string; id: string }): { source: string; id: string } => {
    if (thread.source !== 'github' || !deps.githubNamespace) return thread
    const raw = thread.id.replace(/^github:/, ''), number = githubThreadNumber(raw)
    if (number === undefined) return thread
    const key = githubNamespaceKey(deps.githubNamespace, number)
    // A Thread already scoped for another project is foreign, never silently rewrapped.
    if (/^[a-f0-9]{64}:\d+$/.test(raw) && !raw.startsWith(`${key}:`)) throw new Error('GitHub thread belongs to a different project scope')
    // Idempotent: an already namespaced id keeps its single scope.
    return { source: thread.source, id: raw.startsWith(`${key}:`) ? raw : `${key}:${raw}` }
  }
  const ticketInScope = (ticket: { projectId?: string; follows?: readonly { thread: string }[] }): boolean => {
    if (!deps.githubNamespace) return !ticket.projectId
    if (ticket.projectId !== deps.githubNamespace.projectId) return false
    // A project repository consumer only owns tickets bound to its own resource scope.
    return !ticket.follows?.length || ticket.follows.some(follow => inScope(follow.thread))
  }
  /** A scoped watcher may read a Thread only while an open Task in this project owns or follows it. */
  const boundThread = (key: string): boolean => {
    if (!deps.githubNamespace) return true
    for (const ticket of store.tickets.open()) {
      if (ticket.projectId !== deps.githubNamespace.projectId) continue
      if (ticket.follows?.some(follow => follow.thread === key)) return true
      const references = new Set<string>([ticket.origin.triggerId, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])
      for (const id of references) {
        const trigger = store.triggers.get(id)
        if (trigger?.threads.some(ref => threadKey(ref) === key)) return true
      }
    }
    return false
  }
  return {
    get deployment() { return deps.deployment },
    get githubNamespace() { return deps.githubNamespace },
    commands: deps.commands,
    ready: deps.ready,
    configured: () => deps.configured() && (kind.kind === 'github' ? !!deps.deployment.github : kind.kind === 'feishu' ? !!deps.deployment.feishu : true),
    baseConfigured: deps.configured,
    get problem() { return [deps.githubProblem, deps.feishuProblem, deps.setupProblem].find(problem => problem?.place === kind.kind) },
    config: <C extends Record<string, unknown>>(id: string) => {
      const instance = deps.sources.instance<C>(id)
      return instance?.enabled ? instance.config : undefined
    },
    receive: trigger => deps.receive(trigger),
    atomic: work => store.atomic(work),
    state: {
      // A project GitHub consumer keeps its cursors, retries and CI baselines in its own namespace;
      // deployment-wide polling keeps the historical keys.
      get: name => store.get(stateKey(name)),
      set: (name, value) => { if (value === undefined) store.delete(stateKey(name)); else store.set(stateKey(name), value) },
      keys: family => {
        const prefix = typeof family === 'string' ? family : family.prefix
        const keys = store.keys(prefix)
        if (!deps.githubNamespace) return keys.filter(key => !/#[a-f0-9]{64}$/.test(key)) as never
        const suffix = `#${githubNamespaceKey(deps.githubNamespace)}`
        // Persisted typed members are `<prefix>name#<scope>`; enumerate only this scope, without
        // losing the member names by looking for a bare scoped prefix.
        return keys.filter(key => key.endsWith(suffix) && key.slice(prefix.length, -suffix.length).length > 0) as never
      },
    },
    threads: {
      get: key => inScope(key) ? store.threads.get(key) : undefined,
      subscribed: source => store.read.subscribedThreads(source).filter(thread => inScope(thread.key) && boundThread(thread.key)),
      describe: (key, description) => { if (inScope(key)) store.threads.describe(key, description) },
      patch: (key, meta) => { if (inScope(key)) store.threads.patchMeta(key, meta) },
    },
    tickets: {
      get: id => { const ticket = store.tickets.get(id); return ticket && ticketInScope(ticket) ? ticket : undefined },
      open: () => store.tickets.open().filter(ticketInScope),
      bindThread: (id, thread, own) => {
        const ticket = store.tickets.get(id)
        if (!ticket || !ticketInScope(ticket)) throw new Error('Ticket is outside this project GitHub scope')
        deps.engine.bindThread(id, githubThread(thread), own)
      },
      threadClosed: (thread, outcome, at) => { deps.engine.threadClosed(githubThread(thread), outcome, at) },
    },
    triggers: { get: id => store.triggers.get(id), latest: thread => store.read.threadTriggers(thread, 1)[0] },
    notify: message => { deps.outbox.send(message) },
    report: (entry, value) => {
      if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`)
      health.get(entry)?.set(value)
    },
  }
}
