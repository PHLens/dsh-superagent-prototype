# T5 Backup and Attention Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable backup scheduling and safe independent restore, then make a successful versioned Attention answer trigger exactly one durable continuation.

**Architecture:** Extend the existing settings revision path with a narrow backup block and connect it to a focused `BackupService` that owns one scheduler and one in-flight operation. Reuse `src/app/backup.ts` for WAL-consistent recovery points and inert restore profiles. Add a durable continuation request keyed by the resolved answer and current execution lease, with executor fences checked before dispatch.

**Tech Stack:** TypeScript ESM, Node `node:sqlite`, Vitest, Cordis HTTP, existing Store/Settings/Runtime/Executor APIs.

**Spec:** `docs/superpowers/specs/2026-11-03-t5-backup-attention-design.md`

## Global Constraints

- Reuse `src/app/backup.ts`; do not add a task engine or a second database.
- Backup points use the canonical `orchestrator.sqlite` name and committed WAL state.
- Restore rejects traversal, symlink, incomplete, hash-mismatched, and credential-bearing inputs before writing.
- Restored profiles disable model, dispatch, outbound send, manual receive/pump, settings mutation, and tool entry points.
- Attention answers bind to exact `questionId + version`.
- Duplicate answers, receipts, or uncertain network results must not create a second continuation.
- Pause, stop, reconciliation, attempt, and lease fences remain authoritative.
- Existing lifecycle, reconciliation, backup, UI, typecheck, build, and full regression suites must continue passing.

---

### Task 1: Add backup settings contract

**Files:**
- Modify: `src/policy.ts:99-109`
- Modify: `src/app/settings.ts:32-53,109-140`
- Modify: `src/kv.ts:21-30` only if a persisted backup run record is needed
- Test: `tests/settings.spec.ts`

**Interfaces:**
- Produces `Settings.backup: { enabled: boolean; directory: string; intervalMinutes: number; retention: number }` with defaults `{ enabled: false, directory: '', intervalMinutes: 1440, retention: 7 }`.
- Produces a `backup` settings block accepted by the existing optimistic revision save/view APIs.

- [ ] **Step 1: Write failing settings tests**

Add tests that parse defaults, reject relative directories and out-of-range interval/retention, expose a `backup` block in `Settings.view()`, and reject a stale backup revision with `SettingsConflict`.

- [ ] **Step 2: Run focused tests**

Run `pnpm vitest run tests/settings.spec.ts` and confirm the new assertions fail because the schema and block registry do not contain `backup`.

- [ ] **Step 3: Implement the schema and block**

Add a strict `BackupConfigSchema`, include it in `SettingsSchema`, extend `SettingsBlock`/`SettingsSave`, add the `backup` entry to `BLOCKS`, and include its value/revision in `Settings.view()`.

- [ ] **Step 4: Run focused tests and typecheck**

Run `pnpm vitest run tests/settings.spec.ts` and `pnpm typecheck`; all settings tests and type checking must pass.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts src/app/settings.ts src/kv.ts tests/settings.spec.ts
git commit -m "feat: add versioned backup settings"
```

### Task 2: Implement BackupService scheduling and retention

**Files:**
- Create: `src/app/backup-service.ts`
- Modify: `src/app/runtime.ts:100-180`
- Modify: `src/app/settings.ts` to notify the service after a backup block save
- Test: `tests/backup-service.spec.ts`

**Interfaces:**
- `BackupService.run(reason: 'manual' | 'schedule'): Promise<RecoveryManifest>` creates and verifies one point.
- `BackupService.start(settings: BackupSettings): void` replaces the existing timer.
- `BackupService.stop(): void` clears the timer and prevents new work after shutdown.
- `BackupService.restore(input, destination): Promise<RestoreResult>` delegates verified independent restore to `backup.ts`.

- [ ] **Step 1: Write failing service tests**

Test manual creation, one in-flight result for concurrent manual/timer calls, disabled settings, timer replacement, retention only after complete points, and failed runs preserving the prior point while reporting health.

- [ ] **Step 2: Run the service tests**

Run `pnpm vitest run tests/backup-service.spec.ts`; confirm failure because `BackupService` is absent.

- [ ] **Step 3: Implement the service**

Construct the service from runtime paths and health/lifetime dependencies. Use a `Map<string, Promise<RecoveryManifest>>` keyed by the current destination and interval window; schedule with `setInterval`; call `createRecoveryPoint`; verify the resulting manifest; remove only older complete points beyond retention; and clear all timers on `stop()`.

- [ ] **Step 4: Wire runtime/settings lifecycle**

Instantiate the service once during Runtime setup, start it from the current backup settings, call its restart method after a successful backup settings save, and stop it before the runtime Store/session disposal.

- [ ] **Step 5: Run tests and typecheck**

Run `pnpm vitest run tests/backup-service.spec.ts tests/settings.spec.ts` and `pnpm typecheck`.

- [ ] **Step 6: Commit**

```bash
git add src/app/backup-service.ts src/app/runtime.ts src/app/settings.ts tests/backup-service.spec.ts
git commit -m "feat: schedule verified recovery points"
```

### Task 3: Add independent restore and safe-restore zero-work coverage

**Files:**
- Modify: `src/app/backup.ts`
- Modify: `src/app/backup-service.ts`
- Modify: `src/app/http.ts` and `src/app/api.ts` only if the existing management route pattern exposes restore
- Test: `tests/backup.spec.ts`
- Test: `tests/backup-service.spec.ts`

**Interfaces:**
- `restoreRecoveryPoint` accepts a verified point and destination profile and returns relocation metadata plus the inert profile path.
- The restore result contains the restored database path, mapped roots, and `executionDisabled: true`.

- [ ] **Step 1: Add failing independent restore tests**

Cover relocation into a different destination, traversal/symlink/hash/incomplete rejection, credential exclusion, and calls through model, dispatch, outbox/send, manual receive/pump, settings mutation, and tools producing zero work under the restored profile.

- [ ] **Step 2: Run backup tests**

Run `pnpm vitest run tests/backup.spec.ts tests/backup-service.spec.ts`; confirm any missing relocation or zero-work behavior fails.

- [ ] **Step 3: Implement restore verification and profile fencing**

Validate the complete manifest before opening the destination, map every captured root relative to the new profile, write the inert profile atomically, and make all listed entry points consult that profile before acting.

- [ ] **Step 4: Run focused restore tests**

Run `pnpm vitest run tests/backup.spec.ts tests/backup-service.spec.ts` and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/app/backup.ts src/app/backup-service.ts src/app/http.ts src/app/api.ts tests/backup.spec.ts tests/backup-service.spec.ts
git commit -m "feat: restore independent inert profiles"
```

