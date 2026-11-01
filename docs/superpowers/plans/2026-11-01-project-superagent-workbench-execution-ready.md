# Project Superagent Workbench Execution-Ready Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变项目型 Superagent 工作台既定产品架构的前提下，把宿主兼容性门、项目实现任务和外部自动分发机制拆成可独立验收、可恢复、可并行执行的任务图。

**Architecture:** 本计划保留 approved design 中的数据库业务事实、DSH Session 执行现场、项目归属、PlanRevision/Authorization、Assignment/attempt、Web 与飞书统一入口以及三个增量。新增的 dispatcher 是运行在 Superagent 进程之外的操作工具：它读取版本化任务 DAG，观察 GitHub PR 和 Superagent Ticket 状态，向现有飞书入口提交依赖已满足的任务；它不修改 Superagent Runtime、Engine、Source 或管理 API。

**Tech Stack:** TypeScript ESM、Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`、SQLite `node:sqlite`、Vitest、React 18、现有 DSH `^0.2.1-alpha.2` 插件接口、现有 Effects/Outbox/Source/Channel/Session 适配层、Node 内置 `fetch`、GitHub CLI、独立 Feishu OAuth 客户端。

**Spec:** `docs/superpowers/specs/2026-11-01-project-superagent-workbench-design.md`；源码事实和复用边界见 `docs/superpowers/specs/2026-11-01-superagent-prototype-reuse-audit.md`；原始架构实现蓝图见 `docs/superpowers/plans/2026-11-01-project-superagent-workbench.md`。

**Relationship to the original plan:** 本文件只重排执行顺序、补齐任务边界和定义仓库外运行的分发工具；它不替换产品架构设计。dispatcher 的 manifest 与源代码可以在仓库 `ops/` 中版本化，但运行时是独立进程，不进入 DSH bundle、不导入 `src/`。执行本文件时，原始 plan 的架构接口、数据归属和产品范围继续有效；原始 plan 的 Task 0、全局发布门、任务依赖和交付顺序以本文件为准。

## Global Constraints

- 应用数据库仍是项目业务事实的唯一权威；DSH Session 只保存模型与工具执行现场；`.superagent/` 只保存可重建清单。
- 所有 Task、PlanRevision、Authorization、Assignment、attempt、Resource、Artifact、ChannelMessage、Attention、Delivery 和缓存都必须有明确项目归属。
- `PlanRevision` 不可变；`Authorization` 必须绑定方案版本、稳定 actor 和确认意图，幂等不能只依赖原生 messageId。
- worker 是正式 Assignment；subagent 有父子记录、范围交集和预算；Increment 1 的 subagent 入口在安全合同完成前必须 disabled/fail-closed。
- 首版继续以单 Mac、Tailscale 私网、手机 Web、一个 Superagent bot 和一对一飞书私聊为目标；不做公网入口、自动合并 PR、自动发表研究结论或云端离线执行。
- GitHub 是可选项目资源；无 GitHub 的项目必须完成讨论、确认、文件任务、Artifact 登记和恢复。
- 现有 KORAM 运行状态、旧 profile 和 `docs/superpowers/plans/2026-11-01-superagent-setup.md` 保持隔离；任何 implementation PR 不得加入该历史部署记录。
- 每项代码任务遵循失败测试 → 最小实现 → 局部测试 → 独立 commit；任务必须声明确切文件、接口、验收命令和依赖。
- 兼容性状态必须区分 `passed`、`failed`、`unsupported`、`untested` 和 `not_applicable`；fixture 通过不能冒充真实宿主通过。
- 只有使用某项宿主能力的消费者受该能力门禁；纯领域类型、事务存储和不依赖未验证能力的工作不被后续浏览器、附件或远程流能力阻塞。
- 发布门不允许永久停留在 `blocked`：每个失败能力必须记录受影响消费者、修复任务、负责人、重测命令和重新进入条件。
- dispatcher 不读取或改写 Superagent 内部 SQLite，不调用不存在的“创建 Ticket”管理 API，不注入应用 Runtime；它只通过现有受信入口提交任务，并通过只读观察接口确认状态。
- dispatcher 的 OAuth refresh token、Feishu app secret、GitHub token、state cache 和本机路径不得进入 Git；仓库中的 manifest 和任务正文不得包含本机绝对路径、秘密或私有部署信息。
- 默认推荐外部 dispatcher 使用独立 Feishu OAuth 用户身份发送任务；它与当前 bot-only `lark-bot` 使用不同配置，不修改 `src/sources/feishu.ts`。若不允许额外用户身份，则必须采用第二个 Feishu bot + `include_bot` 权限 + 狭窄 auto policy；若连入口配置也不允许，自动派发不可实现。

## Current Dispatch Boundary and Decision

当前管理 API 只有状态、Ticket/Thread/Decision 查询、retry、stop、pause、settings 和 prompts 路由，没有 create-ticket、ingest-trigger 或 dispatch 路由。当前 Feishu trigger 会过滤 Superagent 自己发送的 bot 消息；GitHub Source 当前关闭 Issue、PR 和 comment 监听。因而“只运行一个本地脚本、完全不改变凭证或入口配置”不能自动制造可执行 Ticket。

本计划采用以下运行合同：

1. `ops/workbench-dispatch/manifest.yaml` 是人工审阅过的任务 DAG，列出每个任务的 prompt、文件范围、验收命令、依赖、所需能力和完成证据。
2. dispatcher 只选择所有依赖都达到 `merged` 且所需 capability 已达到 `passed` 或明确批准的 `amber` 的任务。
3. dispatcher 在飞书私聊中发送带 `[WB-DISPATCH:<task-id>]` 标记、任务全文和 `@KORAM-Robot` 的消息。发送方是已被当前 Feishu Policy 允许的用户身份，因此现有 `observe` 模式和 allowed human list 不需要改变。
4. dispatcher 保存 Feishu 原生 message id、发送幂等键、任务状态和时间戳；同一 task id 在 `sent`、`accepted`、`working`、`blocked` 或 `merged` 状态下不得重复发送。
5. dispatcher 通过 `GET http://127.0.0.1:3082/orchestrator/api/tickets` 和 Ticket detail 只读确认 Ticket 是否已创建、是否 working/blocked；通过 `gh-agent` 查询 PR 的 `mergedAt`、merge commit 和 base branch。PR `closed` 但未合并不得满足依赖。
6. worker 仍然由 Superagent 执行；dispatcher 不代替 worker，不直接写代码，不自动合并 PR，不自动绕过 blocked gate。

