/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ArtifactStore } from './artifact-store.ts'
import type { AcceptedReport, GateDecision } from './report-acceptance.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { Assignment, PlanAuthorization, PlanExecutionTarget, Project as ProjectModel, Ticket } from '../core/model.ts'

export type Project = ProjectModel
export type ConversationRole = 'user' | 'assistant'
export type ConversationMessageStatus = 'queued' | 'running' | 'answered' | 'error' | 'saved'
export interface ConversationMessage {
  id: string
  projectId: string
  role: ConversationRole
  text: string
  createdAt: string
  status: ConversationMessageStatus
  error?: string
}
export interface ProjectTaskView extends Ticket {
  planRevisions?: Ticket['planRevisions']
  authorizations?: Ticket['authorizations']
  executionTargets?: Ticket['executionTargets']
  assignments: Assignment[]
}
export interface ProjectConversationView {
  project: Project
  messages: ConversationMessage[]
  artifacts?: ReturnType<ArtifactStore['view']>
  reports?: AcceptedReport[]
  decisions?: GateDecision[]
  tasks?: ProjectTaskView[]
  coordinator?: { status: 'idle' | 'running' | 'error'; error?: string }
  draft?: { text: string }
}
export interface ProjectPlanConfirmationResponse {
  authorization: PlanAuthorization
  target: PlanExecutionTarget
  assignment: Assignment
  ticket: Ticket
}

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/reconcile': { body: { operationId: string }; response: { state: 'checking' | 'clear' | 'unknown'; operationId: string } }
  'POST tickets/:id/stop': { response: { stopped: boolean; stopping?: boolean } }
  'POST tickets/:id/pause': { response: { paused: true } }
  'POST tickets/:id/resume': { response: { resumed: true } }
  'POST tickets/:id/attention': { body: { version: number; questionId?: string; text: string }; response: { resolved: boolean; version: number } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET projects': { response: { projects: Project[] } }
  'POST projects': { body: { name: string; goal: string }; response: { project: Project } }
  'GET projects/:id/conversation': { response: ProjectConversationView }
  'POST projects/:id/messages': { body: { requestId: string; text: string; ticketId?: string; planRevision?: number }; response: { message: ConversationMessage; clarification?: string; authorization?: PlanAuthorization; target?: PlanExecutionTarget; assignment?: Assignment; ticket?: Ticket } }
  'POST projects/:id/plan-confirmation': { body: { ticketId: string; planRevision: number; operationId: string; intent?: 'execute' | 'rerun' }; response: ProjectPlanConfirmationResponse }
  'POST projects/:id/plan-revocation': { body: { ticketId: string; authorizationId: string; operationId: string }; response: PlanAuthorization }
  'GET projects/:id/artifacts/:artifactId/:version': { response: { id: string; name: string; contentVersion: string; content: string } }
  'POST projects/:id/acceptance': { body: { ticketId: string; operationId: string; reportId: string; conclusion: GateDecision['conclusion']; evidence: string }; response: GateDecision }
  'POST projects/:id/retry': { response: { retried: true } }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
