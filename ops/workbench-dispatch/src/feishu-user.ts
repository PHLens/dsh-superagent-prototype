// External OAuth transport: no application imports, bot configuration, token storage or refresh.
export type DispatchEnvironment = Readonly<Record<string, string | undefined>>
export interface UserMessage {
  chatId: string
  text: string
  idempotencyKey: string
  mentionOpenId?: string
}
export type SendFailure = 'configuration' | 'expired' | 'rate_limited' | 'rejected' | 'unknown'

export class FeishuSendError extends Error {
  readonly kind: SendFailure
  readonly retryAfterMs?: number
  readonly nativeCode?: number
  constructor(kind: SendFailure, retryAfterMs?: number, nativeCode?: number) {
    // Never include response bodies, token values, URLs, local paths or transport diagnostics.
    super(`Feishu user request: ${kind}${kind === 'unknown' ? '; reconcile before retry' : ''}`)
    this.name = 'FeishuSendError'
    this.kind = kind
    this.retryAfterMs = retryAfterMs
    this.nativeCode = nativeCode
  }
}

export function requireValue(env: DispatchEnvironment, key: string): string {
  const value = env[key]
  if (!value || value.trim() !== value) throw new FeishuSendError('configuration')
  return value
}
export function validateId(value: string, prefix: 'oc_' | 'ou_' | 'om_'): void {
  if (!new RegExp(`^${prefix}[a-zA-Z0-9_-]+$`).test(value)) throw new FeishuSendError('configuration')
}
export function validateUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new FeishuSendError('configuration')
  }
}
function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+(\.\d+)?$/.test(value)) {
    const milliseconds = Number(value) * 1000
    return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : undefined
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined
  const deadline = Date.parse(value)
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : undefined
}

export class FeishuUserClient {
  readonly chatId: string
  private readonly baseUrl: string
  private readonly token: string
  private readonly transport: typeof fetch

  constructor(env: DispatchEnvironment = process.env, transport: typeof fetch = fetch) {
    let url: URL
    try { url = new URL(requireValue(env, 'FEISHU_DISPATCH_BASE_URL')) } catch { throw new FeishuSendError('configuration') }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new FeishuSendError('configuration')
    }
    this.baseUrl = url.origin
    this.token = requireValue(env, 'FEISHU_DISPATCH_ACCESS_TOKEN')
    // Header construction must not leak a malformed token through a native exception.
    if (/[\s\x00-\x1f\x7f]/.test(this.token)) throw new FeishuSendError('configuration')
    this.chatId = requireValue(env, 'FEISHU_DISPATCH_CHAT_ID')
    validateId(this.chatId, 'oc_')
    this.transport = transport
  }

  /** One native request only. Unknown outcomes and duplicate errors need reconciliation. */
  async request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!path.startsWith('/open-apis/') || path.includes('..')) throw new FeishuSendError('configuration')
    let response: Response
    try {
      response = await this.transport(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json; charset=utf-8' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      })
    } catch { throw new FeishuSendError('unknown') }
    if (response.status === 401) throw new FeishuSendError('expired')
    if (response.status === 429) throw new FeishuSendError('rate_limited', retryAfter(response.headers.get('Retry-After')))
    if (response.status === 408 || response.status >= 500) throw new FeishuSendError('unknown')
    let result: { code?: unknown; data?: unknown }
    try { result = await response.json() as typeof result } catch { throw new FeishuSendError('unknown') }
    if (!result || typeof result !== 'object' || typeof result.code !== 'number') throw new FeishuSendError('unknown')
    const code = result.code
    if ([20005, 20006, 99991663, 99991668, 99991677].includes(code)) throw new FeishuSendError('expired', undefined, code)
    if ([99991400, 230020].includes(code)) throw new FeishuSendError('rate_limited', retryAfter(response.headers.get('Retry-After')), code)
    // Native 230049 means the message is still being sent; its id is unknown.
    if (code === 230049) throw new FeishuSendError('unknown', undefined, code)
    if (!response.ok || code !== 0) throw new FeishuSendError('rejected', undefined, code)
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new FeishuSendError('unknown')
    return result.data as Record<string, unknown>
  }

  async sendUserMessage(input: UserMessage): Promise<{ messageId: string }> {
    validateId(input.chatId, 'oc_')
    validateUuid(input.idempotencyKey)
    if (input.chatId !== this.chatId || !input.text.trim() || /<at\b/i.test(input.text)) throw new FeishuSendError('configuration')
    if (input.mentionOpenId !== undefined) validateId(input.mentionOpenId, 'ou_')
    const mention = input.mentionOpenId ? `<at user_id="${input.mentionOpenId}">user</at> ` : ''
    const body = {
      receive_id: input.chatId, msg_type: 'text', uuid: input.idempotencyKey,
      content: JSON.stringify({ text: mention + input.text }),
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 150 * 1024) throw new FeishuSendError('configuration')
    const data = await this.request('/open-apis/im/v1/messages?receive_id_type=chat_id', body)
    if (typeof data.message_id !== 'string' || !/^om_[a-zA-Z0-9_-]+$/.test(data.message_id)) throw new FeishuSendError('unknown')
    return { messageId: data.message_id }
  }
}

/** The external token helper supplies FEISHU_DISPATCH_ACCESS_TOKEN to this process. */
export async function sendUserMessage(input: UserMessage): Promise<{ messageId: string }> {
  return new FeishuUserClient().sendUserMessage(input)
}