外部 Feishu 用户发送需要 `im:message` 与 `im:message.send_as_user` 权限，并使用独立 OAuth 配置。消息创建应使用稳定 idempotency UUID；正式 canary 需要确认当前用户身份、chat、bot mention、message id 去重和 Superagent Ticket 关联。官方事件文档说明群聊中接收其他机器人 @mention 需要 `im:message.group_at_msg.include_bot:readonly`；这属于第二个 bot 方案的验证项，不是默认方案。参考：[接收消息事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/receive.md) 与 [发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create.md)。

## File Map Before Tasks

### Product implementation files

沿用原始 plan 中的 `src/core`、`src/app`、`src/executor`、`src/sources`、`src/client` 和 `tests` 文件边界。下面的任务只拆分原始 plan 中已经确认的职责，不改变模块职责或产品架构。

### Host probe files

- Create: `scripts/host/record-toolchain.mjs` — 记录 Node、CPU、pnpm、DSH CLI、依赖锁文件摘要和 native optional dependency 状态。
- Create: `scripts/host/run-isolated-probe.mjs` — 创建临时 `DSH_HOME`、profile、state、workspace、端口和清理钩子，禁止外部发送。
- Create: `scripts/host/probe-host-plugin.ts` — 不启动 Superagent Runtime 的最小 DSH host probe plugin。
- Create: `scripts/host/probe-schema.json` — 规定每项 capability 的证据格式。
- Create: `tests/host-toolchain.spec.ts`、`tests/host-probe-launcher.spec.ts`、`tests/native-session-probe.spec.ts`、`tests/native-skill-probe.spec.ts`、`tests/native-web-probe.spec.ts`。
- Create: `docs/superpowers/verification/2026-11-01-host-compatibility.md` — 记录事实、失败边界、影响消费者、修复任务和重测命令。

### External dispatcher files

这些文件位于仓库的 `ops/` 下，但不进入 DSH bundle、不导入 `src/`、不改变现有 Runtime。它们使用 Node 内置 `fetch` 和现有 `gh-agent`，不新增生产依赖。

- Create: `ops/workbench-dispatch/manifest.yaml` — 版本化任务 DAG；每个 task id 只出现一次。
- Create: `ops/workbench-dispatch/manifest.schema.json` — 校验依赖无环、状态枚举和必填字段。
- Create: `ops/workbench-dispatch/src/model.ts` — `DispatchTask`、`DispatchState`、`CapabilityState`、`DeliveryRecord`。
- Create: `ops/workbench-dispatch/src/manifest.ts` — 读取、校验和拓扑排序 manifest。
- Create: `ops/workbench-dispatch/src/superagent.ts` — 读取现有 orchestrator API 的 Ticket/State，不发送命令。
- Create: `ops/workbench-dispatch/src/github.ts` — 通过 `gh-agent` 读取 PR merged/base/head/mergeSha；不执行 merge。
- Create: `ops/workbench-dispatch/src/feishu-user.ts` — 调用独立 OAuth user client；禁止读取 `~/.lark-cli-dsh-superagent` bot 配置。
- Create: `ops/workbench-dispatch/src/state.ts` — 原子写入外部 state 文件，保存发送和观测记录，不保存 token。
- Create: `ops/workbench-dispatch/src/engine.ts` — 根据依赖、capability、Ticket 和 PR 证据计算 ready/blocked/complete。
- Create: `ops/workbench-dispatch/src/main.ts` — `--once`、`--watch`、`--dry-run`、`--reconcile` 命令。
- Create: `ops/workbench-dispatch/tests/*.spec.ts` — manifest、依赖、幂等、PR 合并判断、Ticket 状态、Feishu payload 和失败恢复测试。
- Create: `ops/workbench-dispatch/README.md` — 凭证、首次 canary、systemd/launchd 运行、暂停和恢复。
- Modify: `.gitignore` — 忽略 dispatcher state、OAuth cache、probe 临时目录和日志。

## Dependency Graph and Release Gates

```text
0A toolchain
 └─ 0B isolated launcher
     ├─ 0C native Session/Workspace
     ├─ 0D native skills/permissions
     └─ 0E native web/auth/transport

0A ──┬─ 1A contracts ── 1B stores + migration safeguards ── 1C authorization ── 1D lifecycle
     │                                      ├─ 1E no-GitHub boot ── 1F preparation ── 1G report/Artifact
     │                                      ├─ 1I intake/coordinator ── 1J knowledge/conventions
     │                                      └─ 1L backup/recovery ── Increment 1 acceptance
     └─ D0 manifest/model ── D1 sender canary ── D2 dispatcher ── D3 reconciliation

1B + 0C + 1H ── 1I ── 1K Web/API/notification
1G + 1I + 1K + 1L ── Increment 1 release gate

Increment 2: 2A resources; 2B durable events; 2C collaboration; 2E budgets/scheduler;
             2D subagents; 2F repositories; 2G remote Web/Tailscale
Increment 3: 3A identity/targets; 3B routing; 3C delivery receipts;
             3D attachments; 3E cross-channel acceptance
```

A task becomes dispatchable only when:

- all `depends_on` tasks have a merged PR on the declared base branch;
- any required `capabilities` are `passed`, or the task explicitly declares an approved `amber` workaround;
- the previous attempt for the same task is stopped, completed, or reconciled;
- no unresolved Attention or manual decision is attached;
- the task's files and acceptance commands are present in the manifest;
- the dispatcher can identify a unique task marker and expected PR head branch.

A release gate is `green` only when all required consumer tasks and their acceptance matrix pass. `blocked` creates or points to a concrete repair task; it is never treated as a successful prerequisite. A later increment may proceed with unrelated pure-domain work only when its consumer-specific capability gate is satisfied.

---

### Task 0A: Reproduce and bound local toolchain readiness

**Files:**
- Create: `scripts/host/record-toolchain.mjs`
- Create: `tests/host-toolchain.spec.ts`
- Create: `docs/superpowers/verification/2026-11-01-toolchain.md`
- Modify: `pnpm-lock.yaml` only if a reproduced optional/native dependency failure requires a lockfile change

