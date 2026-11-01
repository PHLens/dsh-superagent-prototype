# Project Superagent Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 DSH Superagent 原型上实现一个以项目为中心、可恢复、可审计、支持 Web 与飞书入口的个人研究工作台，同时保留原型的 SQLite、Effects/Outbox、DSH Session、Source/Channel 和服务控制底座。

**Architecture:** 应用数据库是项目业务事实的唯一权威，保存项目、主对话、方案、授权、任务、执行尝试、成果、通知、归属和恢复状态；DSH Session 只保存模型与工具执行现场。每个项目拥有可重建的逻辑 coordinator，较重工作通过带授权和 attempt 身份的 Assignment 运行，Web 与飞书都先进入统一 ChannelMessage，再由应用确定项目归属和可执行范围。三个增量分别交付无 GitHub 文件任务闭环、Web/KORAM 协作闭环和共享飞书私聊闭环。

**Tech Stack:** TypeScript ESM、Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`、SQLite `node:sqlite`、Vitest、React 18 客户端、DSH `^0.2.1-alpha.2` 插件接口、现有 Effects/Outbox/Source/Channel/Session 适配层、macOS 本地运行与 Tailscale Serve。

**Spec:** `docs/superpowers/specs/2026-11-01-project-superagent-workbench-design.md`；源码事实与改造边界见 `docs/superpowers/specs/2026-11-01-superagent-prototype-reuse-audit.md`。

> **Execution revision (2026-11-01):** 本文件保留产品架构和完整职责清单。Task 0 的全局宿主门、粗粒度任务顺序和人工逐条分发方式已由 [`2026-11-01-project-superagent-workbench-execution-ready.md`](2026-11-01-project-superagent-workbench-execution-ready.md) 修订。实现时必须使用修订版的 0A–0E、1A–1L、2A–2G、3A–3D 和 D0–D4 依赖图；本文件中的旧 Task 0 不得单独执行。

## Global Constraints

- 应用数据库保存项目业务事实；DSH Session 保存执行现场；`.superagent/` 只保存可重建清单，不能单独恢复授权。
- 所有任务、方案、授权、Assignment、attempt、资源、Artifact、ChannelMessage、Delivery 和缓存都必须有明确项目归属。
- `PlanRevision` 不可变；`Authorization` 绑定具体方案版本、稳定 actor 和确认意图，业务幂等不能只依赖原生 messageId。
- 暂停、停止、Attention 和必要执行状态跨重启保持；普通消息、历史回填和网络重连不能自动恢复任务。
- 恢复必须先核对 Session、workspace、cwd、realpath、prepare 证据和外部副作用；无法确认时进入核对状态，不盲目重跑。
- 增量 1 可以只运行一个 Assignment，但数据模型必须支持同一 Task 的多 Assignment、attempt、依赖、独立目录和成果聚合。
- worker 是正式 Assignment；subagent 是有父子记录、范围交集和预算的临时委派；暂停或停止后不能新建委派。
- 首版只提供应用层项目、资源、工具和路径检查；执行以当前 Mac 用户身份运行，不宣称 OS 文件沙箱。
- GitHub 是可选项目资源；无 GitHub 的项目必须能讨论、确认方案、执行文件任务、登记成果并恢复。
- Web 与飞书都写入统一 ChannelMessage；不能默认使用上一个项目，也不能把共享私聊 Thread 广播给多个项目。
- NotificationTarget 独立于输入 Channel；Delivery 持久保存原生 messageId、项目/任务/attempt/Attention 映射和 unknown 状态。
- 首版是单 Mac、Tailscale 私网、手机 Web、一个机器人、一对一飞书私聊；不做云端离线执行、多用户协作、公网入口、自动合并 PR 或自动发表研究结论。
- 旧的自动合并、重写提交、强推、same-tree approval 和自动关闭 PR 政策不能继承；PR 始终由人合并。
- 现有 KORAM 服务和旧 profile 保持隔离；实现使用独立开发 profile/state，不能改动 operator GUI 或既有 KORAM 运行状态。
- 每项任务都先写失败测试，再实现最小行为，再运行局部测试；任务完成时提交独立 commit，提交不得包含 `docs/superpowers/plans/2026-11-01-superagent-setup.md`。

## 交付顺序与发布门

- **能力级宿主门。** 先执行修订版 0A–0E。纯领域、类型、事务存储和迁移安全工作只依赖 0A 与隔离状态；Session、技能、Web、附件、持久 replay、Tailscale 和 Feishu 投递消费者分别依赖各自的 capability evidence。
- **有限失败处理。** 每个 `failed` 或 `unsupported` 能力必须生成带负责人、受影响消费者、修复命令和重测标准的 repair task；没有安全 workaround 时，只有对应消费者和相应发布门 blocked。
- **增量 1：项目基础与最小纵向切片。** 无 GitHub 配置也能完成“项目 → 主对话 → 方案确认 → 一次文件任务 → Artifact → Web 通知 → 重启核对”；两个项目的查询、工具、缓存、文件和事件不得串属。
- **增量 2：Web 协作闭环。** 完善项目首页、主对话、任务/Attention、资源/Artifact、持久事件和移动端远程访问；关联 KORAM，支持多 Assignment、协作和预算。
- **增量 3：飞书私聊闭环。** 单机器人主动通知、原生投递回执、逐消息跨项目路由、回复关联、待归属输入和跨入口去重。
- 每个增量结束时必须运行该增量的领域、存储、恢复、HTTP/客户端和故障注入验收；未通过时不能进入下一个增量。依赖只有在预期 PR 合并到 `dev`、记录 merge SHA 并完成对应验收后才算完成。
- 自动分发由修订版 D0–D4 负责：它读取版本化 DAG，通过现有 Feishu 受信入口提交 ready task，最多保持三个独立任务在途，不直接写数据库、不调用不存在的 create-ticket API、不自动合并 PR。

---

### Task 0: 建立真实宿主兼容与隔离验证门

**Files:**
- Create: `tests/host-compatibility.spec.ts`
- Modify: `package.json:30-85` only when the verified host requires a dependency range change
- Modify: `cordis.patch.yml` only when the verified host requires a declared capability
- Create: `docs/superpowers/verification/2026-11-01-host-compatibility.md`
- Preserve: existing `docs/superpowers/plans/2026-11-01-superagent-setup.md`

**Interfaces:**
- Consumes: current `src/app/sessions.ts`, `src/app/http.ts`, `src/executor/dsh.ts`, `src/app/skill-files.ts`, `tsdown.config.ts` and the installed DSH RC host.
- Produces: a checked compatibility matrix covering Session/Workspace, permission preset, skills, attachments, client slots, authentication, SSE/WS behavior and bundle loading; no business implementation may rely on an unverified host capability.

- [ ] **Step 1: Write the failing compatibility assertions**

  Add fixture-driven assertions that record the host version and require explicit results for: creating and reopening a Session with a workspace, registering and reading a skill, attaching a file, loading the browser bundle through `window.__ModuleLoader__`, rejecting an unauthenticated HTTP write, and reconnecting the selected streaming transport.

- [ ] **Step 2: Run the gate and record the actual failure boundary**

  Run:

  ```bash
  pnpm typecheck
  pnpm test -- tests/host-compatibility.spec.ts
  pnpm build
  ```

  Expected: existing native Rolldown binding failure may stop Vitest/build; record the exact environment blocker in the verification document rather than changing dependencies speculatively.

- [ ] **Step 3: Verify the installed RC host in an isolated profile**

  Use a new development profile/state directory and a port distinct from `53818`, run the smallest Session/Workspace/skill/HTTP probe, and save host version, package versions, probe output and known failures. Do not touch the operator GUI, KORAM state or existing `superagent` profile.

- [ ] **Step 4: Make only evidence-backed compatibility changes**

  If a type or peer range blocks the verified host, update the narrowest package or patch declaration and add a regression assertion. If the host capability is missing, mark the affected increment blocked in the verification document and keep the design boundary explicit.

- [ ] **Step 5: Run the gate again and commit**

  Run the three commands from Step 2 plus the host probe. Commit only the compatibility test, verification record and evidence-backed package/patch changes:

  ```bash
  git add tests/host-compatibility.spec.ts docs/superpowers/verification/2026-11-01-host-compatibility.md package.json cordis.patch.yml
  git commit -m "test: establish DSH host compatibility gate"
  ```

**Exit condition:** the host matrix is either green for the capabilities required by the next increment or contains a concrete blocked capability and no implementation proceeds past it.

### Task 1: Add project, identity, channel and artifact domain contracts

**Files:**
- Create: `src/core/project-model.ts`
- Create: `src/core/project-ids.ts`
- Create: `src/core/project-ports.ts`
- Modify: `src/core/index.ts`
- Modify: `src/core/model.ts` only for shared actor/attempt/report types
- Create: `tests/project-model.spec.ts`
- Create: `tests/project-ids.spec.ts`

**Interfaces:**
- Consumes: existing `ActorRef`, `ChannelRef`, `Ticket`, `Assignment`, `Attention`, `Trigger` and `Repositories` types.
- Produces: stable domain types and validation functions used by persistence, intake, API and executor:

  ```ts
  export type ProjectId = string & { readonly __projectId: unique symbol }
  export type PlanRevisionId = string & { readonly __planRevisionId: unique symbol }
  export type AuthorizationId = string & { readonly __authorizationId: unique symbol }
  export type TaskId = string & { readonly __taskId: unique symbol }
  export type AssignmentId = string & { readonly __assignmentId: unique symbol }
  export type AttemptId = string & { readonly __attemptId: unique symbol }
  export type ResourceId = string & { readonly __resourceId: unique symbol }
  export type ArtifactId = string & { readonly __artifactId: unique symbol }

  export interface Project { id: ProjectId; name: string; goal: string; state: 'active' | 'archived'; coordinatorSessionId?: string; workspaceId: string; createdAt: string; updatedAt: string }
  export interface StableActor { id: string; displayName: string; webIdentity?: string; feishuOpenId?: string; sourceEvidence: ActorRef[] }
  export interface ProjectConversation { id: string; projectId: ProjectId; sequence: number; messages: ChannelMessage[] }
  export interface ChannelMessage { id: string; source: 'web' | 'feishu' | 'github'; nativeId?: string; projectId?: ProjectId; taskId?: TaskId; replyToId?: string; text: string; actorId?: string; status: 'unresolved' | 'accepted' | 'ignored'; at: string }
  export interface Artifact { id: ArtifactId; projectId: ProjectId; taskId: TaskId; path: string; contentVersion: string; kind: string; evidence: string[]; valid: boolean; createdAt: string }
  export interface Resource { id: ResourceId; projectId: ProjectId; kind: 'directory' | 'repository' | 'data' | 'service'; root: string; version?: string; state: 'ready' | 'missing' | 'checking' }
  ```

- [ ] **Step 1: Write tests for identity stability and project invariants**

  Assert that changing a project display name does not change its id; duplicate names require explicit selection; a Task, PlanRevision, Authorization, Assignment, Attempt, Resource and Artifact cannot be saved without a project id; an unresolved ChannelMessage cannot create an Assignment.

- [ ] **Step 2: Run the focused tests to verify they fail**

  ```bash
  pnpm test -- tests/project-model.spec.ts tests/project-ids.spec.ts
  ```

  Expected: FAIL because the new contracts and validators do not exist.

- [ ] **Step 3: Implement the contracts and validators**

  Add branded id constructors using the existing `key()`/id conventions, Zod-free pure validators for required project ownership, and explicit source evidence on `StableActor`. Do not infer authorization from `ActorRef.source`, display names or `Trigger.human`.

- [ ] **Step 4: Run the focused tests and typecheck**

  ```bash
  pnpm test -- tests/project-model.spec.ts tests/project-ids.spec.ts
  pnpm typecheck
  ```

  Expected: PASS with no changes to existing Ticket semantics beyond shared type exports.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/project-model.ts src/core/project-ids.ts src/core/project-ports.ts src/core/index.ts src/core/model.ts tests/project-model.spec.ts tests/project-ids.spec.ts
  git commit -m "feat: define project and execution identity contracts"
  ```

