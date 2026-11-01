# Task 0B Host Compatibility Verification

This record covers the isolated DSH launcher and host-only probe. It certifies launcher startup, isolated temporary context allocation, loopback binding, outbound guard behavior and cleanup. It does not certify native Session, skills, permission, web, auth or transport capabilities; those remain untested for Tasks 0C–0E.

## Host capability status

| Capability | Status | Evidence boundary |
| --- | --- | --- |
| Isolated launcher | passed | Two independent real probes started the minimal plugin through DSH 0.2.1-rc.5 with fresh profile, DSH home, state, workspace and loopback port values |
| Host-only plugin | passed | State roundtrip, loopback roundtrip and host context observations passed; the application Runtime, business Sources and delivery bundles were not loaded |
| Outbound disabled | passed | The preload guard rejected non-loopback TCP, UDP, DNS, UNIX socket paths, fetch and subprocess delivery routes; numeric loopback resolution required for the probe listener remained allowed |
| Process and port cleanup | passed | Both real probes recorded owned process-group cleanup and successful rebind of each allocated port after host exit |
| Temporary directory cleanup | passed | Both real probes removed only their canonical launcher-owned temporary root; independent contexts were distinct |
| Machine-readable evidence | passed | Both records validated against `scripts/host/probe-schema.json`, used private exclusive output files, and preserved evidence outside the removed temporary root |
| Native Session, skills, permission, web, auth and transport | untested | Task 0B intentionally does not claim Tasks 0C–0E capabilities |

## Reproduction

```text
node scripts/host/run-isolated-probe.mjs --capability launcher --json .superagent-host/launcher-final-1.json
node scripts/host/run-isolated-probe.mjs --capability launcher --json .superagent-host/launcher-final-2.json
pnpm exec vitest run tests/host-probe-launcher.spec.ts tests/host-toolchain.spec.ts
pnpm typecheck
pnpm build
env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM pnpm exec vitest run
```

The focused host tests cover poisoned inherited configuration, repeated disjoint contexts, startup and malformed-result failures, missing executables, deadlines, aborts, output limits, detached inherited pipes, incumbent ports, symlink-safe cleanup, evidence exclusivity and the identified outbound API routes. Fixture hosts are used for negative cases; only the two real DSH runs establish native launcher evidence.

The final real runs used Node v24.22.2 on darwin arm64 and installed DSH 0.2.1-rc.5. Their raw records remain under ignored `.superagent-host/` because they contain temporary absolute paths and host diagnostics. The records reported ports 31699 and 53201, distinct contexts, schema validation, and passed process, directory and port cleanup.

## Boundary

No KORAM service, production profile, Superagent profile, ordinary business bundle, historical setup plan or external message was accessed or modified. The probe binds only loopback and uses a disposable profile with an empty bundle list and one local plugin. A missing, malformed or incomplete host result is recorded as failed and never promotes later capabilities to passed.
