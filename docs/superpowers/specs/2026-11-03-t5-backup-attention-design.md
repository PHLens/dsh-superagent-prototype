# T5 Backup and Attention Continuation Design

## Scope

This bounded T5 extension adds durable backup orchestration and the missing Attention continuation behavior. It reuses the existing recovery primitives in `src/app/backup.ts`, existing settings revision machinery, and existing executor lifecycle fences. It does not add a task engine or allow recovery mode to execute work.

## Backup service

`BackupService` owns manual and scheduled recovery point creation. It receives the canonical database path, declared state roots, credential exclusions, destination directory, and a lifetime signal. Each run creates a SQLite-consistent point through `createRecoveryPoint`, verifies the manifest and hashes, records the result in health, and applies retention only after a complete point is present. A run is identified by a deterministic request key so overlapping timer/manual requests share one in-flight operation.

Backup settings are a versioned settings block with `enabled`, `directory`, `interval`, and `retention`. Saving the block uses the existing optimistic revision and panel origin rules. The service replaces its one scheduler on a successful settings change and stops it on runtime shutdown. Scheduling is interval based and bounded by the configured minimum; a failed run leaves prior points intact and records an error.

## Safe independent restore

Restore accepts a verified recovery point and an empty or newly created destination profile. It rejects traversal, symlink, incomplete, hash-mismatched, or credential-bearing inputs before writing. It maps the captured database and declared roots into the destination, writes an inert recovery profile, and returns a manifest of relocated paths. The restored profile starts with model, dispatch, outbound send, manual receive/pump, settings mutation, and tool entry points disabled. Tests invoke every entry point and assert zero outbound calls, zero dispatch, and zero model work.

## Attention continuation

`answerAttention` remains an exact `questionId + version` transaction. After a successful resolution, the executor receives one durable continuation request keyed by ticket, answer id, attempt/lease, and question version. Repeated HTTP requests, duplicate receipts, stale answers, and uncertain network outcomes reuse the key and cannot create a second continuation. A continuation is accepted only when the ticket is still runnable and its pause, stop, reconciliation, attempt, and lease fences permit it. The answer is durable even when continuation is deferred or rejected.

## Verification

Permanent tests cover settings revision conflicts, scheduler deduplication, retention after complete points, restore relocation and rejection cases, safe-restore zero-work behavior, and the real Attention answer-to-one-continuation path. Existing lifecycle boundary, reconciliation, backup, UI, typecheck, build, and full regression suites remain required.