**Interfaces:**
- Consumes: `package.json`, `pnpm-lock.yaml`, current Node/pnpm/DSH installation.
- Produces: a JSON/text evidence record containing executable paths, versions, CPU/OS, lockfile hash, package graph, native optional dependency result, exact command and cleanup result.

- [ ] **Step 1: Write the failing evidence test**

  Assert that the record includes `node`, `pnpm`, `dsh`, `cpu`, `lockHash`, `commands`, `status`, and one status per `typecheck`, `testStartup`, and `build`; `passed` cannot be inferred from package presence.

- [ ] **Step 2: Run the evidence test**

  Run: `pnpm test -- tests/host-toolchain.spec.ts`

  Expected: FAIL because the record writer does not exist.

- [ ] **Step 3: Implement bounded recording and diagnosis**

  Run `node scripts/host/record-toolchain.mjs --out .superagent-host/toolchain.json` with a 120-second timeout. If Vitest or build fails, record the first native/optional binding failure and the exact repair candidate; do not change dependencies speculatively. A repair may change the lockfile only when the recorded package graph proves it is required.

- [ ] **Step 4: Verify and commit**

  Run: `pnpm test -- tests/host-toolchain.spec.ts`, `pnpm typecheck`, `pnpm build`.

  Commit: `git add scripts/host/record-toolchain.mjs tests/host-toolchain.spec.ts docs/superpowers/verification/2026-11-01-toolchain.md pnpm-lock.yaml && git commit -m "test: record host toolchain readiness"`.

**Exit condition:** local commands either pass or have a named finite repair task with an owner, affected consumers and a retest command. This task does not claim DSH host capability compatibility.

### Task 0B: Build the isolated host probe launcher

**Files:**
- Create: `scripts/host/run-isolated-probe.mjs`
- Create: `scripts/host/probe-host-plugin.ts`
- Create: `scripts/host/probe-schema.json`
- Create: `tests/host-probe-launcher.spec.ts`
- Modify: `docs/superpowers/verification/2026-11-01-host-compatibility.md`

**Interfaces:**
- Consumes: Task 0A toolchain record and installed DSH RC packages.
- Produces: `ProbeContext { profile, dshHome, stateDir, workspace, port, outboundDisabled, startedAt }` and evidence entries `{ capability, status, command, expected, actual, host, context, cleanup }`.

- [ ] **Step 1: Test isolation and cleanup**

  Assert that the launcher creates a fresh temporary state/profile/workspace, chooses a port outside `53818` and `3082`, sets outbound delivery disabled, records the context, kills its child process on timeout, and removes only its own temporary directory.

- [ ] **Step 2: Implement host-only startup**

  Launch `probe-host-plugin.ts` directly against the DSH host. Do not import `src/app/runtime.ts`, `src/setup.ts` or any business Source. Use a 120-second timeout and an exit record even when startup fails.

- [ ] **Step 3: Verify repeatability**

  Run twice: `node scripts/host/run-isolated-probe.mjs --capability launcher --json .superagent-host/launcher.json`. Assert the two runs use different state/workspace paths and neither changes the operator profile, KORAM state or current `superagent` profile.

- [ ] **Step 4: Commit**

  Run: `pnpm test -- tests/host-probe-launcher.spec.ts` and commit the launcher, schema, test and verification update.

**Exit condition:** every native probe can run independently, time out, clean up, and produce machine-readable evidence. A full application boot is not a valid substitute for this launcher.

### Task 0C: Probe native Session, Workspace and permission persistence

**Files:**
- Create: `tests/native-session-probe.spec.ts`
- Modify: `scripts/host/probe-host-plugin.ts`
- Modify: `docs/superpowers/verification/2026-11-01-host-compatibility.md`

**Interfaces:**
- Consumes: Task 0B `ProbeContext`.
- Produces: evidence for Session create/reopen after host restart, actual workspace/cwd, permission preset, mismatched mapping rejection and cleanup.

- [ ] **Step 1:** Write assertions for create, persist, stop host, reopen, verify cwd/realpath, and reject a mismatched workspace.
- [ ] **Step 2:** Run `pnpm test -- tests/native-session-probe.spec.ts` and record the initial failure.
- [ ] **Step 3:** Add the smallest host-only probe command; do not add application workarounds for a missing host feature.
- [ ] **Step 4:** Run the probe twice and record `passed`, `failed`, `unsupported` or `untested` with affected consumers and repair task.
- [ ] **Step 5:** Commit `test: verify native session workspace persistence`.

**Gate:** Tasks that create/resume Sessions require `0C=passed`; pure domain/storage tasks do not.

### Task 0D: Probe native skills, global visibility and permission inheritance

**Files:**
- Create: `tests/native-skill-probe.spec.ts`
- Modify: `scripts/host/probe-host-plugin.ts`
- Modify: `docs/superpowers/verification/2026-11-01-host-compatibility.md`

**Interfaces:**
- Consumes: Task 0B `ProbeContext` and installed Skill/permission packages.
- Produces: observed results for skill registration/read, global skill suppression, descendant permission inheritance and denied out-of-scope read.

- [ ] **Step 1:** Write assertions that distinguish declared types from observed behavior.
- [ ] **Step 2:** Run the focused test and record failure.
- [ ] **Step 3:** Implement the host-only probe with no application catalog.
- [ ] **Step 4:** Record exact skill body/version and permission observation; keep later application-level catalog enforcement in Task 1H.
- [ ] **Step 5:** Run focused tests and commit `test: verify native skill and permission behavior`.

**Gate:** Task 1H and executable worker context require only the specific native capabilities they consume; subagent entrypoints remain disabled until Task 2D.

### Task 0E: Probe native browser bundle, slots, local auth and transport

**Files:**
- Create: `tests/native-web-probe.spec.ts`
- Modify: `scripts/host/probe-host-plugin.ts`
- Modify: `tsdown.config.ts` only if evidence requires a bundle declaration change
- Modify: `docs/superpowers/verification/2026-11-01-host-compatibility.md`

**Interfaces:**
- Consumes: Task 0B launcher and installed webserver/client packages.
- Produces: separate evidence for bundle injection, client slots, valid authenticated write, unauthenticated write rejection, exact wrong-origin rejection and selected native SSE/WS handshake/reconnect.