### Task 2: Extend SQLite persistence with schema 12 and transactional project records

**Files:**
- Modify: `src/app/store.ts:30-95` and repository methods below the schema setup
- Modify: `src/app/migration.ts:20-95`
- Modify: `src/kv.ts`
- Create: `src/app/project-store.ts`
- Create: `src/app/channel-store.ts`
- Create: `src/app/artifact-store.ts`
- Create: `tests/project-store.spec.ts`
- Modify: `tests/migration.spec.ts`
- Modify: `tests/store.spec.ts`

**Interfaces:**
- Consumes: Task 1 domain contracts and existing `Store.atomic`, `afterCommit`, SQLite WAL/FULL and version migration behavior.
- Produces:

  ```ts
  export const SCHEMA_VERSION = 12
  export interface ProjectStore {
    create(project: Project): void
    get(id: ProjectId): Project | undefined
    save(project: Project): void
    list(): Project[]
  }
  export interface ChannelStore {
    receive(message: ChannelMessage, operationId: string): { message: ChannelMessage; duplicate: boolean }
    resolveProject(messageId: string, projectId: ProjectId): ChannelMessage
    get(id: string): ChannelMessage | undefined
  }
  export interface ArtifactStore {
    save(artifact: Artifact): void
    list(projectId: ProjectId, taskId?: TaskId): Artifact[]
    get(id: ArtifactId): Artifact | undefined
  }
  ```

- [ ] **Step 1: Write migration and transaction tests**

  Add tests that create an empty database at schema 12, migrate a schema 11 database without changing old records, reject a schema older than 10, leave the database unchanged when a migration fails, enforce project-scoped uniqueness for native message ids, and reject artifact records whose task belongs to another project.

- [ ] **Step 2: Run migration/store tests and verify failure**

  ```bash
  pnpm test -- tests/migration.spec.ts tests/store.spec.ts tests/project-store.spec.ts
  ```

  Expected: FAIL because schema 12 tables and stores do not exist.

