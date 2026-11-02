/** Real SQLite and managed files; no model/native-host claim is made by this fixture. */
import { join } from 'node:path'
import { Store } from '../../src/app/store.ts'
import { ConversationStore } from '../../src/app/conversation-store.ts'
import { ProjectPlans } from '../../src/app/project-plans.ts'
import { Projects } from '../../src/core/projects.ts'
import { ExecutionAttempts } from '../../src/app/execution-attempts.ts'
import { ArtifactStore } from '../../src/app/artifact-store.ts'
import { ReportAcceptance, type FileReport } from '../../src/app/report-acceptance.ts'
import type { PlanContent } from '../../src/core/index.ts'

export function workerFixture(directory: string, acceptance?: PlanContent['acceptance']) {
  const store = new Store(join(directory, 'project.sqlite'))
  const projects = new Projects({ repo: store })
  const conversations = new ConversationStore(store)
  const project = projects.create({ name: 'File research', goal: 'Produce a sourced note' })
  conversations.claimProject(project.id, 'owner', { newlyCreated: true })
  conversations.appendUser(project.id, 'owner', { clientRequestKey: 'original', text: 'Write a sourced note, without GitHub' })
  const plans = new ProjectPlans(store, projects, conversations)
  const plan = plans.save('owner', project.id, { expectedRevision: 0, operationId: 'draft', plan: {
    goal: 'Sourced note', scope: 'A Markdown file', outputs: ['note'], resources: [], environment: 'Managed file worker', cost: 'One worker', completion: 'A nonempty sourced note', ...(acceptance ? { acceptance } : {}),
  } })
  conversations.appendUser(project.id, 'owner', { clientRequestKey: 'confirm', text: '按这个方案做' })
  const confirmed = plans.confirm('owner', project.id, { projectId: project.id, ticketId: plan.ticketId, planRevision: 1, operationId: 'confirm', intent: 'execute' })
  const attempts = new ExecutionAttempts(store, directory), artifacts = new ArtifactStore(store, attempts), reports = new ReportAcceptance(store, attempts, artifacts)
  const attempt = attempts.allocate(confirmed.ticket, confirmed.assignment)
  const prepare = () => attempts.prepare(attempt)
  const write = (content = '# Source\nA useful finding.', operationId = 'file-1') => artifacts.write(attempt.sessionId, { operationId, output: 'note', name: 'note.md', content })
  const report = (refs: FileReport['artifacts'], overrides: Partial<FileReport> = {}): FileReport => ({ operationId: 'report-1', state: 'ready', completed: 'Wrote the sourced note', evidence: ['Verified registered content'], artifacts: refs, unresolved: [], ...overrides })
  return { store, projects, conversations, project, plans, plan, confirmed, attempts, artifacts, reports, attempt, prepare, write, report }
}