- [ ] **Step 1:** Write tests that reject a result caused solely by a missing header as proof of authentication.
- [ ] **Step 2:** Run the focused test and record failure.
- [ ] **Step 3:** Add the minimal local probe client using a temporary profile; do not claim Tailscale or application durable replay.
- [ ] **Step 4:** Test valid write, unauthenticated write, wrong origin and native reconnect; record selected transport and exact response/status.
- [ ] **Step 5:** Commit `test: verify native web and transport capabilities`.

**Gate:** Web/API consumers require the local auth result; durable replay remains gated by Task 2B and real Tailscale behavior by Task 2G. Attachments are gated by their consumer task and are not falsely marked green here.

### Task 1A: Define project, attempt, lease, report and authority contracts

**Files:**
- Create: `src/core/project-model.ts`
- Create: `src/core/project-ids.ts`
- Create: `src/core/attempts.ts`
- Create: `src/core/reports.ts`
- Modify: `src/core/index.ts`
- Create: `tests/project-model.spec.ts`
- Create: `tests/attempts.spec.ts`

**Interfaces:**
- Consumes: existing `ActorRef`, `ChannelRef`, `Ticket`, `Assignment`, `Attention`, `Trigger` and `Repositories` types.
- Produces: `ProjectId`, `TaskId`, `PlanRevisionId`, `AuthorizationId`, `AssignmentId`, `AttemptId`, `LeaseId`, `ArtifactId`, `Attempt`, `Lease`, `ExecutionReport`, `ReportEffect` and project ownership validators.

- [ ] **Step 1:** Write failing tests for stable ids, project ownership, lease freshness, stale report rejection and report immutability.
- [ ] **Step 2:** Run `pnpm test -- tests/project-model.spec.ts tests/attempts.spec.ts` and verify failure.
- [ ] **Step 3:** Implement branded ids and runtime validators without database access.
- [ ] **Step 4:** Run focused tests and `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat: define project execution contracts`.

### Task 1B: Add transactional stores with pre-migration snapshot and rollback

**Files:**
- Modify: `src/app/migration.ts`
- Modify: `src/app/store.ts`
- Modify: `src/kv.ts`
- Create: `src/app/project-store.ts`
- Create: `src/app/channel-store.ts`
- Create: `src/app/artifact-store.ts`
- Create: `src/app/backup.ts`
- Create: `tests/project-store.spec.ts`
- Modify: `tests/migration.spec.ts`, `tests/store.spec.ts`

**Interfaces:**
- Consumes: Task 1A contracts and existing atomic/outbox behavior.
- Produces: schema 12 project/channel/artifact/attempt tables, `ProjectStore`, `ChannelStore`, `ArtifactStore`, pre-migration snapshot metadata and rollback result.

- [ ] **Step 1:** Test schema 11→12 migration, duplicate source/account/native event identity, project routing uniqueness, rollback on injected failure and backup restore into an isolated state with outbound delivery disabled.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Add schema and indexes while preserving legacy tables; define source event identity separately from project mapping.
- [ ] **Step 4:** Implement atomic stores and snapshot/rollback before changing the schema version.
- [ ] **Step 5:** Run focused tests, typecheck and commit `feat: persist project execution records safely`.

### Task 1C: Implement immutable PlanRevision and Authorization idempotency

**Files:**
- Create: `src/core/plans.ts`
- Modify: `src/core/intake.ts`, `src/app/project-store.ts`
- Create: `tests/plans.spec.ts`, `tests/authorization.spec.ts`

**Interfaces:**
- Consumes: Task 1A ids and Task 1B stores.
- Produces: `confirmPlan`, `revokePlan`, `sameOperationResult`, immutable PlanRevision and Authorization records.

- [ ] **Step 1:** Test duplicate confirmations with changed message ids, conflicting client operation ids, expired/superseded revisions, run-again creating a new intent and unverified actor rejection.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement transactionally idempotent confirmation and explicit intent records.
- [ ] **Step 4:** Run tests and commit `feat: persist immutable plan authorization`.

### Task 1D: Implement pause, stop, resume, retry and Attention lifecycle

**Files:**
- Create: `src/core/lifecycle.ts`
- Modify: `src/core/tickets.ts`, `src/core/assignments.ts`, `src/app/project-store.ts`
- Create: `tests/lifecycle.spec.ts`, `tests/attention.spec.ts`

**Interfaces:**
- Consumes: Task 1A–1C contracts.
- Produces: versioned Attention questions, atomic answer+Effect, pause/stop/resume/retry transitions and stale attempt/lease guards.

- [ ] **Step 1:** Test pause across restart, stopped task refusing new work, stale report rejection, Attention answer idempotency and retry creating a new attempt.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement state transitions and version checks.
- [ ] **Step 4:** Run tests and commit `feat: persist execution lifecycle`.

### Task 1E: Remove the mandatory GitHub startup dependency

**Files:**
- Modify: `src/deployment.ts`, `src/app/setup.ts`, `src/app/runtime.ts`
- Create: `tests/no-github-startup.spec.ts`

**Interfaces:**
- Consumes: Task 1B stores and Task 0C native Session evidence.
- Produces: instance readiness independent of GitHub; project resource readiness checked only when a task consumes that resource; missing Feishu/GitHub reports `not_ready` without blocking local discussion.

- [ ] **Step 1:** Write a failing no-GitHub boot test with no source credentials.
- [ ] **Step 2:** Run `pnpm test -- tests/no-github-startup.spec.ts tests/runtime.spec.ts` and verify current setup gate failure.
- [ ] **Step 3:** Move setup checks that are resource-specific after base runtime/session installation; keep existing operator profile isolation.
- [ ] **Step 4:** Run focused tests and commit `fix: allow project runtime without github resource`.

### Task 1F: Implement one Assignment preparation and Session mapping

**Files:**
- Create: `src/app/execution-attempts.ts`
- Modify: `src/executor/dsh.ts`, `src/app/sessions.ts`, `src/app/workspaces.ts`
- Create: `tests/attempt-preparation.spec.ts`

**Interfaces:**
- Consumes: Tasks 0C, 1A, 1B and 1D.
- Produces: `prepareAttempt`, `PreparationEvidence`, workspace/cwd/realpath checks, Session mapping and fail-closed residue handling.

- [ ] **Step 1:** Test independent cwd, valid prepare evidence, mismatched Session mapping, failed prepare residue and no blind reuse.
- [ ] **Step 2:** Run focused test and verify failure.
- [ ] **Step 3:** Implement preparation and Session binding with explicit attempt id.
- [ ] **Step 4:** Run tests and commit `feat: bind attempts to verified workspaces`.

