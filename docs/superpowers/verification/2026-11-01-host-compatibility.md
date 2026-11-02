# Tasks 0B–0C Host Compatibility Verification

This record covers the isolated DSH launcher and host-only probes. Task 0B certifies launcher startup, isolated temporary context allocation, loopback binding, outbound guard behavior and cleanup. Task 0C certifies native Session, Workspace and permission persistence across a real host restart. Skills, web, auth and transport remain untested.

## Host capability status

| Capability | Status | Evidence boundary |
| --- | --- | --- |
| Isolated launcher | passed | Two independent Task 0B probes started the minimal plugin through DSH 0.2.1-rc.5 with fresh profile, DSH home, state, workspace and loopback port values |
| Host-only plugin | passed | Task 0B state, loopback and host-context observations passed; Task 0C composes only native host services and the probe, without application Runtime, business Sources or delivery bundles |
| Outbound disabled | passed | The preload guard rejects non-loopback TCP, UDP, DNS, UNIX socket paths, fetch and subprocess routes; both capabilities retain it. Task 0B exercises those rejection paths |
| Native Session create/persist/reopen | passed | Two independent Task 0C probes each created a native Session, flushed and closed native JSONL storage, let the first real host exit, and reopened its stored events/header in a second real host process |
| Native Workspace and cwd/realpath | passed | Session ID, Workspace ID and membership survive restart; Session header cwd, filesystem realpath, registry path and resolved sandbox boundary equal the canonical ProbeContext workspace |
| Permission preset persistence | passed | Both phases observe `workspace-write` / sandbox `workspace-write` / approval `ask`, with all three durable knob events present. The reopen host defaults to `danger-full-access`, while sandbox/approval deployment fallbacks are `read-only` / `never`, so matching defaults cannot explain the result |
| Mismatched workspace mapping | passed | In both phases, native `Workspace.attachSession` rejects a second existing directory whose canonical path differs from the stored cwd; the rejected Workspace never acquires membership |
| Process, directory and port cleanup | passed | Each Task 0C run records two distinct exited host PIDs, process-group cleanup, deletion of its canonical owned root and successful rebind of its allocated port |
| Machine-readable evidence | passed | Both Task 0C records validate against `scripts/host/probe-schema.json`; outputs are private exclusive files retained outside the removed root; all context fields differ across runs |
| Skills, web, auth and transport | untested | Tasks 0D–0E and later consumers require their own real evidence |

## Task 0C reproduction and evidence

Input revision: `ec95dac5f87b2eff717726df19e76e31dd5497b5` on `dev` (merged Task 0B). The schema's historical `baseline` value, `7a68779c32e8dcf2ef9f4c942fdc7c24b25c05bb`, still identifies the launcher lineage; it is not the Task 0C input revision.

```text
node scripts/host/run-isolated-probe.mjs --capability session --json .superagent-host/native-session-1.json
node scripts/host/run-isolated-probe.mjs --capability session --json .superagent-host/native-session-2.json
pnpm exec vitest run tests/native-session-probe.spec.ts tests/host-probe-launcher.spec.ts tests/host-toolchain.spec.ts
env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM pnpm test
pnpm typecheck
pnpm build
```

Use a new output filename when repeating a command: existing files and symlinks are refused before the host boots. Native service entries are isolated in the disposable profile: Session store/projections, JSONL persistence, Workspace registry, JSON storage/domain, sandbox policy/local provider, native sandbox shell/subprocess provider, approval and permission presets. No shell command or model call is executed.

| Real run | UTC start | UTC finish | Port | Session events create → reopen | Result / cleanup |
| --- | --- | --- | --- | --- | --- |
| `native-session-1.json` | 2026-11-02 01:49:09.926 | 2026-11-02 01:49:11.340 | 31294 | 3 → 3 | passed / processes, directory, port passed |
| `native-session-2.json` | 2026-11-02 01:49:11.380 | 2026-11-02 01:49:12.772 | 45583 | 3 → 3 | passed / processes, directory, port passed |

Both runs used installed DSH `0.2.1-rc.5`, Node `v24.22.2`, darwin arm64. Both host invocations exited 0 with no timeout, signal or cleanup error. Each run preserved the same Session/Workspace identities and canonical paths across its restart, while the two runs had different profile, DSH home, state, workspace and port values. Schema validation and an independent filesystem absence check confirmed both deleted roots. Raw records remain under ignored `.superagent-host/`; they contain local absolute paths and are not committed.

Validation passed: the full suite ran 1,268 tests across 64 files with the documented isolated Git environment; `pnpm typecheck` and `pnpm build` also passed (the build retains its existing CommonJS recommendation warning). The final focused host suite passed 42 tests across three files, plus six documentation tests. It exercises two-process supervision and fail-closed evidence admission for missing results, changed identities/event counts, reused PID, wrong cwd/realpath/workspace, wrong permission/sandbox/approval and accepted mismatches. Fixtures alone do not certify native behavior; the two real runs above do.

The initial focused run failed on a nested schema reference while schema work was incomplete; final schema import and focused tests pass. Early real runs failed with missing result files while the native dependency chain was incomplete; adding native services, including the subprocess provider required by the sandbox shell, resolved startup without application code changes. An initial full-suite run exposed the new test's missing architecture index entry (now added) and two pre-existing environment-sensitive runtime assertions. The documented full-suite command removes inherited Git configuration variables for that run only; it does not modify host configuration.

Task 0C supplies the native capability gate for Tasks that create/resume Sessions. This evidence covers an unseeded Session with durable permission events and native persistence handles. It does not cover fork lineage, turns/model history, application-owned persistence wiring, concurrent writers, sandbox execution/enforcement or permission UI. No repair task is needed for the exercised native contract; consumers beyond this boundary require their own verification.

## Task 0B historical reproduction

```text
node scripts/host/run-isolated-probe.mjs --capability launcher --json .superagent-host/launcher-final-1.json
node scripts/host/run-isolated-probe.mjs --capability launcher --json .superagent-host/launcher-final-2.json
pnpm exec vitest run tests/host-probe-launcher.spec.ts tests/host-toolchain.spec.ts
```

The launcher fixture tests cover poisoned inherited configuration, repeated disjoint contexts, startup and malformed-result failures, missing executables, deadlines, aborts, output limits, detached inherited pipes, incumbent ports, symlink-safe cleanup, evidence exclusivity and the identified outbound API routes. Task 0B's real runs used the same host versions, reported ports 31699 and 53201, and passed process, directory and port cleanup.

## Boundary

No KORAM service, production profile, Superagent profile, ordinary business bundle or historical setup plan was modified. The probe binds only loopback and uses a disposable profile with an empty bundle list. The launcher capability boots one local plugin; the Session capability adds only native host services. A missing, malformed or incomplete host result is failed and cannot promote a capability to passed. Secrets and local absolute paths remain outside committed evidence.
