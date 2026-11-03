import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { projectWorkerTools } from '../src/app/tools/executor.ts'
import { DshExecutor } from '../src/executor/dsh.ts'

let h: Host | undefined
afterEach(async () => {
  if (h) {
    for (const agent of h.agents.values()) agent.status = 'idle'
    await h.stop()
    h = undefined
  }
  vi.restoreAllMocks()
})
async function setup() {
  h = await startRuntime()
  const c = h.runtime.projectCoordinator
  const p = c.create('owner', { name: 'Question continuation', goal: 'One note' })
  c.conversations.appendUser(p.id, 'owner', { clientRequestKey: 'original', text: 'Write one note.' })
  const plan = c.plans.save('owner', p.id, { expectedRevision: 0, operationId: 'plan', plan: {
    goal: 'One note', scope: 'One note', outputs: ['note'], resources: [], environment: 'Managed', cost: 'One worker', completion: 'A note', acceptance: { version: 1, mode: 'registered-files' },
  } })
  c.confirm('owner', p.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  h.runtime.executor.dispatchProjects()
  await waitUntil(() => c.attempts.all().some(a => a.ticketId === plan.ticketId && a.status === 'running'))
  const attempt = c.attempts.all().find(a => a.ticketId === plan.ticketId)!
  const agent = h.agents.get(attempt.sessionId)!
  agent.status = 'idle'; agent.inbox.nextStep.length = 0; agent.inbox.nextTurn.length = 0
  const ask = (operation_id = 'question', question = 'Which dataset?') => h!.runGuardedTool(attempt.sessionId, 'project_worker_request_question', { operation_id, question }) as Promise<{ question: { id: string; version: number; question: string; binding: object } }>
  const deliveries = () => h!.deliveries.mock.calls.map(([d]) => d).filter(d => d.sessionId === attempt.sessionId && d.text.includes('answered the pending Attention'))
  const answer = (q: { id: string; version: number }, text = 'Persisted dataset B') => h!.runtime.engine.answerAttention(plan.ticketId, q.version, { source: 'web', id: 'owner' }, 'web', text, q.id)
  return { c, p, plan, attempt, agent, ask, answer, deliveries }
}


it('cold reconciliation resumes one pending answer without resubmitting the whole execution plan', async () => {
  const f = await setup(), {question} = await f.ask('cold-question', 'Which dataset after restart?')
  const originalExecutor = h!.runtime.executor
  h!.runtime.engine.pauseTicket(f.plan.ticketId)
  originalExecutor.dispatchProjects()
  await waitUntil(() => h!.runtime.store.tickets.get(f.plan.ticketId)?.lifecycle?.pause.state === 'paused')
  const answered = f.answer(question, 'COLD_ANSWER_DATASET_B_9027')
  expect(await originalExecutor.continueAfterAttention(f.plan.ticketId, answered.answer.id, answered.answer.text)).toBe(false)
  expect(h!.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!.attentionContinuation!.deliveredAt).toBeUndefined()
  // Restart loses executor scheduling memory and unloads the native agent;
  // durable application attempt/question/answer/file state remains intact.
  await h!.runtime.passes.stop()
  originalExecutor.dispose()
  const host = (originalExecutor as unknown as {host: ConstructorParameters<typeof DshExecutor>[0]}).host
  const cold = new DshExecutor({...host, effects: {handle: vi.fn()} as unknown as typeof host.effects})
  const persistedExecution = h!.deliveries.mock.calls.map(([d]) => d).filter(d => d.sessionId === f.attempt.sessionId)
  expect(persistedExecution).toHaveLength(1)
  const nativeHistory = persistedExecution.map(d => ({ type: 'user/message', data: { id: d.id, role: 'user', source: {kind:'dsh-superagent', form:'relay'}, content: [{type:'text',text:d.text}] } }))
  // Preserve the original execution prompt in native persistence. The
  // restored delivery must not rely on an empty-history fixture to dedupe.
  const readHistory = vi.fn(async (offset = 0, limit = 512) => ({events:nativeHistory.slice(offset,offset+limit)}))
  const persistence = h!.ctx.sessionPersistence
  persistence.open = vi.fn(async () => ({read:readHistory,[Symbol.asyncDispose]:async()=>{}})) as unknown as typeof persistence.open
  h!.agents.delete(f.attempt.sessionId)
  try {
    cold.resume()
    expect(f.c.attempts.bySession(f.attempt.sessionId)?.status).toBe('reconcile')
    expect(await cold.reconcileTicket(f.plan.ticketId, 'cold-reconcile-once')).toEqual({state:'clear',operationId:'cold-reconcile-once'})
    expect(f.c.attempts.bySession(f.attempt.sessionId)?.status).toBe('prepared')
    const allBefore = h!.deliveries.mock.calls.map(([d]) => d).filter(d => d.sessionId === f.attempt.sessionId)
    expect(allBefore).toHaveLength(1)
    h!.runtime.engine.resumeTicket(f.plan.ticketId)
    for (let i=0;i<8;i++) {cold.dispatchProjects(); await new Promise<void>(resolve=>setImmediate(resolve))}
    await waitUntil(()=>!!h!.runtime.store.tickets.get(f.plan.ticketId)!.lifecycle!.attentionContinuation!.deliveredAt)
    cold.dispatchProjects(); await new Promise<void>(resolve=>setImmediate(resolve))
    const allAfter = h!.deliveries.mock.calls.map(([d]) => d).filter(d => d.sessionId === f.attempt.sessionId)
    const newlyDelivered = allAfter.slice(allBefore.length)
    console.log('COLD attention all execution inputs', {before:allBefore.map(d=>({id:d.id,text:d.text})),newlyDelivered:newlyDelivered.map(d=>({id:d.id,text:d.text})),attempts:f.c.attempts.all().length})
    // Count every execution input. Filtering only Attention text would miss a
    // second complete Execute-plan wake before the correct answer arrives.
    expect.soft(newlyDelivered).toHaveLength(1)
    expect.soft(newlyDelivered.every(d=>d.text.includes('COLD_ANSWER_DATASET_B_9027'))).toBe(true)
    expect.soft(newlyDelivered.some(d=>d.text.includes('Execute exactly the confirmed plan'))).toBe(false)
    expect.soft(f.c.attempts.all()).toHaveLength(1)
    expect.soft(readHistory).toHaveBeenCalled()
  } finally {cold.dispose()}
})