### Task 1G: Persist reports, validate Artifacts and complete the single-worker slice

**Files:**
- Create: `src/app/report-acceptance.ts`
- Modify: `src/core/assignments.ts`, `src/app/artifact-store.ts`, `src/executor/dsh.ts`
- Create: `tests/report-acceptance.spec.ts`, `tests/artifact-recovery.spec.ts`

**Interfaces:**
- Consumes: Tasks 1A, 1C, 1D and 1F.
- Produces: `acceptExecutionReport`, `validateArtifactOwnership`, completion aggregation for one Assignment and stale-report rejection.

- [ ] **Step 1:** Test file-write-before-Artifact-commit interruption, duplicate report, stale attempt report and invalid cross-project Artifact.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement report acceptance and reconciliation without rerunning side effects automatically.
- [ ] **Step 4:** Run tests and commit `feat: accept attempt reports and artifacts safely`.

### Task 1H: Add immutable prompt/skill bodies and fail-closed execution manifests

**Files:**
- Create: `src/app/skill-catalog.ts`, `src/app/skill-bodies.ts`, `src/app/execution-manifests.ts`
- Modify: `src/app/prompts.ts`, `src/app/sessions.ts`, `src/app/tools/tool.ts`
- Create: `tests/skill-catalog.spec.ts`, `tests/execution-manifest.spec.ts`

**Interfaces:**
- Consumes: Task 0D and Task 1A contracts.
- Produces: candidate filtering, authorized body reads, exact prompt/skill body versions, reconstructable `ExecutionContextManifest`; subagent entrypoints return disabled until Task 2D.

- [ ] **Step 1:** Test revoked/out-of-role reads, global path leakage, exact body restoration after restart and manifest mismatch.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement catalog/body separation and server-side read checks.
- [ ] **Step 4:** Run tests and commit `feat: persist scoped execution manifests`.

### Task 1I: Implement project intake, coordinator replacement and completed messages

**Files:**
- Modify: `src/core/intake.ts`, `src/core/engine.ts`
- Create: `src/app/project-coordinator.ts`, `src/app/conversation-store.ts`
- Modify: `src/app/http.ts`
- Create: `tests/project-intake.spec.ts`, `tests/coordinator-recovery.spec.ts`

**Interfaces:**
- Consumes: Tasks 1B–1H and existing Web/Source adapters.
- Produces: normalized `ChannelMessage`, project resolution, durable user and completed assistant messages, draft-vs-saved distinction, single coordinator writer and replacement recovery.

- [ ] **Step 1:** Test duplicate input, unresolved project, assistant finalization before UI saved state, coordinator crash and replacement without two decision writers.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement intake transaction and coordinator persistence.
- [ ] **Step 4:** Run tests and commit `feat: persist project conversation authority`.

### Task 1J: Implement ProjectKnowledge and conventions versions

**Files:**
- Create: `src/core/knowledge.ts`, `src/app/knowledge-store.ts`
- Modify: `src/app/resources.ts`, `src/client/project-conventions.tsx`
- Create: `tests/knowledge.spec.ts`, `tests/conventions.spec.ts`

**Interfaces:**
- Consumes: Task 1B and Task 1I.
- Produces: immutable confirmed knowledge versions, source message provenance, manual edit pending state and shared normalized message view.

- [ ] **Step 1:** Test confirmation, supersession, source provenance and unconfirmed manual edits.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement versioned store and acceptance operation.
- [ ] **Step 4:** Run tests and commit `feat: version project knowledge and conventions`.

### Task 1K: Add minimal authenticated project API, Web notifications and UI

**Files:**
- Modify: `src/app/api.ts`, `src/app/http.ts`, `src/app/notifications.ts`
- Create: `src/client/project-home.tsx`, `src/client/project-conversation.tsx`, `src/client/project-task.tsx`
- Modify: `src/client/route.ts`, `src/client/app.tsx`, `src/client/api.ts`
- Create: `tests/project-panel.spec.tsx`, `tests/http-project.spec.ts`

**Interfaces:**
- Consumes: Tasks 0E, 1G, 1I and 1J.
- Produces: authenticated project list/conversation/task/artifact routes, Web notification records and mobile-safe minimal workflow.

- [ ] **Step 1:** Test authenticated read/write, wrong origin, project isolation and saved assistant state.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement minimal API and UI; do not add Feishu routing here.
- [ ] **Step 4:** Run tests, typecheck and commit `feat: deliver authenticated project workbench slice`.

### Task 1L: Add Increment 1 backup, isolated restore and fault acceptance

**Files:**
- Modify: `src/app/backup.ts`, `src/app/runtime.ts`
- Create: `tests/increment1-recovery.spec.ts`, `tests/increment1-acceptance.spec.ts`
- Create: `docs/superpowers/verification/2026-11-01-increment1.md`

**Interfaces:**
- Consumes: Tasks 1B, 1D, 1F–1K.
- Produces: restore of DB, run files, manifests and prompt/skill bodies into outbound-disabled isolated state; no replay of legacy Effects/Outbox; two-project acceptance report.

- [ ] **Step 1:** Test pause/restart, prepare failure, file/Artifact interruption, isolated restore and no external delivery.
- [ ] **Step 2:** Run acceptance and record each scenario as pass/fail/blocked/not-applicable.
- [ ] **Step 3:** Fix only failures owned by Increment 1; create a named repair task for later capability failures.
- [ ] **Step 4:** Commit `test: accept increment one recovery boundaries`.

**Increment 1 release gate:** no GitHub project can create and complete one authorized file task with Artifact and Web notification; two projects remain isolated; restart requires evidence review; backup restore does not run work or send notifications; all required local capabilities are green.

---

### Task 2A: Add project resources, snapshots and authorized cache access

**Files:**
- Modify: `src/app/resources.ts`, `src/app/execution-environment.ts`
- Create: `src/app/resource-snapshots.ts`, `tests/resource-isolation.spec.ts`

**Interfaces:**
- Consumes: Increment 1 project and attempt contracts.
- Produces: project-scoped directory/repository/data/service resources, stable snapshots, authorized cache reads and missing-resource states.

- [ ] **Step 1:** Test two-project resource and cache isolation.
- [ ] **Step 2:** Implement snapshot and authorization checks.
- [ ] **Step 3:** Run tests and commit `feat: scope project resources and snapshots`.

