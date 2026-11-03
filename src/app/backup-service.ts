/** Owns scheduled and manual recovery point creation without dispatching application work. */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRecoveryPoint, finalizeRecoveryPoint, restoreRecoveryPoint, verifyRecoveryPoint, type NativeSessionArchive, type RecoveryManifest, type RecoveryOptions } from './backup.ts'
import type { Store } from './store.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Settings } from '../policy.ts'

export interface BackupMaterialSnapshot {
  roots?: RecoveryOptions['roots']
  nativeSessions?: NativeSessionArchive[]
  expectedNativeSessionIds?: string[]
  relocations?: RecoveryOptions['relocations']
  consistency: 'database-only' | 'declared-files-best-effort' | 'declared-files-quiesced'
  verify?: () => Promise<void>
  release?: () => void
}
export interface BackupServiceOptions {
  store: Store
  databasePath: string
  destinationRoot: string
  recovery: Omit<RecoveryOptions, 'databasePath' | 'destination'>
  recoveryRoots?: () => RecoveryOptions['roots']
  prepareMaterials?: () => Promise<BackupMaterialSnapshot>
  applicationFull?: boolean
  health: HealthEntry
  lifetime: AbortSignal
  now?: () => Date
}

function completeApplicationPoint(manifest: RecoveryManifest, applicationFull = false): boolean {
  if (!applicationFull) return true
  const ids = manifest.coverage?.nativeSessionIds ?? []
  if (manifest.consistency !== 'declared-files-quiesced' || manifest.missing.length || manifest.incomplete.length) return false
  if (!manifest.coverage) return false
  return manifest.coverage.kind === 'application-full' && new Set(ids).size === ids.length
    && ids.length === manifest.nativeSessions?.length && ids.every(id => manifest.nativeSessions.some(session => session.id === id))
    && !!manifest.relocations?.some(mapping => mapping.path === '.')
}

/** Creates at most one recovery point at a time and replaces its scheduler on settings changes. */
export class BackupService {
  private timer?: ReturnType<typeof setInterval>
  private active?: Promise<RecoveryManifest>
  private stopped = false
  private settings?: Settings['backup']
  private readonly now: () => Date
  constructor(private readonly options: BackupServiceOptions) {
    this.now = options.now ?? (() => new Date())
    options.lifetime.addEventListener('abort', () => this.stop(), { once: true })
  }
  start(settings: Settings['backup']): void {
    this.stopTimer()
    this.settings = settings
    this.stopped = this.options.lifetime.aborted
    if (!settings.enabled || this.stopped) return
    const delay = settings.intervalMinutes * 60_000
    this.timer = setInterval(() => { void this.run('schedule').catch(() => {}) }, delay)
    this.timer.unref?.()
  }
  stop(): void { this.stopped = true; this.stopTimer() }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  private cancelled(): boolean { return this.stopped || this.options.lifetime.aborted }
  run(reason: 'manual' | 'schedule'): Promise<RecoveryManifest> {
    if (this.stopped || (reason === 'schedule' && !this.settings?.enabled)) return Promise.reject(new Error('Backup service is stopped or disabled'))
    if (this.active) return this.active
    const settings = this.settings
    if (!settings) return Promise.reject(new Error('Backup service is not configured'))
    const root = settings.directory || this.options.destinationRoot
    const destination = join(root, `${this.now().toISOString().replaceAll(':', '-')}-${reason}`)
    let materials: BackupMaterialSnapshot | undefined
    this.active = Promise.resolve().then(async () => {
      if (this.cancelled()) throw new Error('Backup service stopped before recovery point creation')
      materials = this.options.prepareMaterials ? await this.options.prepareMaterials() : undefined
      if (this.cancelled()) throw new Error('Backup service stopped while preparing recovery materials')
      const manifest = createRecoveryPoint(this.options.store, { ...this.options.recovery, roots: materials?.roots ?? this.options.recoveryRoots?.() ?? this.options.recovery.roots,
        nativeSessions: materials?.nativeSessions, relocations: materials?.relocations, coverage: materials?.expectedNativeSessionIds !== undefined ? { kind: 'application-full', nativeSessionIds: materials.expectedNativeSessionIds } : undefined, consistency: materials?.consistency, complete: false, databasePath: this.options.databasePath, destination })
      if (this.cancelled()) throw new Error('Backup service stopped during recovery point creation')
      await materials?.verify?.()
      if (this.cancelled()) throw new Error('Backup service stopped during final material verification')
      if (materials?.consistency === 'declared-files-quiesced' && manifest.consistency !== 'declared-files-quiesced') throw new Error('Recovery materials changed or were incomplete during capture')
      verifyRecoveryPoint(destination, manifest, { allowIncompleteMarker: true })
      finalizeRecoveryPoint(destination, manifest)
      this.options.health.set({ state: 'ready', detail: `Recovery point created at ${destination}` })
      this.retain(root, settings.retention, destination)
      return manifest
    }).catch(error => {
      materials?.release?.()
      this.options.health.set({ state: 'error', detail: error instanceof Error ? error.message : String(error) })
      throw error
    }).finally(() => { materials?.release?.(); this.active = undefined })
    return this.active
  }
  private retain(root: string, retention: number, keep: string): void {
    if (!existsSync(root)) return
    const points = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)).filter(point => {
      try { return completeApplicationPoint(verifyRecoveryPoint(point), this.options.applicationFull) } catch { return false }
    }).sort().reverse()
    for (const point of points.slice(retention)) if (point !== keep) rmSync(point, { recursive: true, force: true })
  }
  restore(source: string, destination: string): RecoveryManifest {
    if (!completeApplicationPoint(verifyRecoveryPoint(source), this.options.applicationFull)) throw new Error('Partial recovery points cannot be restored as complete application recovery points')
    return restoreRecoveryPoint(source, destination)
  }
  status(): { configured: boolean; running: boolean; health?: ReturnType<HealthEntry['get']> } { return { configured: !!this.settings, running: !!this.active, health: this.options.health.get() } }
  list(): Array<{ path: string; createdAt: string; bytes: number; consistency: RecoveryManifest['consistency']; complete: boolean }> {
    const root = this.settings?.directory || this.options.destinationRoot
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
      const path = join(root, entry.name)
      try { const manifest = verifyRecoveryPoint(path); if (!completeApplicationPoint(manifest, this.options.applicationFull)) return []; return [{ path, createdAt: manifest.createdAt, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), consistency: manifest.consistency, complete: true }] } catch { return [] }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}
