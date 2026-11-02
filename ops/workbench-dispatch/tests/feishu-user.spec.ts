import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { FeishuUserClient, FeishuSendError } from '../src/feishu-user.ts'
import { runCanary } from '../src/feishu-canary.ts'

const uuid = '00000000-0000-4000-8000-000000000001'
const env = {
  FEISHU_DISPATCH_BASE_URL: 'https://open.feishu.cn',
  FEISHU_DISPATCH_ACCESS_TOKEN: 'fixture-secret',
  FEISHU_DISPATCH_CHAT_ID: 'oc_fixture',
  FEISHU_AGENT_OPEN_ID: 'ou_agent',
}
const input = { chatId: 'oc_fixture', text: 'hello "world"\n<&', idempotencyKey: uuid }
const response = (data: unknown, code = 0, status = 200, headers = {}) =>
  new Response(JSON.stringify({ code, data, msg: 'untrusted fixture-secret diagnostics' }), { status, headers })
const fail = (kind: string) => (error: unknown) => error instanceof FeishuSendError && error.kind === kind && !error.message.includes('fixture-secret')

describe('external Feishu user sender', () => {
  it('sends native JSON text and stable UUID, preserving text and adding only the explicit mention', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const client = new FeishuUserClient(env, async (url, init) => {
      calls.push({ url: String(url), init: init! })
      return response({ message_id: 'om_fixture' })
    })
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(await client.sendUserMessage({ ...input, mentionOpenId: 'ou_agent' }), { messageId: 'om_fixture' })
    }
    assert.equal(calls[0]!.url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
    assert.equal(calls[0]!.init.redirect, 'error')
    assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), 'Bearer fixture-secret')
    const payload = JSON.parse(calls[0]!.init.body as string)
    assert.deepEqual(payload, {
      receive_id: 'oc_fixture', msg_type: 'text', uuid,
      content: JSON.stringify({ text: '<at user_id="ou_agent">user</at> hello "world"\n<&' }),
    })
    assert.equal(calls[0]!.init.body, calls[1]!.init.body)
    assert.deepEqual(await client.sendUserMessage(input), { messageId: 'om_fixture' })
    assert.equal(JSON.parse(JSON.parse(calls[2]!.init.body as string).content).text, 'hello "world"\n<&')
  })

  it('refuses missing configuration, unsafe URLs, wrong chat, invalid UUID and mention before network', async () => {
    let calls = 0
    const transport: typeof fetch = async () => { calls++; return response({}) }
    for (const key of ['FEISHU_DISPATCH_BASE_URL', 'FEISHU_DISPATCH_ACCESS_TOKEN', 'FEISHU_DISPATCH_CHAT_ID']) {
      const missing = { ...env }; delete missing[key as keyof typeof missing]
      await assert.rejects(async () => new FeishuUserClient(missing, transport).sendUserMessage(input), fail('configuration'))
    }
    for (const base of ['http://open.feishu.cn', 'https://name:secret@open.feishu.cn', 'https://open.feishu.cn/path']) {
      await assert.rejects(async () => new FeishuUserClient({ ...env, FEISHU_DISPATCH_BASE_URL: base }, transport).sendUserMessage(input), fail('configuration'))
    }
    const client = new FeishuUserClient(env, transport)
    for (const change of [{ chatId: 'oc_other' }, { idempotencyKey: 'random' }, { text: '' }, { text: '<at user_id="all"></at>' }, { mentionOpenId: 'ou_bad"/>' }]) {
      await assert.rejects(() => client.sendUserMessage({ ...input, ...change }), fail('configuration'))
    }
    assert.equal(calls, 0)
  })

  it('reports expired tokens without refreshing, retrying or leaking server diagnostics', async () => {
    for (const [status, code] of [[401, 0], [200, 99991663], [200, 99991668], [200, 99991677], [200, 20005], [200, 20006]]) {
      let calls = 0
      const client = new FeishuUserClient(env, async () => { calls++; return response({}, code, status) })
      await assert.rejects(() => client.sendUserMessage(input), fail('expired'))
      assert.equal(calls, 1)
    }
  })

  it('preserves numeric and HTTP-date Retry-After as a lower bound without automatic replay', async () => {
    for (const header of ['2', new Date(Date.now() + 60_000).toUTCString()]) {
      let calls = 0
      const client = new FeishuUserClient(env, async () => { calls++; return response({}, 0, 429, { 'Retry-After': header }) })
      await assert.rejects(() => client.sendUserMessage(input), (error: unknown) =>
        error instanceof FeishuSendError && error.kind === 'rate_limited' && error.retryAfterMs! >= 2000)
      assert.equal(calls, 1)
    }
  })

  it('classifies native throttling separately from quota and permission failures, with optional backoff', async () => {
    for (const code of [99991400, 230020]) {
      for (const header of ['invalid', '-1', '']) {
        await assert.rejects(() => new FeishuUserClient(env, async () => response({}, code, 400, { 'Retry-After': header })).sendUserMessage(input),
          (error: unknown) => error instanceof FeishuSendError && error.kind === 'rate_limited' && error.retryAfterMs === undefined)
      }
    }
    for (const code of [99991403, 99991672, 99991669]) {
      await assert.rejects(() => new FeishuUserClient(env, async () => response({}, code, 400)).sendUserMessage(input), fail('rejected'))
    }
  })

  it('accepts native duplicate success with the original id, but never fabricates one', async () => {
    const client = new FeishuUserClient(env, async () => response({ message_id: 'om_original' }))
    assert.deepEqual(await client.sendUserMessage(input), { messageId: 'om_original' })
    for (const reply of [response({}, 230049), response({}), new Response('invalid JSON'), response({}, 0, 503)]) {
      await assert.rejects(async () => new FeishuUserClient(env, async () => reply).sendUserMessage(input), fail('unknown'))
    }
    await assert.rejects(async () => new FeishuUserClient(env, async () => { throw new Error('fixture-secret') }).sendUserMessage(input), fail('unknown'))
    await assert.rejects(async () => new FeishuUserClient(env, async () => response({}, 230002, 400)).sendUserMessage(input), fail('rejected'))
  })
})