### Task 2B: Add durable events and replay

**Files:**
- Create: `src/app/events.ts`, `src/app/event-replay.ts`
- Modify: `src/app/store.ts`, `src/app/http.ts`
- Create: `tests/events.spec.ts`, `tests/event-replay.spec.ts`

**Interfaces:**
- Consumes: Task 1B and 1K.
- Produces: durable event sequence, reconnect cursor, replay authorization and gap detection; native transport behavior remains separately evidenced by Task 0E.

- [ ] **Step 1:** Test commit ordering, cursor replay, gap and unauthorized project stream.
- [ ] **Step 2:** Implement event persistence and replay.
- [ ] **Step 3:** Run tests and commit `feat: persist project events and replay cursors`.

### Task 2C: Add multi-Assignment dependency and result aggregation

**Files:**
- Modify: `src/core/assignments.ts`, `src/core/lifecycle.ts`
- Create: `src/core/dependencies.ts`, `src/app/assignment-store.ts`
- Create: `tests/assignment-dependencies.spec.ts`, `tests/aggregation.spec.ts`

**Interfaces:**
- Consumes: Task 1A, 1D, 1G and Task 2B.
- Produces: dependency DAG, lease ownership, blocked/runnable transitions and evidence-based result aggregation.

- [ ] **Step 1:** Test independent parallel assignments, dependency failure, stale lease and aggregate completion.
- [ ] **Step 2:** Implement DAG validation and aggregation.
- [ ] **Step 3:** Run tests and commit `feat: aggregate dependent assignments`.

### Task 2D: Enable scoped subagent registration and result processing

**Files:**
- Modify: `src/app/delegations.ts`, `src/app/skill-catalog.ts`, `src/app/sessions.ts`
- Modify: `src/core/assignments.ts`
- Create: `tests/delegations.spec.ts`, `tests/subagent-scope.spec.ts`

**Interfaces:**
- Consumes: Task 0D, 1H, 2C and the completed Task 2E budget contracts.
- Produces: parent-child delegation, intersected scope, processed result requirement and fail-closed behavior on pause/revoke. Task 2E is the predecessor because it defines the budget contracts consumed here.

- [ ] **Step 1:** Test that disabled entrypoints fail closed before this task's gate, then test parent-child scope and result processing.
- [ ] **Step 2:** Implement registration and lifecycle.
- [ ] **Step 3:** Run tests and commit `feat: record scoped subagent delegations`.

### Task 2E: Add fair scheduling, budgets and background lifecycle

**Files:**
- Create: `src/app/scheduler.ts`, `src/app/budgets.ts`
- Modify: `src/app/passes.ts`, `src/core/assignments.ts`
- Create: `tests/scheduler.spec.ts`, `tests/budgets.spec.ts`

**Interfaces:**
- Consumes: Task 2C.
- Produces: per-project fairness, model/shell/service budgets, background stop confirmation and restart reconciliation. Task 2D consumes these budget contracts, so 2E must complete before 2D.

- [ ] **Step 1:** Test fairness, budget exhaustion, pause and background process confirmation.
- [ ] **Step 2:** Implement scheduler and budget accounting.
- [ ] **Step 3:** Run tests and commit `feat: schedule bounded project work fairly`.

### Task 2F: Add multi-repository identity and KORAM validation

**Files:**
- Modify: `src/deployment.ts`, `src/app/execution-environment.ts`, `src/infra/commands.ts`, `src/infra/environment.ts`, `src/sources/github-trigger.ts`, `src/sources/github.ts`
- Create: `tests/multi-repository.spec.ts`, `tests/github-read.spec.ts`, `tests/environment.spec.ts`

**Interfaces:**
- Consumes: Task 2A and 2C.
- Produces: `(account, resource, owner/repo, native number)` identity, independent cursors/cache and human-reviewable KORAM PR artifact.

- [ ] **Step 1:** Test same issue number in two repositories and a repository bound to two projects.
- [ ] **Step 2:** Implement namespace and environment snapshots.
- [ ] **Step 3:** Run isolated KORAM validation and commit `feat: namespace repository resources`.

### Task 2G: Complete Web collaboration and exact-origin Tailscale acceptance

**Files:**
- Modify: `src/client/*`, `src/app/http.ts`, `src/app/events.ts`
- Create: `tests/tailscale-acceptance.spec.ts`, `docs/superpowers/verification/2026-11-01-tailscale.md`

**Interfaces:**
- Consumes: Tasks 0E, 2A, 2B and 2F.
- Produces: mobile project/task/resource/Artifact views and exact real-origin auth/download/reconnect evidence from a tailnet device.

- [ ] **Step 1:** Test 320–430px navigation and project isolation.
- [ ] **Step 2:** Test exact Origin/Host, authenticated stream/download, wrong-source rejection and reconnect from a real tailnet device.
- [ ] **Step 3:** Commit acceptance evidence and UI changes.

**Increment 2 release gate:** required resources, durable replay, collaboration, scheduler and remote access are independently green; no task uses an unverified remote capability.

---

### Task 3A: Bind verified Feishu identity and NotificationTarget

**Files:**
- Create: `src/app/notification-targets.ts`
- Modify: `src/sources/feishu.ts`, `src/sources/feishu-read.ts`
- Create: `tests/notification-targets.spec.ts`

**Interfaces:**
- Consumes: Task 1I identity/channel records and Task 2B events.
- Produces: stable actor-to-chat binding with ready/not_ready/revoked state and project-scoped target lookup.

- [ ] **Step 1:** Test verified user, wrong actor, revoked target and cross-project chat isolation.
- [ ] **Step 2:** Implement target binding.
- [ ] **Step 3:** Run tests and commit `feat: bind verified notification targets`.

### Task 3B: Implement shared Feishu DM routing and answer correlation

**Files:**
- Modify: `src/sources/feishu-trigger.ts`, `src/sources/feishu-channel.ts`, `src/sources/feishu-read.ts`, `src/app/intake.ts`
- Create: `tests/feishu-routing.spec.ts`

**Interfaces:**
- Consumes: Task 1I, Task 1D and Task 3A.
- Produces: explicit project routing, reply-to Attention/task correlation, unresolved-message storage and duplicate native event handling.

