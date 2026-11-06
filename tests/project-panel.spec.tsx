// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, click, field, text, type, all, at } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workerFixture } from './fixtures/project-worker.ts'

usePanel()
it('opens a registered immutable file version and submits independent semantic evidence for its exact report', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'project-panel-worker-')), f = workerFixture(directory)
  try {
    f.prepare()
    const artifact = f.write()
    const report = f.reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }]))
    server.projects = [f.project]
    server.conversations[f.project.id] = { project: f.project, messages: [], tasks: [f.store.tickets.get(f.plan.ticketId)!], artifacts: f.artifacts.view(f.project.id), reports: [report], decisions: [] }
    at({ page: 'projects', id: f.project.id }); await mount(en)
    expect(text()).toContain(en.humanReview)
    expect(text()).toContain('note.md')
    await click(en.artifactRead)
    expect(server.requests.some(item => item.path === `projects/${f.project.id}/artifacts/${artifact.id}/${artifact.contentVersion}`)).toBe(true)
    expect(text()).toContain('Fixture artifact content')
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:t9-artifact'), revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const requestFetch = vi.spyOn(globalThis, 'fetch')
    await click(en.artifactDownload)
    expect(server.requests.some(item => item.path === `projects/${f.project.id}/artifacts/${artifact.id}/${artifact.contentVersion}/download`)).toBe(true)
    const downloadCall = requestFetch.mock.calls.find(([url]) => String(url).endsWith(`/artifacts/${artifact.id}/${artifact.contentVersion}/download`))
    expect(downloadCall?.[1]?.headers).toMatchObject({ 'x-orchestrator-request': '1' })
    expect(createObjectURL).toHaveBeenCalledTimes(1); expect(anchorClick).toHaveBeenCalledTimes(1); expect(revokeObjectURL).toHaveBeenCalledWith('blob:t9-artifact')
    server.failArtifactDownload = true
    await click(en.artifactDownload)
    expect(text()).toContain(en.artifactDownloadError)
    expect(text()).toContain('Artifact download temporarily unavailable')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    server.failArtifactDownload = false
    await click(en.artifactDownloadRetry)
    expect(text()).not.toContain(en.artifactDownloadError)
    expect(createObjectURL).toHaveBeenCalledTimes(2); expect(anchorClick).toHaveBeenCalledTimes(2)
    expect(all('button').find(item => item.textContent === en.acceptancePass)?.hasAttribute('disabled')).toBe(true)
    await type(field<HTMLTextAreaElement>(en.acceptanceEvidence), 'Checked sources and scope against the original request')
    await click(en.acceptancePass)
    expect(server.requests.find(item => item.path === `projects/${f.project.id}/acceptance`)?.body).toMatchObject({ ticketId: f.plan.ticketId, reportId: report.id, conclusion: 'passed', evidence: 'Checked sources and scope against the original request' })
    expect(text()).toContain('Fixture gate requires a registered report')
    expect(server.conversations[f.project.id]?.tasks?.[0]?.ended).toBeUndefined()
  } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }) }
})
it.each([zh, en])('shows localized blockers alongside the independent gate and reviews only the current report (%#)', async dictionary => {
  const directory = mkdtempSync(join(tmpdir(), 'project-panel-blockers-')), f = workerFixture(directory, { version: 2, mode: 'human-review' })
  try {
    f.prepare()
    const artifact = f.write(), report = f.reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }], { unresolved: ['尚缺原始文献的发布日期', 'The cited table has not been checked'] }))
    const update = () => {
      server.projects = [f.project]
      server.conversations[f.project.id] = { project: f.project, messages: [], tasks: [f.store.tickets.get(f.plan.ticketId)!], artifacts: f.artifacts.view(f.project.id), reports: f.reports.reports(f.plan.ticketId), decisions: f.reports.decisions(f.plan.ticketId) }
    }
    update(); at({ page: 'projects', id: f.project.id }); await mount(dictionary)
    expect(text()).toContain(dictionary.executionUnresolved)
    expect(text()).toContain(dictionary.reportUnresolved)
    expect(text()).toContain('尚缺原始文献的发布日期'); expect(text()).toContain('The cited table has not been checked')
    expect(text()).not.toContain('unresolved-items')
    expect(text()).toContain(dictionary.acceptanceBlockersRemain)
    await type(field<HTMLTextAreaElement>(dictionary.acceptanceEvidence), 'Reviewed available note; remaining source work is still required')
    expect(all('button').find(item => item.textContent === dictionary.acceptancePass)?.hasAttribute('disabled')).toBe(false)
    f.reports.decide('owner', f.project.id, { ticketId: f.plan.ticketId, reportId: report.id, operationId: 'blocked-pass', conclusion: 'passed', evidence: 'Reviewed this version' })
    expect(f.store.tickets.get(f.plan.ticketId)?.ended).toBeUndefined()
    const revised = f.write('# Note\nSources and dates checked.', 'revised-file')
    const next = f.reports.submit(f.attempt.sessionId, f.report([{ id: revised.id, contentVersion: revised.contentVersion }], { operationId: 'revised-report' }))
    update(); await remount(dictionary)
    expect(text()).toContain(dictionary.executionSemanticReview)
    expect(text()).not.toContain('semantic-review')
    expect(text()).not.toContain('尚缺原始文献的发布日期')
    expect(text()).not.toContain('The cited table has not been checked')
    expect(text()).toContain(dictionary.acceptancePass)
    f.reports.decide('owner', f.project.id, { ticketId: f.plan.ticketId, reportId: next.id, operationId: 'current-pass', conclusion: 'passed', evidence: 'Reviewed revised content' })
    update(); await remount(dictionary)
    expect(text()).toContain(dictionary.executionDone)
    expect(all('button').some(item => item.textContent === dictionary.acceptancePass)).toBe(false)
  } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('opens the project home, creates a project from name and goal, and isolates its conversation', async () => {
  at({ page: 'projects' })
  await mount()
  expect(text()).toContain(zh.projectHome)
  await type(field<HTMLInputElement>(zh.projectName), 'KORAM')
  await type(field<HTMLInputElement>(zh.projectGoal), 'Research and code together')
  await click(zh.projectCreateSubmit)
  expect(text()).toContain('KORAM')
  expect(server.requests.some(request => request.path === 'projects' && request.method === 'POST')).toBe(true)
  expect(server.requests.some(request => request.path === 'projects/p2/conversation')).toBe(true)
})

