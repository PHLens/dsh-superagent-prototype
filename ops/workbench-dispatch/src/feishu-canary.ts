import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FeishuUserClient, FeishuSendError, requireValue, validateId, validateUuid } from './feishu-user.ts'
import type { DispatchEnvironment } from './feishu-user.ts'

const canaryText = 'OAuth user identity canary. No task requested.'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export interface CanaryReceipt {
  version: 1
  capability: 'dispatch.user-sender'
  capabilityStatus: 'untested' | 'passed'
  status: 'dry_run' | 'verified'
  externalSend: boolean
  senderVerified: boolean
  membershipVerified: boolean
  nativeMessageVerified: boolean
  senderIdHash?: string
  chatIdHash?: string
  messageIdHash?: string
  idempotencyKeyHash?: string
}

/** Fixed non-task message only. No helper execution, file writes or task dispatch. */
export async function runCanary(
  mode: 'dry-run' | 'send', env: DispatchEnvironment = process.env, transport: typeof fetch = fetch,
): Promise<CanaryReceipt> {
  if (mode === 'dry-run') {
    // Deliberately return before reading any environment configuration, including tokens.
    return {
      version: 1, capability: 'dispatch.user-sender', capabilityStatus: 'untested', status: 'dry_run',
      externalSend: false, senderVerified: false, membershipVerified: false, nativeMessageVerified: false,
    }
  }
  if (mode !== 'send' || env.FEISHU_DISPATCH_CANARY_AUTHORIZED !== 'true') throw new FeishuSendError('configuration')
  const expectedSender = requireValue(env, 'FEISHU_DISPATCH_EXPECTED_SENDER_OPEN_ID')
  const idempotencyKey = requireValue(env, 'FEISHU_DISPATCH_IDEMPOTENCY_KEY')
  validateId(expectedSender, 'ou_')
  validateUuid(idempotencyKey)
  const client = new FeishuUserClient(env, transport)
  const identity = await client.request('/open-apis/authen/v1/user_info')
  if (identity.open_id !== expectedSender) throw new FeishuSendError('rejected')
  const membership = await client.request(`/open-apis/im/v1/chats/${client.chatId}/members/is_in_chat`)
  if (membership.is_in_chat !== true) throw new FeishuSendError('rejected')
  const { messageId } = await client.sendUserMessage({ chatId: client.chatId, text: canaryText, idempotencyKey })
  // Any post-send failure must be reconciled, not automatically resent, even after token refresh.
  try {
    const observation = await client.request(`/open-apis/im/v1/messages/${messageId}?user_id_type=open_id`)
    const items = observation.items
    if (!Array.isArray(items) || items.length !== 1) throw new FeishuSendError('unknown')
    const message = items[0]
    if (message?.message_id !== messageId || message.chat_id !== client.chatId ||
      message.sender?.id !== expectedSender || message.sender?.id_type !== 'open_id' || message.sender?.sender_type !== 'user' ||
      message.msg_type !== 'text' || message.deleted !== false || message.updated !== false ||
      JSON.parse(message.body?.content).text !== canaryText ||
      (message.mentions !== undefined && (!Array.isArray(message.mentions) || message.mentions.length !== 0))) {
      throw new FeishuSendError('unknown')
    }
  } catch { throw new FeishuSendError('unknown') }
  return {
    version: 1, capability: 'dispatch.user-sender', capabilityStatus: 'passed', status: 'verified', externalSend: true,
    senderVerified: true, membershipVerified: true, nativeMessageVerified: true,
    senderIdHash: hash(expectedSender), chatIdHash: hash(client.chatId), messageIdHash: hash(messageId), idempotencyKeyHash: hash(idempotencyKey),
  }
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 1 || (args[0] !== '--dry-run' && args[0] !== '--send')) {
    throw new Error('Usage: node --experimental-strip-types ops/workbench-dispatch/src/feishu-canary.ts --dry-run|--send')
  }
  console.log(JSON.stringify(await runCanary(args[0] === '--dry-run' ? 'dry-run' : 'send'), null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof FeishuSendError
      ? JSON.stringify({ status: error.kind, retryAfterMs: error.retryAfterMs, nativeCode: error.nativeCode })
      : 'Canary refused: invalid invocation')
    process.exitCode = 1
  })
}