- [ ] **Step 1:** Test known reply, explicit project, ambiguous project, no project, body/reply conflict, duplicate event and unresolved input.
- [ ] **Step 2:** Implement routing and fail-closed unresolved handling.
- [ ] **Step 3:** Run tests and commit `feat: route shared feishu messages by project`.

### Task 3C: Add active delivery, receipts and unknown reconciliation

**Files:**
- Create: `src/app/deliveries.ts`
- Modify: `src/app/notifications.ts`, `src/sources/feishu-channel.ts`, `src/sources/registry.ts`
- Create: `tests/delivery-reconciliation.spec.ts`

**Interfaces:**
- Consumes: Task 3A, 3B and Task 2B.
- Produces: idempotent Delivery with native message id, `pending/sent/unknown/gone/reconciled` state and restart reconciliation.

- [ ] **Step 1:** Test timeout after remote send, duplicate idempotency key, deleted chat and receipt lookup.
- [ ] **Step 2:** Implement delivery state machine.
- [ ] **Step 3:** Run a real authorized bot canary only after the user approves the external send, then commit `feat: reconcile feishu delivery receipts`.

### Task 3D: Add persistent attachments and cross-channel acceptance

**Files:**
- Modify: `src/sources/feishu-image.ts`, `src/app/artifact-store.ts`, `src/app/backup.ts`
- Create: `tests/attachment-ownership.spec.ts`, `tests/cross-channel-acceptance.spec.ts`

**Interfaces:**
- Consumes: Attachment host evidence from its own probe, Task 1G, Task 3B and Task 3C.
- Produces: project/task-owned attachment Artifact, bounded download, backup inventory and Web/Feishu confirmation continuity.

- [ ] **Step 1:** Test attachment ownership, size/type limits, failed download and cross-channel duplicate confirmation.
- [ ] **Step 2:** Implement persistence and reconciliation.
- [ ] **Step 3:** Run tests and commit `feat: persist project attachments safely`.

**Increment 3 release gate:** Web-confirmed work can notify the bound Feishu target; replies resume the correct Attention/task; ambiguous messages wait for selection; duplicate/unknown sends do not duplicate work; attachments remain project-owned.

---

## Dispatcher Implementation Tasks

### Task D0: Define and validate the versioned dispatch manifest

**Files:**
- Create: `ops/workbench-dispatch/manifest.yaml`
- Create: `ops/workbench-dispatch/manifest.schema.json`
- Create: `ops/workbench-dispatch/src/model.ts`, `ops/workbench-dispatch/src/manifest.ts`
- Create: `ops/workbench-dispatch/tests/manifest.spec.ts`

**Interfaces:**
- Consumes: this plan's task graph and the original plan's exact files/commands.
- Produces:

```ts
export type DispatchStatus = 'pending' | 'ready' | 'sent' | 'accepted' | 'working' | 'blocked' | 'pr_open' | 'merged' | 'failed' | 'cancelled'
export interface DispatchTask {
  id: string
  title: string
  prompt: string
  files: { create?: string[]; modify?: string[]; test?: string[] }
  dependsOn: string[]
  capabilities: string[]
  baseBranch: 'dev'
  expectedHead: string
  acceptance: string[]
  verification: string[]
  blockedBy: string[]
}
export interface DispatchState {
  manifestRevision: string
  tasks: Record<string, { status: DispatchStatus; messageId?: string; ticketId?: string; prNumber?: number; updatedAt: string; error?: string }>
}
```

- [ ] **Step 1:** Add manifest entries for 0A–0E, 1A–1L, D0–D3 and later increments with exact dependencies and acceptance commands.
- [ ] **Step 2:** Validate duplicate ids, unknown dependencies, cycles, missing branch/base, missing acceptance and capability names.
- [ ] **Step 3:** Run `node --experimental-strip-types ops/workbench-dispatch/src/manifest.ts --check ops/workbench-dispatch/manifest.yaml` and focused tests.
- [ ] **Step 4:** Commit `ops: add execution dispatch manifest`.

### Task D1: Add external Feishu OAuth sender and canary contract

