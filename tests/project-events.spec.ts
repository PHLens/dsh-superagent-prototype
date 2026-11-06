import { afterEach, beforeEach, expect, it } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { ProjectEvents, type ProjectEvent } from '../src/app/events.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

const event = (projectId: string, id: string, at: string): ProjectEvent => ({ id, projectId, ticketId: `ticket-${id}`, kind: 'report-recorded', version: id,
  operationId: id, at })

it('resumes by durable sequence, deduplicates at the cursor, and snapshots an unknown/expired cursor', () => {
  const c = h.runtime.projectCoordinator, first = c.create('owner', { name: 'Event project', goal: 'Reconnect safely' }),
    second = c.create('owner', { name: 'Other project', goal: 'Remain isolated' })
  const events = new ProjectEvents(h.runtime.store)
  h.runtime.store.atomic(() => {
    events.append(event(first.id, 'a', '2026-11-05T00:00:01Z'))
    events.append(event(second.id, 'foreign', '2026-11-05T00:00:02Z'))
    events.append(event(first.id, 'b', '2026-11-05T00:00:03Z'))
    events.append(event(first.id, 'c', '2026-11-05T00:00:04Z'))
  })
  const page = c.events('owner', first.id, 0, undefined, 2)
  expect(page).toMatchObject({ projectId: first.id, reset: false, events: [{ event: { id: 'a' } }, { event: { id: 'b' } }] })
  expect(page.events.every(item => item.event.projectId === first.id)).toBe(true)
  expect(page.cursorId).toBe('b')
  const next = c.events('owner', first.id, page.cursor, page.cursorId, 10)
  expect(next.events.map(item => item.event.id)).toEqual(['c'])
  expect(next.cursor).toBeGreaterThan(page.cursor)
  expect(c.events('owner', first.id, next.cursor, next.cursorId, 10)).toMatchObject({ cursor: next.cursor, cursorId: 'c', reset: false, events: [] })

  const missing = c.events('owner', first.id, 999_999, 'unknown', 10)
  expect(missing).toMatchObject({ reset: true, cursor: next.cursor, snapshot: { project: { id: first.id } } })
  expect(missing.events.map(item => item.event.id)).toEqual(['a', 'b', 'c'])
})

it('keeps the counter unchanged when a health transition cannot be persisted', async () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Health atomicity', goal: 'Do not leave a phantom cursor' })
  const before = Number((h.runtime.store.db.prepare('SELECT value FROM project_event_counter').get() as { value: number }).value)
  h.runtime.store.db.exec(`CREATE TRIGGER fail_health_event BEFORE INSERT ON project_event
    WHEN json_extract(NEW.payload, '$.kind') = 'health-changed'
    BEGIN SELECT RAISE(ABORT, 'injected health event failure'); END`)
  await expect((c as any).schedule(project.id, 'owner', async () => { throw new Error('coordinator failed') }))
    .rejects.toThrow('coordinator failed')
  expect((h.runtime.store.db.prepare('SELECT value FROM project_event_counter').get() as { value: number }).value).toBe(before)
  expect(h.runtime.store.db.prepare("SELECT count(*) AS n FROM project_event WHERE project_id=? AND json_extract(payload, '$.kind')='health-changed'").get(project.id))
    .toEqual({ n: 0 })
})

it('rolls a message back when its durable event cannot be written', () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Atomic project', goal: 'Keep writes and facts together' })
  h.runtime.store.db.exec('DROP TABLE project_event_counter')
  expect(() => c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'atomic', text: 'Must not persist alone' })).toThrow(/project_event_counter/)
  expect(c.conversations.listMessages(project.id, 'owner')).toHaveLength(0)
})

