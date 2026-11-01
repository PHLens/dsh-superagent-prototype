# Task 0A Toolchain Verification

This record covers the local toolchain gate only. It does not certify DSH host compatibility; Session, skill, permission, web, auth and transport capabilities are verified by Tasks 0B–0E.

## Host capability status

| Capability | Status | Evidence boundary |
| --- | --- | --- |
| Node and package manager | passed | Node v24.22.2 and pnpm 11.7.0 satisfy the repository declarations |
| DSH CLI version | unsupported | The installed CLI reports `0.2.1-rc.5`; the package declares DSH `^0.2.1-alpha.2`, so version presence does not prove host compatibility |
| Locked dependency installation | passed | `pnpm install --frozen-lockfile` completed without changing `pnpm-lock.yaml` |
| Typecheck | passed | `pnpm typecheck` |
| Focused recorder tests | passed | `pnpm exec vitest run tests/host-toolchain.spec.ts` (6 tests) |
| Full repository test suite | passed | Clean-shell command `env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM pnpm exec vitest run` passed; an inherited worker git config caused two failures in the initial run and remains a host isolation limitation |
| Native optional dependencies | passed | The real Rolldown and LightningCSS transforms completed; the raw record is written under ignored `.superagent-host/` and is intentionally not committed because it includes executable paths and diagnostics |

## Reproduction

```text
node scripts/host/record-toolchain.mjs --out .superagent-host/toolchain.json
pnpm exec vitest run tests/host-toolchain.spec.ts
pnpm typecheck
pnpm exec vitest run tests/host-toolchain.spec.ts
pnpm build
```

The recorder uses a bounded command budget, captures exit status and cleanup, checks the installed native transform path, hashes the lockfile, and records a finite repair entry for each failed or untested command. Fixture tests never count as real host capability evidence.

## Known boundary and repair

The initial full suite run inherited a worker git config and exposed two existing Runtime environment restoration failures. A clean-shell rerun with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` unset passed. The recorder's raw evidence remains local and ignored.

No KORAM service, production profile, Superagent profile, historical setup plan, or external message was accessed or modified by this task.
