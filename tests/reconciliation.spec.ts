import { afterEach, beforeEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

it('exposes owner reconciliation with a server-owned outcome', async () => {
  const { ticket } = await h.acceptedTicket(feishu('reconcile-route', 'Check the running work.'))
  const response = await h.api('POST', `tickets/${ticket.id}/reconcile`, { operationId: 'reconcile-1' })
  expect(response.status).toBe(200)
  expect(response.body).toEqual({ state: 'unknown', operationId: 'reconcile-1' })
  expect(h.runtime.store.tickets.get(ticket.id)?.lifecycle?.reconciliation).toMatchObject({
    state: 'unknown', operationId: 'reconcile-1',
  })
})

it('rejects caller supplied reconciliation outcomes', async () => {
  const { ticket } = await h.acceptedTicket(feishu('reconcile-schema', 'Check the running work.'))
  const response = await h.api('POST', `tickets/${ticket.id}/reconcile`, { operationId: 'reconcile-2', state: 'clear' })
  expect(response.status).toBe(400)
})