### Task 4: Make Attention resolution trigger one continuation

**Files:**
- Modify: `src/core/tickets.ts:211-227`
- Modify: `src/core/engine.ts:170-180`
- Modify: `src/executor/dsh.ts` continuation dispatch path
- Modify: `src/app/execution-attempts.ts` if a durable continuation request key is needed
- Test: `tests/project-execution.spec.ts`
- Test: `tests/http.spec.ts`

**Interfaces:**
- A resolved answer returns its durable answer id and a continuation request id derived from ticket id, answer id, attempt id, lease, and question version.
- The continuation dispatch is idempotent for that request id and does not create a new attempt unless the current attempt is explicitly retryable.

- [ ] **Step 1: Write failing continuation tests**

Answer a real Attention question through the HTTP route, wait for the worker delivery, assert exactly one continuation delivery, repeat the same request and assert no additional delivery, then cover stale version, uncertain receipt, paused ticket, stopped ticket, and changed lease.

- [ ] **Step 2: Run focused tests**

Run `pnpm vitest run tests/project-execution.spec.ts tests/http.spec.ts`; confirm the answer currently resolves without the required continuation or duplicates it.

- [ ] **Step 3: Implement durable continuation request creation**

Create the request key in the answer transaction result, pass it to the executor, and gate dispatch on current ticket lifecycle and attempt/lease evidence. Persist a sent/accepted marker before or atomically with the existing delivery effect so retrying the HTTP call cannot send again.

- [ ] **Step 4: Run focused tests**

Run `pnpm vitest run tests/project-execution.spec.ts tests/http.spec.ts tests/reconciliation.spec.ts` and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/core/tickets.ts src/core/engine.ts src/executor/dsh.ts src/app/execution-attempts.ts tests/project-execution.spec.ts tests/http.spec.ts
git commit -m "feat: continue once after Attention answers"
```

### Task 5: Final verification and PR update

**Files:**
- Modify: `docs/007-architecture.md` if the module/test table needs the service and continuation entries
- Modify: PR description through the repository's existing PR workflow

- [ ] **Step 1: Run focused suites**

Run `pnpm vitest run tests/lifecycle-boundaries.spec.ts tests/reconciliation.spec.ts tests/backup.spec.ts tests/backup-service.spec.ts tests/task-lifecycle-panel.spec.tsx tests/project-execution.spec.ts tests/http.spec.ts`.

- [ ] **Step 2: Run full verification**

Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.

- [ ] **Step 3: Inspect final repository state**

Run `git status --short`, `git log -6 --oneline --decorate`, and `gh pr view 14 --json number,url,state,headRefName`.

- [ ] **Step 4: Commit and push any final documentation**

```bash
git push origin HEAD
```

- [ ] **Step 5: Report final evidence**

Report final HEAD, PR URL/state, test counts, typecheck/build/diff results, and any remaining limitation only if a test or required interface is genuinely unavailable.
