/** Project entry point; creation only needs a name and goal. */
import { useState, type FormEvent } from 'react'
import { usePoll } from './api.ts'
import { Button, Input } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, LoadState, Section } from './widgets.tsx'

export function ProjectHome() {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET projects'), [call])
  const [name, setName] = useState(''), [goal, setGoal] = useState('')
  const create = useAction(async () => {
    const { project } = await call('POST projects', { body: { name: name.trim(), goal: goal.trim() } })
    navigate({ page: 'projects', id: project.id })
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (name.trim() && goal.trim()) void create.run() }
  return <>
    <Section title={t('projectHome')}>
      {!data ? <LoadState error={error} loading /> : <>
        {error && <LoadState error={error} loading={false} />}
        {data.projects.length ? <ul className="dt-list dt-projects">{data.projects.map(project => <li key={project.id} className="dt-row dt-link">
          <button className="dt-project-card" type="button" aria-label={project.name} onClick={() => navigate({ page: 'projects', id: project.id })}>
            <strong>{project.name}</strong><span className="dt-hint">{project.goal}</span>
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
