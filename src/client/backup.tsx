/** Versioned backup settings and an honest view of the instance's backup service. */
import { Input, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { ConfigHistory, Field, Fields, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { when } from './text.ts'
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
    <ConfigHistory blocks={['backup']} />
  </div>
}
