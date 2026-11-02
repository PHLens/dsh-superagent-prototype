// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LifecycleState } from '../src/core/model.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, at, mount, remount, click, field, text, type, all, settle } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import { workerFixture } from './fixtures/project-worker.ts'

usePanel()
const atTime = '2026-11-02T12:00:00Z'
const lifecycle = (): LifecycleState => ({
  pause: { intent: 'none', state: 'running', at: atTime },
  stop: { intent: 'none', state: 'running', at: atTime },
  observed: { state: 'running', at: atTime },
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lifecycle-panel-'))
  const f = workerFixture(directory)
  const task = f.store.tickets.get(f.plan.ticketId)!
  task.lifecycle = lifecycle()
  server.projects = [f.project]
  server.conversations[f.project.id] = { project: f.project, messages: [], tasks: [task] }
  at({ page: 'projects', id: f.project.id })
  return { ...f, task, dispose() { f.store.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

it('keeps an unconfirmed plan inert instead of presenting an unstarted execution as unknown', async () => {
  const f = fixture()
  f.task.assignments = []; f.task.authorizations = []; f.task.executionTargets = []
  f.task.lifecycle!.observed.state = 'unknown'
  try {
    await mount(en)
    expect(text()).toContain(en.planConfirm)
    expect(text()).not.toContain(en.taskUnknown)
    expect(all('button').some(item => [en.taskPause, en.taskResume, en.taskStop].includes(item.textContent ?? ''))).toBe(false)
  } finally { f.dispose() }
})

it.each([zh, en])('uses server observations for pausing/paused/stopping/exited instead of optimistic receipts (%#)', async dictionary => {
  const f = fixture(), calls: string[] = [], actual = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('/tickets/' + f.task.id + '/')) {
      calls.push(url)
      if (url.endsWith('/pause')) f.task.lifecycle!.pause = { intent: 'pause', state: 'pausing', at: atTime }
      if (url.endsWith('/resume')) f.task.lifecycle!.pause = { intent: 'resume', state: 'running', at: atTime }
      if (url.endsWith('/stop')) f.task.lifecycle!.stop = { intent: 'stop', state: 'stopping', at: atTime }
      return reply({ paused: true, resumed: true, stopped: true })
    }
    return actual(input, init)
  })
  try {
    await mount(dictionary)
    await click(dictionary.taskPause)
    expect(text()).toContain(dictionary.taskPausing)
    expect(text()).not.toContain(dictionary.taskPaused)
    expect(all('button').find(item => item.textContent === dictionary.taskResume)?.hasAttribute('disabled')).toBe(true)
    f.task.lifecycle!.pause.state = 'paused'; f.task.lifecycle!.observed = { state: 'idle', at: atTime }
    await remount(dictionary)
    expect(text()).toContain(dictionary.taskPaused)
    await click(dictionary.taskResume)
    expect(calls.filter(url => url.endsWith('/resume'))).toHaveLength(1)
    await click(dictionary.taskStop)
    expect(text()).toContain(dictionary.taskStopping)
    expect(text()).not.toContain(dictionary.taskStopped)
    expect(all('button').some(item => item.textContent === dictionary.taskResume)).toBe(false)
    f.task.lifecycle!.stop.state = 'exited'; f.task.lifecycle!.observed = { state: 'exited', at: atTime }
    f.task.ended = { by: 'human', at: atTime, outcome: 'stopped' }
    await remount(dictionary)
    expect(text()).toContain(dictionary.taskStopped)
    expect(all('button').some(item => [dictionary.taskPause, dictionary.taskResume, dictionary.taskStop].includes(item.textContent ?? ''))).toBe(false)
    expect(text()).not.toContain('Lifecycle:')
    expect(text()).not.toContain('pause=')
  } finally { f.dispose() }
})

it('retains the exact question and answer after a lost response and never resumes a paused task when answering', async () => {
  const f = fixture(), actual = globalThis.fetch, requests: unknown[] = [], paths: string[] = []
  f.task.lifecycle!.pause = { intent: 'pause', state: 'paused', at: atTime }
  f.task.lifecycle!.observed = { state: 'idle', at: atTime }
  f.task.attention = { id: 'source-choice', version: 4, question: 'Which source should the note use?' }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('/tickets/' + f.task.id + '/')) {
      paths.push(url)
      if (url.endsWith('/attention')) {
        requests.push(JSON.parse(String(init.body)))
        if (requests.length === 1) throw new TypeError('Response was lost')
        return reply({ resolved: true, version: 4 })
      }
    }
    return actual(input, init)
  })
  try {
    await mount(en)
    expect(text()).toContain(en.taskQuestionVersion.replace('{version}', '4'))
    await type(field<HTMLTextAreaElement>(en.taskAnswer), 'Use the primary source')
    await click(en.taskSubmitAnswer)
    expect(field<HTMLTextAreaElement>(en.taskAnswer).value).toBe('Use the primary source')
    expect(text()).toContain(en.taskActionFailed)
    await click(en.taskSubmitAnswer)
    expect(requests).toEqual([
      { questionId: 'source-choice', version: 4, text: 'Use the primary source' },
      { questionId: 'source-choice', version: 4, text: 'Use the primary source' },
    ])
    expect(paths.some(path => path.endsWith('/resume'))).toBe(false)
    expect(text()).toContain(en.taskPaused)
    expect(text()).toContain(en.taskPausedAnswerHint)
    expect(text()).toContain(en.taskAnswerSaved)
  } finally { f.dispose() }
})

