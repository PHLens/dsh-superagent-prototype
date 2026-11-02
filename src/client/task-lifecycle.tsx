/** Task controls show persisted intent separately from the last host observation. */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Attention, LifecycleState } from '../core/model.ts'
import { Button, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText, when } from './text.ts'
import { Hint, MarkdownLite } from './widgets.tsx'

type Lifecycle = Pick<LifecycleState, 'pause' | 'stop' | 'observed'> & Partial<Pick<LifecycleState, 'checkpoint' | 'reconciliation'>>
interface Props {
  id: string
  lifecycle?: Lifecycle
  attention?: Pick<Attention, 'id' | 'question' | 'version'>
  ended: boolean
  enabled?: boolean
  retryable?: boolean
  readOnly?: boolean
  showStop?: boolean
  reload(): Promise<unknown>
}

export function TaskLifecycle({ id, lifecycle, attention, ended, enabled = true, retryable = false, readOnly = false, showStop = true, reload }: Props) {
  const { t, call } = usePanel()
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string>(), [notice, setNotice] = useState<string>()
  const [answer, setAnswer] = useState('')
  const submitting = useRef(false)
  const inputId = useId()
  const questionKey = attention ? attention.id + ':' + (attention.version ?? 1) : ''
  const currentQuestion = useRef(questionKey)
  currentQuestion.current = questionKey
  const pendingAnswer = useRef<{ key: string; body: { questionId: string; version: number; text: string } }>(undefined)
  useEffect(() => {
    setAnswer(''); setFailure(undefined); pendingAnswer.current = undefined
    if (questionKey) setNotice(undefined)
  }, [id, questionKey])

  const stopping = lifecycle?.stop.intent === 'stop'
  const paused = lifecycle?.pause.intent === 'pause'
  const checking = lifecycle?.reconciliation?.state === 'checking'
  const unknown = lifecycle?.reconciliation?.state === 'unknown'
  const held = stopping || paused || checking || unknown
  const canAct = enabled && !ended && !readOnly && !busy
  const action = async (kind: 'pause' | 'resume' | 'stop' | 'retry') => {
    if (submitting.current || readOnly || ended || !enabled) return
    if ((kind === 'resume' || kind === 'retry') && (stopping || checking || unknown)) return
    submitting.current = true; setBusy(true); setFailure(undefined); setNotice(undefined)
    try {
      // Do not turn an accepted request into an optimistic "paused" or "exited" state.
      if (kind === 'pause') await call('POST tickets/:id/pause', { id })
      else if (kind === 'resume') await call('POST tickets/:id/resume', { id })
      else if (kind === 'stop') await call('POST tickets/:id/stop', { id })
      else await call('POST tickets/:id/retry', { id })
      await reload()
    } catch (error) { setFailure(errorText(error)) }
    finally { submitting.current = false; setBusy(false) }
  }
  const submitAnswer = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting.current || readOnly || ended || !attention || !answer.trim()) return
    const key = questionKey, text = answer.trim(), requestKey = key + ':' + text
    const body = pendingAnswer.current?.key === requestKey ? pendingAnswer.current.body
      : { questionId: attention.id, version: attention.version ?? 1, text }
    pendingAnswer.current = { key: requestKey, body }
    submitting.current = true; setBusy(true); setFailure(undefined); setNotice(undefined)
    try {
      const result = await call('POST tickets/:id/attention', { id, body })
      await reload()
      if (currentQuestion.current === key || !currentQuestion.current) {
        setAnswer(''); pendingAnswer.current = undefined
        setNotice(t(result.resolved ? 'taskAnswerSaved' : 'taskAnswerNeedsCheck'))
      }
    } catch (error) {
      // Retain the exact question version and answer after an uncertain response.
      if (currentQuestion.current === key) setFailure(errorText(error))
    } finally { submitting.current = false; setBusy(false) }
  }
  if (!enabled && !lifecycle && !attention) return null
  const state = stopping ? lifecycle?.stop.state === 'exited' ? 'taskStopped' : 'taskStopping'
    : ended ? 'taskEnded' : checking ? 'taskReconciling' : unknown ? 'taskNeedsCheck'
      : paused ? lifecycle?.pause.state === 'paused' ? 'taskPaused' : 'taskPausing'
        : lifecycle?.observed.state === 'running' ? 'taskRunning'
          : lifecycle?.observed.state === 'idle' ? 'taskIdle'
            : lifecycle?.observed.state === 'ready' ? 'taskReady' : 'taskUnknown'
  const checkedAt = lifecycle?.reconciliation?.observedAt
    ?? (lifecycle?.observed.state !== 'unknown' ? lifecycle?.observed.at : undefined)
  const recordedAt = checkedAt ?? lifecycle?.observed.at
  return <section className="dt-task-lifecycle" aria-label={t('taskControl')}>
    {lifecycle && <div role="status">
      <p>{t(state)}</p>
      {paused && (checking || unknown) && <Hint>{t('taskPausePreserved')}</Hint>}
      {recordedAt && <p className="dt-hint">{t(checkedAt ? 'taskLastChecked' : 'taskLastKnown')}{t('labelSeparator')}
        <time dateTime={recordedAt}>{when(recordedAt, t('lang'))}</time></p>}
    </div>}
    {!ended && enabled && <div className="dt-banner-actions">
      {!stopping && !paused && <Button size="sm" disabled={!canAct} icon={<Icon name="pause" />}
        onClick={() => { void action('pause') }}>{t('taskPause')}</Button>}
      {!stopping && paused && <Button size="sm" disabled={!canAct || checking || unknown || lifecycle?.pause.state === 'pausing'} icon={<Icon name="play" />}
        onClick={() => { void action('resume') }}>{t('taskResume')}</Button>}
      {retryable && !held && <Button size="sm" disabled={!canAct} icon={<Icon name="refresh" />}
        onClick={() => { void action('retry') }}>{t('taskRetryExecution')}</Button>}
      {showStop && !stopping && <Button size="sm" disabled={!canAct} icon={<Icon name="stop" />}
        onClick={() => { void action('stop') }}>{t('taskStop')}</Button>}
    </div>}
    {paused && !ended && <Hint>{t('taskPausedAnswerHint')}</Hint>}
    {(checking || unknown) && !stopping && !ended && <Hint>{t('taskReconcileHint')}</Hint>}
    {attention && !ended && <form className="dt-banner" onSubmit={event => { void submitAnswer(event) }}>
      <strong>{t('taskQuestionVersion', { version: attention.version ?? 1 })}</strong>
      <MarkdownLite text={attention.question} />
      <label htmlFor={inputId}>{t('taskAnswer')}</label>
      <textarea id={inputId} className="dt-input" rows={3} value={answer} disabled={busy || readOnly}
        onChange={event => setAnswer(event.target.value)} />
      <Button size="sm" type="submit" disabled={busy || readOnly || !answer.trim()}>{t('taskSubmitAnswer')}</Button>
    </form>}
    {notice && <p role="status">{notice}</p>}
    {failure && <p role="alert" className="dt-error">{t('taskActionFailed')} {failure}</p>}
  </section>
}
