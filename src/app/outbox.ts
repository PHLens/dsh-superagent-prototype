/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'
import { appendProjectEvent, type ProjectEvent } from './events.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'db' | 'atomic' | 'receipts' | 'tickets'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  /** Selects the execution-scoped Commands for a project channel; absence falls back to deployment-wide delivery. */
  commandsFor?(message: OutboundMessage): Commands | undefined
  /** Rechecks the live project/resource grant immediately before a project-scoped provider request. */
  deliveryAuthorization?(message: OutboundMessage): 'authorized' | 'revoked'
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
    host.effects.handle('project-event', async event => this.storeEvent(event))
  }
  private event(message: OutboundMessage, status: string, at: string): ProjectEvent | undefined {
    const ticket = message.ticketId ? this.host.store.tickets.get(message.ticketId) : undefined
    const projectId = message.channel.address.projectId ?? ticket?.projectId
    if (!projectId) return undefined
    return { id: `delivery:${message.id}:${status}`, projectId, ticketId: message.ticketId ?? '',
      kind: 'delivery-changed', version: message.id, operationId: `${message.id}:${status}`, at }
  }
  private storeEvent(event: ProjectEvent): void {
    this.host.store.atomic(() => appendProjectEvent(this.host.store.db, event))
  }
  /** Record a project delivery transition without making non-project outbox traffic a project fact. */
  private changed(message: OutboundMessage, status: string, at: string): void {
    const event = this.event(message, status, at)
    if (event) this.storeEvent(event)
  }
  /** Queue the fact after a provider boundary whose safety receipt has already committed. */
  private changedAfterExternal(message: OutboundMessage, status: string, at: string): boolean {
    const event = this.event(message, status, at)
    if (!event) return true
    // The unknown receipt already committed. Persist the event immediately when possible; otherwise queue an independent retry.
    try { this.storeEvent(event); return true } catch { /* Keep the receipt authoritative and attempt durable event delivery next. */ }
    try { this.host.store.atomic(() => this.host.effects.enqueue('project-event', event.id, event)); return false }
    catch { /* The unknown receipt remains authoritative even when both event persistence paths are unavailable. */ return false }
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => {
      if (!store.receipts.add(message)) return
      effects.enqueue('reply', message.id, {})
      this.changed(message, 'queued', store.receipts.get(message.id)?.createdAt ?? new Date().toISOString())
    })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    const message = store.receipts.get(id), at = new Date().toISOString()
    store.atomic(() => { if (store.receipts.withdraw(id)) { effects.cancel('reply', id); if (message) this.changed(message, 'withdrawn', at) } })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending' || receipt.reconciliation) return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.atomic(() => { store.receipts.settle(receipt, 'channelIgnored'); this.changed(receipt, 'channelIgnored', store.receipts.get(id)?.dropped?.at ?? new Date().toISOString()) }); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    let selected = commands
    try { selected = this.host.commandsFor?.(receipt) ?? commands }
    catch {
      // A project channel whose registered identity disappeared is a revoked target, never a reason
      // to fall back to deployment-wide credentials. No provider request has started.
      store.atomic(() => { store.receipts.settle(receipt, 'channelGone'); this.changed(receipt, 'channelGone', store.receipts.get(id)?.dropped?.at ?? new Date().toISOString()) }); return
    }
    // This intentionally re-reads the live grant after the delayed queue waited: revocation must be
    // effective before the first provider request, and the receipt must never become `sent`.
    if (this.host.deliveryAuthorization?.(receipt) === 'revoked') { store.atomic(() => { store.receipts.settle(receipt, 'channelGone'); this.changed(receipt, 'channelGone', store.receipts.get(id)?.dropped?.at ?? new Date().toISOString()) }); return }
    const result = await sources.send(receipt, selected)
    if (result === 'waiting') throw new Later('The Source is not installed')
    if (result === 'sent') {
      const startedAt = store.atomic(() => {
        store.receipts.beginUnknown(receipt)
        return store.receipts.get(id)?.reconciliation?.at ?? new Date().toISOString()
      })
      // The provider may already have accepted this ID. Commit and preserve the unknown receipt before any event write.
      // If that event cannot persist now, keep the receipt unknown and stop before recording a later `sent` transition.
      if (!this.changedAfterExternal(receipt, 'send-started', startedAt)) return
    }
    try {
      store.atomic(() => {
        store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
        const settled = store.receipts.get(id)
        this.changed(receipt, result === 'gone' ? 'channelGone' : 'sent', settled?.dropped?.at ?? settled?.settledAt ?? new Date().toISOString())
      })
    }
    catch (error) {
      // The provider already returned success, but the local receipt boundary is unknown. Never resend automatically.
      store.atomic(() => {
        store.receipts.unknown(receipt, error)
        this.changed(receipt, 'unknown', store.receipts.get(id)?.reconciliation?.at ?? new Date().toISOString())
      }); return
    }
  }
}