- [ ] **Step 3: Add schema 12 tables and indexes**

  Add tables for `project`, `actor`, `project_message`, `plan_revision`, `authorization`, `resource`, `artifact`, `execution_attempt`, `delivery`, and `app_event`, each storing validated JSON plus indexed `project_id`, `updated_at`, and stable id. Add unique keys for `(source, native_id)` where native ids exist and `(project_id, client_operation_id)` for Web operations. Keep old trigger/thread/ticket/outbox tables intact.

- [ ] **Step 4: Implement migration and store methods**

  Change the migration constants to 12, implement `migrateTo12()` as a transaction, preserve schema 11 records as legacy provenance, and never synthesize Project/Authorization from ticket title, directory name or `worker-<ticketId>`. Add store methods that check project ownership inside the same transaction as writes.

- [ ] **Step 5: Run focused tests and inspect rollback behavior**

  ```bash
  pnpm test -- tests/migration.spec.ts tests/store.spec.ts tests/project-store.spec.ts
  pnpm typecheck
  ```

  Verify the SQLite file remains unchanged after an injected migration error and duplicate operations return the original record.

- [ ] **Step 6: Commit**

  ```bash
  git add src/app/store.ts src/app/migration.ts src/kv.ts src/app/project-store.ts src/app/channel-store.ts src/app/artifact-store.ts tests/migration.spec.ts tests/store.spec.ts tests/project-store.spec.ts
  git commit -m "feat: persist project and channel business records"
  ```

### Task 3: Implement PlanRevision, Authorization and lifecycle state transitions

**Files:**
- Create: `src/core/plans.ts`
- Create: `src/core/lifecycle.ts`
- Modify: `src/core/intake.ts`
- Modify: `src/core/assignments.ts`
- Modify: `src/core/tickets.ts`
- Modify: `src/app/project-store.ts`
- Create: `tests/plans.spec.ts`
- Create: `tests/lifecycle.spec.ts`
- Modify: `tests/followups.spec.ts`
- Modify: `tests/core-engine.spec.ts`

**Interfaces:**
- Consumes: Task 1 identity types and Task 2 stores.
- Produces:

  ```ts
  export interface PlanRevision { id: PlanRevisionId; projectId: ProjectId; taskId: TaskId; parentId?: PlanRevisionId; goal: string; scope: string[]; outputs: string[]; resources: ResourceId[]; completion: string[]; limits: { modelTokens?: number; wallSeconds?: number }; state: 'current' | 'superseded' | 'revoked'; createdAt: string }
  export interface Authorization { id: AuthorizationId; projectId: ProjectId; taskId: TaskId; planRevisionId: PlanRevisionId; actorId: string; confirmationIntent: string; createdAt: string }
  export function confirmPlan(input: { projectId: ProjectId; taskId: TaskId; planRevisionId: PlanRevisionId; actorId: string; confirmationIntent: string }): { authorization: Authorization; duplicate: boolean }
  export function transitionTask(state: TaskState, event: TaskEvent): TaskState
  ```

- [ ] **Step 1: Write tests for confirmation idempotency and stale plans**

  Cover duplicate Web operations with different message ids, duplicate confirmations across Web and Feishu, conflicting `clientOperationId` payloads, expired/superseded plan confirmation, explicit “run again” creating a new intent, and confirmation by an actor without verified identity.

- [ ] **Step 2: Run focused tests and verify failure**

  ```bash
  pnpm test -- tests/plans.spec.ts tests/lifecycle.spec.ts tests/followups.spec.ts
  ```

  Expected: FAIL because current Mandate/accept semantics do not expose PlanRevision/Authorization.

- [ ] **Step 3: Implement immutable plans and business uniqueness**

  Add transactional confirmation keyed by `(projectId, planRevisionId, actorId, confirmationIntent)`. Store the original Authorization when the same key repeats. Reject a reused `clientOperationId` whose content hash differs. Keep legacy Mandates as provenance only; do not treat them as new Authorization records.

- [ ] **Step 4: Implement explicit task lifecycle**

  Add transitions for `planPending`, `queued`, `running`, `attention`, `failed`, `pausing`, `paused`, `stopped`, and `completed`. Require explicit resume for `paused`; make `retry` create a new Attempt under the same Task; make follow-up, Attention answer, retry, resume and new execution intent distinct events.

- [ ] **Step 5: Bind reports to Assignment and Attempt**

  Replace ticket-only report resolution with an operation accepting `assignmentId`, `attemptId`, `authorizationId`, `leaseId` and `operationId`. Reject ended/old leases and aggregate completion only after required artifacts, dependencies and required subagent results are present. Preserve the existing legal no-PR `ready` report behavior for non-code tasks.

- [ ] **Step 6: Run tests and commit**

  ```bash
  pnpm test -- tests/plans.spec.ts tests/lifecycle.spec.ts tests/followups.spec.ts tests/core-engine.spec.ts
  pnpm typecheck
  git add src/core/plans.ts src/core/lifecycle.ts src/core/intake.ts src/core/assignments.ts src/core/tickets.ts src/app/project-store.ts tests/plans.spec.ts tests/lifecycle.spec.ts tests/followups.spec.ts tests/core-engine.spec.ts
  git commit -m "feat: enforce plan authorization and task lifecycle"
  ```

### Task 4: Build unified Web intake, project coordinator and conversation records

