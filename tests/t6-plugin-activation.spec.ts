import { expect, it } from 'vitest'
import { feishu, startRuntime } from './fixtures/host.ts'

it('activates Runtime under the real entry inject declaration and Cordis service guards', async () => {
  const h = await startRuntime(undefined, true)
  try {
    const managed = await h.acceptedTicket(feishu('activation', '@bot fix activation'))
    expect(h.agents.has(managed.sessionId)).toBe(true)
    expect(h.runtime.scheduler.status()).toEqual(expect.any(Array))
  } finally { await h.stop() }
})
