# Workbench dispatch operations

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

## D1: external OAuth user sender

`src/feishu-user.ts` exports `sendUserMessage({ chatId, text, idempotencyKey, mentionOpenId? }): Promise<{ messageId: string }>`. It performs one native message-create request with `receive_id_type=chat_id`, `msg_type=text`, a JSON-serialized `content` string and the caller's stable UUID in `uuid`. `FeishuUserClient` accepts an environment snapshot and injected `fetch` for isolated testing. It has no application runtime, bot CLI, profile, configuration-file or persistence dependency.

Only an **external user_access_token helper** supplies the token through the process environment. This code does not obtain tokens, execute a helper, read bot credentials, store a token or refresh it. The operator's helper owns OAuth consent, token expiry and refresh-token rotation in an external secret store. It must supply a user token from the dedicated OAuth application; never substitute a tenant/bot token. Keep credentials, raw chat/user/message identifiers, raw API responses and deployment paths outside Git, task prompts and PRs. Local state/receipt files belong in ignored `.workbench-dispatch/`; environment files are ignored as an additional guard, not a secret store.

| Environment input | Contract |
| --- | --- |
| `FEISHU_DISPATCH_BASE_URL` | Required HTTPS origin only, for example `https://open.feishu.cn`; no path, query, user credentials or fragment. Redirects are refused. |
| `FEISHU_DISPATCH_ACCESS_TOKEN` | Required fresh `user_access_token`, injected by the external helper; never printed or persisted. |
| `FEISHU_DISPATCH_CHAT_ID` | Required destination allowlist: `chatId` must equal this value. For D1, an approved dedicated test group only. |
| `FEISHU_AGENT_OPEN_ID` | Agent mention target for future authorized task callers, passed explicitly as `mentionOpenId`. The canary never uses it or mentions any agent. |
| `FEISHU_DISPATCH_CANARY_AUTHORIZED` | Live canary requires exactly `true`, set only after the owner approves this dedicated chat and external send. |
| `FEISHU_DISPATCH_EXPECTED_SENDER_OPEN_ID` | Live canary requires the expected consenting human user's Open ID. |
| `FEISHU_DISPATCH_IDEMPOTENCY_KEY` | Live canary requires an operator-retained UUID for this one logical canary, reused for reconciliation. |