**Files:**
- Create: `src/app/project-coordinator.ts`
- Create: `src/app/intake.ts`
- Modify: `src/app/runtime.ts`
- Modify: `src/app/api.ts`
- Modify: `src/app/http.ts`
- Modify: `src/app/views/overview.ts`
- Create: `src/app/views/projects.ts`
- Create: `src/app/views/project.ts`
- Create: `tests/project-coordinator.spec.ts`
- Create: `tests/intake.spec.ts`
- Modify: `tests/http.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–3 stores and lifecycle.
- Produces:

  ```ts
  export interface ProjectCoordinator {
    ensure(projectId: ProjectId): Promise<string>
    accept(projectId: ProjectId, message: ChannelMessage): Promise<void>
    rebuild(projectId: ProjectId, reason: string): Promise<void>
  }
  export interface IntakeService {
    receiveWeb(input: { projectId?: ProjectId; actorId: string; text: string; clientOperationId: string }): Promise<ChannelMessage>
    resolve(messageId: string, projectId: ProjectId, actorId: string): Promise<ChannelMessage>
  }
  ```

- [ ] **Step 1: Write tests for project routing and coordinator uniqueness**

  Assert that two projects can have separate coordinator Session ids, one project cannot have two decision writers, a missing project creates an unresolved message rather than a task, explicit project selection resolves it without resending text, and a normal discussion does not create an Assignment before plan confirmation.

- [ ] **Step 2: Run focused tests and verify failure**

  ```bash
  pnpm test -- tests/project-coordinator.spec.ts tests/intake.spec.ts tests/http.spec.ts
  ```

- [ ] **Step 3: Implement transaction-first Web intake**

  Save the normalized message, actor binding, project resolution and resulting Effect in one application transaction. Return the existing message/task result for retries. Route project conversation messages to the project coordinator, not the global `masterId`; retain DSH message/session references after dispatch.

- [ ] **Step 4: Add project-scoped API contracts**

  Add typed routes for project list/create/detail, conversation read/send, plan read/confirm, task list/detail, Attention answer, artifact list and project resource status. Every route obtains project identity from the authenticated server context and verifies actor authorization; never trust a client-supplied project id alone.

- [ ] **Step 5: Run tests and commit the application slice**

  ```bash
  pnpm test -- tests/project-coordinator.spec.ts tests/intake.spec.ts tests/http.spec.ts
  pnpm typecheck
  git add src/app/project-coordinator.ts src/app/intake.ts src/app/runtime.ts src/app/api.ts src/app/http.ts src/app/views/projects.ts src/app/views/project.ts src/app/views/overview.ts tests/project-coordinator.spec.ts tests/intake.spec.ts tests/http.spec.ts
  git commit -m "feat: route Web input through project coordinators"
  ```

### Task 5: Add explicit attempts, workspace preparation evidence and execution manifests

**Files:**
- Create: `src/app/execution-context.ts`
- Create: `src/app/workspace-preparation.ts`
- Modify: `src/executor/dsh.ts`
- Modify: `src/app/sessions.ts`
- Modify: `src/infra/environment.ts`
- Modify: `src/app/execution-environment.ts`
- Modify: `src/app/runtime.ts`
- Create: `tests/execution-context.spec.ts`
- Create: `tests/workspace-preparation.spec.ts`
- Modify: `tests/runtime.spec.ts`
- Modify: `tests/runtime-concurrency.spec.ts`

**Interfaces:**
- Consumes: Task 3 Assignment/Attempt and Task 4 coordinator.
- Produces:

  ```ts
  export interface ExecutionContextManifest { attemptId: AttemptId; projectId: ProjectId; taskId: TaskId; assignmentId: AssignmentId; authorizationId: AuthorizationId; role: string; sessionId: string; workspaceId: string; cwd: string; promptVersions: number[]; skillVersions: Record<string, number>; model: string; tools: string[]; resources: ResourceId[]; createdAt: string }
  export interface PreparationEvidence { workspaceId: string; realpath: string; recipeVersion: string; owner: string; state: 'preparing' | 'ready' | 'failed' | 'needs_review'; repository?: string; worktree?: string; completedAt?: string; error?: string }
  export function verifyPreparation(evidence: PreparationEvidence, actual: { realpath: string; isDirectory: boolean; repository?: string; worktree?: string }): void
  ```

- [ ] **Step 1: Write failing tests for workspace and Session identity**

  Cover a missing directory, a file at the expected directory path, a symlink escaping the registered root, a non-empty failed-prepare directory, an existing but wrong worktree, mismatched cwd/owner/session, and a valid prepared workspace. Assert that invalid evidence becomes `needs_review` and never triggers deletion or blind prepare rerun.

- [ ] **Step 2: Run focused tests and verify failure**

  ```bash
  pnpm test -- tests/execution-context.spec.ts tests/workspace-preparation.spec.ts tests/runtime.spec.ts tests/runtime-concurrency.spec.ts
  ```

- [ ] **Step 3: Implement persistent preparation evidence**

  Replace `stat(workspace) === exists` as the prepare shortcut. Persist recipe version, normalized realpath, ownership, repository/worktree identity, state and completion evidence. On every launch, run realpath/type/repository/worktree/Git credential checks before reusing the workspace.

- [ ] **Step 4: Implement explicit attempt/session/workspace mapping**

  Allocate an `attemptId` for every initial run and retry. Pass `sessionId`, `workspaceId`, `cwd`, `projectId`, `taskId`, `authorizationId` and `assignmentId` through the executor. When reopening a Session, verify the stored mapping against the actual DSH Session and cwd; do not rebind by renaming `worker-<ticketId>`.

- [ ] **Step 5: Implement manifest capture and safe configuration scope**

  Record resolved prompt/project convention versions, model, tools, resources, candidate and loaded skill versions, source references and Session mapping at attempt start. Replace process-wide project switching with a per-subprocess environment snapshot; retain credential cleanup and Git config checks. A prompt/skill update applies to the next attempt or explicit checkpoint; pause/revocation remains immediate.

- [ ] **Step 6: Run recovery and concurrency tests, then commit**

  ```bash
  pnpm test -- tests/execution-context.spec.ts tests/workspace-preparation.spec.ts tests/runtime.spec.ts tests/runtime-concurrency.spec.ts tests/environment.spec.ts
  pnpm typecheck
  git add src/app/execution-context.ts src/app/workspace-preparation.ts src/executor/dsh.ts src/app/sessions.ts src/infra/environment.ts src/app/execution-environment.ts src/app/runtime.ts tests/execution-context.spec.ts tests/workspace-preparation.spec.ts tests/runtime.spec.ts tests/runtime-concurrency.spec.ts tests/environment.spec.ts
  git commit -m "feat: make attempts and workspace recovery explicit"
  ```

### Task 6: Implement role/phase skill catalogs, scoped reads and subagent contracts

**Files:**
- Create: `src/app/skill-catalog.ts`
- Create: `src/app/delegations.ts`
- Modify: `src/app/prompts.ts`
- Modify: `src/app/sessions.ts`
- Modify: `src/app/tools/tool.ts`
- Modify: `src/app/tools/main.ts`
- Modify: `prompts/orchestrator.md`
- Modify: `prompts/dispatch.md`
- Modify: `prompts/worker.md`
- Modify: `prompts/work.md`
- Modify: `prompts/cli.md`
- Create: `tests/skill-catalog.spec.ts`
- Create: `tests/delegations.spec.ts`
- Modify: `tests/prompts.spec.ts`

**Interfaces:**
- Consumes: Task 5 ExecutionContextManifest and existing versioned `Prompts` mechanism.
- Produces:

  ```ts
  export interface SkillCatalogEntry { id: string; version: number; summary: string; roles: string[]; stages: string[]; tools: string[]; resources: ResourceId[]; conflicts: string[]; state: 'enabled' | 'revoked' }
  export interface SkillSnapshot { candidates: SkillCatalogEntry[]; loaded: { id: string; version: number }[] }
  export function visibleSkills(context: { projectId: ProjectId; role: string; stage: string; tools: string[]; resources: ResourceId[] }): SkillCatalogEntry[]
  export function readSkill(context: { attemptId: AttemptId; skillId: string; version: number }): string
  export interface Delegation { id: string; parentAttemptId: AttemptId; childAttemptId?: AttemptId; scope: string[]; contextVersion: string; state: 'requested' | 'running' | 'returned' | 'processed' | 'blocked'; resultArtifactId?: ArtifactId }
  ```

- [ ] **Step 1: Write tests for candidate filtering and fail-closed reads**

  Assert that a coordinator sees clarification/read-only skills, a code worker sees repository skills, a worker cannot read a revoked or out-of-role skill by guessing its id, skill content does not add tools or resources, conflicting skills are excluded, and unresolved parent ancestry blocks application actions.

- [ ] **Step 2: Run focused tests and verify failure**

  ```bash
  pnpm test -- tests/skill-catalog.spec.ts tests/delegations.spec.ts tests/prompts.spec.ts
  ```

- [ ] **Step 3: Implement versioned catalog and read authorization**

  Store catalog metadata and正文 versions separately from prompt text. Generate candidates from role/project/stage/resource conditions; require a second server-side check for body reads; record candidate and loaded versions in the manifest. Do not expose a global full skill directory.

- [ ] **Step 4: Implement delegation persistence and budgets**

  Create parent-child records before starting a subagent, intersect parent and child scope, reject new delegations for paused/stopped attempts, and require the parent to process necessary results before aggregate completion. Count model calls, subagents, shell jobs, experiments and services separately.

- [ ] **Step 5: Rewrite prompt contracts and remove inherited delivery side effects**

  Make the coordinator capable of discussion, light investigation and plan formation; make worker prompts use structured reports and application routing; keep GitHub/PR instructions opt-in. Remove automatic merge/rewrite/force-push/same-tree approval/automatic PR close behavior from the new execution path.

- [ ] **Step 6: Run tests and commit**

  ```bash
  pnpm test -- tests/skill-catalog.spec.ts tests/delegations.spec.ts tests/prompts.spec.ts
  pnpm typecheck
  git add src/app/skill-catalog.ts src/app/delegations.ts src/app/prompts.ts src/app/sessions.ts src/app/tools/tool.ts src/app/tools/main.ts prompts/orchestrator.md prompts/dispatch.md prompts/worker.md prompts/work.md prompts/cli.md tests/skill-catalog.spec.ts tests/delegations.spec.ts tests/prompts.spec.ts
  git commit -m "feat: scope skills and recorded delegations"
  ```

### Task 7: Deliver Increment 1 vertical slice without GitHub

**Files:**
- Modify: `src/deployment.ts`
- Modify: `src/app/setup.ts`
- Modify: `src/app/runtime.ts`
- Modify: `src/app/tools/executor.ts`
- Modify: `src/app/resources.ts`
- Modify: `src/app/api.ts`
- Create: `src/app/notifications.ts`
- Create: `src/app/health-project.ts`
- Modify: `src/client/route.ts`
- Modify: `src/client/app.tsx`
- Create: `src/client/project-home.tsx`
- Create: `src/client/project-conversation.tsx`
- Create: `src/client/project-task.tsx`
- Modify: `src/client/api.ts`
- Create: `tests/no-github-slice.spec.ts`
- Create: `tests/project-panel.spec.tsx`
- Modify: `tests/runtime.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: a working no-repository flow: create project, send message, save plan, confirm plan, run one worker file task, register Artifact, show Web notification, restart, reconcile the attempt and keep pause/authorization boundaries.

