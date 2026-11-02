/** Project identity and draft ticket service. Confirmation and execution belong to T3. */
import { UserError } from './errors.ts'
import { key } from './ids.ts'
import type { Mandate, Project, Ticket } from './model.ts'
import type { ProjectRepositories } from './ports.ts'

export interface ProjectServiceOptions { repo: ProjectRepositories; now?: () => string; id?: () => string }
export interface CreateProject { name: string; goal: string; directory?: string }
export interface UpdateProject { name?: string; goal?: string; directory?: string | null }

const clean = (value: string): string => value.trim()
const defaultId = (): string => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : key('project', Date.now().toString(36), Math.random().toString(36))
const defaultNow = (): string => new Date().toISOString()

/** Owns stable project identity and project-scoped draft Tickets without granting execution authority. */
export class Projects {
  private readonly now: () => string
  private readonly makeId: () => string
  constructor(private readonly options: ProjectServiceOptions) {
    this.now = options.now ?? defaultNow
    this.makeId = options.id ?? defaultId
  }
  create(input: CreateProject): Project {
    const name = clean(input.name), goal = clean(input.goal)
    if (!name || !goal) throw new UserError('invalidProject')
    const at = this.now(), project: Project = { id: this.makeId(), name, goal, ...(input.directory ? { directory: clean(input.directory) } : {}), createdAt: at, updatedAt: at }
    this.options.repo.projects.save(project)
    return project
  }
  get(id: string): Project {
    const project = this.options.repo.projects.get(id)
    if (!project) throw new UserError('unknownProject')
    return project
  }
  list(): Project[] { return this.options.repo.projects.list() }
  update(id: string, patch: UpdateProject): Project {
    const current = this.get(id)
    const name = patch.name === undefined ? current.name : clean(patch.name)
    const goal = patch.goal === undefined ? current.goal : clean(patch.goal)
    if (!name || !goal) throw new UserError('invalidProject')
    const project: Project = { ...current, name, goal, updatedAt: this.now(), ...(patch.directory === null ? {} : patch.directory === undefined ? {} : { directory: clean(patch.directory) }) }
    if (patch.directory === null) delete project.directory
    this.options.repo.projects.save(project)
    return project
  }
  createDraft(projectId: string, input: { title: string }): Ticket {
    const project = this.get(projectId), title = clean(input.title)
    if (!title) throw new UserError('invalidProject')
    const at = this.now(), mandate: Mandate = { strength: 'explicit', policyVersion: 'project-draft', basis: { via: 'listed' }, actor: { source: 'project', id: project.id }, scope: 'project-draft', projectDraft: { projectId } }
    const ticket: Ticket = { id: this.makeId(), title, decisionId: `project-draft:${project.id}`, mandate, projectId, projectStage: 'draft', channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: `project-draft:${project.id}`, triggerIds: [] } }
    this.options.repo.tickets.save(ticket)
    return ticket
  }
  ticket(projectId: string, ticketId: string): Ticket {
    const project = this.get(projectId), ticket = this.options.repo.tickets.get(ticketId)
    if (!ticket || ticket.projectId !== project.id) throw new UserError('projectOwnership')
    return ticket
  }
  awaitConfirmation(projectId: string, ticketId: string): Ticket {
    const ticket = this.ticket(projectId, ticketId)
    if (ticket.projectStage === 'draft') { ticket.projectStage = 'awaiting-confirmation'; ticket.updatedAt = this.now(); this.options.repo.tickets.save(ticket) }
    return ticket
  }
}
