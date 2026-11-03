// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Assignment, AssignmentProposal } from '../src/core/model.ts'
import type { AcceptedReport } from '../src/app/report-acceptance.ts'
import type { ProjectProgress } from '../src/app/project-progress.ts'
import type { ProjectTaskView } from '../src/app/api.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, at, mount, click, field, text, type, all, settle } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import { workerFixture } from './fixtures/project-worker.ts'

usePanel()
const time = '2026-11-03T08:00:00Z'
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
function seed() {
  const directory = mkdtempSync(join(tmpdir(), 'assignment-panel-'))
  const f = workerFixture(directory)
  const task: ProjectTaskView = f.store.tickets.get(f.plan.ticketId)!
  const original = task.assignments[0]!
  const proposals: AssignmentProposal[] = [
    { key: 'a', goal: 'Investigate route A', outputs: ['a.md'], dependencies: [], completion: 'A sourced note', resources: [], cost: 'One worker', writeScope: 'isolated-directory', acceptance: { version: 1, mode: 'human-review' } },
    { key: 'b', goal: 'Investigate route B', outputs: ['b.md'], dependencies: [], completion: 'A second sourced note', resources: [], cost: 'One worker', writeScope: 'isolated-directory', acceptance: { version: 1, mode: 'human-review' } },
    { key: 'summary', goal: 'Compare the two routes', outputs: ['summary.md'], dependencies: ['a', 'b'], completion: 'A comparison', resources: [], cost: 'One worker', writeScope: 'isolated-directory', acceptance: { version: 1, mode: 'registered-files' } },
  ]
  task.planRevisions = task.planRevisions!.map(plan => ({ ...plan, assignments: proposals }))
  task.assignments = proposals.map((proposal, index): Assignment => ({
    ...original, id: 'branch-' + proposal.key, state: index === 2 ? 'pending' : 'running',
    contract: { ...original.contract!, assignmentKey: proposal.key, proposal,
      plan: { ...original.contract!.plan, goal: proposal.goal, outputs: proposal.outputs, acceptance: proposal.acceptance },
      inputs: proposal.dependencies.map(key => ({ kind: 'dependency', ticketId: task.id, assignmentId: 'branch-' + key })) },
  }))
  task.lifecycle = { pause: { intent: 'none', state: 'running', at: time }, stop: { intent: 'none', state: 'running', at: time }, observed: { state: 'running', at: time } }
  const reports: AcceptedReport[] = task.assignments.slice(0, 2).map(a => ({
    id: 'report-' + a.id, attemptId: 'attempt-' + a.id, lease: 'lease-' + a.id, sessionId: 'worker-' + a.id,
    projectId: f.project.id, ticketId: task.id, assignmentId: a.id, operationId: 'ready', at: time,
    state: 'ready', completed: a.contract!.plan.goal, evidence: ['Checked the note'], artifacts: [], unresolved: [],
  }))
  const progress: ProjectProgress = {
    phase: 'running', workPhase: 'running', assignments: task.assignments.map((a, index) => ({
      assignmentId: a.id, assignmentKey: a.contract!.assignmentKey, title: a.contract!.plan.goal, goal: a.contract!.plan.goal,
      state: a.state, authorizationId: a.contract!.authorizationId, planRevision: 1, conditionsVersion: 1,
      attemptId: 'attempt-' + a.id, attemptState: 'running', nativeState: index === 1 ? 'running' : 'idle',
      phase: index === 2 ? 'queued' : 'semantic-review', dependencies: a.contract!.inputs.flatMap(i => i.kind === 'dependency' ? [i.assignmentId] : []),
      ...(index < 2 ? { reportId: reports[index]!.id, reportState: 'ready', reportAt: time } : { waitingReason: 'dependency' }),
    })),
  }
  task.progress = progress
  server.projects = [f.project]
  server.conversations[f.project.id] = { project: f.project, messages: [], tasks: [task], reports }
  at({ page: 'projects', id: f.project.id })
  return { ...f, task, progress, reports, proposals, dispose() { f.store.close(); rmSync(directory, { recursive: true, force: true }) } }
}
const branch = (name: string) => all('article.dt-assignment').find(e => e.getAttribute('aria-label') === name)!