it('records messages, confirmed assignments, artifacts, delivery and health as durable project facts', async () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Observed project', goal: 'Record every owned change' })
  const request = c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'message', text: 'Write one note' })
  const replay = c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'message', text: 'Write one note' })
  expect(replay.id).toBe(request.id)
  expect(c.events('owner', project.id, 0, undefined, 500).events.filter(item => item.event.kind === 'conversation-message')).toHaveLength(1)

  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'plan', plan: { goal: 'Observed note', scope: 'One file',
    outputs: ['note'], resources: [], environment: 'Managed', cost: 'One worker', completion: 'One note', acceptance: { version: 1, mode: 'registered-files' } } })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'confirm', text: '按这个方案做' })
  const confirmed = c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  const attempt = c.attempts.prepare(c.attempts.allocate(confirmed.ticket, confirmed.assignment))
  c.artifacts.write(attempt.sessionId, { operationId: 'note', output: 'note', name: 'note.md', content: '# Observed' })
  h.runtime.outbox.send({ id: 'project-delivery', ticketId: plan.ticketId, kind: 'notice', text: 'One project update',
    channel: { source: 'feishu', thread: `feishu:${project.id}`, address: { projectId: project.id } } })
  const ticket = h.runtime.store.tickets.get(plan.ticketId)!, question = { id: 'attention-event', version: 1, question: 'Continue?' }
  ticket.attention = question; ticket.attentionQuestions = [question]; ticket.attentionSequence = 1; h.runtime.store.tickets.save(ticket)
  expect(await h.api('POST', `tickets/${ticket.id}/attention`, { version: 1, questionId: question.id, text: 'Continue' })).toMatchObject({ status: 200, body: { resolved: true } })
  await expect((c as any).schedule(project.id, 'owner', async () => { throw new Error('isolated coordinator failure') })).rejects.toThrow('isolated coordinator failure')
  await c.retry('owner', project.id)
  const recorded = c.events('owner', project.id, 0, undefined, 500).events.map(item => item.event), kinds = new Set(recorded.map(item => item.kind))
  for (const kind of ['conversation-message', 'task-changed', 'assignment-ready', 'artifact-registered', 'delivery-changed', 'question-answered', 'health-changed'] as const) expect(kinds).toContain(kind)
  expect(new Set(recorded.filter(item => item.kind === 'health-changed').map(item => item.health?.status))).toEqual(new Set(['error', 'recovered']))
})

it('does not reuse a durable sequence when the newest retained event is removed', () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Monotonic project', goal: 'Never reuse a cursor' })
  const events = new ProjectEvents(h.runtime.store)
  h.runtime.store.atomic(() => events.append(event(project.id, 'first', '2026-11-05T00:00:01Z')))
  h.runtime.store.db.prepare('DELETE FROM project_event WHERE id=?').run('first')
  h.runtime.store.atomic(() => events.append(event(project.id, 'second', '2026-11-05T00:00:02Z')))
  const page = c.events('owner', project.id, 0, undefined, 10)
  expect(page.events).toEqual([{ sequence: 2, event: expect.objectContaining({ id: 'second' }) }])
})

it('rolls the final reconciliation state back when its event cannot be written', async () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Reconcile atomicity', goal: 'Keep state and event together' })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Write one note' })
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'plan', plan: { goal: 'One note', scope: 'One file',
    outputs: ['note'], resources: [], environment: 'Managed', cost: 'One worker', completion: 'One note', acceptance: { version: 1, mode: 'registered-files' } } })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'confirm', text: '按这个方案做' })
  c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  h.runtime.store.db.exec(`CREATE TRIGGER fail_reconcile_event BEFORE INSERT ON project_event
    WHEN json_extract(NEW.payload, '$.kind') = 'reconcile'
    BEGIN SELECT RAISE(ABORT, 'injected reconcile event failure'); END`)
  expect((await h.api('POST', `tickets/${plan.ticketId}/reconcile`, { operationId: 'reconcile-atomic' })).status).toBe(500)
  expect(h.runtime.store.tickets.get(plan.ticketId)?.lifecycle?.reconciliation?.state).not.toBe('clear')
  expect(h.runtime.store.db.prepare("SELECT count(*) AS n FROM project_event WHERE project_id=? AND json_extract(payload, '$.kind')='reconcile'").get(project.id)).toEqual({ n: 0 })
  h.runtime.store.db.exec('DROP TRIGGER fail_reconcile_event')
  expect(await h.api('POST', `tickets/${plan.ticketId}/reconcile`, { operationId: 'reconcile-atomic' })).toMatchObject({ status: 200, body: { state: 'clear' } })
  expect(h.runtime.store.tickets.get(plan.ticketId)?.lifecycle?.reconciliation?.state).toBe('clear')
  expect(h.runtime.store.db.prepare("SELECT count(*) AS n FROM project_event WHERE project_id=? AND json_extract(payload, '$.kind')='reconcile'").get(project.id)).toEqual({ n: 1 })
})