- [ ] **Step 1: Write the end-to-end failing test**

  Use a temporary state directory and assert: no GitHub settings exist; project creation succeeds; Web conversation persists; one plan confirmation creates one Authorization; the same operation retry returns the same task; a file task writes a file under the project workspace; Artifact points to that file; restart marks the attempt `needs_review` until evidence is checked; two projects cannot read or write each other's file or event.

- [ ] **Step 2: Run the test and verify current GitHub gate failure**

  ```bash
  pnpm test -- tests/no-github-slice.spec.ts tests/runtime.spec.ts
  ```

  Expected: current setup/deployment/runtime assumptions fail before a no-GitHub worker can start.

- [ ] **Step 3: Split instance readiness from project resource readiness**

  Make base storage/DSH readiness sufficient to start the app. Resolve GitHub only when a project task requires a GitHub resource. Ensure Feishu configuration is also project/notification scoped and a missing external source reports `not_ready` without blocking local project discussion.

- [ ] **Step 4: Add file-task execution and Artifact registration**

  Use the verified project workspace and attempt manifest; require an authorized output path; register the Artifact transactionally after the file is written and retain path/content version/evidence. Report completion only after the Artifact and required validation evidence exist.

- [ ] **Step 5: Add the minimum project Web surface**

  Add authenticated routes and React views for project creation, project conversation, current plan/confirmation, task status, Attention, Artifact summary and project notification. Use explicit `/projects/:projectId` routes and preserve draft/operation status across refresh; do not expose raw Session lists as the primary UI.

- [ ] **Step 6: Run Increment 1 acceptance and commit**

  ```bash
  pnpm test -- tests/no-github-slice.spec.ts tests/project-panel.spec.tsx tests/runtime.spec.ts tests/runtime-concurrency.spec.ts tests/outbox.spec.ts
  pnpm typecheck
  pnpm build
  git add src/deployment.ts src/app/setup.ts src/app/runtime.ts src/app/tools/executor.ts src/app/resources.ts src/app/api.ts src/app/notifications.ts src/app/health-project.ts src/client/route.ts src/client/app.tsx src/client/project-home.tsx src/client/project-conversation.tsx src/client/project-task.tsx src/client/api.ts tests/no-github-slice.spec.ts tests/project-panel.spec.tsx tests/runtime.spec.ts
  git commit -m "feat: ship no-GitHub project task slice"
  ```

**Increment 1 exit condition:** two projects remain isolated; an unconfigured GitHub account does not block a local file task; restart reconciliation does not duplicate side effects; Web can inspect plan, task, Artifact and notification state.

### Task 8: Add project resources, stable snapshots and authenticated Artifact access

**Files:**
- Modify: `src/app/resources.ts`
- Modify: `src/app/cache.ts`
- Create: `src/app/resource-access.ts`
- Create: `src/app/snapshot.ts`
- Modify: `src/app/cards.ts`
- Modify: `src/app/http.ts`
- Create: `tests/resource-access.spec.ts`
- Create: `tests/snapshot.spec.ts`
- Modify: `tests/cache.spec.ts`
- Modify: `tests/cards.spec.ts`

**Interfaces:**
- Consumes: Increment 1 Resource/Artifact records.
- Produces:

  ```ts
  export interface ResourceCursor { resourceId: ResourceId; snapshotId: string; version: string; expiresAt: string; offset: number }
  export function createSnapshot(resourceId: ResourceId, actorId: string): ResourceCursor
  export function readResource(cursor: ResourceCursor, actorId: string, limit: number): { entries: string[]; next?: ResourceCursor }
  export function downloadArtifact(id: ArtifactId, actorId: string): { stream: NodeJS.ReadableStream; contentType: string; disposition: string }
  ```

- [ ] **Step 1: Write tests for authorization, snapshots and path safety**

  Cover project mismatch, revoked resource cache hit, cursor expiry, content version change, offset mixing, symlink escape, `..` traversal, directory listing, Markdown/text pagination, large-file truncation and binary download headers.

- [ ] **Step 2: Run focused tests and verify failure**

  ```bash
  pnpm test -- tests/resource-access.spec.ts tests/snapshot.spec.ts tests/cache.spec.ts tests/cards.spec.ts
  ```

- [ ] **Step 3: Implement server-side resource authorization**

  Check project, resource, attempt and actor scope before every cache read. Bind cursors to stable snapshot/version/expiry and force a new snapshot after expiry. Key cache entries by project, resource version and visible scope; enforce per-resource size, total cache limit and TTL.

- [ ] **Step 4: Implement authenticated file and Artifact routes**

  Resolve registered resources through realpath, reject symlink escapes and unregistered roots, return safe Content-Type/Disposition, and expose application URLs rather than Mac absolute paths. Limit previews and provide explicit download behavior for large/binary files.

