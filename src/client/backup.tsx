/** Versioned backup settings and an honest view of the instance's backup service. */
import { useState } from 'react'
import { Button, Input, Switch } from './controls.tsx'
import { usePoll } from './api.ts'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { ConfigHistory, Field, Fields, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { errorText, when } from './text.ts'
import { Hint } from './widgets.tsx'

export function BackupSettings() {
  const { t } = usePanel()
  const { state } = usePanelData()
  const readOnly = !state || !!state.safeRestore
  const block = useSettings().settings.blocks.backup
  const saved = { ...block.value, intervalMinutes: String(block.value.intervalMinutes), retention: String(block.value.retention) }
  const draft = useBlockDraft('backup', saved, block.revision, value => ({
    ...value, intervalMinutes: numberOf(value.intervalMinutes), retention: numberOf(value.retention),
  }))
  const value = readOnly ? saved : draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const health = state?.health.backup
  const serviceLabel = readOnly ? 'backupRecoveryDisabled' : !block.value.enabled ? 'backupAutomaticOff'
    : health?.state === 'error' ? 'backupServiceError' : health?.state === 'ready' ? 'backupServiceReady' : 'backupAutomaticOn'
  const defaultDirectory = state ? state.setup.machine.stateDir.replace(/\/$/, '') + '/backups' : t('backupDirectoryDefault')
  return <div className="dt-form">
    <Hint>{t('backupIntro')}</Hint>
    {state?.safeRestore && <Hint>{t('recoveryReadOnly')}</Hint>}
    <section aria-label={t('backupStatus')}>
      <h3>{t('backupStatus')}</h3>
      <p role="status">{t(serviceLabel)}</p>
      {!block.value.directory ? <Hint>{t('backupLocalOnly', { directory: defaultDirectory })}</Hint>
        : <p>{t('backupConfiguredDirectory')}{t('labelSeparator')}<span className="dt-mono">{block.value.directory}</span></p>}
      {health?.detail && <p className={health.state === 'error' ? 'dt-error' : 'dt-hint'}>{health.detail}</p>}
      {health?.at && <p className="dt-hint">{t('backupStatusUpdated')}{t('labelSeparator')}<time dateTime={health.at}>{when(health.at, t('lang'))}</time></p>}
    </section>
    <form className="dt-form" onSubmit={event => {
      if (readOnly) { event.preventDefault(); return }
      void draft.submit(event)
    }}>
      <Fields disabled={draft.busy || readOnly}>
        <div className="dt-switch-row">
          <span>{t('backupAutomatic')}</span>
          <Switch checked={value.enabled} label={t('backupAutomatic')} onChange={enabled => { if (!readOnly) edit({ enabled }) }} />
        </div>
        <Field label={t('backupDirectory')} hint={t('backupDirectoryHint')}>
          <Input value={value.directory} spellCheck={false} pattern="/.*" placeholder={t('backupDirectoryDefault')}
            onChange={event => edit({ directory: event.target.value })} />
        </Field>
        <Field label={t('backupInterval')} hint={t('backupIntervalHint')}>
          <Input type="number" min={5} max={43_200} required value={value.intervalMinutes}
            onChange={event => edit({ intervalMinutes: event.target.value })} />
        </Field>
        <Field label={t('backupRetention')} hint={t('backupRetentionHint')}>
          <Input type="number" min={1} max={365} required value={value.retention}
            onChange={event => edit({ retention: event.target.value })} />
        </Field>
      </Fields>
      {!readOnly && <SaveBar {...draft} onDiscard={draft.discard} />}
    </form>
    <BackupOperations readOnly={readOnly} revision={block.revision} />
    <ConfigHistory blocks={['backup']} />
  </div>
}

/** Operations always reload server receipts; saved settings, rather than the draft, select the destination. */
function BackupOperations({ readOnly, revision }: { readOnly: boolean; revision: number }) {
  const { call, t } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(async () => {
    const [status, result] = await Promise.all([call('GET backup/status'), call('GET backup/points')])
    return { status, points: result.points }
  }, [call, revision, restarts])
  const [source, setSource] = useState('')
  const [destination, setDestination] = useState('')
  const [created, setCreated] = useState<string>()
  const [restored, setRestored] = useState<string>()
  const create = useAction(async () => {
    if (readOnly) return
    const result = await call('POST backup/create')
    setCreated(result.manifest.createdAt)
  }, { reload })
  const restore = useAction(async () => {
    if (readOnly || !source || !destination.trim()) return
    const result = await call('POST backup/restore', { body: { source, destination: destination.trim() } })
    setRestored(result.manifest.restoredProfile.isolatedRoot)
  }, { reload })
  const busy = create.busy || restore.busy || !!data?.status.running
  return <section className="dt-form" aria-label={t('backupPoints')}>
    <h3>{t('backupPoints')}</h3>
    {error && <p role="alert" className="dt-error">{errorText(error)}</p>}
    {data?.status.running && <p role="status">{t('backupCreating')}</p>}
    <div className="dt-row-actions">
      <Button variant="outline" onClick={() => { void reload().catch(() => {}) }}>{t('backupRefresh')}</Button>
      {!readOnly && <Button disabled={busy || !data?.status.configured} onClick={() => { void create.run() }}>{t('backupCreate')}</Button>}
    </div>
    {created && <p role="status">{t('backupCreated', { at: when(created, t('lang')) })}</p>}
    {data && !data.points.length && <Hint>{t('backupPointsEmpty')}</Hint>}
    {data && data.points.length > 0 && <ul className="dt-list">{data.points.map(point => <li key={point.path}>
      <time dateTime={point.createdAt}>{when(point.createdAt, t('lang'))}</time> · {point.bytes.toLocaleString()} bytes
      <p className="dt-mono">{point.path}</p>
      {!readOnly && <Button variant="outline" disabled={busy} onClick={() => { setSource(point.path); setRestored(undefined) }}>{t('backupChooseRestore')}</Button>}
    </li>)}</ul>}
    {!readOnly && source && <form className="dt-form" aria-label={t('backupRestore')} onSubmit={event => {
      event.preventDefault(); void restore.run()
    }}>
      <Hint>{t('backupRestoreHint')}</Hint>
      <p className="dt-mono">{source}</p>
      <Fields disabled={busy}>
        <Field label={t('backupRestoreDirectory')} hint={t('backupRestoreDirectoryHint')}>
          <Input required pattern="/.*" value={destination} onChange={event => { setDestination(event.target.value); setRestored(undefined) }} />
        </Field>
      </Fields>
      <Button type="submit" disabled={busy || !destination.trim()}>{t('backupRestore')}</Button>
    </form>}
    {restored && <p role="status">{t('backupRestored', { directory: restored })}</p>}
  </section>
}
