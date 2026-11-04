/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import type { ExecutionAttempts } from '../execution-attempts.ts'
import type { ArtifactStore } from '../artifact-store.ts'
import type { AcceptedReport, ReportAcceptance } from '../report-acceptance.ts'
import { key, liveTicket, type Assignment, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import type { ProjectResources } from '../project-resources.ts'
import { codeValidationOperation, type CodeValidation } from '../code-validation.ts'
import type { Commands } from '../../infra/commands.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'
import type { Delegations } from '../delegations.ts'
import { ProjectEvents } from '../events.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}

export function projectWorkerTools(attempts: ExecutionAttempts, artifacts: ArtifactStore, reports: ReportAcceptance, engineOrSession: Pick<EngineForExecutor, 'report'> | string, maybeSessionId?: string, resources?: ProjectResources, validation?: CodeValidation, commands?: Commands, delegations?: Delegations): Tool[] {
  const sessionId = typeof engineOrSession === 'string' ? engineOrSession : maybeSessionId!
  // The resource authority that governs this session is bound here so every consumer of the same
  // Attempts set — including skill body loads — re-checks it against the live grant.
  if (resources) attempts.claimResourceAuthority(resources)
  const tools: Tool[] = []
  if (validation && commands && attempts.bySession(sessionId)) tools.push(tool({ name: 'project_validate_code', description: 'Run the exact server-pinned code check for this Assignment and return its structured receipt. The command, profile and source/config versions come only from the confirmed contract.', schema: z.object({ operation_id: z.string().min(1) }).strict(), execute: async (args, signal) => { const { assignment } = attempts.resolve(sessionId); const check = assignment.contract?.plan.acceptance?.codeCheck; if (!check) throw new Error('This Assignment has no approved code check'); return validation.run(sessionId, codeValidationOperation(attempts.resolve(sessionId).attempt.id, assignment.contract!.planRevision), check, commands, signal) } }))
  if (resources && attempts.bySession(sessionId)) tools.push(tool({ name: 'project_read_resource', description: 'Read a registered resource within this execution’s immutable authorized resource range. Browse pages continue with the returned snapshot plus offset; a stale or foreign snapshot fails. Use browse entry versions for text reads.', schema: z.object({ resource_id: z.string(), path: z.string().default(''), version: z.string().optional(), action: z.enum(['browse', 'preview']).default('browse'), offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(500).default(100), snapshot: z.object({ path: z.string(), version: z.string().min(1), expiresAt: z.string().min(1), offset: z.number().int().nonnegative().default(0) }).strict().optional() }).strict(), execute: async args => {
    const { attempt, assignment } = attempts.resolve(sessionId)
    if (!attempt.context?.resources.includes(args.resource_id) || !assignment.contract!.plan.resources.includes(args.resource_id)) throw new Error('Resource is outside this execution grant')
    if (args.action === 'browse') {
      const page = resources.browse(attempt.projectId, args.resource_id, args.path, args.snapshot ? { projectId: attempt.projectId, resourceId: args.resource_id, path: args.snapshot.path, version: args.snapshot.version, expiresAt: args.snapshot.expiresAt, entries: [] } : undefined, args.snapshot?.offset ?? args.offset, args.limit)
      return { projectId: page.projectId, resourceId: page.resourceId, path: page.path, version: page.version, expiresAt: page.expiresAt, entries: page.entries, total: page.total, next_offset: page.next_offset,
        ...(page.next_offset === null ? {} : { continuation: { path: page.path, version: page.version, expiresAt: page.expiresAt, offset: page.next_offset } }) }
    }
    if (!args.version) throw new Error('An exact resource entry version is required')
    return resources.preview(attempt.projectId, args.resource_id, args.path, args.version)
  } }))
  if (typeof engineOrSession !== 'string') tools.push(tool({ name: 'project_worker_request_question', description: 'Ask the authorized project owner one concrete question. Reuse operation_id only with the same question. The server binds the question to this native Session Assignment attempt and lease.', schema: z.object({ operation_id: z.string().trim().min(1), question: z.string().trim().min(1).max(4000) }).strict(), execute: async args => attempts.store.atomic(() => {
    const receipt = attempts.resolve(sessionId, true)
    const previous = receipt.ticket.attentionQuestionOperations?.find(item => item.binding.attemptId === receipt.attempt.id && item.operationId === args.operation_id)
    if (previous) {
      if (previous.question.question !== args.question || previous.binding.lease !== receipt.attempt.lease || previous.binding.sessionId !== sessionId) throw new Error('Question operation_id payload or execution binding changed')
      return { question: previous.question }
    }
    const { attempt, assignment, ticket } = attempts.resolve(sessionId)
    if (!ticket.assignments.some(item => item.id === assignment.id && item.contract && item.state !== 'ended')) throw new Error('Stale worker Assignment')
    const binding = { assignmentId: assignment.id, attemptId: attempt.id, lease: attempt.lease, sessionId }
    const version = (ticket.attentionSequence ?? ticket.attention?.version ?? 0) + 1
    const question = { id: key('attention', ticket.id, String(version)), version, question: args.question, binding }
    const at = new Date().toISOString()
    ticket.attention ??= question
    ticket.attentionQuestions = [...ticket.attentionQuestions ?? [], question]
    ticket.attentionSequence = version
    ticket.attentionQuestionOperations = [...ticket.attentionQuestionOperations ?? [], { operationId: args.operation_id, binding, question }]
    assignment.report = { state: 'progress', summary: `Waiting for owner answer: ${args.question}`, at }
    ticket.updatedAt = at
    attempts.store.tickets.save(ticket)
    new ProjectEvents(attempts.store).append({ id: `attention:${question.id}:recorded`, projectId: ticket.projectId!, ticketId: ticket.id,
      assignmentId: assignment.id, attemptId: attempt.id, kind: 'attention-changed', version: question.id,
      operationId: args.operation_id, at })
    return { question }
  }) }))
  if (attempts.bySession(sessionId)?.reviewTarget) tools.push(tool({ name: 'project_worker_decide', description: 'Submit an independent version-bound judgment for your server-registered review target. A ready review report is not a gate decision. Read reviewTarget in context; use changes_required or needs_judgment when the content does not satisfy its conditions.', schema: z.object({ operation_id: z.string().min(1), report_id: z.string().min(1), conclusion: z.enum(['passed', 'changes_required', 'needs_judgment']), evidence: z.string().min(1) }).strict(), execute: async args => reports.decideWorker(sessionId, { operationId: args.operation_id, reportId: args.report_id, conclusion: args.conclusion, evidence: args.evidence }) }))
  if (delegations && attempts.bySession(sessionId)) tools.push(tool({ name: 'project_process_delegation', description: 'Consume one settled result from a server-recorded local child of this exact parent execution. This records result processing but never starts a child or completes the Assignment by itself. Reuse operation_id only for the same processing receipt.', schema: z.object({ child_session_id: z.string().min(1).max(256), operation_id: z.string().min(1).max(256) }).strict(), execute: async args => {
    const result = delegations.process(sessionId, args.child_session_id, args.operation_id)
    return { delegationId: result.id, childSessionId: result.childSessionId, state: result.state, resultProcessing: result.resultProcessing,
      result: result.result }
  } }))
  return [...tools,
    tool({ name: 'project_worker_context', description: 'Read the immutable authorized plan, saved originalMessage for the original request language, pinned inputs and registered artifacts. Identity and originalMessage come only from this native Session Assignment authorization, never conversation history.', schema: z.object({}).strict(), execute: async () => {
      const { attempt, assignment, ticket } = attempts.resolve(sessionId)
      const authorization = ticket.authorizations?.find(item => item.id === assignment.contract!.authorizationId)
      return { plan: assignment.contract!.plan, inputs: assignment.contract!.inputs, pinnedInputs: attempt.inputs ?? [],
        ...(attempt.identity ? { identity: { executionId: attempt.identity.executionId, repository: attempt.identity.repository, accountId: attempt.identity.accountId, ...(attempt.identity.deliveryBranch ? { deliveryBranch: attempt.identity.deliveryBranch } : {}) } } : {}),
        ...(authorization?.originalMessage ? { originalMessage: authorization.originalMessage } : {}),
        ...(attempt.reviewTarget ? { reviewTarget: attempt.reviewTarget } : {}),
        ...(delegations ? { delegations: delegations.contextForAttempt(attempt.id) } : {}),
        ...(delegations ? { promotedDelegations: delegations.promotedForAssignment(assignment.id).slice(-8).map(item => ({ id: item.id, label: item.label,
          scope: item.scope, ...(item.result ? { result: { stopReason: item.result.stopReason, text: item.result.text.slice(0, 4_000),
            totalChars: item.result.totalChars, truncated: item.result.text.length < item.result.totalChars } } : {}) })) } : {}),
        outputs: artifacts.view(attempt.projectId).filter(item => item.ticketId === attempt.ticketId),
        ...(attempt.context ? { context: attempt.context } : {}) }
    } }),
    tool({ name: 'project_read_input', description: 'Read only an exact artifact content version pinned in this Assignment input contract.', schema: z.object({ id: z.string(), contentVersion: z.string() }).strict(), execute: async args => {
      const { attempt, assignment } = attempts.resolve(sessionId)
      if (!attempt.inputs?.some(item => item.artifactId === args.id && item.contentVersion === args.contentVersion) && !assignment.contract!.inputs.some(item => item.kind === 'artifact' && item.artifactId === args.id && item.contentVersion === args.contentVersion)) throw new Error('Artifact input is not pinned in this contract')
      const item = artifacts.read(attempt.projectId, args.id, args.contentVersion)
      return { id: item.id, contentVersion: item.contentVersion, name: item.name, content: item.content }
    } }),
    tool({ name: 'project_write_artifact', description: 'Write and register an immutable nonempty UTF-8 file for an exact named plan output. Reuse operation_id only with the same content.', schema: z.object({ operation_id: z.string().min(1), output: z.string().min(1), name: z.string().min(1), content: z.string().min(1).max(2_000_000) }).strict(), execute: async args => {
      const item = artifacts.write(sessionId, { operationId: args.operation_id, output: args.output, name: args.name, content: args.content })
      return { id: item.id, contentVersion: item.contentVersion, output: item.output, name: item.name, bytes: item.bytes, status: item.status }
    } }),
    tool({ name: 'project_worker_report', description: 'Submit completed work, evidence, exact artifact versions and actual unfinished work/content blockers. Registered independent acceptance is application-managed, not an unresolved item. Receipt is not completion: follow currentStatus and nextStep. GitHub PR URL is optional.', schema: z.object({
      operation_id: z.string().min(1),
      state: z.enum(['progress', 'ready', 'blocked', 'failed']).describe('Use ready after submitting all outputs; when no actual work/content blockers remain, use unresolved=[]. Registered independent or human acceptance is managed separately by the application.'),
      completed: z.string().min(1), evidence: z.array(z.string().min(1)).min(1), artifacts: z.array(z.object({ id: z.string(), contentVersion: z.string() }).strict()),
      unresolved: z.array(z.string()).describe('Only actual unfinished work or content blockers. Do not list waiting for registered independent acceptance or human review. Preserve real blockers; never clear them merely to finish.'),
      pr_url: z.string().url().optional(),
    }).strict(), execute: async args => {
      const input = { operationId: args.operation_id, state: args.state, completed: args.completed, evidence: args.evidence, artifacts: args.artifacts, unresolved: args.unresolved, ...(args.pr_url ? { prUrl: args.pr_url } : {}) }
      const result = (report: AcceptedReport, context?: { ticket: Ticket; assignment: Assignment }) => {
        const { ticket, assignment } = context ?? attempts.resolve(sessionId, true)
        const current = reports.reports(ticket.id).findLast(item => item.assignmentId === assignment.id)!
        const completed = assignment.state === 'ended' && assignment.endedReason === 'accepted'
        const steps: Record<string, string> = {
          'missing-artifacts': 'Write and register every required output, then submit a new report with exact artifact versions. Preserve any real unresolved work/content blockers.',
          'unresolved-items': 'Resolve the actual work/content blockers and submit an updated report with a new operation_id. Keep every remaining blocker in unresolved; never clear it merely to finish. Independent acceptance is managed separately by the application.',
          'delegation-pending': 'Wait for every required local delegation result, process it through the application, then continue. A child result never completes the parent Assignment by itself.',
          'semantic-review': 'Await the application independent authenticated review of the current report and exact artifact/conditions versions. This review is not an unresolved work item; receipt alone does not complete the task.',
          changes_required: 'Address the independent review feedback, register revised artifacts and submit a new ready report. The new report requires a new independent review. Preserve real blockers.',
          needs_judgment: 'Await further independent judgment of the current version. Preserve real work/content blockers and do not claim completion.',
          blocked: 'Address the reported work/content blockers and submit an updated report. Preserve every remaining real blocker.',
          failed: 'The current execution reported failure. Report the actual failure and remaining work; follow the authorized recovery instructions.',
        }
        const nextStep = completed ? 'The current report satisfies all registered completion conditions. No further worker report is needed.'
          : steps[assignment.waitingReason ?? ''] ?? 'Continue the authorized work; submit ready once all outputs are registered, preserving actual work/content blockers in unresolved.'
        const isCurrentReport = report.id === current.id
        return { received: true, reportId: report.id, currentReportId: current.id, isCurrentReport,
          currentStatus: { completed, waitingReason: assignment.waitingReason ?? null, unresolved: current.unresolved },
          nextStep: isCurrentReport ? nextStep : `This is a historical receipt only; it did not reaggregate or complete work. Follow currentReportId and currentStatus. ${nextStep}` }
      }
      // Recover an exact committed operation before any PR read, claim, resource/authorization check, or aggregation.
      // A changed payload for the same operation still fails explicitly here.
      const replay = reports.replay(sessionId, input)
      if (replay) {
        const attempt = attempts.bySession(sessionId), ticket = attempt && attempts.store.tickets.get(attempt.ticketId)
        const assignment = ticket?.assignments.find(item => item.id === attempt?.assignmentId)
        if (!ticket || !assignment) throw new Error('Stale or unauthorized worker execution')
        return result(replay, { ticket, assignment })
      }
      const pull = args.pr_url ? await reports.pullFor(sessionId, args.pr_url) : undefined
      return result(reports.submit(sessionId, input, pull))
    } }),
  ]
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe("The ticket's PR: its source PR, or one by the configured GitHub account from a branch named after this ticket (DSH_SUPERAGENT_NAME)."),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
