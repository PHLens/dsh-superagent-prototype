import { afterEach, expect, it } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
let h: Host
 afterEach(async () => { if (h) { for (const agent of h.agents.values()) agent.status = 'idle'; await h.stop() } })
it('does not accept a ready report while the current owner question is unanswered', async () => {
  h = await startRuntime()
  const c = h.runtime.projectCoordinator, p = c.create('owner', {name:'Pending question gate',goal:'One file'})
  c.conversations.appendUser(p.id,'owner',{clientRequestKey:'origin',text:'Write one note.'})
  const plan = c.plans.save('owner',p.id,{expectedRevision:0,operationId:'plan',plan:{goal:'One file',scope:'One note',outputs:['note'],resources:[],environment:'Managed',cost:'One worker',completion:'One note after the owner answers',acceptance:{version:1,mode:'registered-files'}}})
  c.confirm('owner',p.id,{ticketId:plan.ticketId,planRevision:1,operationId:'confirm',intent:'execute'})
  h.runtime.executor.dispatchProjects()
  await waitUntil(()=>c.attempts.all().some(a=>a.ticketId===plan.ticketId&&a.status==='running'))
  const attempt = c.attempts.all().find(a=>a.ticketId===plan.ticketId)!
  const agent = h.agents.get(attempt.sessionId)!; agent.status='idle';agent.inbox.nextStep.length=0;agent.inbox.nextTurn.length=0
  const {question} = await h.runGuardedTool(attempt.sessionId,'project_worker_request_question',{operation_id:'ask',question:'What should the note contain?'}) as {question:{id:string}}
  const artifact = c.artifacts.write(attempt.sessionId,{operationId:'file',output:'note',name:'note.md',content:'# Unconfirmed guess'})
  c.reports.submit(attempt.sessionId,{operationId:'premature-ready',state:'ready',completed:'Guessed content',evidence:['Registered file'],artifacts:[{id:artifact.id,contentVersion:artifact.contentVersion}],unresolved:[]})
  const actual = h.runtime.store.tickets.get(plan.ticketId)!
  expect.soft(actual.attention?.id).toBe(question.id)
  expect.soft(actual.ended).toBeUndefined()
  expect.soft(c.attempts.bySession(attempt.sessionId)?.status).not.toBe('ended')
})
