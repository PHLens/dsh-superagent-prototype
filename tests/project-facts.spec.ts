/** Real SQLite/report/artifact consumers for the coordinator's bounded read contract. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { workerFixture } from './fixtures/project-worker.ts'
import { projectTools } from '../src/app/tools/main.ts'
import { key, type Trigger } from '../src/core/index.ts'
let directory: string, f: ReturnType<typeof workerFixture>
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'project-facts-')); f = workerFixture(directory, { version: 1, mode: 'human-review' }) })
afterEach(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }) })
function ready() {
  f.prepare()
  const content = 'Exact evidence with unicode 中文.\n'.repeat(900), artifact = f.write(content)
  const report = f.reports.submit(f.attempt.sessionId, f.report([{ id: artifact.id, contentVersion: artifact.contentVersion }], { completed: 'Finished sourced investigation', evidence: ['Cited primary sources'], unresolved: ['Choose whether evidence meets semantic gate'] }))
  const decision = f.reports.decide('owner', f.project.id, { ticketId: f.plan.ticketId, operationId: 'judgment', reportId: report.id, conclusion: 'needs_judgment', evidence: 'Need an independent comparison before acceptance' })
  return { content, artifact, report, decision }
}
it('supplies current semantic facts and exact refs through the actual installed project read tool', async () => {
  const { artifact, report, decision } = ready()
  const tools = projectTools({ plans: f.plans, actorId: 'owner', projectId: f.project.id, authorize() {} })
  const read = tools.find(t => t.name === 'project_read_assignment_facts')!
  const value = await read.execute({ ticket_id: f.plan.ticketId, offset: 0, limit: 4 }, new AbortController().signal)
  const text = JSON.stringify(value)
  for (const token of [report.id, artifact.id, artifact.contentVersion, decision.id, report.completed, report.evidence[0]!, report.unresolved[0]!, decision.evidence]) expect(text).toContain(token)
  expect(f.plans.readAssignmentFacts('owner', f.project.id, { ticketId: f.plan.ticketId }).assignments[0]!.conditions.conditionsVersion).toBe(1)
})
it('reassembles a long immutable artifact exactly through bounded JSON pages', () => {
  const { artifact, content } = ready()
  let offset = 0, text = '', pages = 0
  for (;;) {
    const page = f.plans.readFact('owner', f.project.id, { ticketId: f.plan.ticketId, kind: 'artifact', id: artifact.id, contentVersion: artifact.contentVersion, offset, limit: 1000 })
    expect(page.content.length).toBeLessThanOrEqual(1000)
    text += page.content; pages++
    if (page.next_offset === null) break
    expect(page.next_offset).toBeGreaterThan(offset); offset = page.next_offset
  }
  expect(pages).toBeGreaterThan(1)
  expect(JSON.parse(text)).toMatchObject({ id: artifact.id, contentVersion: artifact.contentVersion, content })
})
it('rejects foreign actors, projects, tasks, versions and altered artifact bytes', () => {
  const { artifact, report } = ready(), other = f.projects.create({ name: 'Other', goal: 'Unrelated project' })
  f.conversations.claimProject(other.id, 'owner', { newlyCreated: true })
  const input = { ticketId: f.plan.ticketId, kind: 'report' as const, id: report.id }
  expect(() => f.plans.readFact('intruder', f.project.id, input)).toThrow()
  expect(() => f.plans.readFact('owner', other.id, input)).toThrow()
  const draft = f.projects.createDraft(f.project.id, { title: 'Unrelated task' })
  expect(() => f.plans.readFact('owner', f.project.id, { ...input, ticketId: draft.id })).toThrow()
  const artifactInput = { ticketId: f.plan.ticketId, kind: 'artifact' as const, id: artifact.id, contentVersion: artifact.contentVersion }
  expect(() => f.plans.readFact('owner', f.project.id, { ...artifactInput, contentVersion: 'wrong' })).toThrow()
  writeFileSync(artifact.path, 'Altered after registration')
  expect(() => f.plans.readFact('owner', f.project.id, artifactInput)).toThrow(/version changed/)
})

it('reads a long project feedback Trigger input exactly through bounded authorized pages', () => {
  const text = 'Human feedback line with unicode 中文.\n'.repeat(800)
  const trigger: Trigger = { id: 'github-comment:long-feedback', source: 'github',
    threads: [{ source: 'github', id: 'scoped:7' }], actor: { source: 'github', id: 'alice' }, human: true,
    at: '2026-11-02T10:00:00Z', text, meta: { number: 7, isPr: true } }
  f.store.triggers.save(trigger)
  const ticket = f.store.tickets.get(f.plan.ticketId)!, inputId = key('input', ticket.id, 'trigger', trigger.id)
  ticket.inputs.push({ id: inputId, kind: 'trigger', triggerId: trigger.id, human: true, at: trigger.at })
  f.store.tickets.save(ticket)
  let offset = 0, content = '', pages = 0
  for (;;) {
    const page = f.plans.readFact('owner', f.project.id, { ticketId: ticket.id, kind: 'input', id: inputId, offset, limit: 1000 })
    expect(page.content.length).toBeLessThanOrEqual(1000)
    content += page.content; pages++
    if (page.next_offset === null) break
    offset = page.next_offset
  }
  expect(pages).toBeGreaterThan(1)
  expect(JSON.parse(content)).toMatchObject({ id: inputId, triggerId: trigger.id, human: true, text })
})