it.each(['checking', 'unknown'] as const)('preserves pause intent and holds resume while execution is %s', async state => {
  const f = fixture()
  f.task.lifecycle!.pause = { intent: 'pause', state: 'paused', at: atTime }
  f.task.lifecycle!.reconciliation = { state, startedAt: atTime }
  try {
    await mount(zh)
    expect(text()).toContain(state === 'checking' ? zh.taskReconciling : zh.taskNeedsCheck)
    expect(text()).toContain(zh.taskPausePreserved)
    expect(text()).toContain(zh.taskLastChecked)
    const resume = all('button').find(item => item.textContent === zh.taskResume)!
    expect(resume.hasAttribute('disabled')).toBe(true)
    await click(resume)
    expect(server.requests.some(item => item.path.endsWith('/resume'))).toBe(false)
  } finally { f.dispose() }
})

it('does not let a delayed answer receipt dismiss the next question or reuse its old version', async () => {
  const f = fixture(), actual = globalThis.fetch, answers: unknown[] = []
  let release: ((response: Response) => void) | undefined
  f.task.attention = { id: 'question-before', version: 4, question: 'Select the source' }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && String(input).endsWith('/tickets/' + f.task.id + '/attention')) {
      answers.push(JSON.parse(String(init.body)))
      if (answers.length === 1) return new Promise<Response>(resolve => { release = resolve })
      return reply({ resolved: true, version: 5 })
    }
    return actual(input, init)
  })
  try {
    await mount(en)
    await type(field<HTMLTextAreaElement>(en.taskAnswer), 'The first source')
    await click(en.taskSubmitAnswer)
    expect(release).toBeTypeOf('function')
    f.task.attention = { id: 'question-after', version: 5, question: 'Select the output format' }
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      expect(text()).toContain('Select the output format')
    }, { timeout: 2500, interval: 25 })
    await act(async () => { release!(reply({ resolved: true, version: 4 })) })
    await settle()
    expect(text()).toContain('Select the output format')
    expect(text()).not.toContain(en.taskAnswerSaved)
    expect(field<HTMLTextAreaElement>(en.taskAnswer).value).toBe('')
    await type(field<HTMLTextAreaElement>(en.taskAnswer), 'Markdown')
    await click(en.taskSubmitAnswer)
    expect(answers).toEqual([
      { questionId: 'question-before', version: 4, text: 'The first source' },
      { questionId: 'question-after', version: 5, text: 'Markdown' },
    ])
  } finally {
    await act(async () => { release?.(reply({ resolved: true, version: 4 })) })
    await settle()
    f.dispose()
  }
})