it('puts an unconfirmed plan before the project and clears that pending item after explicit confirmation', () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Pending project', goal: 'Confirm one bounded change' })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Make one bounded change' })
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'plan', plan: { goal: 'One change', scope: 'One file',
    outputs: ['note'], resources: [], environment: 'Managed', cost: 'One worker', completion: 'One note', acceptance: { version: 1, mode: 'registered-files' } } })
  expect(c.home('owner').pending).toContainEqual(expect.objectContaining({ projectId: project.id, ticketId: plan.ticketId, kind: 'confirmation' }))
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'confirm', text: '按这个方案做' })
  c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  expect(c.home('owner').pending.some(item => item.ticketId === plan.ticketId && item.kind === 'confirmation')).toBe(false)
  const ticket = h.runtime.store.tickets.get(plan.ticketId)!, at = '2099-11-05T00:00:00Z'
  ticket.lifecycle = { pause: { intent: 'pause', state: 'paused', at }, stop: { intent: 'none', state: 'running', at }, observed: { state: 'idle', at } }
  h.runtime.store.tickets.save(ticket)
  expect(c.home('owner').projects.find(item => item.project.id === project.id)).toMatchObject({ status: 'paused', paused: true, lastCheckedAt: at })
})

it('references the same normalized report message from the task and project conversation', () => {
  const c = h.runtime.projectCoordinator, project = c.create('owner', { name: 'Shared report', goal: 'One checked file' })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Write one checked file' })
  const plan = c.plans.save('owner', project.id, { expectedRevision: 0, operationId: 'plan', plan: { goal: 'Checked file', scope: 'One file', outputs: ['note'],
    resources: [], environment: 'Managed', cost: 'One worker', completion: 'One note', acceptance: { version: 1, mode: 'registered-files' } } })
  c.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'confirm', text: '按这个方案做' })
  const confirmed = c.confirm('owner', project.id, { ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  const attempt = c.attempts.prepare(c.attempts.allocate(confirmed.ticket, confirmed.assignment))
  const artifact = c.artifacts.write(attempt.sessionId, { operationId: 'note', output: 'note', name: 'note.md', content: '# Checked' })
  const report = c.reports.submit(attempt.sessionId, { operationId: 'ready', state: 'ready', completed: 'Wrote the checked note', evidence: ['Read the file'],
    artifacts: [{ id: artifact.id, contentVersion: artifact.contentVersion }], unresolved: [] })
  const view = c.view('owner', project.id), shown = view.reports.find(item => item.id === report.id)!
  expect(shown.conversationMessageId).toBeDefined()
  const messageId = shown.conversationMessageId!
  expect(view.messages.find(item => item.id === messageId)).toMatchObject({ role: 'assistant', status: 'saved' })
  const accepted = h.runtime.store.db.prepare('SELECT * FROM conversation_message WHERE id=?').get(messageId) as {
    id: string; project_id: string; client_request_key: string; role: string; actor_id: string; text: string; created_at: string; status: string
    request_ticket_id: string | null; request_plan_revision: number | null
  }
  h.runtime.store.db.prepare('DELETE FROM conversation_message WHERE id=?').run(messageId)
  h.runtime.store.db.prepare(`INSERT INTO conversation_message
    (id,project_id,client_request_key,role,actor_id,text,created_at,status,request_ticket_id) VALUES (?,?,?,'assistant',?,?,?,'saved',?)`)
    .run(`worker-result:${report.id}:semantic-review`, project.id, `worker-result:${report.id}:semantic-review`, 'owner', 'Waiting for review', '2026-11-05T00:00:00Z', plan.ticketId)
  h.runtime.store.db.prepare(`INSERT INTO conversation_message
    (id,project_id,client_request_key,role,actor_id,text,created_at,status,request_ticket_id,request_plan_revision) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(accepted.id, accepted.project_id, accepted.client_request_key, accepted.role, accepted.actor_id, accepted.text, accepted.created_at,
      accepted.status, accepted.request_ticket_id, accepted.request_plan_revision)
  const latest = c.view('owner', project.id).reports.find(item => item.id === report.id)!
  expect(latest.conversationMessageId).toBe(messageId)
})