it.each([zh, en])('previews the proposed work and sends one confirmation for the whole plan (%#)', async dictionary => {
  const f = seed()
  f.task.authorizations = []; f.task.assignments = []; f.task.progress = undefined
  try {
    await mount(dictionary)
    expect(text()).toContain(dictionary.assignmentPlan)
    for (const p of f.proposals) expect(text()).toContain(p.goal)
    expect(text()).toContain('a.md'); expect(text()).toContain('b.md'); expect(text()).toContain('summary.md')
    expect(all('button').filter(b => b.textContent === dictionary.planConfirm)).toHaveLength(1)
    await click(dictionary.planConfirm)
    const sent = server.requests.filter(r => r.path.endsWith('/plan-confirmation'))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toMatchObject({ ticketId: f.task.id, planRevision: 1, intent: 'execute' })
  } finally { f.dispose() }
})

it('shows each current branch and does not declare the Task complete when only one branch ended', async () => {
  const f = seed()
  f.task.assignments[0]!.state = 'ended'; f.task.assignments[0]!.endedReason = 'accepted'
  f.progress.assignments[0]!.phase = 'completed'
  f.progress.assignments[1]!.phase = 'running'
  f.progress.assignments[2]!.budgetWait = 'global-budget'
  try {
    await mount(en)
    expect(branch(f.proposals[0]!.goal).textContent).toContain(en.executionDone)
    expect(branch(f.proposals[1]!.goal).textContent).toContain(en.executionRunning)
    const summary = branch(f.proposals[2]!.goal)
    expect(summary.textContent).toContain(en.assignmentBudgetGlobal)
    expect(summary.textContent).toContain(f.proposals[0]!.goal)
    expect(summary.textContent).toContain(f.proposals[1]!.goal)
    expect(text()).not.toContain('global-budget')
    const direct = [...document.querySelector('.dt-conversation-plan')!.children].filter(e => e.tagName === 'P')
    expect(direct.some(e => e.textContent === en.executionDone)).toBe(false)
  } finally { f.dispose() }
})

it('binds acceptance to the selected current report and holds only the branch needing reconciliation', async () => {
  const f = seed()
  f.progress.reconciliation = 'unknown'
  f.progress.assignments[0]!.attemptState = 'reconcile'
  f.progress.assignments[0]!.acceptanceHold = 'reconciliation-required'
  f.progress.assignments[1]!.phase = 'semantic-review'
  f.progress.assignments[1]!.nativeState = 'idle'
  server.conversations[f.project.id]!.reports!.push({ ...f.reports[1]!, id: 'old-report-b', attemptId: 'old-attempt-b', completed: 'STALE_REPORT_MUST_NOT_BE_REVIEWED' })
  try {
    await mount(en)
    const a = branch(f.proposals[0]!.goal), b = branch(f.proposals[1]!.goal)
    const first = a.querySelector<HTMLTextAreaElement>('textarea')!, second = b.querySelector<HTMLTextAreaElement>('textarea')!
    expect(first.disabled).toBe(true); expect(second.disabled).toBe(false)
    expect(text()).not.toContain('STALE_REPORT_MUST_NOT_BE_REVIEWED')
    await type(second, 'Checked the current route B report')
    await click([...b.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === en.acceptancePass)!)
    const sent = server.requests.filter(r => r.path.endsWith('/acceptance'))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toMatchObject({ ticketId: f.task.id, reportId: f.reports[1]!.id, conclusion: 'passed' })
    expect(f.task.ended).toBeUndefined()
  } finally { f.dispose() }
})

it('holds every branch acceptance during an instance pause while retaining the conversation input', async () => {
  const f = seed()
  server.settings.paused = true
  try {
    await mount(en)
    for (const proposal of f.proposals.slice(0, 2)) {
      const card = branch(proposal.goal)
      expect(card.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true)
      expect(card.textContent).toContain(en.executionPaused)
    }
    expect(field<HTMLTextAreaElement>(en.conversationLocalDraft).disabled).toBe(false)
    expect(server.requests.some(r => r.path.endsWith('/acceptance'))).toBe(false)
  } finally { f.dispose() }
})

