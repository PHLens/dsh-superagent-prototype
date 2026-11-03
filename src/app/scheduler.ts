/** Fair scheduler for model, worker, and background slots. Waiting is explicit and deterministic. */
export interface SchedulerJob { id: string; projectId: string; kind: 'model' | 'worker' | 'background'; run: () => Promise<void> }
export interface SchedulerOptions { total: number; perProject?: number; now?: () => string }
export interface SchedulerStatus { id: string; projectId: string; kind: SchedulerJob['kind']; state: 'queued' | 'running' | 'finished'; waitingReason?: 'global-budget' | 'project-fairness' }
/** Queues bounded project jobs and exposes explicit budget and fairness waits. */
export class ProjectScheduler {
  private readonly queue: SchedulerJob[] = []
  private readonly active = new Map<string, SchedulerJob>()
  private readonly statusRows = new Map<string, SchedulerStatus>()
  private readonly perProject: number
  private pumping = false
  constructor(private readonly options: SchedulerOptions) {
    if (!Number.isSafeInteger(options.total) || options.total < 1) throw new Error('Scheduler budget must be positive')
    this.perProject = options.perProject ?? options.total
  }
  enqueue(job: SchedulerJob): SchedulerStatus {
    if (this.statusRows.has(job.id)) return this.statusRows.get(job.id)!
    if (!job.id || !job.projectId) throw new Error('Scheduler job identity required')
    const status: SchedulerStatus = { id: job.id, projectId: job.projectId, kind: job.kind, state: 'queued' }
    this.queue.push(job); this.statusRows.set(job.id, status); void this.pump(); return status
  }
  status(): SchedulerStatus[] { return [...this.statusRows.values()].map(item => structuredClone(item)) }
  async idle(): Promise<void> { while (this.queue.length || this.active.size) await new Promise(resolve => setTimeout(resolve, 0)) }
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length && this.active.size < this.options.total) {
        const projectCounts = new Map<string, number>()
        for (const job of this.active.values()) projectCounts.set(job.projectId, (projectCounts.get(job.projectId) ?? 0) + 1)
        const index = this.queue.findIndex(job => (projectCounts.get(job.projectId) ?? 0) < this.perProject)
        if (index < 0) { for (const job of this.queue) this.statusRows.get(job.id)!.waitingReason = 'project-fairness'; break }
        const job = this.queue.splice(index, 1)[0]!
        const status = this.statusRows.get(job.id)!; status.state = 'running'; delete status.waitingReason; this.active.set(job.id, job)
        void job.run().catch(() => undefined).finally(() => { this.active.delete(job.id); const finished = this.statusRows.get(job.id)!; finished.state = 'finished'; void this.pump() })
      }
      if (this.queue.length && this.active.size >= this.options.total) for (const job of this.queue) if (!this.statusRows.get(job.id)!.waitingReason) this.statusRows.get(job.id)!.waitingReason = 'global-budget'
    } finally { this.pumping = false }
  }
}
