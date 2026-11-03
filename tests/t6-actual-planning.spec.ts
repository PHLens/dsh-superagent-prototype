/** Replays sanitized actual tool arguments; does not claim model/browser acceptance. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Projects, UserError, type PlanRevision } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { ProjectPlans } from '../src/app/project-plans.ts'
import { projectTools } from '../src/app/tools/main.ts'

it('repairs the actual rejected four-node tool payload without granting authority on rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'actual-plan-')), store = new Store(join(dir, 'db.sqlite'))
  try {
    const projects = new Projects({ repo: store }), project = projects.create({ name: 'Backup', goal: 'Compare backups' })
    const plans = new ProjectPlans(store, projects)
    plans.conversations.claimProject(project.id, 'owner', { newlyCreated: true })
    plans.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'goal', text: 'Compare backups with independent investigations and a reviewed synthesis.' })
    const tools = projectTools({ plans, actorId: 'owner', projectId: project.id, authorize() {} })
    expect(tools.some(t => /confirm/.test(t.name))).toBe(false)
    const tool = tools.find(t => t.name === 'project_save_plan')!
    const original = JSON.parse(readFileSync(new URL('./fixtures/t6-actual-invalid-plan.json', import.meta.url), 'utf8'))
    const save = (args: typeof original) => tool.execute(tool.schema.parse(args), new AbortController().signal) as Promise<PlanRevision>
    const reject = async (args: typeof original) => {
      let caught: unknown
      try { await save(args) } catch (e) { caught = e }
      expect(caught).toBeInstanceOf(UserError)
      const error = caught as UserError
      expect(error.code).toBe('invalidPlan')
      expect(error.message.length).toBeLessThan(4200)
      expect(error.values.details).toBeTruthy()
      expect(store.tickets.list()).toEqual([])
      return error.message
    }
    const message = await reject(original)
    expect(message).toContain('recoverability.resources[0]')
    expect(message).toContain('copy an exact top-level')
    expect(message).toContain('targeting recoverability')
    expect(message).toContain('targeting maintenance')
    const canonical = structuredClone(original)
    for (const node of canonical.assignments) node.resources = [canonical.resources[0]]
    const gateFailure = await reject(canonical)
    expect(gateFailure).not.toContain('undeclared resource')
    expect(gateFailure).toContain('targeting maintenance')
    // Choose the actual needed draft contract; no confirmed contract is downgraded.
    const repaired = structuredClone(canonical)
    repaired.acceptance.mode = 'registered-files'
    repaired.assignments[2].acceptance.mode = 'human-review'
    repaired.assignments[3].acceptance.mode = 'registered-files'
    repaired.assignments[0].resources = []
    const illegal = structuredClone(repaired)
    illegal.assignments[0].resources = ['undeclared resource']
    expect(await reject(illegal)).toContain('recoverability.resources[0]')
    const missing = structuredClone(repaired)
    missing.outputs.push('missing.md')
    expect(await reject(missing)).toContain('missing.md')
    const malformed = structuredClone(repaired)
    malformed.assignments[0].dependencies = ['missing-key']
    expect(await reject(malformed)).toContain('Unknown dependency')
    const wrongReview = structuredClone(repaired)
    wrongReview.assignments[3].review.conditionsVersion = 2
    expect(await reject(wrongReview)).toContain('match its acceptance.version')
    const many = structuredClone(repaired)
    many.assignments[0].resources = Array.from({ length: 30 }, (_, i) => `${i}:` + 'untrusted'.repeat(200))
    const bounded = await reject(many)
    expect(bounded).toContain('additional issues')
    expect(bounded).not.toContain('untrusted'.repeat(100))
    const saved = await save(repaired)
    expect(await save(repaired)).toEqual(saved)
    await expect(save({ ...repaired, goal: 'Changed committed payload' })).rejects.toThrow(/Operation/)
    expect(store.tickets.get(saved.ticketId)?.authorizations ?? []).toEqual([])
    expect(store.tickets.get(saved.ticketId)?.assignments).toEqual([])
    plans.conversations.appendUser(project.id, 'owner', { clientRequestKey: 'confirm', text: 'implement this plan' })
    const confirmed = plans.confirm('owner', project.id, { projectId: project.id, ticketId: saved.ticketId, planRevision: saved.revision, operationId: 'confirm', intent: 'execute' })
    expect(confirmed.ticket.authorizations).toHaveLength(1)
    expect(confirmed.ticket.assignments).toHaveLength(4)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('serializes usable missing-field feedback for localized consumers too', () => {
  const error = new UserError('invalidPlan')
  expect(error.values.details).toContain('goal')
  expect(error.message).not.toContain('{details}')
})