it('keeps saved history distinct from a coordinator draft and retries coordinator failures', async () => {
  server.conversations.p1 = { ...server.conversations.p1!, messages: [{ id: 'm1', projectId: 'p1', role: 'user', text: 'Saved question',
    createdAt: '2026-09-23T00:00:00Z', status: 'saved' }], draft: { text: 'Draft answer' }, coordinator: { status: 'error', error: 'timeout' } }
  at({ page: 'projects' })
  await mount()
  await click('Demo project')
  expect(text()).toContain('Saved question')
  expect(text()).toContain(zh.conversationDraft)
  expect(text()).toContain('Draft answer')
  expect(text()).toContain(zh.conversationCoordinatorError)
  await click(zh.conversationRetry)
  expect(server.requests.some(request => request.path === 'projects/p1/retry' && request.method === 'POST')).toBe(true)
})

it('sends one durable user message and polls the project conversation', async () => {
  at({ page: 'projects' })
  await mount(en)
  await click('Demo project')
  await type(field<HTMLTextAreaElement>(en.conversationLocalDraft), 'Hello project')
  await click(en.conversationSend)
  const send = server.requests.find(request => request.path === 'projects/p1/messages')
  expect(send?.method).toBe('POST')
  expect(send?.body).toMatchObject({ text: 'Hello project' })
  expect(all('.dt-conversation-user').map(item => item.textContent).join(' ')).toContain('Hello project')
  await remount(en)
  expect(text()).toContain('Hello project')
})

it('polls persisted assistant replies and replaces the separate live draft', async () => {
  at({ page: 'projects', id: 'p1' })
  server.conversations.p1!.draft = { text: 'Still generating' }
  await mount(en)
  expect(text()).toContain(en.conversationDraft)
  const project = server.projects[0]!
  server.conversations.p1 = { project, messages: [{ id: 'reply', projectId: 'p1', role: 'assistant', text: 'Finished reply',
    createdAt: project.createdAt, status: 'saved' }] }
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(text()).toContain('Finished reply')
  }, { timeout: 2500, interval: 25 })
  expect(text()).not.toContain('Still generating')
  expect(text()).not.toContain(en.conversationDraft)
  expect(server.requests.filter(request => request.path === 'projects/p1/conversation').length).toBeGreaterThan(1)
})

it('restores an unsent project draft after refresh without leaking it to another project', async () => {
  at({ page: 'projects', id: 'p1' }); await mount(en)
  await type(field<HTMLTextAreaElement>(en.conversationLocalDraft), 'Keep this through a reconnect')
  await remount(en)
  expect(field<HTMLTextAreaElement>(en.conversationLocalDraft).value).toBe('Keep this through a reconnect')
  const second = { ...server.projects[0]!, id: 'p2', name: 'Second project' }
  server.projects.push(second); server.conversations.p2 = { project: second, messages: [], tasks: [] }; server.projectEvents.p2 = []
  await click(en['tab.projects']); await click('Second project')
  expect(field<HTMLTextAreaElement>(en.conversationLocalDraft).value).toBe('')
})

