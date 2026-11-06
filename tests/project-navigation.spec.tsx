// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { initialLocation, parseRouteHash, routeHash } from '../src/client/route.ts'
import { act } from 'react'
import { usePanel, mount, text, at, click, settle } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import { en } from '../src/client/locales.ts'

usePanel()

it('round-trips explicit project/task deep links without relying on session history', () => {
  const routes = [
    { page: 'projects' as const },
    { page: 'projects' as const, id: 'project/a b', query: { ticket: 'task:1' } },
    { page: 'trigger' as const, id: 'github:7', query: { trigger: 'event 1' } },
    { page: 'eval' as const, query: { filter: 'work' as const, window: '24h' as const } },
    { page: 'settings' as const, query: { group: 'backup' as const } },
  ]
  for (const route of routes) expect(parseRouteHash(routeHash(route))).toEqual(route)
  expect(parseRouteHash('#/projects/%E0%A4%A')).toBeUndefined()
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'overview' }, stack: [] }))
  history.replaceState(null, '', '#/projects/stale')
  expect(initialLocation()).toMatchObject({ route: { page: 'projects', id: 'stale' }, stack: [] })
})

it('refreshes a deep-linked project at the selected task while preserving project ownership', async () => {
  const task = { id: 'task-deep', title: 'Deep task', planRevisions: [], authorizations: [], assignments: [], inputs: [], undelivered: [],
    attentionQuestions: [], progress: { phase: 'running', workPhase: 'running', assignments: [] } }
  server.conversations.p1 = { ...server.conversations.p1!, tasks: [task as never] }
  history.replaceState(null, '', routeHash({ page: 'projects', id: 'p1', query: { ticket: task.id } }))
  const original = HTMLElement.prototype.scrollIntoView, focus = vi.fn()
  HTMLElement.prototype.scrollIntoView = focus
  try {
    await mount()
    expect(text()).toContain('Demo project')
    expect(document.getElementById(`project-task-${task.id}`)).not.toBeNull()
    expect(history.state).toMatchObject({ route: { page: 'projects', id: 'p1', query: { ticket: task.id } } })
    server.conversations.p1!.messages.push({ id: 'live-update', projectId: 'p1', role: 'assistant', text: 'Live update',
      status: 'saved', createdAt: '2026-11-05T00:00:00Z' })
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
      expect(text()).toContain('Live update')
    }, { timeout: 2500 })
    expect(focus.mock.contexts.filter((value: unknown) => (value as HTMLElement | undefined)?.id === `project-task-${task.id}`)).toHaveLength(1)
  } finally {
    if (original) HTMLElement.prototype.scrollIntoView = original
    else delete (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView
  }
})

it('marks a project page as needing attention while its plan awaits confirmation', async () => {
  const task = { id: 'task-confirm', title: 'Confirm this plan', planRevisions: [{ revision: 1, createdAt: '2026-11-05T00:00:00Z',
    goal: 'Confirm one change', scope: 'One file', outputs: ['note'], resources: [], environment: 'Managed', cost: 'One worker', completion: 'One note' }],
    authorizations: [], assignments: [], inputs: [], undelivered: [], attentionQuestions: [],
    progress: { phase: 'awaiting-confirmation', workPhase: 'awaiting-confirmation', assignments: [] } }
  server.conversations.p1 = { ...server.conversations.p1!, tasks: [task as never] }
  at({ page: 'projects', id: 'p1' }); await mount(en)
  expect(text()).toContain(en.projectStatusNeedsAttention)
})

it('keeps a superseded physical owner visible as history instead of a current branch', async () => {
  const plan = { goal: 'Coordinate current work', scope: 'Two branches', outputs: ['note'], resources: [], environment: 'Managed',
    cost: 'Two workers', completion: 'One note', assignments: [] }
  const contract = { authorizationId: 'auth-1', planRevision: 1, assignmentKey: 'current', inputs: [], plan }
  const current = { id: 'current-assignment', state: 'running', createdAt: '2026-11-05T00:00:00Z', contract }
  const historical = { id: 'historical-assignment', state: 'running', createdAt: '2026-11-05T00:00:01Z',
    contract: { ...contract, assignmentKey: 'historical', plan: { ...plan, goal: 'Historical physical owner' } } }
  const task = { id: 'task-history', title: 'History', planRevisions: [{ ...plan, revision: 1, createdAt: '2026-11-05T00:00:00Z' }],
    authorizations: [{ id: 'auth-1', planRevision: 1, authorizedAt: '2026-11-05T00:00:00Z' }], assignments: [current, historical],
    inputs: [], undelivered: [], attentionQuestions: [], progress: { phase: 'running', workPhase: 'running', assignments: [{
      assignmentId: current.id, state: 'running', title: 'Current branch', goal: 'Current branch', dependencies: [], planRevision: 1,
      authorizationId: 'auth-1', phase: 'running', nativeState: 'running', conditionsVersion: 1 }] } }
  server.conversations.p1 = { ...server.conversations.p1!, tasks: [task as never] }
  at({ page: 'projects', id: 'p1' }); await mount(en)
  expect(text()).toContain(en.assignmentHistory.replace('{count}', '1'))
  expect(text()).toContain('Historical physical owner')
  expect(text()).toContain(en['assignment.running'])
  expect(document.querySelectorAll('.dt-project-live dd')[1]?.textContent).toBe('2')
})