The OAuth app needs `im:message` and `im:message.send_as_user` for sending. Canary identity verification uses `authen/v1/user_info`; membership verification additionally needs a supported chat-read scope such as `im:chat.members:read`. The native readback of a group message needs `im:message.group_msg:get_as_user` as well as `im:message` (and the app's required bot capability/group availability). Scope consent must be completed outside this tool. Configure only the dedicated canary group for D1.

Message text is preserved through nested JSON serialization, including quotes, Unicode and newlines. Native `<at ...>` markup is refused inside `text`; optional `mentionOpenId` creates the single validated native mention entity. The canary uses a fixed non-task text, `OAuth user identity canary. No task requested.`, with no mention and no dispatch marker. It accepts no task text, manifest or dispatch command.

### Idempotency, expiry and retry contract

The caller supplies a valid UUID and retains it with the destination and unchanged logical payload. A retry must use the same UUID and payload. Feishu's native UUID deduplication window is **one hour**; this module makes no durable or cross-window exactly-once claim. A native successful repeat is accepted only when it includes a valid original `message_id`. Native `230049` (message still being sent), a missing ID, timeout, network failure, HTTP 408/5xx or malformed response is `unknown`: reconcile the dedicated chat/native receipt before considering another send. Never generate a new UUID to recover an uncertain send.

`FeishuSendError.kind` distinguishes `configuration`, `expired`, `rate_limited`, `rejected` and `unknown`. HTTP 401 and native invalid/expired access-token codes (`99991663`, `99991668`, `99991677`, or legacy identity API codes `20005`/`20006`) require the external helper/operator to renew or correct the token; no bot fallback or internal refresh occurs. HTTP 429 and native frequency-limit codes expose `retryAfterMs` when `Retry-After` is a valid number of seconds or HTTP date. This is a minimum wait, not an automatic retry. Missing/invalid headers leave it undefined; callers must apply their own bounded backoff and reconciliation policy. Monthly quota exhaustion and missing scopes remain rejected. Native numeric error codes may be returned; raw server diagnostics never are. A failed post-send canary readback is `unknown` even if the read itself failed with expiry or throttling, because a message may already exist.

### Canary and sanitized receipt

From the repository root, without credentials or helper execution:

```sh
node --experimental-strip-types ops/workbench-dispatch/src/feishu-canary.ts --dry-run
```

Dry-run returns before accessing environment configuration. It makes no HTTP requests, spawns no helpers, writes no files and does not generate an idempotency key. Sanitized dry-run receipt (observed with the real CLI):

```json
{
  "version": 1,
  "capability": "dispatch.user-sender",
  "capabilityStatus": "untested",
  "status": "dry_run",
  "externalSend": false,
  "senderVerified": false,
  "membershipVerified": false,
  "nativeMessageVerified": false
}
```

After separate approval and external OAuth setup, the operator can inject the environment above and run:

```sh
# The operator supplies this helper; it emits only a fresh user token on stdout.
FEISHU_DISPATCH_ACCESS_TOKEN="$(user-access-token-helper)" \
  node --experimental-strip-types ops/workbench-dispatch/src/feishu-canary.ts --send
```

`--send` first checks explicit authorization, the expected sender and the retained UUID. It then verifies the token's user identity and that this user is in the configured group before sending the fixed message once. Readback must match the native message ID, group, user sender type, expected Open ID and unchanged fixed text, with no mentions, deletion or edit. Success prints a `verified` receipt with `capabilityStatus: passed`, true verification flags and SHA-256 hashes of sender, chat, message ID and UUID; no raw IDs, content, endpoint, credentials or local paths appear. Failure exits nonzero with a sanitized status and optional numeric retry/code fields. CLI invocations must select exactly one mode; there is no default live operation.

Receipts go to stdout only; callers decide whether to retain them outside Git. A hashed receipt is an audit correlation record, not a signed authorization, native receipt replacement, ticket association or dispatch permit. Retain the raw native evidence privately if a later reconciliation needs it. Only an actually verified authorized live canary can establish this capability; a fixture or dry-run cannot. **This D1 delivery has not performed a live canary: `dispatch.user-sender` remains `untested`.** The versioned manifest is not modified or promoted. D1 never dispatches another task, enables a service, changes a Superagent profile or starts automatic scheduling; later task/Ticket correlation is outside this canary.

Official API references: [message create and native UUID deduplication](https://open.feishu.cn/document/server-docs/im-v1/message/create), [text/mention JSON](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json), [token user identity](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get), [membership check](https://open.feishu.cn/document/server-docs/group/chat-member/is_in_chat), [message readback](https://open.feishu.cn/document/server-docs/im-v1/message/get), and [native error codes](https://open.feishu.cn/document/ukTMukTMukTM/ugjM14COyUjL4ITN).

### Standalone D1 checks

```sh
node --experimental-strip-types --test ops/workbench-dispatch/tests/feishu-user.spec.ts ops/workbench-dispatch/tests/manifest.spec.ts
node --experimental-strip-types ops/workbench-dispatch/src/feishu-canary.ts --dry-run
pnpm exec tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target es2024 --module nodenext --allowImportingTsExtensions --types node ops/workbench-dispatch/src/feishu-user.ts ops/workbench-dispatch/src/feishu-canary.ts ops/workbench-dispatch/tests/feishu-user.spec.ts
```

These tests inject native-response fixtures, cover payloads/mentions/stable UUIDs/expiry/rate limits/duplicates/unknown delivery, and check that authorization, identity and membership gates precede any send. They also exercise the actual dry-run CLI and receipt redaction. They do not use OAuth secrets or send live messages.
