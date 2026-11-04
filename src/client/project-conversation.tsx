/** Database-backed project history. Streaming drafts and unsent input never appear as saved messages. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, usePoll, useProjectEvents } from './api.ts'
import { Button, Icon } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { errorText, reasonLabel } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'
import { TaskLifecycle } from './task-lifecycle.tsx'
import { ProjectMaterials } from './project-materials.tsx'

const budgetLabels = { 'global-budget': 'assignmentBudgetGlobal', 'project-fairness': 'assignmentBudgetFairness', 'worker-slot': 'executionWorkerSlot' } as const

const executionReasons = {
  'executor-unavailable': 'planWaitingExecutor', 'worker-slot': 'executionWorkerSlot', 'preparation-reconciliation': 'executionPreparation',
  'worker-running': 'executionRunning', 'worker-idle': 'executionIdle', 'semantic-review': 'executionSemanticReview',
  'missing-artifacts': 'executionMissingArtifacts', 'unresolved-items': 'executionUnresolved', 'delegation-pending': 'executionDelegationPending', changes_required: 'executionChangesRequired',
  needs_judgment: 'executionNeedsJudgment', failed: 'executionFailed', blocked: 'executionBlocked', dependency: 'executionDependency', 'processing-paused': 'executionPaused',
} as const
const progressLabels = {
  'awaiting-confirmation': 'taskAwaitingConfirmation', queued: 'taskQueued', preparing: 'taskPreparing', retrying: 'taskRetrying',
  running: 'executionRunning', 'worker-idle': 'executionIdle', 'semantic-review': 'executionSemanticReview',
  'missing-artifacts': 'executionMissingArtifacts', 'unresolved-items': 'executionUnresolved', 'delegation-pending': 'executionDelegationPending', changes_required: 'executionChangesRequired',
  needs_judgment: 'executionNeedsJudgment', failed: 'executionFailed', blocked: 'executionBlocked', unknown: 'taskNeedsCheck',
  'authorization-revoked': 'planRevoked', completed: 'executionDone', ended: 'taskEnded',
} as const
interface StoredConversationDraft { text: string; pending?: { requestId: string; text: string } }
function conversationDraft(id: string): StoredConversationDraft {
  try {
    const value = JSON.parse(sessionStorage.getItem(`dsh-superagent/project-draft/${id}`) ?? 'null') as Partial<StoredConversationDraft> | null
    const text = typeof value?.text === 'string' ? value.text : ''
    const candidate = value?.pending && typeof value.pending.requestId === 'string' && typeof value.pending.text === 'string' ? value.pending : undefined
    const pending = candidate?.text === text.trim() ? candidate : undefined
    return { text, ...(pending ? { pending } : {}) }
  } catch { return { text: '' } }
}

export function ProjectConversation({ id, focusTicket }: { id: string; focusTicket?: string }) {
  const { t, call, navigate } = usePanel()
  const { state, error: hostError } = usePanelData()
  const readOnly = !state || !!state.safeRestore
  const { data, error, reload } = usePoll(() => call('GET projects/:id/conversation', { id }), [call, id], 1000)
  const live = useProjectEvents(id, call, () => { void reload() }, 1000)
  const initialDraft = useRef(conversationDraft(id)).current
  const [text, setText] = useState(initialDraft.text), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string>(), [confirming, setConfirming] = useState<string>()
  const [artifact, setArtifact] = useState<{ name: string; content: string; contentVersion: string }>()
  const [downloadFailure, setDownloadFailure] = useState<{ file: { id: string; version: string; name: string }; message: string }>()
  const [reviewEvidence, setReviewEvidence] = useState<Record<string, string>>({})
  const decisionPending = useRef<{ key: string; operationId: string }>(undefined)
  const focused = useRef<string>()
  useEffect(() => {
    if (!data || !focusTicket) return
    const key = `${id}:${focusTicket}`
    if (focused.current === key) return
    const target = document.getElementById(`project-task-${focusTicket}`)
    if (!target) return
    focused.current = key
    target.scrollIntoView?.({ block: 'start' })
  }, [data, focusTicket, id])
  const decide = async (ticketId: string, reportId: string, conclusion: 'passed' | 'changes_required' | 'needs_judgment') => {
    const evidence = reviewEvidence[reportId]?.trim()
    if (!evidence || confirming || readOnly) return
    const key = JSON.stringify([ticketId, reportId, conclusion, evidence])
    const operationId = decisionPending.current?.key === key ? decisionPending.current.operationId : crypto.randomUUID()
    decisionPending.current = { key, operationId }; setConfirming(ticketId); setFailure(undefined)
    try { await call('POST projects/:id/acceptance', { id, body: { ticketId, reportId, operationId, conclusion, evidence } }); decisionPending.current = undefined; await reload() }
    catch (error) { setFailure(errorText(error)) }
    finally { setConfirming(undefined) }
  }
  const viewArtifact = async (artifactId: string, version: string) => {
    try { setArtifact(await call('GET projects/:id/artifacts/:artifactId/:version', { id, artifactId, version })) }
    catch (error) { setFailure(errorText(error)) }
  }
  const downloadArtifact = async (file: { id: string; version: string; name: string }) => {
    setDownloadFailure(undefined)
    try {
      const response = await fetch(`/orchestrator/api/projects/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(file.id)}/${encodeURIComponent(file.version)}/download`,
        { headers: { 'x-orchestrator-request': '1' } })
      if (!response.ok) {
        const body = await response.text()
        let detail = body
        try { const value = JSON.parse(body) as { error?: unknown }; if (typeof value.error === 'string') detail = value.error } catch { /* Keep a plain response body. */ }
        throw new Error(detail || `${t('artifactDownloadError')} (${response.status})`)
      }
      const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a')
      anchor.href = url; anchor.download = file.name; anchor.click(); URL.revokeObjectURL(url)
    } catch (error) { setDownloadFailure({ file, message: error instanceof Error ? error.message : t('artifactDownloadError') }) }
  }
  const pending = useRef<{ requestId: string; text: string } | undefined>(initialDraft.pending)
  const storeDraft = (value: string, request: { requestId: string; text: string } | undefined = pending.current) => {
    try {
      if (!value) sessionStorage.removeItem(`dsh-superagent/project-draft/${id}`)
      else sessionStorage.setItem(`dsh-superagent/project-draft/${id}`, JSON.stringify(request?.text === value.trim() ? { text: value, pending: request } : { text: value }))
    }
    catch { /* Draft persistence is optional. */ }
  }
  useEffect(() => { storeDraft(text) }, [text])
  const submitting = useRef(false)
  const retry = useAction(() => call('POST projects/:id/retry', { id }), { reload })
  const planPending = useRef<{ key: string; operationId: string }>(undefined)
  const revoke = async (ticketId: string, authorizationId: string) => {
    if (readOnly) return
    setConfirming(ticketId); setFailure(undefined)
    try { await call('POST projects/:id/plan-revocation', { id, body: { ticketId, authorizationId, operationId: crypto.randomUUID() } }); await reload() }
    catch (error) { setFailure(errorText(error)) }
    finally { setConfirming(undefined) }
  }
  const confirm = async (ticketId: string, planRevision: number, intent: 'execute' | 'rerun' = 'execute') => {
    if (confirming || readOnly) return
    const key = `${ticketId}:${planRevision}:${intent}`
    const operationId = planPending.current?.key === key ? planPending.current.operationId : crypto.randomUUID()
    planPending.current = { key, operationId }
    setConfirming(ticketId); setFailure(undefined)
    try { await call('POST projects/:id/plan-confirmation', { id, body: { ticketId, planRevision, operationId, intent } }); planPending.current = undefined; await reload() }
    catch (error) { setFailure(errorText(error)) }
    finally { setConfirming(undefined) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting.current || !text.trim() || readOnly) return
    submitting.current = true; setBusy(true); setFailure(undefined)
    // Keep the exact request after an ambiguous network failure. Editing starts a new user intent.
    const request = pending.current?.text === text.trim() ? pending.current : { requestId: crypto.randomUUID(), text: text.trim() }
    pending.current = request; storeDraft(text, request)
    try {
      const displayed = data?.tasks?.filter(task => task.planRevisions?.length).map(task => ({ ticketId: task.id, planRevision: task.planRevisions!.at(-1)!.revision })) ?? []
      const strict = /^(?:按这个方案做|执行这个方案|implement this plan|再运行一次|run it again)$/.test(request.text)
      const body = strict && displayed.length === 1 ? { ...request, ...displayed[0] } : request
      const result = await call('POST projects/:id/messages', { id, body })
      pending.current = undefined
      try { sessionStorage.removeItem(`dsh-superagent/project-draft/${id}`) } catch { /* Draft persistence is optional. */ }
      setText(''); setFailure(result.clarification); await reload()
    } catch (error) { setFailure(errorText(error)) }
    finally { submitting.current = false; setBusy(false) }
  }
  if (!data) return <LoadState error={error} loading />
  // The keyed route also remounts this component; check ownership before displaying server data.
  if (data.project.id !== id) return <LoadState loading />
  const tasks = data.tasks ?? []
  const runningWorkers = tasks.reduce((count, task) => {
    const current = new Set(task.progress?.assignments.map(item => item.assignmentId) ?? [])
    const tracked = (task.progress?.assignments ?? []).filter(item => ['preparing', 'retrying', 'running'].includes(item.phase)).length
    const untracked = task.progress ? task.assignments.filter(item => item.state === 'running' && !current.has(item.id)).length : 0
    return count + tracked + untracked
  }, 0)
  const projectPaused = tasks.some(task => task.lifecycle?.pause.intent === 'pause' || task.lifecycle?.pause.state === 'paused')
  const projectNeedsAttention = tasks.some(task => {
    if (task.ended) return false
    const plan = task.planRevisions?.at(-1)
    if (plan && !task.authorizations?.findLast(item => item.planRevision === plan.revision && !item.revokedAt)) return true
    if ([...task.attentionQuestions ?? [], ...(task.attention ? [task.attention] : [])].some(item => !item.resolvedAt)) return true
    return task.progress?.assignments.some(item => ['semantic-review', 'changes_required', 'needs_judgment', 'blocked', 'failed'].includes(item.phase)) ?? false
  })
  const lastCheckedAt = tasks.flatMap(task => [task.lifecycle?.observed.at, task.lifecycle?.reconciliation?.observedAt, task.updatedAt])
    .filter((value): value is string => !!value).sort().at(-1)
  const coordinatorBudgetWait = data.coordinator && 'budgetWait' in data.coordinator
    && (data.coordinator.budgetWait === 'global-budget' || data.coordinator.budgetWait === 'project-fairness')
    ? data.coordinator.budgetWait : undefined
  return <div className="dt-conversation">
    <div><Button size="sm" icon={<Icon name="chevron-left" />} onClick={() => navigate({ page: 'projects' })}>{t('tab.projects')}</Button></div>
    <header><h2>{data.project.name}</h2><p className="dt-hint">{t('projectGoalPrefix')}{data.project.goal}</p>
      <dl className="dt-project-live" aria-label={t('projectLiveStatus')}>
        <div><dt>{t('projectStatus')}</dt><dd>{t(data.coordinator?.status === 'error' ? 'projectStatusCoordinatorError' : projectPaused ? 'projectStatusPaused'
          : projectNeedsAttention ? 'projectStatusNeedsAttention' : runningWorkers ? 'projectStatusRunning'
            : data.coordinator?.status === 'running' ? 'projectStatusCoordinatorRunning' : 'projectStatusIdle')}</dd></div>
        <div><dt>{t('projectRunningWorkers')}</dt><dd>{runningWorkers}</dd></div>
        <div><dt>{t('projectLastChecked')}</dt><dd>{lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : '—'}</dd></div>
      </dl>
    </header>
    <nav className="dt-section-nav" aria-label={t('projectSections')}>
      <button type="button" onClick={() => document.getElementById('project-conversation-history')?.scrollIntoView?.({ block: 'start' })}>{t('projectSectionConversation')}</button>
      <button type="button" onClick={() => document.getElementById('project-tasks')?.scrollIntoView?.({ block: 'start' })}>{t('projectSectionTasks')}</button>
      <button type="button" onClick={() => document.getElementById('project-materials')?.scrollIntoView?.({ block: 'start' })}>{t('projectSectionMaterials')}</button>
    </nav>
    <section id="project-materials"><ProjectMaterials id={id} readOnly={readOnly} /></section>
    {state?.safeRestore && <Hint>{t('recoveryReadOnly')}</Hint>}
    {error && <LoadState error={error} loading={false} />}
    {(hostError || error instanceof ApiError && error.details.unreachable) && data && <div className="dt-banner" role="status"><strong>{t('projectHostOffline')}</strong></div>}
    {(live.error || live.transport === 'polling') && <div className="dt-banner" role="status"><strong>{t('projectEventsFallback')}</strong></div>}
    {data.coordinator?.status === 'error' && <div className="dt-banner dt-danger" role="alert">
      <p>{t('conversationCoordinatorError')}</p>{data.coordinator.error && <p>{data.coordinator.error}</p>}
      <Button variant="outline" disabled={retry.busy || readOnly} onClick={() => { void retry.run() }}>{t('conversationRetry')}</Button>
    </div>}
    {coordinatorBudgetWait && <div className="dt-banner" role="status">
      <strong>{t('conversationBudgetWaiting')}</strong><p>{t(budgetLabels[coordinatorBudgetWait])}</p>
    </div>}
    <section id="project-conversation-history" aria-label={t('projectConversation')} className="dt-conversation-history">
      {!data.messages.length && <Hint>{t('conversationEmpty')}</Hint>}
      {data.messages.filter(message => message.projectId === id).map(message => <article key={message.id} id={`project-message-${message.id}`} className={`dt-conversation-message dt-conversation-${message.role}`}>
        <div className="dt-row-meta"><strong>{t(message.role === 'user' ? 'conversationUser' : 'conversationAssistant')}</strong>
          <span>{t('conversationSaved')}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
          {(message.status === 'queued' || message.status === 'running') && <span>{t('conversationWaiting')}</span>}
          {message.status === 'error' && <span className="dt-error">{t('conversationMessageError')}</span>}
        </div>
        <div className="dt-conversation-text">{message.text}</div>
        {message.error && <p className="dt-error">{message.error}</p>}
      </article>)}
      {data.draft && <article className="dt-conversation-message dt-conversation-draft" role="status">
        <strong>{t('conversationDraft')}</strong><div className="dt-conversation-text">{data.draft.text}</div>
      </article>}
    </section>
    <section id="project-tasks" aria-label={t('planTitle')} className="dt-conversation-plans">
      <h3>{t('planTitle')}</h3>
      {!tasks.length && <Hint>{t('planNoRevision')}</Hint>}
      {tasks.map(task => {
        const plan = task.planRevisions?.at(-1)
        const authorization = task.authorizations?.findLast(item => item.planRevision === plan?.revision)
        const latestExecutionAuthorization = task.authorizations?.findLast(item => task.assignments.some(assignment => assignment.contract?.authorizationId === item.id))
        const currentAssignmentIds = new Set(task.progress?.assignments.map(item => item.assignmentId) ?? [])
        // Older fixture/API shapes may omit progress; the live API carries the authoritative current graph.
        const assignments = task.progress
          ? task.assignments.filter(item => item.contract && currentAssignmentIds.has(item.id))
          : task.assignments.filter(item => item.contract && (item.state !== 'ended' || item.contract.authorizationId === latestExecutionAuthorization?.id))
        const historicalAssignments = task.progress
          ? task.assignments.filter(item => item.contract && !currentAssignmentIds.has(item.id)) : []
        const otherActiveAuthorizations = task.authorizations?.filter(item => !item.revokedAt && item.id !== authorization?.id
          && task.assignments.some(assignment => assignment.state !== 'ended' && assignment.contract?.authorizationId === item.id)) ?? []
        const assignmentTitle = (id: string) => {
          const execution = task.progress?.assignments.find(item => item.assignmentId === id)
          return execution?.title || execution?.goal || task.assignments.find(item => item.id === id)?.contract?.plan.goal || t('assignmentUnknown')
        }
        const proposalTitle = (key: string) => plan?.assignments?.find(item => item.key === key)?.goal || t('assignmentUnknown')
        const held = task.lifecycle?.pause.intent === 'pause' || task.lifecycle?.stop.intent === 'stop'
          || task.lifecycle?.reconciliation?.state === 'checking' || task.lifecycle?.reconciliation?.state === 'unknown'
          || task.progress?.reconciliation === 'checking' || task.progress?.reconciliation === 'unknown'
        const reviewHeld = task.lifecycle?.pause.intent === 'pause' || task.lifecycle?.stop.intent === 'stop' || !!state?.paused
        const controllable = task.assignments.some(item => item.state !== 'ended')
          || task.lifecycle?.pause.intent === 'pause' || task.lifecycle?.stop.intent === 'stop'
        const hasBranchQuestion = assignments.some(item => task.progress?.assignments.some(progress => progress.assignmentId === item.id && progress.question)
          || task.attention?.binding?.assignmentId === item.id)
        return <article key={task.id} id={`project-task-${task.id}`} className="dt-conversation-plan">
          {plan ? <>
            <strong>{t('planRevision', { revision: plan.revision })}</strong>
            <dl>
              <dt>{t('planGoal')}</dt><dd>{plan.goal}</dd>
              <dt>{t('planScope')}</dt><dd>{plan.scope}</dd>
              <dt>{t('planOutputs')}</dt><dd>{plan.outputs.join('\n')}</dd>
              <dt>{t('planResources')}</dt><dd>{[...plan.resources, ...(plan.artifactInputs ?? []).map(item => `${item.artifactId} @ ${item.contentVersion}`)].join('\n') || '—'}</dd>
              <dt>{t('planEnvironment')}</dt><dd>{plan.environment}</dd>
              <dt>{t('planCost')}</dt><dd>{plan.cost}</dd>
              <dt>{t('planCompletion')}</dt><dd>{plan.completion}</dd>
              <dt>{t('acceptanceMode')}</dt><dd>{t(plan.acceptance?.mode === 'registered-files' ? 'registeredFiles' : 'humanReview')}</dd>
               {plan.acceptance?.codeCheck && <><dt>Code validation</dt><dd>Profile: {plan.acceptance.codeCheck.profile}; command: {[plan.acceptance.codeCheck.command, ...plan.acceptance.codeCheck.args].join(' ')}; source: {plan.acceptance.codeCheck.sourceVersion}; config: {plan.acceptance.codeCheck.configVersion}; budget: {plan.cost}</dd></>}
            </dl>
            {!!plan.assignments?.length && <section aria-label={t('assignmentPlan')}>
              <h4>{t('assignmentPlan')}</h4>
              <ol className="dt-assignment-list">{plan.assignments.map(proposal => <li key={proposal.key} className="dt-assignment">
                <strong>{proposal.goal}</strong>
                <p>{t('planOutputs')}{t('labelSeparator')}{proposal.outputs.join(', ')}</p>
                {!!proposal.resources.length && <p className="dt-hint">{t('planResources')}{t('labelSeparator')}{proposal.resources.join('; ')}</p>}
                <p className="dt-hint">{t('planCost')}{t('labelSeparator')}{proposal.cost}</p>
                {!!proposal.dependencies.length && <p className="dt-hint">{t('assignmentDependencies')}{t('labelSeparator')}{proposal.dependencies.map(proposalTitle).join('; ')}</p>}
                {proposal.review && <p className="dt-hint">{t('assignmentReviewTarget')}{t('labelSeparator')}{proposalTitle(proposal.review.target)}</p>}
                {proposal.retry && <p className="dt-hint">{t('assignmentRetryLimit', { count: proposal.retry.limit })}</p>}
                <p className="dt-hint">{t('planCompletion')}{t('labelSeparator')}{proposal.completion}</p>
              </li>)}</ol>
            </section>}
            {authorization ? <p className="dt-hint">{t(authorization.revokedAt ? 'planRevoked' : 'planConfirmed')}</p> : <Button variant="primary" size="sm" disabled={!!confirming || readOnly}
              onClick={() => { void confirm(task.id, plan.revision) }}>{t('planConfirm')}</Button>}
            {authorization && !authorization.revokedAt && <Button size="sm" disabled={!!confirming || readOnly || held || task.ended?.by === 'human'}
              onClick={() => { void confirm(task.id, plan.revision, 'rerun') }}>{t('planRerun')}</Button>}
            {authorization && !authorization.revokedAt && <Button size="sm" disabled={!!confirming || readOnly}
              onClick={() => { void revoke(task.id, authorization.id) }}>{t('planRevoke')}</Button>}
            {authorization && task.ended?.outcome === 'completed' && <p>{t('executionDone')}</p>}
            <TaskLifecycle key={task.id} id={task.id} lifecycle={controllable || task.ended ? task.lifecycle : undefined}
              reconciliationState={task.progress?.reconciliation} attention={hasBranchQuestion ? undefined : task.attention}
              ended={!!task.ended} enabled={controllable}
              retryable={task.assignments.some(item => item.state !== 'ended' && item.report?.state === 'failed')}
              readOnly={readOnly} reload={reload} />
            {otherActiveAuthorizations.map(item => <div className="dt-row-actions" key={item.id}>
              <span className="dt-hint">{t('planRevision', { revision: item.planRevision })}</span>
              <Button size="sm" disabled={!!confirming || readOnly} onClick={() => { void revoke(task.id, item.id) }}>{t('planRevoke')}</Button>
            </div>)}
            {!!assignments.length && <section aria-label={t('assignmentProgress')} className="dt-assignment-progress">
              <h4>{t('assignmentProgress')}</h4>
              {assignments.map(assignment => {
                const execution = task.progress?.assignments.find(item => item.assignmentId === assignment.id)
                const report = execution ? data.reports?.find(item => item.id === execution.reportId)
                  : data.reports?.findLast(item => item.assignmentId === assignment.id)
                const reason = execution?.waitingReason ?? assignment.waitingReason
                const queuedReason = execution?.phase === 'queued' && ['dependency', 'worker-slot', 'processing-paused'].includes(reason ?? '')
                const label = execution?.phase === 'completed' ? 'executionDone' : execution?.phase === 'ended' ? 'taskEnded'
                  : queuedReason ? executionReasons[reason as keyof typeof executionReasons]
                    : execution ? progressLabels[execution.phase]
                      : reason && Object.hasOwn(executionReasons, reason) ? executionReasons[reason as keyof typeof executionReasons]
                        : assignment.state === 'ended' ? 'taskEnded' : 'taskQueued'
                const branchHeld = reviewHeld || !!execution?.acceptanceHold || !execution && held
                const branchAuthorization = task.authorizations?.find(item => item.id === assignment.contract?.authorizationId)
                const canReviewBranch = branchAuthorization && !branchAuthorization.revokedAt && !task.ended && assignment.state !== 'ended'
                  && assignment.contract && assignment.contract.plan.acceptance?.mode !== 'registered-files' && report?.state === 'ready'
                const question = execution?.question ?? (task.attention?.binding?.assignmentId === assignment.id ? task.attention : undefined)
                return <article className="dt-assignment" key={assignment.id} aria-label={assignmentTitle(assignment.id)}>
                  <strong>{assignmentTitle(assignment.id)}</strong>
                  <p className="dt-hint">{t('planRevision', { revision: assignment.contract!.planRevision })}</p>
                  <p className="dt-hint" role="status">{t('executionWait', { reason: t(branchAuthorization?.revokedAt ? 'planRevoked' : label) })}</p>
                  {report?.conversationMessageId && <Button size="sm" onClick={() => document.getElementById(`project-message-${report.conversationMessageId}`)?.scrollIntoView?.({ block: 'center' })}>{t('viewInConversation')}</Button>}
                  {execution?.budgetWait && !['completed', 'ended'].includes(execution.phase) && <p className="dt-hint">{t(budgetLabels[execution.budgetWait])}</p>}
                  {!!execution?.dependencies.length && <p className="dt-hint">{t('assignmentDependencies')}{t('labelSeparator')}{execution.dependencies.map(assignmentTitle).join('; ')}</p>}
                  {execution?.gate && <p className="dt-hint">{t('assignmentReviewTarget')}{t('labelSeparator')}{assignmentTitle(execution.gate.targetAssignmentId)}
                    {' · '}{t(execution.gate.conclusion === 'passed' ? 'assignmentGatePassed' : execution.gate.conclusion === 'changes_required' ? 'assignmentGateChanges' : execution.gate.conclusion === 'needs_judgment' ? 'assignmentGateJudgment' : 'assignmentGateWaiting')}</p>}
                  {question && <TaskLifecycle key={assignment.id + ':' + question.id} id={task.id} attention={question}
                    ended={!!task.ended} enabled={false} readOnly={readOnly} reload={reload} />}
                  {!!report?.unresolved.length && <div><strong>{t('reportUnresolved')}</strong><ul>{report.unresolved.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                  {canReviewBranch && report && <div>
                <p>{report.completed}</p><p>{report.evidence.join('\n')}</p>
                {!!report.unresolved.length && <p className="dt-hint">{t('acceptanceBlockersRemain')}</p>}
                {branchHeld && <Hint>{t(state?.paused ? 'executionPaused' : assignments.length > 1 ? 'assignmentReviewHeld' : 'taskReviewHeld')}</Hint>}
                <label>{t('acceptanceEvidence')}<textarea className="dt-input" disabled={readOnly || branchHeld} aria-label={t('acceptanceEvidence')} value={reviewEvidence[report.id] ?? ''} onChange={event => setReviewEvidence(previous => ({ ...previous, [report.id]: event.target.value }))} /></label>
                {(['passed', 'changes_required', 'needs_judgment'] as const).map(conclusion => <Button key={conclusion} size="sm" disabled={!!confirming || readOnly || branchHeld || !reviewEvidence[report.id]?.trim()} onClick={() => { void decide(task.id, report.id, conclusion) }}>{t(conclusion === 'passed' ? 'acceptancePass' : conclusion === 'changes_required' ? 'acceptanceChanges' : 'acceptanceJudgment')}</Button>)}
              </div>}
                </article>
              })}
            </section>}
            {!!historicalAssignments.length && <section aria-label={t('assignmentHistory')} className="dt-assignment-history">
              <details>
                <summary>{t('assignmentHistory', { count: historicalAssignments.length })}</summary>
                <ul className="dt-list">
                  {historicalAssignments.map(item => {
                    const question = task.attentionQuestions?.find(attention => attention.binding?.assignmentId === item.id)
                      ?? (task.attention?.binding?.assignmentId === item.id ? task.attention : undefined)
                    return <li key={item.id} className="dt-assignment">
                      <strong>{item.contract!.plan.goal}</strong>
                      <p className="dt-hint">{t('planRevision', { revision: item.contract!.planRevision })}{t('labelSeparator')}
                        {item.endedReason ? reasonLabel(t, item.endedReason) : t(`assignment.${item.state}` as const)}</p>
                      {item.report?.summary && <p className="dt-hint">{item.report.summary}</p>}
                      {question && <TaskLifecycle key={`${item.id}:${question.id}`} id={task.id} attention={question}
                        ended={!!task.ended} enabled={false} readOnly={readOnly} reload={reload} />}
                    </li>
                  })}
                </ul>
              </details>
            </section>}
          </> : <p className="dt-hint">{t('planNoRevision')}</p>}
        </article>
      })}
    </section>
    {!!data.artifacts?.length && <section aria-label={t('projectArtifacts')}>
      <h3>{t('projectArtifacts')}</h3>
      {downloadFailure && <div className="dt-banner dt-danger" role="alert">
        <strong>{t('artifactDownloadError')}</strong><p>{downloadFailure.message}</p>
        <Button size="sm" onClick={() => { void downloadArtifact(downloadFailure.file) }}>{t('artifactDownloadRetry')}</Button>
      </div>}
      {data.artifacts.map(item => <article key={item.id}><strong>{item.name}</strong> · {item.output} · {item.bytes} bytes
        <p className="dt-hint">{t('artifactVersion')}: {item.contentVersion.slice(0, 12)}</p>
        <Button size="sm" onClick={() => { void viewArtifact(item.id, item.contentVersion) }}>{t('artifactRead')}</Button>
        <Button size="sm" onClick={() => { void downloadArtifact({ id: item.id, version: item.contentVersion, name: item.name }) }}>{t('artifactDownload')}</Button>
      </article>)}
      {artifact && <article><strong>{artifact.name}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{artifact.content}</pre><Button size="sm" onClick={() => setArtifact(undefined)}>{t('close')}</Button></article>}
    </section>}
    <form className="dt-conversation-compose" onSubmit={event => { void submit(event) }}>
      <label htmlFor="dt-project-message" className="dt-hint">{t('conversationLocalDraft')}</label>
      <textarea id="dt-project-message" className="dt-input" rows={4} required value={text} disabled={busy || readOnly}
        placeholder={t('conversationPlaceholder')} onChange={event => setText(event.target.value)} />
      {failure && <p className="dt-error" role="alert">{t('conversationSaveError')} {failure}</p>}
      <div><Button variant="primary" type="submit" disabled={busy || readOnly || !text.trim()}>{t(busy ? 'conversationSending' : failure ? 'conversationRetry' : 'conversationSend')}</Button></div>
    </form>
  </div>
}