it('keeps authorized active branches and their report and question visible while a newer plan is still a draft', async () => {
  const f = seed()
  f.task.planRevisions = [...f.task.planRevisions!, { ...f.task.planRevisions![0]!, revision: 2, goal: 'A revised proposal awaiting confirmation' }]
  f.progress.assignments[0]!.question = { id: 'active-v1-question', version: 1, question: 'Which source for the authorized work?' }
  try {
    await mount(en)
    expect(text()).toContain('A revised proposal awaiting confirmation')
    expect(all('button').filter(b => b.textContent === en.planConfirm)).toHaveLength(1)
    for (const proposal of f.proposals) expect(branch(proposal.goal)).toBeDefined()
    expect(branch(f.proposals[0]!.goal).textContent).toContain('Which source for the authorized work?')
    expect(branch(f.proposals[0]!.goal).textContent).toContain(en.planRevision.replace('{revision}', '1'))
    expect(all('button').some(b => b.textContent === en.planRevoke)).toBe(true)
    const card = branch(f.proposals[1]!.goal)
    await type(card.querySelector<HTMLTextAreaElement>('textarea')!, 'Reviewed the authorized revision 1 report')
    await click([...card.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === en.acceptancePass)!)
    expect(server.requests.find(r => r.path.endsWith('/acceptance'))?.body).toMatchObject({ ticketId: f.task.id, reportId: f.reports[1]!.id })
  } finally { f.dispose() }
})

it('keeps another branch answer draft and a newer question when an older answer receipt arrives', async () => {
  const f = seed(), actual = globalThis.fetch
  f.task.lifecycle!.pause = { intent: 'pause', state: 'paused', at: time }
  f.progress.assignments[0]!.question = { id: 'question-a', version: 1, question: 'Which source for route A?' }
  f.progress.assignments[1]!.question = { id: 'question-b', version: 2, question: 'Which source for route B?' }
  let finish!: (response: Response) => void
  const held = new Promise<Response>(resolve => { finish = resolve })
  const sent: unknown[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/attention') && init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body))); return held
    }
    return actual(input, init)
  })
  try {
    await mount(en)
    const a = branch(f.proposals[0]!.goal), b = branch(f.proposals[1]!.goal)
    const first = a.querySelector<HTMLTextAreaElement>('textarea[rows=\"3\"]')!, second = b.querySelector<HTMLTextAreaElement>('textarea[rows=\"3\"]')!
    await type(first, 'Use source A')
    await type(second, 'Keep source B draft')
    await click([...a.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === en.taskSubmitAnswer)!)
    f.progress.assignments[0]!.question = { id: 'question-a-next', version: 3, question: 'Which date for the new route A source?' }
    await act(async () => { finish(reply({ resolved: true, version: 1 })) })
    await settle()
    expect(sent).toEqual([{ questionId: 'question-a', version: 1, text: 'Use source A' }])
    expect(text()).toContain('Which date for the new route A source?')
    expect(branch(f.proposals[1]!.goal).querySelector<HTMLTextAreaElement>('textarea[rows=\"3\"]')!.value).toBe('Keep source B draft')
    expect(f.task.lifecycle!.pause.intent).toBe('pause')
    expect(server.requests.some(r => r.path.endsWith('/resume'))).toBe(false)
  } finally { f.dispose() }
})

it('shows the same multi-branch facts in a read-only restore and disables every mutation', async () => {
  const f = seed(), actual = globalThis.fetch
  f.progress.assignments[0]!.question = { id: 'question-a', version: 1, question: 'Which source?' }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = await actual(input, init)
    if (String(input).endsWith('/state')) return reply({ ...JSON.parse(await result.text()), safeRestore: true })
    return result
  })
  try {
    await mount(en)
    expect(text()).toContain(en.recoveryReadOnly)
    for (const proposal of f.proposals) expect(branch(proposal.goal)).toBeDefined()
    for (const area of all('textarea')) expect((area as HTMLTextAreaElement).disabled).toBe(true)
    for (const label of [en.planRerun, en.planRevoke, en.taskPause, en.taskStop, en.taskSubmitAnswer, en.acceptancePass]) {
      for (const button of all('button').filter(e => e.textContent === label)) expect(button.hasAttribute('disabled')).toBe(true)
    }
    expect(server.requests.some(r => r.method === 'POST')).toBe(false)
  } finally { f.dispose() }
})