- [ ] **Step 5: Run tests and commit**

  ```bash
  pnpm test -- tests/resource-access.spec.ts tests/snapshot.spec.ts tests/cache.spec.ts tests/cards.spec.ts
  pnpm typecheck
  git add src/app/resources.ts src/app/cache.ts src/app/resource-access.ts src/app/snapshot.ts src/app/cards.ts src/app/http.ts tests/resource-access.spec.ts tests/snapshot.spec.ts tests/cache.spec.ts tests/cards.spec.ts
  git commit -m "feat: add scoped resource and artifact access"
  ```

### Task 9: Add persistent events, multi-Assignment collaboration and fair budgets

**Files:**
- Create: `src/app/events.ts`
- Create: `src/app/collaboration.ts`
- Create: `src/app/budget.ts`
- Modify: `src/app/effects.ts`
- Modify: `src/app/passes.ts`
- Modify: `src/core/assignments.ts`
- Modify: `src/executor/background.ts`
- Modify: `src/executor/dsh.ts`
- Modify: `src/app/api.ts`
- Create: `tests/events.spec.ts`
- Create: `tests/collaboration.spec.ts`
- Create: `tests/budget.spec.ts`
- Modify: `tests/runtime-concurrency.spec.ts`
- Modify: `tests/background.spec.ts`

**Interfaces:**
- Consumes: Increment 1 attempts and Increment 2 resource/event routes.
- Produces:

  ```ts
  export interface AppEvent { id: string; sequence: number; projectId: ProjectId; aggregate: string; aggregateVersion: number; kind: string; payload: unknown; at: string }
  export interface EventCursor { projectId: ProjectId; afterSequence: number; expiresAt: string }
  export interface CollaborationRecord { id: string; projectId: ProjectId; taskId: TaskId; kind: 'dependency' | 'handoff' | 'help' | 'review'; fromAttemptId: AttemptId; toAttemptId?: AttemptId; inputArtifacts: ArtifactId[]; outputArtifacts: ArtifactId[]; state: 'open' | 'received' | 'processed' }
  export interface Budget { projectId: ProjectId; taskId?: TaskId; modelCalls: number; subagents: number; shellJobs: number; services: number; max: Record<string, number> }
  ```

- [ ] **Step 1: Write tests for durable events and reconnect**

  Assert monotonic per-project sequence, aggregate version increments, cursor replay after reconnect, duplicate event suppression, expired cursor snapshot fallback and no event leakage between projects.

- [ ] **Step 2: Write tests for collaboration and aggregate completion**

  Cover dependency version mismatch, idempotent handoff, review feedback, duplicate collaboration messages, missing required result blocking completion and paused/stopped attempts rejecting new work.

- [ ] **Step 3: Write tests for fair scheduling and background stop state**

  Assert per-project fairness, explicit wait reasons, total instance budget, separate model/subagent/shell/service counters, slot release while a background job remains alive, timeout with unconfirmed cancellation, and confirmed stop before marking exited.

- [ ] **Step 4: Implement durable event append and streaming adapter**

  Append events in the same transaction as the business mutation; expose authenticated SSE or the verified host stream with project-scoped cursors; deduplicate on event id and fall back to a snapshot when the cursor is expired. Keep polling as a degraded path only.

- [ ] **Step 5: Implement collaboration records and multi-Assignment execution**

  Add independent attempt directories/worktrees, explicit dependencies and input/output Artifact versions. Update active indexes, stop/recovery, report routing and completion aggregation to query all active assignments rather than `latestAssignment()`.

- [ ] **Step 6: Implement fair budgets and background lifecycle**

  Add project-aware queue selection, starvation protection and wait reasons. Persist background owner/purpose/deadline/health/cleanup responsibility; use AbortSignal plus explicit process-exit confirmation instead of treating `Promise.race` timeout as cancellation.

- [ ] **Step 7: Run tests and commit**

  ```bash
  pnpm test -- tests/events.spec.ts tests/collaboration.spec.ts tests/budget.spec.ts tests/runtime-concurrency.spec.ts tests/background.spec.ts tests/effects.spec.ts
  pnpm typecheck
  git add src/app/events.ts src/app/collaboration.ts src/app/budget.ts src/app/effects.ts src/app/passes.ts src/core/assignments.ts src/executor/background.ts src/executor/dsh.ts src/app/api.ts tests/events.spec.ts tests/collaboration.spec.ts tests/budget.spec.ts tests/runtime-concurrency.spec.ts tests/background.spec.ts tests/effects.spec.ts
  git commit -m "feat: add durable collaboration events and fair execution"
  ```

### Task 10: Complete Web workbench and validate Tailscale/mobile behavior

**Files:**
- Modify: `src/client/route.ts`
- Modify: `src/client/app.tsx`
- Modify: `src/client/provider.tsx`
- Modify: `src/client/api.ts`
- Create: `src/client/project-list.tsx`
- Modify: `src/client/project-home.tsx`
- Modify: `src/client/project-conversation.tsx`
- Modify: `src/client/project-task.tsx`
- Create: `src/client/project-resources.tsx`
- Create: `src/client/project-conventions.tsx`
- Modify: `src/client/styles.css` or the repository’s actual style entry
- Modify: `src/app/http.ts`
- Create: `tests/project-workbench.spec.tsx`
- Modify: `tests/client.spec.tsx`
- Modify: `tests/http.spec.ts`
- Create: `tests/tailscale-acceptance.md`

**Interfaces:**
- Consumes: Tasks 7–9 project APIs, resource routes and AppEvent cursor.
- Produces: mobile-capable project list/home, conversation, task/Attention, resources/Artifacts and conventions views; deep links and refresh preserve project identity; authenticated remote streaming and downloads work through Tailscale Serve.

- [ ] **Step 1: Write client tests for navigation and operation state**

  Assert direct `/projects/:id` navigation, browser refresh, back navigation, two tabs with different projects, narrow 320–430px layout, soft-keyboard input, long Markdown/code content, disconnected stream, draft preservation and idempotent retry.

- [ ] **Step 2: Implement project-first navigation and views**

  Add explicit project routes and replace global previous-Session assumptions. Keep raw Session/execution details behind task detail; expose plan, Attention, Artifact and health summaries in the primary mobile flow.

- [ ] **Step 3: Implement scoped client cache and event reconnect**

  Key cache by project/resource/params; store the last durable event cursor; invalidate only affected aggregates; apply duplicate suppression; fetch a fresh snapshot after cursor expiry; keep streaming drafts separate from persisted messages.

- [ ] **Step 4: Configure and test remote origin/authentication**

  Set one exact HTTPS `publicOrigin`, allow only configured Host values, require exact Origin on writes and WS/SSE, preserve DSH login/CSRF checks, and keep loopback backend plus Tailscale Serve without Funnel. Test project reads/writes, downloads, stream reconnect and rejected wrong-origin/unauthenticated requests from a real tailnet device.

- [ ] **Step 5: Run client, HTTP and build checks, then commit**

  ```bash
  pnpm test -- tests/project-workbench.spec.tsx tests/client.spec.tsx tests/http.spec.ts
  pnpm typecheck
  pnpm build
  git add src/client/route.ts src/client/app.tsx src/client/provider.tsx src/client/api.ts src/client/project-list.tsx src/client/project-home.tsx src/client/project-conversation.tsx src/client/project-task.tsx src/client/project-resources.tsx src/client/project-conventions.tsx src/app/http.ts tests/project-workbench.spec.tsx tests/client.spec.tsx tests/http.spec.ts tests/tailscale-acceptance.md
  git commit -m "feat: deliver project-first remote workbench"
  ```

