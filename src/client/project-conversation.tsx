/** Database-backed project history. Streaming drafts and unsent input never appear as saved messages. */
import { useRef, useState, type FormEvent } from 'react'
import { usePoll } from './api.ts'
import { Button, Icon } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'

export function ProjectConversation({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET projects/:id/conversation', { id }), [call, id], 1000)
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string>()
  const pending = useRef<{ requestId: string; text: string }>(undefined)
  const submitting = useRef(false)
  const retry = useAction(() => call('POST projects/:id/retry', { id }), { reload })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting.current || !text.trim()) return
    submitting.current = true; setBusy(true); setFailure(undefined)
    // Keep the exact request after an ambiguous network failure. Editing starts a new user intent.
    const request = pending.current?.text === text.trim() ? pending.current : { requestId: crypto.randomUUID(), text: text.trim() }
    pending.current = request
    try {
      await call('POST projects/:id/messages', { id, body: request })
      pending.current = undefined; setText(''); await reload()
    } catch (error) { setFailure(errorText(error)) }
    finally { submitting.current = false; setBusy(false) }
  }
  if (!data) return <LoadState error={error} loading />
  // The keyed route also remounts this component; check ownership before displaying server data.
  if (data.project.id !== id) return <LoadState loading />
  return <div className="dt-conversation">
    <div><Button size="sm" icon={<Icon name="chevron-left" />} onClick={() => navigate({ page: 'projects' })}>{t('tab.projects')}</Button></div>
    <header><h2>{data.project.name}</h2><p className="dt-hint">{t('projectGoalPrefix')}{data.project.goal}</p></header>
    {error && <LoadState error={error} loading={false} />}
    {data.coordinator?.status === 'error' && <div className="dt-banner dt-danger" role="alert">
      <p>{t('conversationCoordinatorError')}</p>{data.coordinator.error && <p>{data.coordinator.error}</p>}
      <Button variant="outline" disabled={retry.busy} onClick={() => { void retry.run() }}>{t('conversationRetry')}</Button>
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
    <form className="dt-conversation-compose" onSubmit={event => { void submit(event) }}>
      <label htmlFor="dt-project-message" className="dt-hint">{t('conversationLocalDraft')}</label>
      <textarea id="dt-project-message" className="dt-input" rows={4} required value={text} disabled={busy}
        placeholder={t('conversationPlaceholder')} onChange={event => setText(event.target.value)} />
      {failure && <p className="dt-error" role="alert">{t('conversationSaveError')} {failure}</p>}
      <div><Button variant="primary" type="submit" disabled={busy || !text.trim()}>{t(busy ? 'conversationSending' : failure ? 'conversationRetry' : 'conversationSend')}</Button></div>
    </form>
  </div>
}