it('retries reconciliation with one operation id and uses refreshed facts before allowing a separate resume', async () => {
  const f = fixture(), actual = globalThis.fetch, requests: { operationId: string }[] = [], paths: string[] = []
  f.task.lifecycle!.pause = { intent: 'pause', state: 'paused', at: atTime }
  f.task.lifecycle!.observed = { state: 'idle', at: atTime }
  f.task.lifecycle!.reconciliation = { state: 'unknown', operationId: 'previous-check', startedAt: atTime }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('/tickets/' + f.task.id + '/')) {
      paths.push(url)
      if (url.endsWith('/reconcile')) {
        const body = JSON.parse(String(init.body)) as { operationId: string }
        requests.push(body)
        if (requests.length === 1) throw new TypeError('Reconciliation response was lost')
        if (requests.length === 3) f.task.lifecycle!.reconciliation = { state: 'clear', operationId: body.operationId, startedAt: atTime, observedAt: atTime }
        return reply({ state: 'clear', operationId: body.operationId })
      }
    }
    return actual(input, init)
  })
  try {
    await mount(en)
    await click(en.taskReconcile)
    expect(text()).toContain(en.taskActionFailed)
    await click(en.taskReconcile)
    expect(requests[0]).toEqual(requests[1])
    expect(Object.keys(requests[0]!)).toEqual(['operationId'])
    expect(requests[0]!.operationId).not.toBe('previous-check')
    // The receipt alone cannot clear a newer or still-unknown snapshot.
    expect(text()).toContain(en.taskNeedsCheck)
    expect(all('button').find(item => item.textContent === en.taskResume)?.hasAttribute('disabled')).toBe(true)
    await click(en.taskReconcile)
    expect(requests[2]!.operationId).not.toBe(requests[0]!.operationId)
    expect(text()).toContain(en.taskPaused)
    expect(all('button').find(item => item.textContent === en.taskResume)?.hasAttribute('disabled')).toBe(false)
    expect(paths.every(path => path.endsWith('/reconcile'))).toBe(true)
  } finally { f.dispose() }
})

it('joins an existing checking operation without treating it as an exit confirmation', async () => {
  const f = fixture(), actual = globalThis.fetch, requests: unknown[] = []
  f.task.lifecycle!.stop = { intent: 'stop', state: 'stopping', at: atTime }
  f.task.lifecycle!.reconciliation = { state: 'checking', operationId: 'existing-check', startedAt: atTime }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && String(input).endsWith('/tickets/' + f.task.id + '/reconcile')) {
      requests.push(JSON.parse(String(init.body)))
      return reply({ state: 'checking', operationId: 'existing-check' })
    }
    return actual(input, init)
  })
  try {
    await mount(zh)
    expect(text()).toContain(zh.taskStopPreserved)
    await click(zh.taskReconcile)
    await click(zh.taskReconcile)
    expect(requests).toEqual([{ operationId: 'existing-check' }, { operationId: 'existing-check' }])
    expect(text()).toContain(zh.taskReconciling)
    expect(text()).not.toContain(zh.taskStopped)
  } finally { f.dispose() }
})

it('keeps recovered project history readable while disabling project mutation and question answers', async () => {
  const f = fixture(), actual = globalThis.fetch, posts: string[] = []
  f.task.attention = { id: 'recovery-question', version: 2, question: 'Saved before the recovery point' }
  f.task.lifecycle!.reconciliation = { state: 'unknown', startedAt: atTime }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') { posts.push(url); return reply({}) }
    const result = await actual(input, init)
    if (url.endsWith('/state')) return reply({ ...JSON.parse(await result.text()), safeRestore: true })
    return result
  })
  try {
    await mount(zh)
    expect(text()).toContain(f.project.name)
    expect(text()).toContain('Saved before the recovery point')
    expect(text()).toContain(zh.recoveryReadOnly)
    expect(field<HTMLTextAreaElement>(zh.taskAnswer).disabled).toBe(true)
    expect(field<HTMLTextAreaElement>(zh.conversationLocalDraft).disabled).toBe(true)
    for (const name of [zh.taskPause, zh.taskStop, zh.planRerun, zh.taskSubmitAnswer, zh.taskReconcile]) {
      const button = all('button').find(item => item.textContent === name)!
      expect(button.hasAttribute('disabled')).toBe(true)
      await click(button)
    }
    expect(posts).toEqual([])
  } finally { f.dispose() }
})
