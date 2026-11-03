/** Owns scheduled and manual recovery point creation without dispatching application work. */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRecoveryPoint, restoreRecoveryPoint, verifyRecoveryPoint, type RecoveryManifest, type RecoveryOptions } from './backup.ts'
import type { Store } from './store.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Settings } from '../policy.ts'

export interface BackupServiceOptions {
  store: Store
  databasePath: string
  destinationRoot: string
  recovery: Omit<RecoveryOptions, 'databasePath' | 'destination'>
  recoveryRoots?: () => RecoveryOptions['roots']
  health: HealthEntry
  lifetime: AbortSignal
  now?: () => Date
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
    this.active = Promise.resolve().then(() => {
      if (this.cancelled()) throw new Error('Backup service stopped before recovery point creation')
      const manifest = createRecoveryPoint(this.options.store, { ...this.options.recovery, roots: this.options.recoveryRoots?.() ?? this.options.recovery.roots, databasePath: this.options.databasePath, destination })
      if (this.cancelled()) { rmSync(destination, { recursive: true, force: true }); throw new Error('Backup service stopped during recovery point creation') }
      verifyRecoveryPoint(destination, manifest)
      this.options.health.set({ state: 'ready', detail: `Recovery point created at ${destination}` })
      this.retain(root, settings.retention, destination)
      return manifest
    }).catch(error => {
      this.options.health.set({ state: 'error', detail: error instanceof Error ? error.message : String(error) })
      throw error
    }).finally(() => { this.active = undefined })
    return this.active
  }
  private retain(root: string, retention: number, keep: string): void {
    if (!existsSync(root)) return
    const points = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)).filter(point => {
      try { verifyRecoveryPoint(point); return true } catch { return false }
    }).sort().reverse()
    for (const point of points.slice(retention)) if (point !== keep) rmSync(point, { recursive: true, force: true })
  }
  restore(source: string, destination: string): RecoveryManifest { return restoreRecoveryPoint(source, destination) }
  status(): { configured: boolean; running: boolean; health?: ReturnType<HealthEntry['get']> } { return { configured: !!this.settings, running: !!this.active, health: this.options.health.get() } }
  list(): Array<{ path: string; createdAt: string; bytes: number }> {
    const root = this.settings?.directory || this.options.destinationRoot
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
      const path = join(root, entry.name)
      try { const manifest = verifyRecoveryPoint(path); return [{ path, createdAt: manifest.createdAt, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) }] } catch { return [] }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}