### Task 11: Add multi-repository resources and KORAM code-task validation

**Files:**
- Modify: `src/deployment.ts`
- Modify: `src/app/execution-environment.ts`
- Modify: `src/infra/commands.ts`
- Modify: `src/infra/environment.ts`
- Modify: `src/sources/github-trigger.ts`
- Modify: `src/sources/github.ts`
- Modify: `src/sources/github-pull.ts`
- Modify: `src/app/resources.ts`
- Create: `tests/multi-repository.spec.ts`
- Modify: `tests/github-read.spec.ts`
- Modify: `tests/deployment.spec.ts`
- Modify: `tests/environment.spec.ts`

**Interfaces:**
- Consumes: Task 8 Resource authorization and Task 10 remote workbench.
- Produces: structured GitHub identity `(account, resource, owner/repo, native number)`, project-scoped CLI/env/Git snapshots, independent polling cursors and KORAM code-task validation with human merge.

- [ ] **Step 1: Write namespace collision tests**

  Use two repositories with the same issue number, one repository linked to two projects, and changed repository configuration. Assert thread keys, PR bindings, cursors, caches, receipts and reports never cross namespaces.

- [ ] **Step 2: Write project environment tests**

  Assert two concurrent attempts receive independent `cwd`, `PATH`, account, Git identity and repository snapshots; changing project settings does not mutate another running process; inherited credential-shaped variables remain stripped.

- [ ] **Step 3: Implement structured GitHub resource identity**

  Replace `github:<number>` with a namespace containing account/resource/repository/number while preserving overlap/horizon/ETag polling behavior. Require a Task/Assignment mapping when one repository belongs to multiple projects.

- [ ] **Step 4: Implement project-scoped command and Git snapshots**

  Pass explicit resource context to Commands and subprocesses. Remove assumptions that Deployment has one repository; keep account health as a resource check. Validate realpath, Git config and worktree per attempt.

- [ ] **Step 5: Run KORAM code-task acceptance and commit**

  Run the code-task path against an isolated KORAM worktree/profile, verify a human-reviewable commit/PR artifact and no automatic merge/force-push/PR close, then run:

  ```bash
  pnpm test -- tests/multi-repository.spec.ts tests/github-read.spec.ts tests/deployment.spec.ts tests/environment.spec.ts
  pnpm typecheck
  git add src/deployment.ts src/app/execution-environment.ts src/infra/commands.ts src/infra/environment.ts src/sources/github-trigger.ts src/sources/github.ts src/sources/github-pull.ts src/app/resources.ts tests/multi-repository.spec.ts tests/github-read.spec.ts tests/deployment.spec.ts tests/environment.spec.ts
  git commit -m "feat: scope code resources across repositories"
  ```

### Task 12: Implement Increment 3 shared Feishu DM routing and delivery

**Files:**
- Create: `src/app/notification-targets.ts`
- Create: `src/app/deliveries.ts`
- Modify: `src/sources/feishu-channel.ts`
- Modify: `src/sources/feishu-trigger.ts`
- Modify: `src/sources/feishu-read.ts`
- Modify: `src/sources/feishu-image.ts`
- Modify: `src/sources/kind.ts`
- Modify: `src/sources/registry.ts`
- Modify: `src/app/intake.ts`
- Modify: `src/app/notifications.ts`
- Create: `tests/feishu-routing.spec.ts`
- Create: `tests/delivery-reconciliation.spec.ts`
- Modify: `tests/sources.spec.ts`
- Modify: `tests/feishu-read.spec.ts`
- Modify: `tests/feishu-image.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–4 ChannelMessage/identity/intake and Task 9 durable events.
- Produces:

  ```ts
  export interface NotificationTarget { id: string; actorId: string; source: 'feishu'; chatId: string; state: 'ready' | 'not_ready' | 'revoked' }
  export interface Delivery { id: string; targetId: string; idempotencyKey: string; projectId: ProjectId; taskId?: TaskId; attemptId?: AttemptId; attentionId?: string; planRevisionId?: PlanRevisionId; nativeMessageId?: string; state: 'pending' | 'sent' | 'unknown' | 'gone' | 'reconciled'; }
  export function sendActiveFeishu(target: NotificationTarget, delivery: Delivery, text: string): Promise<Delivery>
  ```

- [ ] **Step 1: Write routing tests**

  Cover a reply to a known notification, a new message with explicit project, ambiguous project name, no project, reply/body conflict, bot self-message, duplicate native event, historical cross-project DM and attachment ownership. Assert unresolved messages are stored but never dispatched.

- [ ] **Step 2: Write delivery failure tests**

  Simulate successful send before local commit, thrown send with unknown remote result, duplicate idempotency key, missing chat permission and reconciliation by native message query. Assert no blind duplicate notification and no Attention auto-resolution merely because a message was sent.

- [ ] **Step 3: Implement active send and native receipt contract**

  Extend `SourceChannel.send` or add a typed active-send method that returns the native message id when available. Keep reply-to-existing-message behavior for direct answers. Store Delivery and its mapping transactionally; mark `unknown` when remote success cannot be reconciled.

- [ ] **Step 4: Implement deterministic per-message project routing**

  Persist every incoming message before route evaluation; resolve known reply mapping first, explicit project second, and ask for project ownership otherwise. Filter history, attachments, around reads and worker context per message/project. Do not broadcast a Thread to all subscribers.

- [ ] **Step 5: Run Feishu acceptance and commit**

  ```bash
  pnpm test -- tests/feishu-routing.spec.ts tests/delivery-reconciliation.spec.ts tests/sources.spec.ts tests/feishu-read.spec.ts tests/feishu-image.spec.ts
  pnpm typecheck
  git add src/app/notification-targets.ts src/app/deliveries.ts src/sources/feishu-channel.ts src/sources/feishu-trigger.ts src/sources/feishu-read.ts src/sources/feishu-image.ts src/sources/kind.ts src/sources/registry.ts src/app/intake.ts src/app/notifications.ts tests/feishu-routing.spec.ts tests/delivery-reconciliation.spec.ts tests/sources.spec.ts tests/feishu-read.spec.ts tests/feishu-image.spec.ts
  git commit -m "feat: route shared Feishu DM by project"
  ```

**Increment 3 exit condition:** Web-confirmed work can notify the bound Feishu DM, a Feishu answer resumes the correct Attention/task, ambiguous messages wait for project selection, and duplicate or unknown sends do not create duplicate work or notifications.

### Task 13: Add backup, isolated restore, service lifecycle and migration safeguards

**Files:**
- Create: `src/app/backup.ts`
- Create: `src/app/restore.ts`
- Modify: `src/app/migration.ts`
- Modify: `src/app/runtime.ts`
- Modify: `src/infra/health.ts`
- Modify: `scripts/dsh-superagent`
- Create: `tests/backup.spec.ts`
- Create: `tests/restore.spec.ts`
- Modify: `tests/migration.spec.ts`
- Modify: `tests/health.spec.ts`
- Modify: `tests/service-script.spec.ts`
- Create: `docs/superpowers/verification/2026-11-01-recovery-drill.md`

**Interfaces:**
- Consumes: all persisted project/session/resource/artifact/delivery records and existing lock/stop/migration behavior.
- Produces:

  ```ts
  export interface BackupManifest { id: string; createdAt: string; schema: number; dbSnapshot: string; dshState: string; workspaces: string[]; attachments: string[]; resourceIndex: string; promptSkillVersions: string[]; complete: boolean }
  export function createBackup(destination: string): Promise<BackupManifest>
  export function restoreIsolated(manifest: BackupManifest, destination: string): Promise<void>
  ```

- [ ] **Step 1: Write backup completeness tests**

  Assert that a backup includes the SQLite snapshot, DSH state references, workspace/run files, attachments, external resource inventory, prompt/skill versions and a `complete` marker; credentials are not copied into the backup payload.

- [ ] **Step 2: Write isolated restore tests**

  Restore into a new state/profile with execution and external delivery disabled. Assert project conversations, Artifact links, manifests and versions are readable; no Effect, Outbox or Delivery is executed during restore.

- [ ] **Step 3: Implement coordinated backup and restore**

  Take a consistent DB snapshot, record file versions, mark incomplete backups on interruption, and restore into a separate directory. Keep old state untouched until the restored copy passes link/read checks.

- [ ] **Step 4: Implement migration and service health safeguards**

  Preserve legacy records as read-only provenance; never infer new authorization from them. Distinguish instance readiness, project resource missing, notification not ready, reconciliation pending, task failure and service unreachable. Preserve lock-before-SQLite and drain-before-close order.

- [ ] **Step 5: Run recovery drill and commit**

  Execute a full interruption/restart/restore drill and save exact evidence. Then run:

  ```bash
  pnpm test -- tests/backup.spec.ts tests/restore.spec.ts tests/migration.spec.ts tests/health.spec.ts tests/service-script.spec.ts
  pnpm typecheck
  git add src/app/backup.ts src/app/restore.ts src/app/migration.ts src/app/runtime.ts src/infra/health.ts scripts/dsh-superagent tests/backup.spec.ts tests/restore.spec.ts tests/migration.spec.ts tests/health.spec.ts tests/service-script.spec.ts docs/superpowers/verification/2026-11-01-recovery-drill.md
  git commit -m "feat: add isolated backup and recovery safeguards"
  ```

### Task 14: Run full acceptance matrix and update operational documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-01-project-superagent-workbench-design.md` only for implementation decisions that differ from the approved design
- Create: `docs/superpowers/verification/2026-11-01-acceptance-report.md`
- Create: `tests/project-workbench-e2e.spec.ts`
- Modify: `package.json` scripts only if a deterministic acceptance command is added

