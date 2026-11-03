// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, at, mount, remount, click, field, type, text, all, find, settle } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it.each([zh, en])('saves backup configuration through its versioned block and keeps local-only status explicit (%#)', async dictionary => {
  at({ page: 'settings', query: { group: 'backup' } })
  await mount(dictionary)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(dictionary['settingsGroup.backup'])
  expect(text()).toContain(dictionary.backupAutomaticOff)
  expect(text()).toContain(dictionary.backupLocalOnly.split('{directory}')[0]!)
  expect(field<HTMLInputElement>(dictionary.backupInterval).value).toBe('1440')
  expect(field<HTMLInputElement>(dictionary.backupRetention).value).toBe('7')
  await click(find(dictionary.backupAutomatic, '[role="switch"]'))
  await type(field<HTMLInputElement>(dictionary.backupDirectory), '/backup-volume/project-recovery')
  await type(field<HTMLInputElement>(dictionary.backupInterval), '720')
  await type(field<HTMLInputElement>(dictionary.backupRetention), '14')
  expect(server.requests.some(request => request.method === 'PUT')).toBe(false)
  await click(dictionary.save)
  expect(server.requests.find(request => request.path === 'settings/backup')?.body).toEqual({
    revision: 0, value: { enabled: true, directory: '/backup-volume/project-recovery', intervalMinutes: 720, retention: 14 },
  })
  expect(server.settings.backup).toEqual({ enabled: true, directory: '/backup-volume/project-recovery', intervalMinutes: 720, retention: 14 })
  await remount(dictionary)
  expect(text()).toContain(dictionary.backupAutomaticOn)
  expect(text()).toContain('/backup-volume/project-recovery')
})

it('retains a backup draft after a revision conflict instead of silently replacing newer configuration', async () => {
  at({ page: 'settings', query: { group: 'backup' } })
  await mount(en)
  await type(field<HTMLInputElement>(en.backupDirectory), '/my-unsaved-destination')
  server.settings.backup = { ...server.settings.backup, directory: '/changed-elsewhere' }
  server.revisions.backup = 1
  await click(en.save)
  expect(server.settings.backup.directory).toBe('/changed-elsewhere')
  expect(field<HTMLInputElement>(en.backupDirectory).value).toBe('/my-unsaved-destination')
  expect(server.requests.find(request => request.path === 'settings/backup')?.body).toMatchObject({ revision: 0 })
})

it('shows archived backup settings in read-only recovery and never submits a retained local draft', async () => {
  server.backupPoints = [{ path: '/archived/point', createdAt: '2026-11-03T00:00:00Z', bytes: 123 }]
  at({ page: 'settings', query: { group: 'backup' } })
  await mount(zh)
  await type(field<HTMLInputElement>(zh.backupDirectory), '/unsaved-live-instance-path')
  const actual = globalThis.fetch, writes: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'PUT' || init?.method === 'POST') writes.push(url)
    const result = await actual(input, init)
    if (url.endsWith('/state')) return new Response(JSON.stringify({ ...JSON.parse(await result.text()), safeRestore: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    return result
  })
  await remount(zh)
  expect(text()).toContain(zh.backupRecoveryDisabled)
  expect(text()).toContain(zh.recoveryReadOnly)
  expect(field<HTMLInputElement>(zh.backupDirectory).value).toBe('')
  expect(field<HTMLInputElement>(zh.backupDirectory).matches(':disabled')).toBe(true)
  expect(all('button').some(button => button.textContent === zh.save)).toBe(false)
  expect(all('button').some(button => [zh.backupCreate, zh.backupChooseRestore, zh.backupRestore].includes(button.textContent ?? ''))).toBe(false)
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await settle()
  expect(writes).toEqual([])
})

it('creates a recovery point with saved settings and restores the selected point only after a destination is supplied', async () => {
  at({ page: 'settings', query: { group: 'backup' } })
  await mount(en)
  expect(text()).toContain(en.backupPointsEmpty)
  await type(field<HTMLInputElement>(en.backupDirectory), '/unsaved-backup-draft')
  await click(en.backupCreate)
  expect(server.requests.find(request => request.path === 'backup/create')).toMatchObject({ method: 'POST' })
  expect(server.requests.some(request => request.path === 'settings/backup')).toBe(false)
  expect(text()).toContain('/srv/dsh-superagent/backups/point-1')
  await click(en.backupChooseRestore)
  expect(server.requests.some(request => request.path === 'backup/restore')).toBe(false)
  await type(field<HTMLInputElement>(en.backupRestoreDirectory), '/recovery/preview-1')
  await click(en.backupRestore)
  expect(server.requests.find(request => request.path === 'backup/restore')?.body).toEqual({
    source: '/srv/dsh-superagent/backups/point-1', destination: '/recovery/preview-1',
  })
  expect(text()).toContain(en.backupRestored.replace('{directory}', '/recovery/preview-1'))
})

it('preserves the selected recovery point and destination after a restore failure', async () => {
  server.backupPoints = [{ path: '/backups/point-1', createdAt: '2026-11-03T00:00:00Z', bytes: 123 }]
  const actual = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/backup/restore')) return new Response(JSON.stringify({ error: 'Restore destination already exists' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })
    return actual(input, init)
  })
  at({ page: 'settings', query: { group: 'backup' } })
  await mount(en)
  await click(en.backupChooseRestore)
  await type(field<HTMLInputElement>(en.backupRestoreDirectory), '/existing-directory')
  await click(en.backupRestore)
  expect(text()).toContain('Restore destination already exists')
  expect(field<HTMLInputElement>(en.backupRestoreDirectory).value).toBe('/existing-directory')
  expect(text()).toContain('/backups/point-1')
  expect(text()).not.toContain(en.backupRestored.split('{directory}')[0]!)
})
