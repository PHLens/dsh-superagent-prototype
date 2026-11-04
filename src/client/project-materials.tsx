/** Project-owned knowledge and explicitly registered materials. */
import { useState } from 'react'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import type { ResourceSnapshot } from '../app/project-resources.ts'
export function ProjectMaterials({ id, readOnly }: { id: string; readOnly: boolean }) {
  const { call } = usePanel()
  const { data, reload, error } = usePoll(() => call('GET projects/:id/materials', { id }), [call, id], 5000)
  const [failure, setFailure] = useState(''), [busy, setBusy] = useState(false)
  const [title, setTitle] = useState(''), [content, setContent] = useState(''), [path, setPath] = useState(''), [purpose, setPurpose] = useState('code-source'), [type, setType] = useState<'directory' | 'file' | 'repository' | 'attachment'>('directory')
  const [repository, setRepository] = useState(''), [gitName, setGitName] = useState(''), [gitEmail, setGitEmail] = useState('')
  const [maxBytes, setMaxBytes] = useState('1000000')
  const [page, setPage] = useState<ResourceSnapshot>(), [preview, setPreview] = useState('')
  // A pending submit freezes both its operation id and payload. Retrying unchanged input reuses
  // them (so a committed-but-lost response is a replay, not a second write); changing any input is
  // a new user intent and gets a new id.
  const [pendingKnowledge, setPendingKnowledge] = useState<{ operationId: string; title: string; content: string }>()
  const [pendingResource, setPendingResource] = useState<{ operationId: string; payload: Record<string, unknown> }>()
  const operation = () => crypto.randomUUID()
  /** Fetches the authenticated download and saves it under the browser-visible name. */
  const save = async (resourceId: string, path: string, version: string, name: string) => {
    const query = new URLSearchParams({ path, version })
    const response = await fetch(`/orchestrator/api/projects/${encodeURIComponent(id)}/resources/${encodeURIComponent(resourceId)}/download?${query}`,
      { headers: { 'x-orchestrator-request': '1' } })
    if (!response.ok) throw new Error((await response.text()) || `Download failed (${response.status})`)
    const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a')
    anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url)
  }
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setFailure(''); try { await action(); await reload() } catch (error) { setFailure(errorText(error)) } finally { setBusy(false) } }
  const PAGE = 100
  const browse = (resourceId: string, path = '', offset = 0, snapshot?: ResourceSnapshot) => run(async () => {
    setPreview(''); setPage(await call('POST projects/:id/resources/:resourceId/browse', { id, resourceId,
      body: { path, offset, limit: PAGE, ...(offset && snapshot ? { snapshot } : {}) } }))
  })
  return <details><summary>Project knowledge and materials</summary>
    {(failure || error) && <p role="alert">{failure || errorText(error)}</p>}
    <form onSubmit={event => { event.preventDefault(); const same = pendingKnowledge?.title === title && pendingKnowledge?.content === content
      const operationId = same ? pendingKnowledge.operationId : operation(); setPendingKnowledge({ operationId, title, content })
      void run(async () => { await call('POST projects/:id/knowledge', { id, body: { kind: 'note', title, content, source: { kind: 'import' }, operationId } }); setPendingKnowledge(undefined); setTitle(''); setContent('') }) }}>
      <label>Knowledge title<input value={title} onChange={event => setTitle(event.target.value)} disabled={readOnly || busy} required /></label>
      <label>Content<textarea value={content} onChange={event => setContent(event.target.value)} disabled={readOnly || busy} required /></label><button disabled={readOnly || busy}>Propose knowledge version</button>
    </form>
    <ul>{data?.knowledge.map(item => <li key={item.id}><strong>{item.title}</strong> v{item.version} · {item.state}<pre>{item.content}</pre><small>Source: {item.source.kind} {item.source.id}</small>{item.state === 'proposed' && <button disabled={readOnly || busy} onClick={() => void run(() => call('POST projects/:id/knowledge/:knowledgeId/confirm', { id, knowledgeId: item.id, body: { operationId: `knowledge-confirm:${item.id}` } }))}>Confirm version</button>}</li>)}</ul>
    <form onSubmit={event => { event.preventDefault(); const body = { type, path, purpose, maxBytes: Number(maxBytes), ...(type === 'repository' && repository.trim() ? { identity: { repository: repository.trim(), gitAuthorName: gitName.trim(), gitAuthorEmail: gitEmail.trim() } } : {}) }
      const same = pendingResource && JSON.stringify(pendingResource.payload) === JSON.stringify(body)
      const operationId = same ? pendingResource.operationId : operation(); setPendingResource({ operationId, payload: body })
      void run(async () => { await call('POST projects/:id/resources', { id, body: { ...body, operationId } }); setPendingResource(undefined); setPath(''); setPurpose('code-source') }) }}>
      <label>Registered path<input value={path} onChange={event => setPath(event.target.value)} disabled={readOnly || busy} required /></label>
      <label>Resource type<select value={type} onChange={event => setType(event.target.value as typeof type)} disabled={readOnly || busy}><option value="directory">Directory</option><option value="repository">Repository</option><option value="file">File</option><option value="attachment">Attachment</option></select></label>
      <label>Purpose<select value={purpose} onChange={event => setPurpose(event.target.value)} disabled={readOnly || busy}><option value="code-source">Code source</option><option value="code-config">Code configuration</option><option value="code-runtime">Code interpreter</option><option value="repository">Repository</option><option value="context">Context</option></select></label>
      <label>Max bytes<input type="number" min={1} max={16000000} step={1} value={maxBytes} onChange={event => setMaxBytes(event.target.value)} disabled={readOnly || busy} required /></label>
      {type === 'repository' && <><label>GitHub repository<input value={repository} onChange={event => setRepository(event.target.value)} placeholder="owner/name" disabled={readOnly || busy} /></label>
        <label>Git author name<input value={gitName} onChange={event => setGitName(event.target.value)} disabled={readOnly || busy} /></label>
        <label>Git author email<input value={gitEmail} onChange={event => setGitEmail(event.target.value)} disabled={readOnly || busy} /></label></>}
      <button disabled={readOnly || busy}>Register resource</button>
    </form>
    <ul>{data?.resources.map(item => <li key={item.id}>{item.purpose} · {item.type} · {item.revoked ? 'revoked' : 'active'}{!item.revoked && <><button disabled={busy} onClick={() => void browse(item.id)}>Browse</button><button disabled={readOnly || busy} onClick={() => void run(async () => { await call('POST projects/:id/resources/:resourceId/revoke', { id, resourceId: item.id, body: { operationId: operation() } }); setPage(undefined); setPreview('') })}>Revoke access</button></>}</li>)}</ul>
    {page && <div><p>{page.path || '/'} · version {page.version.slice(0, 12)}{page.total != null && <span> · {(page.offset ?? 0) + 1}–{(page.offset ?? 0) + page.entries.length} of {page.total}</span>}</p><ul>{page.entries.map(item => <li key={item.path}><button disabled={busy} onClick={() => { if (item.kind === 'directory') void browse(page.resourceId, item.path); else void run(async () => setPreview((await call('GET projects/:id/resources/:resourceId/preview', { id, resourceId: page.resourceId, query: { path: item.path, version: item.version } })).content)) }}>{item.name}</button> {item.bytes} bytes
              {item.kind === 'file' && <button disabled={busy} onClick={() => void run(() => save(page.resourceId, item.path, item.version, item.name))}>Download</button>}</li>)}</ul><p><button disabled={busy || !page.offset} onClick={() => void browse(page.resourceId, page.path, Math.max(0, (page.offset ?? 0) - PAGE), page)}>Previous</button>
          <button disabled={busy || page.next_offset == null} onClick={() => void browse(page.resourceId, page.path, page.next_offset!, page)}>Next</button></p></div>}
    {preview && <pre>{preview}</pre>}
  </details>
}