const nativeCanary = () => ({
  message_id: 'om_canary', chat_id: 'oc_fixture', msg_type: 'text', deleted: false, updated: false, mentions: [],
  body: { content: JSON.stringify({ text: 'OAuth user identity canary. No task requested.' }) },
  sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' },
})

describe('dedicated identity canary', () => {
  const authorized = {
    ...env, FEISHU_DISPATCH_CANARY_AUTHORIZED: 'true', FEISHU_DISPATCH_EXPECTED_SENDER_OPEN_ID: 'ou_user',
    FEISHU_DISPATCH_IDEMPOTENCY_KEY: uuid,
  }
  it('dry-runs without reading configuration, fetching, spawning helpers or writing receipts', async () => {
    const config = new Proxy({}, { get() { throw new Error('configuration accessed') } })
    const receipt = await runCanary('dry-run', config, async () => { throw new Error('network accessed') })
    assert.equal(receipt.status, 'dry_run')
    assert.equal(receipt.capabilityStatus, 'untested')
    assert.equal(receipt.externalSend, false)
    const cli = fileURLToPath(new URL('../src/feishu-canary.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, '--dry-run'], { env: {}, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).status, 'dry_run')
    const bad = spawnSync(process.execPath, ['--experimental-strip-types', cli, '--send', '--dry-run'], { env: {}, encoding: 'utf8' })
    assert.notEqual(bad.status, 0)
  })

  it('refuses live operation without explicit dedicated-chat authorization or identity and UUID', async () => {
    let calls = 0
    for (const key of ['FEISHU_DISPATCH_CANARY_AUTHORIZED', 'FEISHU_DISPATCH_EXPECTED_SENDER_OPEN_ID', 'FEISHU_DISPATCH_IDEMPOTENCY_KEY']) {
      const missing = { ...authorized }; delete missing[key as keyof typeof missing]
      await assert.rejects(() => runCanary('send', missing, async () => { calls++; return response({}) }))
    }
    assert.equal(calls, 0)
  })

  it('verifies user identity and membership before sending one fixed non-task message, then observes its sender and chat', async () => {
    const calls: string[] = []
    const replies = [
      response({ open_id: 'ou_user' }), response({ is_in_chat: true }), response({ message_id: 'om_canary' }),
      response({ items: [nativeCanary()] }),
    ]
    const receipt = await runCanary('send', authorized, async (url, init) => {
      calls.push(String(url))
      if (init?.method === 'POST') {
        const text = JSON.parse(JSON.parse(init.body as string).content).text
        assert.doesNotMatch(text, /WB-DISPATCH|<at|ou_agent/)
      }
      return replies.shift()!
    })
    assert.equal(calls.length, 4)
    assert.match(calls[0]!, /authen\/v1\/user_info$/)
    assert.match(calls[1]!, /chats\/oc_fixture\/members\/is_in_chat$/)
    assert.match(calls[3]!, /messages\/om_canary\?user_id_type=open_id$/)
    assert.equal(receipt.capabilityStatus, 'passed')
    assert.equal(receipt.status, 'verified')
    assert.equal(receipt.externalSend, true)
    assert.doesNotMatch(JSON.stringify(receipt), /fixture-secret|ou_user|oc_fixture|om_canary|https:|\/Users\//)
    assert.match(String(receipt.messageIdHash), /^[a-f0-9]{64}$/)
  })

  it('rejects wrong or modified native canary evidence without replaying a send', async () => {
    for (const change of [
      { message_id: 'om_other' }, { chat_id: 'oc_other' }, { sender: { id: 'ou_other', id_type: 'open_id', sender_type: 'user' } },
      { sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'app' } }, { deleted: true }, { updated: true },
      { body: { content: JSON.stringify({ text: '[WB-DISPATCH:fixture]' }) } }, { body: { content: 'malformed' } },
      { mentions: [{ id: 'ou_agent' }] },
    ]) {
      let sends = 0
      const replies = [response({ open_id: 'ou_user' }), response({ is_in_chat: true }), response({ message_id: 'om_canary' }),
        response({ items: [{ ...nativeCanary(), ...change }] })]
      await assert.rejects(() => runCanary('send', authorized, async (_url, init) => {
        if (init?.method === 'POST') sends++
        return replies.shift()!
      }), fail('unknown'))
      assert.equal(sends, 1)
    }
    const replies = [response({ open_id: 'ou_user' }), response({ is_in_chat: true }), response({ message_id: 'om_canary' }), response({}, 99991677)]
    await assert.rejects(() => runCanary('send', authorized, async () => replies.shift()!), fail('unknown'))
  })

  it('fails closed on identity/membership mismatch before sending and never replays an unverified send', async () => {
    for (const replies of [
      [response({ open_id: 'ou_other' })],
      [response({ open_id: 'ou_user' }), response({ is_in_chat: false })],
      [response({ open_id: 'ou_user' }), response({ is_in_chat: true }), response({ message_id: 'om_canary' }), response({ items: [] })],
    ]) {
      let sends = 0
      await assert.rejects(() => runCanary('send', authorized, async (_url, init) => {
        if (init?.method === 'POST') sends++
        return replies.shift()!
      }))
      assert.ok(sends <= 1)
      assert.equal(replies.length, 0)
    }
  })
})