**Interfaces:**
- Consumes: all increment deliverables and verification records.
- Produces: one reproducible acceptance command and a report that distinguishes passed, failed, blocked-by-host and not-applicable scenarios.

- [ ] **Step 1: Write the final end-to-end scenarios**

  Cover: no-GitHub file task; two-project isolation; plan confirmation idempotency; pause across restart; prepare failure residue; manifest/skill revocation; parallel Assignment aggregation; Feishu routing; multi-repository same-number isolation; authenticated Tailscale read/write/download/reconnect; mobile 320–430px flow; backup restore; legacy migration; wrong-origin rejection; unknown delivery reconciliation.

- [ ] **Step 2: Run focused suites in dependency order**

  ```bash
  pnpm test -- tests/project-workbench-e2e.spec.ts tests/project-model.spec.ts tests/project-store.spec.ts tests/plans.spec.ts tests/lifecycle.spec.ts
  pnpm test -- tests/execution-context.spec.ts tests/workspace-preparation.spec.ts tests/skill-catalog.spec.ts tests/delegations.spec.ts
  pnpm test -- tests/events.spec.ts tests/collaboration.spec.ts tests/budget.spec.ts tests/feishu-routing.spec.ts tests/delivery-reconciliation.spec.ts
  pnpm test -- tests/project-workbench.spec.tsx tests/http.spec.ts tests/client.spec.tsx
  pnpm typecheck
  pnpm build
  ```

- [ ] **Step 3: Run the real host and tailnet checks**

  Repeat Task 0’s host matrix from the isolated profile, then validate the exact Tailscale HTTPS origin from a real tailnet device. Record authentication, Origin/Host, stream reconnect, file download, wrong-source rejection and Mac offline behavior.

- [ ] **Step 4: Write the acceptance report**

  For each scenario record command, profile/state, timestamp, result, relevant event/attempt/artifact ids, and whether a failure is business logic, host incompatibility or environment setup. Do not label a typecheck as host compatibility or a homepage `200` as authentication success.

- [ ] **Step 5: Commit documentation only after the report is reproducible**

  ```bash
  git add README.md docs/superpowers/specs/2026-11-01-project-superagent-workbench-design.md docs/superpowers/verification/2026-11-01-acceptance-report.md tests/project-workbench-e2e.spec.ts package.json
  git commit -m "docs: record project workbench acceptance matrix"
  ```

## Self-review against the approved design

- **Project and authority:** Tasks 1–4 define Project, ProjectConversation, ProjectKnowledge integration point, Resource, Artifact, ChannelMessage and database authority; Tasks 2 and 13 define schema, backup, restore and legacy boundaries.
- **Plan and lifecycle:** Task 3 covers immutable PlanRevision/Authorization, explicit pause/stop/resume/retry, Attention versioning and aggregate completion.
- **Execution and recovery:** Tasks 5, 6 and 9 cover attempt identity, Session/workspace/cwd, prepare evidence, manifests, skills, subagents, background jobs, leases, budgets and fair scheduling.
- **Channels and notifications:** Task 4 defines Web intake; Task 12 defines per-message Feishu routing, NotificationTarget, Delivery, native receipts and unknown reconciliation; Task 11 namespaces GitHub resources.
- **Web and remote access:** Tasks 8 and 10 cover project-first UI, resources, Artifact downloads, durable events, mobile behavior, exact Origin/Host, authentication and Tailscale.
- **Operations and migration:** Tasks 0, 7, 13 and 14 cover host compatibility, no-GitHub startup, service lifecycle, backups, isolated restore, schema migration and acceptance reporting.
- **Legacy policy boundary:** Tasks 6 and 11 explicitly remove automatic merge, rewrite, force-push, same-tree approval and automatic PR-close assumptions.

## Known verification limits before implementation

- The current checkout’s typecheck passed in the audit phase, but Vitest startup was blocked by the missing Rolldown native/WASI optional binding; implementation must resolve or document that environment issue before claiming tests pass.
- DSH RC host authentication, global skill inheritance, subagent permissions, attachment behavior, client slots and remote streaming require the Task 0 real-host probe; source inspection alone is insufficient.
- Feishu active-send native receipt and reconciliation behavior requires a real authorized bot test; no external message is sent by this plan.
- macOS login/sleep/restart, Tailscale Serve and full backup/restore require the isolated operational drills in Tasks 0, 10 and 13.
