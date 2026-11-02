/** Owns scheduled and manual recovery point creation without dispatching application work. */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRecoveryPoint, restoreRecoveryPoint, type RecoveryManifest, type RecoveryOptions } from './backup.ts'
import type { Store } from './store.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Settings } from '../policy.ts'

export interface BackupServiceOptions {
  store: Store
  databasePath: string
  destinationRoot: string
  recovery: Omit<RecoveryOptions, 'databasePath' | 'destination'>
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
    this.stopped = false
    if (!settings.enabled) return
    const delay = settings.intervalMinutes * 60_000
    this.timer = setInterval(() => { void this.run('schedule').catch(() => {}) }, delay)
    this.timer.unref?.()
  }
  stop(): void { this.stopped = true; this.stopTimer() }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  run(reason: 'manual' | 'schedule'): Promise<RecoveryManifest> {
    if (this.stopped || (reason === 'schedule' && !this.settings?.enabled)) return Promise.reject(new Error('Backup service is stopped or disabled'))
    if (this.active) return this.active
    const settings = this.settings
    if (!settings) return Promise.reject(new Error('Backup service is not configured'))
    const root = settings.directory || this.options.destinationRoot
    const destination = join(root, `${this.now().toISOString().replaceAll(':', '-')}-${reason}`)
    this.active = Promise.resolve().then(() => {
      const manifest = createRecoveryPoint(this.options.store, { ...this.options.recovery, databasePath: this.options.databasePath, destination })
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
    const points = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)).sort().reverse()
    for (const point of points.slice(retention)) if (point !== keep) rmSync(point, { recursive: true, force: true })
  }
  restore(source: string, destination: string): RecoveryManifest { return restoreRecoveryPoint(source, destination) }
}
