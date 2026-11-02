/** Database-backed project history. Streaming drafts and unsent input never appear as saved messages. */
import { useRef, useState, type FormEvent } from 'react'
import { usePoll } from './api.ts'
import { Button, Icon } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'
import { TaskLifecycle } from './task-lifecycle.tsx'

const executionReasons = {
  'executor-unavailable': 'planWaitingExecutor', 'worker-slot': 'executionWorkerSlot', 'preparation-reconciliation': 'executionPreparation',
  'worker-running': 'executionRunning', 'worker-idle': 'executionIdle', 'semantic-review': 'executionSemanticReview',
  'missing-artifacts': 'executionMissingArtifacts', 'unresolved-items': 'executionUnresolved', changes_required: 'executionChangesRequired',
  needs_judgment: 'executionNeedsJudgment', failed: 'executionFailed', blocked: 'executionBlocked', dependency: 'executionDependency', 'processing-paused': 'executionPaused',
} as const
const progressLabels = {
  'awaiting-confirmation': 'taskAwaitingConfirmation', queued: 'taskQueued', preparing: 'taskPreparing', retrying: 'taskRetrying',
  running: 'executionRunning', 'worker-idle': 'executionIdle', 'semantic-review': 'executionSemanticReview',
  'missing-artifacts': 'executionMissingArtifacts', 'unresolved-items': 'executionUnresolved', changes_required: 'executionChangesRequired',
  needs_judgment: 'executionNeedsJudgment', failed: 'executionFailed', blocked: 'executionBlocked', unknown: 'taskNeedsCheck',
  'authorization-revoked': 'planRevoked', completed: 'executionDone', ended: 'taskEnded',
} as const