it('reuses the request id after an ambiguous network failure', async () => {
  at({ page: 'projects', id: 'p1' }); await mount(en)
  const actual = globalThis.fetch
  let loseResponse = true
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = await actual(input, init)
    if (String(input).endsWith('/messages') && loseResponse) {
      loseResponse = false
      // Consume the fake server response to release its in-flight counter, then simulate losing it on the network.
      await result.text()
      throw new TypeError('Network disconnected')
    }
    return result
  })
  await type(field<HTMLTextAreaElement>(en.conversationLocalDraft), '  Retry safely\n')
  await click(en.conversationSend)
  expect(field<HTMLTextAreaElement>(en.conversationLocalDraft).value).toBe('  Retry safely\n')
  expect(text()).toContain(en.conversationSaveError)
  // Refresh restores the exact in-flight request id; resubmitting is therefore idempotent.
  await remount(en)
  await click(en.conversationSend)
  const requests = server.requests.filter(request => request.path === 'projects/p1/messages')
  expect(requests).toHaveLength(2)
  expect(requests[0]!.body).toEqual(requests[1]!.body)
  expect(server.conversations.p1!.messages).toHaveLength(1)
  expect(field<HTMLTextAreaElement>(en.conversationLocalDraft).value).toBe('')
})

it('shows only the selected project history and drops unsent input when switching projects', async () => {
  const second = { ...server.projects[0]!, id: 'p2', name: 'Second project' }
  server.projects.push(second)
  server.conversations.p2 = { project: second, messages: [{ id: 'a2', projectId: 'p2', role: 'assistant', text: 'Second answer',
    status: 'saved', createdAt: second.createdAt }] }
  server.conversations.p1!.messages.push({ id: 'a1', projectId: 'p1', role: 'assistant', text: 'First answer',
    status: 'saved', createdAt: second.createdAt })
  at({ page: 'projects' }); await mount(); await click('Demo project')
  await type(field<HTMLTextAreaElement>(zh.conversationLocalDraft), 'Private unsent draft')
  await click(zh['tab.projects']); await click('Second project')
  expect(text()).toContain('Second answer')
  expect(text()).not.toContain('First answer')
  expect(field<HTMLTextAreaElement>(zh.conversationLocalDraft).value).toBe('')
  expect(server.requests.some(request => request.path.includes('tickets') || request.path.includes('executor'))).toBe(false)
})


it('replays a committed knowledge write with the frozen operation id after its response was lost', async () => {
  server.loseKnowledgeResponse = true
  at({ page: 'projects', id: 'p1' }); await mount(en)
  await type(field<HTMLInputElement>('Knowledge title'), 'Lost response note')
  await type(field<HTMLTextAreaElement>('Content'), 'The server committed this version before the response vanished.')
  await click('Propose knowledge version')
  expect(server.materials.knowledge).toHaveLength(1)
  expect(text()).toContain('Knowledge title')
  // The fields and the pending operation are still the same user intent, so the retry reuses the
  // exact operation id and payload; the fixture applies the first write only once.
  await click('Propose knowledge version')
  const writes = server.requests.filter(request => request.method === 'POST' && request.path === 'projects/p1/knowledge')
  expect(writes).toHaveLength(2)
  expect(writes[0]!.body).toMatchObject({ operationId: expect.any(String), title: 'Lost response note' })
  expect(writes[1]!.body).toEqual(writes[0]!.body)
  expect(server.materials.knowledge).toHaveLength(1)
  expect(text()).toContain('Lost response note')
  // A changed payload is a new intent, not a replay: it gets a new operation id.
  await type(field<HTMLInputElement>('Knowledge title'), 'A different note')
  await type(field<HTMLTextAreaElement>('Content'), 'Different content is a new write.')
  await click('Propose knowledge version')
  const changed = server.requests.filter(request => request.method === 'POST' && request.path === 'projects/p1/knowledge')
  expect(changed).toHaveLength(3)
  const operationId = (index: number) => (changed[index]!.body as { operationId: string }).operationId
  expect(operationId(2)).not.toBe(operationId(0))
  expect(server.materials.knowledge).toHaveLength(2)
})

it('replays a committed resource registration with the frozen operation id after its response was lost', async () => {
  server.loseResourceResponse = true
  at({ page: 'projects', id: 'p1' }); await mount(en)
  await type(field<HTMLInputElement>('Registered path'), '/srv/project/materials')
  await click('Register resource')
  expect(server.materials.resources).toHaveLength(1)
  await click('Register resource')
  const writes = server.requests.filter(request => request.method === 'POST' && request.path === 'projects/p1/resources')
  expect(writes).toHaveLength(2)
  expect(writes[0]!.body).toMatchObject({ operationId: expect.any(String), path: '/srv/project/materials' })
  expect(writes[1]!.body).toEqual(writes[0]!.body)
  expect(server.materials.resources).toHaveLength(1)
  expect(server.materials.resources[0]).toMatchObject({ path: '/srv/project/materials', type: 'directory', purpose: 'code-source' })
  expect(text()).toContain('code-source · directory · active')
})
