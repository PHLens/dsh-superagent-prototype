# Workbench dispatch manifest

This directory is an external operations tool, separate from the Superagent runtime and its bundle. D0 defines the inventory and validates it; it does not send messages, create tickets, observe services, write application SQLite, or infer that a PR has merged. No credentials or service configuration are needed to run these checks.

The source of task scope is the numbered task sections of [the execution-ready plan](../../docs/superpowers/plans/2026-11-01-project-superagent-workbench-execution-ready.md), with the [original implementation plan](../../docs/superpowers/plans/2026-11-01-project-superagent-workbench.md) supplying detailed later-increment files and acceptance cases. The execution-ready plan and manifest use the resolved interface contract order described below; the original implementation plan remains unchanged.

## Format and checks

`manifest.yaml` uses JSON syntax, which is a YAML 1.2 subset. Keep this syntax when editing: the standalone reader deliberately uses Node's JSON parser so it needs no YAML package or application dependencies. It rejects ordinary indentation-based YAML. Increment `revision` whenever the task inventory or its contracts change; `version` identifies the format and is currently `1`.

From the repository root, on Node `^22.19.0 || >=24.0.0`:

```sh
node --experimental-strip-types ops/workbench-dispatch/src/manifest.ts --check ops/workbench-dispatch/manifest.yaml
node --experimental-strip-types --test ops/workbench-dispatch/tests/manifest.spec.ts
```

The tests use Node's built-in test runner, independently of the application's Vitest configuration. For a strict typecheck using the repository's locked TypeScript 6 toolchain:

```sh
pnpm exec tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target es2024 --module nodenext --allowImportingTsExtensions --types node ops/workbench-dispatch/src/model.ts ops/workbench-dispatch/src/manifest.ts ops/workbench-dispatch/tests/manifest.spec.ts
```

`manifest.schema.json` defines the structural contract, including required fields, status enums and repository-relative file scopes. The reader evaluates the schema keywords used in this bundled schema; it is not a general JSON Schema service. Semantic validation additionally rejects duplicate task/capability ids, duplicate expected PR heads, unknown task/capability references, and dependency cycles. Errors identify the field or cycle path. A successful check prints a stable dependency-first ordering; it does not mean those tasks are ready to dispatch.

Every task declares `capabilities`, including an empty array for work with no native host requirement. Capability states start as `untested`: fixture tests and a merged toolchain PR do not prove native host behavior. Future dispatch readiness must require actual evidence for each consuming capability, merged PR evidence for dependencies on `dev`, no unresolved `blockedBy`, and separate approval evidence for any `amber` workaround. `amber` alone is not permission to proceed.

`expectedHead` declares the PR head to be checked, not evidence that a PR exists. Live ticket/PR association, merge SHAs, receipts and attempts belong in external state, not in the versioned inventory. `DeliveryRecord` keeps an unknown send distinct from task progress; reconciliation must precede a retry.

## Source-plan dependency order

The execution-ready plan resolves the interface order as `2C -> 2E -> 2D`: Task `2E` defines the scheduling and budget contracts using Task `2C`, and Task `2D` consumes those contracts. The manifest retains cycle detection so future edits fail closed instead of silently accepting a cyclic graph.

The overview's `3E` has no numbered implementation task. The manifest includes the defined `3A`–`3D` tasks; `3D` owns cross-channel acceptance. `D4` is included as the defined operational acceptance task, with explicit approval prerequisites; this tool never runs its external sends.