**Files:**
- Create: `ops/workbench-dispatch/src/feishu-user.ts`
- Create: `ops/workbench-dispatch/src/feishu-canary.ts`
- Create: `ops/workbench-dispatch/tests/feishu-user.spec.ts`
- Create: `ops/workbench-dispatch/README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `FEISHU_DISPATCH_BASE_URL`, `FEISHU_DISPATCH_ACCESS_TOKEN` supplied by an external token helper, `FEISHU_DISPATCH_CHAT_ID`, `FEISHU_AGENT_OPEN_ID`.
- Produces: `sendUserMessage({ chatId, text, idempotencyKey, mentionOpenId }): Promise<{ messageId: string }>`; no token is written to disk by this module.

- [ ] **Step 1:** Test payload JSON, mention entity, UUID idempotency key, refusal when token/config is absent, and no use of bot CLI config.
- [ ] **Step 2:** Implement native message-create request using `user_access_token`; require `im:message` and `im:message.send_as_user` during setup and document refresh lifecycle.
- [ ] **Step 3:** Implement `--dry-run` and a canary that sends only a non-task message to a dedicated test chat; the canary must not include `[WB-DISPATCH:` or mention the production agent.
- [ ] **Step 4:** Verify token expiry, retry-after behavior and duplicate idempotency response.
- [ ] **Step 5:** Commit `ops: add external feishu dispatch sender`.

**Safety:** The sender is separate from `/Users/phlens/.lark-cli-dsh-superagent` and `lark-bot`; it cannot read or alter the Superagent bot secret. No task is sent until the canary proves sender identity and chat membership.

### Task D2: Implement dependency-aware dispatch and idempotent state

**Files:**
- Create: `ops/workbench-dispatch/src/state.ts`, `ops/workbench-dispatch/src/superagent.ts`, `ops/workbench-dispatch/src/github.ts`, `ops/workbench-dispatch/src/engine.ts`, `ops/workbench-dispatch/src/main.ts`
- Create: `ops/workbench-dispatch/tests/engine.spec.ts`, `ops/workbench-dispatch/tests/idempotency.spec.ts`

**Interfaces:**
- Consumes: Task D0 manifest, Task D1 sender, read-only orchestrator API, `gh-agent` JSON output.
- Produces: `--once`, `--watch`, `--dry-run`, `--reconcile`; `computeReadyTasks()`; `dispatchReadyTasks()`; atomic state updates.

- [ ] **Step 1:** Test that a task is not ready when a dependency PR is merely open or closed-unmerged; require `mergedAt`, base `dev`, expected head and merge SHA.
- [ ] **Step 2:** Test max three in-flight tasks, one message per task, restart after send-before-state-write, duplicate polling, blocked Ticket and explicit manual Attention.
- [ ] **Step 3:** Implement read-only state readers and ready computation; treat `paused`, `blocked`, `unknown`, missing and contradictory evidence as no-dispatch.
- [ ] **Step 4:** Implement Feishu message with task id, goal, exact files, dependencies, acceptance commands, branch/base, no-adjacent-scope rule and expected PR evidence.
- [ ] **Step 5:** Atomically persist `messageId` before considering the task dispatched; if send result is unknown, mark `unknown` and reconcile by message id before retry.
- [ ] **Step 6:** Run `node --experimental-strip-types ops/workbench-dispatch/src/main.ts --dry-run --once` and focused tests; commit `ops: dispatch dependency-ready work safely`.

### Task D3: Add reconciliation, launchd operation and stop controls

**Files:**
- Modify: `ops/workbench-dispatch/src/main.ts`, `ops/workbench-dispatch/src/state.ts`
- Create: `ops/workbench-dispatch/launchd/com.phlens.superagent-dispatch.plist.example`
- Create: `ops/workbench-dispatch/tests/reconcile.spec.ts`
- Modify: `ops/workbench-dispatch/README.md`

**Interfaces:**
- Consumes: Task D2 state and current service read-only API.
- Produces: restart-safe reconciliation, `--pause`, `--resume`, `--stop-task`, `--status`, log rotation and launchd example with no embedded secrets.

- [ ] **Step 1:** Test state recovery after process termination at each send/observe/write boundary.
- [ ] **Step 2:** Implement reconciliation that checks Ticket marker, PR merge evidence and Feishu message id before retry.
- [ ] **Step 3:** Add launchd example using environment file/keychain token helper and a 30-second/one-minute polling interval; do not enable it automatically.
- [ ] **Step 4:** Run `--dry-run`, status and reconciliation tests; commit `ops: make task dispatcher restart safe`.

### Task D4: Run dispatcher canary and enable automatic task flow

**Files:**
- Modify: `ops/workbench-dispatch/README.md`
- Create: `docs/superpowers/verification/2026-11-01-dispatcher-canary.md`

**Interfaces:**
- Consumes: Tasks D0–D3 and the deployed service's read-only state.
- Produces: one sanitized canary record proving a task message creates exactly one Ticket and that the next dependency is withheld until the expected PR is merged.

- [ ] **Step 1:** Run dry-run against the current Ticket list and verify no external message is sent.
- [ ] **Step 2:** Send exactly one approved 0A dispatch message through the external user identity; include no local absolute path or secret.
- [ ] **Step 3:** Observe the new Ticket and record trigger/message/ticket correlation.
- [ ] **Step 4:** Simulate open, closed-unmerged, merged and blocked dependency states; verify only merged unlocks the next task.
- [ ] **Step 5:** Run the dispatcher in watch mode with max three in-flight tasks; record pause and restart recovery.
- [ ] **Step 6:** Commit only the sanitized verification record and documentation.

**Dispatcher acceptance:** User no longer needs to send individual task messages. The dispatcher sends at most three independent ready tasks, waits for dependency evidence, never retries unknown sends blindly, never dispatches a blocked capability consumer, and can be paused without touching Superagent runtime state.

## Operational Ordering

1. Complete 0A and 0B first. If 0A exposes a finite toolchain repair, complete that repair before any host-dependent task.
2. In parallel after 0A, dispatch 1A, 1B and D0; D0 does not wait for product schema work.
3. Complete 0C–0E independently after 0B. A failed capability creates a repair task and only gates its consumers.
4. Complete D1 canary before D2 can send any task. Do not use the current bot-only CLI as the dispatcher sender.
5. After D2/D3 are validated, the dispatcher may issue 0C, 0D, 0E, 1A, 1B and other ready tasks according to capabilities and dependencies.
6. Do not dispatch Task 1E until 0C and 1B are merged; do not dispatch Web consumers until 0E is passed; do not dispatch durable replay consumers until 2B is merged.
7. At each increment gate, run the listed acceptance task and update the capability/dependency state before opening the next increment.
8. A worker's `ready` report or open PR is not completion. A dependency completes only when the expected PR is merged into `dev` and its verification evidence is present.

## Self-Review Against the Approved Design

- **Architecture unchanged:** database authority, DSH execution context, project isolation, immutable authorization, Web-first workbench, optional GitHub, and shared Feishu DM remain unchanged.
- **Task 0 repaired:** toolchain, isolated launcher and native probes are separate; no full Runtime startup dependency; failures have finite repair tasks and consumer-specific gates.
- **Increment 1 repaired:** contracts, migration safety, no-GitHub boot, one-worker report/artifact, knowledge, UI, backup and recovery are independently reviewable.
- **Increment 2 repaired:** resources, events, collaboration, subagents, budgets, repositories and remote access are separated by testable deliverable.
- **Increment 3 repaired:** identity, routing, delivery reconciliation and attachments are separated; real external delivery requires a canary.
- **Dispatch repaired:** the current system remains unchanged; the external dispatcher supplies the missing task compiler, dependency resolver, and message delivery loop. Existing management API remains read-only.
- **Recovery repaired:** migration snapshots precede schema changes; Increment 1 already restores an outbound-disabled isolated state; later increments extend backup inventories.
- **No hidden claims:** native host evidence, application enforcement, durable replay and Tailscale behavior are recorded by their own tasks rather than inferred from types or package presence.

## Verification Limits and Explicit Non-Goals

- Without an external Feishu user identity or a separately configured dispatcher bot accepted by a narrow policy rule, automatic task submission cannot work with the current API and current bot self-message filtering. This is an operational prerequisite, not an implementation detail that a worker can solve inside a normal task.
- The external dispatcher does not make Feishu invisible; it removes manual user message entry. If the requirement is to send no Feishu messages at all, the Superagent intake must gain a new authenticated task-ingest endpoint or Source, which would violate the current no-core-change constraint and requires a separate design decision.
- The dispatcher never publishes local paths, secrets or historical deployment details to a public GitHub repository or Feishu task message.
- No implementation task from this plan has been executed by writing this document.