export function ProjectConversation({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
  const { state } = usePanelData()
  const readOnly = !state || !!state.safeRestore
  const { data, error, reload } = usePoll(() => call('GET projects/:id/conversation', { id }), [call, id], 1000)
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string>(), [confirming, setConfirming] = useState<string>()
  const [artifact, setArtifact] = useState<{ name: string; content: string; contentVersion: string }>()
  const [reviewEvidence, setReviewEvidence] = useState<Record<string, string>>({})
  const decisionPending = useRef<{ key: string; operationId: string }>(undefined)
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
  const pending = useRef<{ requestId: string; text: string }>(undefined)
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
    pending.current = request
    try {
      const displayed = data?.tasks?.filter(task => task.planRevisions?.length).map(task => ({ ticketId: task.id, planRevision: task.planRevisions!.at(-1)!.revision })) ?? []
      const strict = /^(?:按这个方案做|执行这个方案|implement this plan|再运行一次|run it again)$/.test(request.text)
      const body = strict && displayed.length === 1 ? { ...request, ...displayed[0] } : request
      const result = await call('POST projects/:id/messages', { id, body })
      pending.current = undefined; setText(''); setFailure(result.clarification); await reload()
    } catch (error) { setFailure(errorText(error)) }
    finally { submitting.current = false; setBusy(false) }
  }
  if (!data) return <LoadState error={error} loading />
  // The keyed route also remounts this component; check ownership before displaying server data.
  if (data.project.id !== id) return <LoadState loading />
  const tasks = data.tasks ?? []
  return <div className="dt-conversation">
    <div><Button size="sm" icon={<Icon name="chevron-left" />} onClick={() => navigate({ page: 'projects' })}>{t('tab.projects')}</Button></div>
    <header><h2>{data.project.name}</h2><p className="dt-hint">{t('projectGoalPrefix')}{data.project.goal}</p></header>
    {state?.safeRestore && <Hint>{t('recoveryReadOnly')}</Hint>}
    {error && <LoadState error={error} loading={false} />}
    {data.coordinator?.status === 'error' && <div className="dt-banner dt-danger" role="alert">
      <p>{t('conversationCoordinatorError')}</p>{data.coordinator.error && <p>{data.coordinator.error}</p>}
      <Button variant="outline" disabled={retry.busy || readOnly} onClick={() => { void retry.run() }}>{t('conversationRetry')}</Button>
    </div>}
    <section aria-label={t('projectConversation')} className="dt-conversation-history">
      {!data.messages.length && <Hint>{t('conversationEmpty')}</Hint>}
      {data.messages.filter(message => message.projectId === id).map(message => <article key={message.id} className={`dt-conversation-message dt-conversation-${message.role}`}>
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
    <section aria-label={t('planTitle')} className="dt-conversation-plans">
      <h3>{t('planTitle')}</h3>
      {!tasks.length && <Hint>{t('planNoRevision')}</Hint>}
      {tasks.map(task => {
        const plan = task.planRevisions?.at(-1)
        const authorization = task.authorizations?.findLast(item => item.planRevision === plan?.revision)
        const assignment = task.assignments.find(item => item.contract?.targetId === authorization?.targetId)
        const execution = task.progress?.assignments.find(item => item.assignmentId === assignment?.id)
        const report = assignment && (execution ? data.reports?.find(item => item.id === execution.reportId)
          : data.reports?.findLast(item => item.assignmentId === assignment.id))
        const waitingLabel = execution ? !['completed', 'ended'].includes(execution.phase) ? progressLabels[execution.phase] : undefined
          : assignment?.waitingReason ? executionReasons[assignment.waitingReason] : undefined
        const held = task.lifecycle?.pause.intent === 'pause' || task.lifecycle?.stop.intent === 'stop'
          || task.lifecycle?.reconciliation?.state === 'checking' || task.lifecycle?.reconciliation?.state === 'unknown'
          || task.progress?.reconciliation === 'checking' || task.progress?.reconciliation === 'unknown'
        const controllable = task.assignments.some(item => item.state !== 'ended')
          || task.lifecycle?.pause.intent === 'pause' || task.lifecycle?.stop.intent === 'stop'
        const canReview = authorization && !authorization.revokedAt && !task.ended && assignment?.state !== 'ended'
          && assignment?.contract && assignment.contract.plan.acceptance?.mode !== 'registered-files' && report?.state === 'ready'
        return <article key={task.id} className="dt-conversation-plan">
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
            </dl>
            {authorization ? <p className="dt-hint">{t(authorization.revokedAt ? 'planRevoked' : 'planConfirmed')}</p> : <Button variant="primary" size="sm" disabled={!!confirming || readOnly}
              onClick={() => { void confirm(task.id, plan.revision) }}>{t('planConfirm')}</Button>}
            {authorization && !authorization.revokedAt && <Button size="sm" disabled={!!confirming || readOnly || held || task.ended?.by === 'human'}
              onClick={() => { void confirm(task.id, plan.revision, 'rerun') }}>{t('planRerun')}</Button>}
            {authorization && !authorization.revokedAt && <Button size="sm" disabled={!!confirming || readOnly}
              onClick={() => { void revoke(task.id, authorization.id) }}>{t('planRevoke')}</Button>}
            {waitingLabel && !authorization?.revokedAt && <p className="dt-hint">{t('executionWait', { reason: t(waitingLabel) })}</p>}
            {assignment?.state === 'ended' && assignment.report?.state === 'ready' && <p>{t('executionDone')}</p>}
            <TaskLifecycle key={task.id} id={task.id} lifecycle={controllable || task.ended ? task.lifecycle : undefined}
              reconciliationState={task.progress?.reconciliation} attention={task.attention}
              ended={!!task.ended} enabled={controllable}
              retryable={task.assignments.some(item => item.state !== 'ended' && item.report?.state === 'failed')}
              readOnly={readOnly} reload={reload} />
            {!!report?.unresolved.length && <div><strong>{t('reportUnresolved')}</strong><ul>{report.unresolved.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
            {canReview && report && <div>
                <p>{report.completed}</p><p>{report.evidence.join('\n')}</p>
                {!!report.unresolved.length && <p className="dt-hint">{t('acceptanceBlockersRemain')}</p>}
                {held && <Hint>{t('taskReviewHeld')}</Hint>}
                <label>{t('acceptanceEvidence')}<textarea className="dt-input" disabled={readOnly || held} aria-label={t('acceptanceEvidence')} value={reviewEvidence[report.id] ?? ''} onChange={event => setReviewEvidence(previous => ({ ...previous, [report.id]: event.target.value }))} /></label>
                {(['passed', 'changes_required', 'needs_judgment'] as const).map(conclusion => <Button key={conclusion} size="sm" disabled={!!confirming || readOnly || held || !reviewEvidence[report.id]?.trim()} onClick={() => { void decide(task.id, report.id, conclusion) }}>{t(conclusion === 'passed' ? 'acceptancePass' : conclusion === 'changes_required' ? 'acceptanceChanges' : 'acceptanceJudgment')}</Button>)}
              </div>}
          </> : <p className="dt-hint">{t('planNoRevision')}</p>}
        </article>
      })}
    </section>
    {!!data.artifacts?.length && <section aria-label={t('projectArtifacts')}>
      <h3>{t('projectArtifacts')}</h3>
      {data.artifacts.map(item => <article key={item.id}><strong>{item.name}</strong> · {item.output} · {item.bytes} bytes
        <p className="dt-hint">{t('artifactVersion')}: {item.contentVersion.slice(0, 12)}</p>
        <Button size="sm" onClick={() => { void viewArtifact(item.id, item.contentVersion) }}>{t('artifactRead')}</Button>
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