it('uses coordinator availability as the primary project status when pause and error coincide', async () => {
  const project = server.projects[0]!
  const task = { id: 'task-error-paused', title: 'Paused task', planRevisions: [], authorizations: [], assignments: [], inputs: [], undelivered: [],
    attentionQuestions: [], lifecycle: { pause: { intent: 'pause', state: 'paused', at: '2026-11-05T01:00:00Z' },
      stop: { intent: 'none', state: 'running', at: '2026-11-05T01:00:00Z' }, observed: { state: 'idle', at: '2026-11-05T01:01:00Z' } },
    progress: { phase: 'paused', workPhase: 'queued', assignments: [] } }
  server.conversations.p1 = { project, messages: [], tasks: [task as never], coordinator: { status: 'error', error: 'Coordinator unavailable' } }
  at({ page: 'projects', id: 'p1' }); await mount(en)
  expect(document.querySelector('.dt-project-live dd')?.textContent).toBe(en.projectStatusCoordinatorError)
})

it('puts actionable questions before projects and distinguishes a user-paused project', async () => {
  const project = { ...server.projects[0]!, id: 'p2', name: 'Paused research' }
  server.projects.push(project)
  const task = { id: 'task-question', title: 'Choose a source', planRevisions: [], authorizations: [], assignments: [], inputs: [], undelivered: [],
    attentionQuestions: [{ id: 'q2', question: 'Which source should be authoritative?' }], attention: { id: 'q2', question: 'Which source should be authoritative?' },
    lifecycle: { pause: { intent: 'pause', state: 'paused', at: '2026-11-05T01:00:00Z' }, stop: { intent: 'none', state: 'running', at: '2026-11-05T01:00:00Z' },
      observed: { state: 'idle', at: '2026-11-05T01:01:00Z' } }, progress: { phase: 'paused', workPhase: 'queued', assignments: [] } }
  server.conversations.p2 = { project, messages: [], tasks: [task as never] }
  server.projectEvents.p2 = []
  at({ page: 'projects' }); await mount(en)
  const page = text()
  expect(page.indexOf(en.projectPending)).toBeLessThan(page.indexOf(en.projectHome))
  expect(page).toContain('Which source should be authoritative?')
  expect(page).toContain('Paused research')
  expect(page).toContain(en.projectStatusPaused)
  expect(page).toContain(en.projectLastChecked)
})

it('reconnects a stale project-event cursor from a snapshot and stores the new sequence', async () => {
  server.projectEvents.p1 = [{ sequence: 7, event: { id: 'evt-7', projectId: 'p1', ticketId: 't1', kind: 'report-recorded', version: 'r1',
    operationId: 'r1', at: '2026-11-05T02:00:00Z' } }]
  sessionStorage.setItem('dsh-superagent/project-event-cursor/p1', JSON.stringify({ sequence: 999, id: 'stale' }))
  at({ page: 'projects', id: 'p1' }); await mount(en)
  await vi.waitFor(() => expect(JSON.parse(sessionStorage.getItem('dsh-superagent/project-event-cursor/p1')!)).toEqual({ sequence: 7, id: 'evt-7' }))
  expect(server.requests.some(item => item.path === 'projects/p1/events?after=999&afterId=stale&limit=200')).toBe(true)
  expect(server.requests.some(item => item.path === 'projects/p1/events?after=7&afterId=evt-7&limit=200')).toBe(true)
})

it('lets browser back restore the prior explicit route', async () => {
  at({ page: 'projects' }); await mount(en)
  await click('Demo project')
  expect(location.hash).toBe('#/projects/p1')
  await act(async () => { history.back(); await new Promise(resolve => setTimeout(resolve, 0)) })
  await settle()
  expect(location.hash).toBe('#/projects')
  expect(text()).toContain(en.projectPending)
})

it('retains the last project view and labels a host outage separately from task state', async () => {
  at({ page: 'projects', id: 'p1' }); await mount(en)
  expect(text()).toContain('Demo project')
  server.down = true
  await vi.waitFor(() => expect(text()).toContain(en.projectHostOffline), { timeout: 2500, interval: 50 })
  expect(text()).toContain('Demo project')
})
