/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from './model.ts'
export * from './ports.ts'
export { Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForSettings, type EngineForSources,
  type EngineOptions, type ProjectFeedbackFact, type Outcome, type ReceiveResult, type Reply, type ReplyRequest, type WorkerReport } from './engine.ts'
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
export { MemoryRepositories } from './memory.ts'
export { Projects, type ProjectServiceOptions, type CreateProject, type UpdateProject } from './projects.ts'
export { Plans, type PlanServiceOptions, type SavePlan, type ConfirmPlan, type RevokePlan, type RegisterPlanAssignment, type PlanConfirmationResult } from './plans.ts'
export { canRetry, ticketStage, type TicketStage } from './stage.ts'
export { key } from './ids.ts'
export { validateAssignmentGraph, assignmentReady, planAssignments, type DependencyResult } from './dependencies.ts'

export * from './assignment-graphs.ts'
