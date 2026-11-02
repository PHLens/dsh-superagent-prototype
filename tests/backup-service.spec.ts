import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackupService } from '../src/app/backup-service.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
let root: string | undefined
afterEach(async () => { await h?.stop(); h = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined })

it('deduplicates manual and scheduled recovery point creation and applies retention', async () => {
  h = await startRuntime()
  root = mkdtempSync(join(tmpdir(), 'dsh-backup-service-'))
  const db = h.runtime.store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file as string
  const service = new BackupService({ store: h.runtime.store, databasePath: db, destinationRoot: root, recovery: {}, health: (h.runtime as any).board.claim('backup-test'), lifetime: h.runtime.lifetime })
  service.start({ enabled: true, directory: root, intervalMinutes: 5, retention: 1 })
  const first = service.run('manual')
  expect(await service.run('schedule')).toBe(await first)
  expect((await first).database.walIncluded).toBe(true)
  service.stop()
})

it('replaces the scheduler and refuses work after stop', async () => {
  h = await startRuntime()
  root = mkdtempSync(join(tmpdir(), 'dsh-backup-service-'))
  const service = new BackupService({ store: h.runtime.store, databasePath: h.runtime.store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file as string,
    destinationRoot: root, recovery: {}, health: (h.runtime as any).board.claim('backup-test'), lifetime: h.runtime.lifetime })
  vi.useFakeTimers()
  service.start({ enabled: true, directory: root, intervalMinutes: 5, retention: 1 })
  service.start({ enabled: false, directory: root, intervalMinutes: 5, retention: 1 })
  service.stop()
  await expect(service.run('manual')).rejects.toThrow('stopped')
  vi.useRealTimers()
})
