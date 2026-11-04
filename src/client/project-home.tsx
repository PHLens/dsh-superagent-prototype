/** Project entry point; creation only needs a name and goal. */
import { useState, type FormEvent } from 'react'
import { usePoll } from './api.ts'
import { Button, Input } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, LoadState, Section } from './widgets.tsx'

export function ProjectHome() {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET projects/home'), [call])
  const [name, setName] = useState(''), [goal, setGoal] = useState('')
  const create = useAction(async () => {
    const { project } = await call('POST projects', { body: { name: name.trim(), goal: goal.trim() } })
    navigate({ page: 'projects', id: project.id })
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (name.trim() && goal.trim()) void create.run() }
  const statusLabel = (status: NonNullable<typeof data>['projects'][number]['status']) => t(status === 'needs-attention' ? 'projectStatusNeedsAttention'
    : status === 'running' ? 'projectStatusRunning' : status === 'coordinator-running' ? 'projectStatusCoordinatorRunning'
      : status === 'coordinator-error' ? 'projectStatusCoordinatorError' : status === 'paused' ? 'projectStatusPaused' : 'projectStatusIdle')
  const pendingLabel = (kind: NonNullable<typeof data>['pending'][number]['kind']) => t(kind === 'question' ? 'projectPendingQuestion'
    : kind === 'confirmation' ? 'projectPendingConfirmation' : kind === 'semantic-review' ? 'projectPendingReview'
      : kind === 'changes-required' ? 'projectPendingChanges' : kind === 'needs-judgment' ? 'projectPendingJudgment'
        : kind === 'blocked' ? 'executionBlocked' : kind === 'failed' ? 'executionFailed' : 'projectStatusCoordinatorError')
  return <>
    <Section title={t('projectPending')}>
      {!data ? <LoadState error={error} loading /> : <>
        {error && <LoadState error={error} loading={false} />}
        {data.pending.length ? <ul className="dt-list dt-project-pending">{data.pending.map(item => <li key={item.id} className="dt-row dt-link">
          <button className="dt-project-card" type="button" onClick={() => navigate({ page: 'projects', id: item.projectId,
            ...(item.ticketId ? { query: { ticket: item.ticketId } } : {}) })}>
            <span className="dt-tag" data-tone={item.kind === 'coordinator-error' || item.kind === 'changes-required' ? 'danger' : 'warning'}>{pendingLabel(item.kind)}</span>
            <strong>{item.projectName}</strong><span>{item.summary}</span>
            {item.taskTitle && <span className="dt-hint">{item.taskTitle}</span>}
          </button>
        </li>)}</ul> : <Hint>{t('projectPendingEmpty')}</Hint>}
      </>}
    </Section>
    <Section title={t('projectHome')}>
      {!data ? <LoadState error={error} loading /> : <>
        {error && <LoadState error={error} loading={false} />}
        {data.projects.length ? <ul className="dt-list dt-projects">{data.projects.map(item => <li key={item.project.id} className="dt-row dt-link">
          <button className="dt-project-card" type="button" aria-label={item.project.name} onClick={() => navigate({ page: 'projects', id: item.project.id })}>
            <span className="dt-tag" data-tone={item.status === 'coordinator-error' ? 'danger' : item.paused || item.status === 'needs-attention' ? 'warning' : item.status === 'running' || item.status === 'coordinator-running' ? 'info' : 'neutral'}>{statusLabel(item.status)}</span>
            <strong>{item.project.name}</strong><span className="dt-hint">{item.project.goal}</span>
            <span className="dt-row-meta">{t('projectRunningWorkers')} {item.runningAssignments}{item.pendingCount ? ` · ${t('projectPendingCount', { count: item.pendingCount })}` : ''}</span>
            {item.lastCheckedAt && <span className="dt-hint">{t('projectLastChecked')} {new Date(item.lastCheckedAt).toLocaleString()}</span>}
          </button>
        </li>)}</ul> : <Hint>{t('projectEmpty')}</Hint>}
      </>}
    </Section>
    <Section title={t('projectCreate')}>
      <form className="dt-form dt-block" onSubmit={submit}>
        <label>{t('projectName')}<Input required aria-label={t('projectName')} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>{t('projectGoal')}<Input required aria-label={t('projectGoal')} value={goal} onChange={event => setGoal(event.target.value)} /></label>
        <div><Button variant="primary" type="submit" disabled={create.busy || !name.trim() || !goal.trim()}>{t('projectCreateSubmit')}</Button></div>
      </form>
    </Section>
  </>
}
