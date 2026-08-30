---
title: Persistent Run History and Command Registry - Plan
type: feat
date: 2026-08-29
deepened: 2026-08-29
topic: run-history-command-registry
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Persistent Run History and Command Registry - Plan

## Goal Capsule

- **Objective:** Make every run's full record — request, thread context, tool steps, reply, terminal status, friction diagnosis — visible live and after completion for a retention window, and expose all run reads/stop through one channel-agnostic **command registry** whose generic HTTP, MCP, CLI, and chat adapters need no per-command code. Tracker: [#157](https://github.com/coreplanelabs/switchboard/issues/157) (matrix row in [#81](https://github.com/coreplanelabs/switchboard/issues/81) §3.H).
- **Authority:** Product Contract Rs own product behavior; Planning Contract KTDs own implementation mechanism within their cited Rs; units override neither. AGENTS.md invariants bind every unit; this plan adds one (KTD16: no registry command starts an agent run).
- **Execution profile:** Bot code in `src/`, one new Durable Object on the existing state Worker (`deploy/cloudflare-memory/`), feature-spec files updated in the same PR as the behavior they describe. Three phases, each independently mergeable (units within a phase may also merge separately); the state Worker (`v4` migration) deploys before the bot PR that writes to it.
- **Stop conditions:** Surface rather than guess when (a) a record cannot fit the byte budget after KTD3's head+tail truncation, (b) zod v4 JSON-Schema derivation cannot express a command input, (c) the live SSE contract cannot be kept byte-identical under the KTD6 split, (d) the Cloudflare Access application cannot be extended to `/api/*` before the bot deploy, or (e) a change would alter Product Contract scope.
- **Open blockers:** None. Deferred questions are listed in Open Questions.
- **Product Contract preservation:** Bootstrapped from the issue and the session; no upstream brainstorm. KD3 carries a rollout refinement (see its conflict call-out), not a reversal.

---

## Product Contract

### Summary

Runs stop being ephemeral. The run event stream becomes the canonical record of a run — it gains the request text, the thread context fed to the model, and the assistant's reply, all redacted by the existing pipeline — and every finished run is written to a durable store with a configurable retention window. `/runs/:id` renders a finished run as a live viewer saw it, up to the recorded window. Run reads and stop become registry commands (`runs.list`, `runs.get`, `runs.events`, `runs.friction`, `runs.stop`) available over HTTP, MCP, CLI, and chat with the same names, inputs, and JSON output. The registry is the open/closed seam for every future command; existing chat-only commands (`friction report/propose`, `repo list`) migrate onto it in the final phase.

### Problem Frame

`RunRegistry` (`src/core/runRegistry.ts`) is in-memory and evicts a finished run 60 s after it finishes, so https://switchboard.coreplanelabs.dev/runs returns 404 for every completed run. The live page shows only tool steps: the user's request and the bot's reply never enter the stream. Run reads exist on one surface (the `/runs` HTML page in `src/channels/liveView.ts`); MCP exposes a single hard-coded `dispatch` tool; the CLI has no run reads. Each new surface today means new logic, contradicting Switchboard's "one core, every channel" principle. The friction ledger (`FrictionDO`) already persists one record per finished run, so a naive run store would create a second population of "which runs exist".

Cheaper baselines were rejected: a longer registry TTL still loses every record on restart or deploy (routine on Cloudflare Containers) and violates AGENTS.md invariant 6; a diagnosis-only durable record (the ledger today) cannot satisfy the full-exchange requirement; doing nothing leaves the two-population problem and the 404s. If the DO path proves too costly, the fallback is a shorter `retentionDays`, not a return to in-memory-only.

### Key Decisions

- KD1. **The run stream is the canonical record; live and history render the same thing** (session-settled: user-directed — chosen over persisting a separate outcome/answer field: one canonical shape means no second redaction path and no live/history divergence). Governs R1, R2, R3, R12.
- KD2. **One core command registry with thin generic adapters per surface** (session-settled: user-directed — chosen over hand-written HTTP/MCP/CLI handlers per feature: logic is written once and wired to every surface by configuration; new surfaces are adapters, new features are registrations). Governs R6, R7, R8, R13.
- KD3. **Run history is the single durable run store; the friction ledger reads from it** (session-settled: user-directed — chosen over a second `RunHistoryDO` beside `FrictionDO`: one population for the dashboard and the self-improvement loop). Governs R3, R5. *Conflict call-out (rollout, not reversal):* `FrictionDO` keeps receiving its small diagnosis write until the deferred decommission, so a defect in the new write path has a rollback and the weekly self-improvement cron never loses its population. Reads flip to the run store immediately (KTD12).

### Requirements

**Canonical run record**

- R1. The run event stream carries the full exchange: the request text, the text of each thread-context item supplied to the model (attachments reduced to name/type/size metadata, never bytes or file bodies), the assistant's reply, plus the existing tool calls, results, and notes. Every text field, and the run label, passes `redactSecrets` and a per-kind cap before it enters the stream.
- R2. The live `/runs/:id` page renders request, context, and reply events in order with the tool steps, as escaped text nodes.
- R3. Every finished run's record — summary, event stream (bounded by a byte budget with head+tail truncation marked `truncated`), friction diagnosis, terminal status (`completed`, `stopped_soft`, `stopped_hard`, `failed`) — is built at run finish and written to the durable store once, with bounded retries on transient errors only. A store failure is logged and counted and never fails or delays the reply.
- R4. Retention is `runHistory.retentionDays` (default 30), `runHistory.maxRuns` (default 5000), and `runHistory.maxBytes` (default 2 GB). The store owns the effective policy; expired records are invisible on every read, trimmed on write, and deleted by a scheduled sweep in every store implementation. Every `runs.*` `id` input matches `^[A-Za-z0-9_-]{1,64}$` (400 otherwise, before any store call). Unknown, expired, and wrong-token lookups return the same not-found result.
- R5. The friction ledger's `recent()` is served from the run store (unioned with legacy `FrictionDO` rows for one retention window), preserving its current default limit, oldest-first ordering, and record shape. Run-store retention must not shrink the friction population below the ledger's current count-based window of 500 runs.

**Command registry and surfaces**

- R6. A command is registered once with an id `<group>.<verb>`, a zod input schema, an output type, a scope (`<group>:<read|write>`), a chat gate (`open`, `operator`, `repoManager`), an effect (`read`/`write`), optional per-surface opt-outs, and a handler. Registration alone makes it available on every surface it does not opt out of.
- R7. Generic adapters expose every registered command on HTTP JSON (`/api/<group>.<verb>`, under the Access gate; `write` commands POST-only), MCP (`tools/list` + `tools/call`, tool name `<group>_<verb>`), CLI (`npx tsx src/commandCli.ts <group> <verb> [--key=value]`), and chat (`<group> <verb> key=value`). Every adapter passes the same JSON object out of `invoke`; text adapters pass raw string arguments and the schema coerces them; text surfaces render the object through one shared renderer. Error semantics are identical: 400 invalid input, 403 unauthorized (checked before parsing), 404 not found, 409 conflict.
- R8. Run commands: `runs.list {status: "active"|"finished"|"all", agent?, channel?, sinceMs?, limit?}` (metadata only), `runs.get {id, include?: "messages"}`, `runs.events {id, afterSeq?, limit?}` (server-capped page, returns `nextAfterSeq`), `runs.friction {id}`, `runs.stop {id, mode: "soft"|"hard"}`. `runs.list` merges live and persisted runs, deduplicated by id, newest-first, with `limit` default 50 and server cap 200; `channel` is a platform-namespaced channel id.
- R9. `runs.list/get/events/friction` carry scope `runs:read`, `runs.stop` carries `runs:write`; all five require the `operator` chat gate. Caller identity is platform-namespaced: `access:<sub>` for browser sessions and `access:svc:<common_name>` for Cloudflare Access service tokens (HTTP), `mcp:<subject>` (MCP), `cli:local`, `slack:U…` (chat). Every command declares a scope `<group>:<read|write>`; machine callers (MCP tokens, Access service tokens) must hold that scope explicitly (default `dispatch` only), browser Access identities hold every `read` scope and gain `write` scopes via `permissions.operators`, `cli:local` holds all scopes, chat callers pass the command's declared chat gate. A channel-pinned ingress token sees only its channel's run-derived output on every command. `runs.stop` records the structured actor on the `stop_requested` note; every `invoke` and every persisted-run page read emits one structured audit line (command, caller, effect, outcome — never the payload).
- R10. No command output, JSON response, MCP result, CLI output, or persisted row contains a run's capability token. Live-run HTML/SSE/stop routes keep requiring the token; finished/persisted run pages are served to Access-authenticated viewers without one. Free text returned on machine surfaces is wrapped as untrusted content.

**Dashboard**

- R11. The `/runs` index shows active runs by default and never calls the store for that view. A "show all" toggle (`?all=1`) adds finished and persisted runs, visually distinct (terminal status, duration, finished-at). The toggle carries a tooltip stating the configured retention truthfully ("Finished runs are kept for N days, then deleted").
- R12. `/runs/:id` for a persisted run renders through the same renderer as a finished live run, up to the recorded window with any truncation marked in place ("N events omitted"); `/runs/:id/events` replays the stored stream and closes; `/runs/:id/friction` returns the stored diagnosis; `POST /runs/:id/stop` returns 409.

**Migration**

- R13. `friction report`, `friction propose`, and `repo list` are re-homed as registry commands (`friction.report`, `friction.propose`, `repo.list`) with their current chat syntax **and current chat gates** unchanged (`friction.propose` keeps its `canManageRepos` gate: admins ∪ `permissions.repoManagement`); on machine surfaces they require an explicit `friction:read`/`friction:write`/`repo:read` scope, so no existing token gains them silently.

### Scope Boundaries

- Not resuming, restarting, or forking a past run. The record keeps `seq` and full context so it does not preclude it.
- No registry command starts an agent run; anything that runs an agent goes through `dispatch()` (KTD16).
- Not a per-org cap: no org identity exists (`deriveScopeKey("org")` is a constant); `maxRuns`/`maxBytes` are per deployment.
- Not full-text search over history.
- Not live SSE tail over MCP (single-response transport by locked design in `features/mcp-ingress.md`); machine clients follow a run by polling `runs.events {afterSeq}`.
- Not a chunked `put` protocol (see Risks for the specified fallback if bot-side truncation proves insufficient).

#### Deferred to Follow-Up Work

- Migrating `config show/set/clear` and `repo onboard/offboard/reconfigure/rebuild` onto the registry (user-scoped and mutating admin commands needing a `user` class and confirmation semantics).
- Decommissioning `FrictionDO` writes and the legacy union read after one retention window, once R5's 500-run population floor is guaranteed by the run store alone; removing `WorkerFrictionLedger`/`FileFrictionLedger`.
- In-run agent tools (`ctx.runs` on `ToolContext`) for "why was my last run slow" follow-ups.
- MCP `structuredContent` alongside the text result.
- A provisional pre-reply `put` (status `running`) to close the crash window between finish and write.
- Erasure by channel (erasure by id ships as `POST /runs/delete` in U3).

### Acceptance Examples

- AE1. **Covers R3, R4, R12.** Given a run finished 10 minutes ago, when an Access-authenticated viewer opens `/runs/<id>`, then the page shows request, context, every tool step, the reply, and `✅ completed`; `/runs/<id>/events` streams the same events then ends.
- AE2. **Covers R4.** Given `retentionDays: 30` and a run finished 31 days ago, when `runs.get {id}` is called on any surface, then the result is the same not-found shape as an unknown id, regardless of any policy value a caller sends.
- AE3. **Covers R7, R8, R10.** Given one seeded live run and one seeded persisted run, when `runs.list {status:"all"}` is invoked via HTTP, MCP, CLI, and chat, then the JSON object produced by `invoke` is deep-equal across all four rows, both runs appear exactly once, no output contains a token, and the two text surfaces render from that same object.
- AE4. **Covers R8.** Given a run that finished 20 s ago (in the registry and persisted), when `runs.list {status:"all"}` runs, then the run appears once with its live stop state and the same `eventCount` it will show after eviction.
- AE5. **Covers R9.** Given an MCP token with scope `runs:write`, when `runs.stop {id, mode:"soft"}` is called on a live run, then the stream gains `stop_requested` with `actor: {kind:"mcp", id:"mcp:<subject>"}`; on a finished run the result is 409. Given a token with the default `dispatch` scope, the same call is 403 before input parsing.
- AE6. **Covers R11.** Given two active and five finished runs, when `/runs` loads, then two rows show and the store is not called; with `?all=1` seven rows show and the toggle's tooltip names the configured retention.
- AE7. **Covers R1.** Given a request text, a thread-context item, a tool result, and a run label each containing `AWS_SECRET_ACCESS_KEY=…`, when the run completes, then no persisted field (including `label`), no surface output, and no generated friction-proposal body contains the secret value.
- AE8. **Covers R7.** Given an operator's browser session, when a cross-site page issues `GET /api/runs.stop?id=…` or a `POST` with a foreign `Origin`, then the responses are 405 and 403 and no `stop_requested` note is published.
- AE9. **Covers R2, R10.** Given a persisted user message `</script><script>alert(1)</script>`, when its run page and index row render, then the text is inert (escaped text node) and no script executes.
- AE11. **Covers R12.** Given a run whose record was truncated, when `/runs/<id>` and `runs.events` render, then head and tail events appear with an explicit "N events omitted" marker in place.
- AE12. **Covers R9, R13.** Given a `dispatch`-only MCP token, when it calls `friction_report`, `repo_list`, or `friction_propose`, then each is 403; given a `repoManagement`-listed non-admin in chat, `friction propose` still runs.
- AE10. **Covers R13.** Given a non-admin Slack user, when they type `friction report` after the migration, then they receive the same reply as before the migration.

### Sources

- Issue [#157](https://github.com/coreplanelabs/switchboard/issues/157); tracker [#81](https://github.com/coreplanelabs/switchboard/issues/81).
- `features/live-view.md` (locked "in-memory, live-only" — reversed here), `features/run-visibility.md`, `features/run-friction.md`, `features/self-improvement.md`, `features/mcp-ingress.md`, `features/access-gate.md`.
- `src/core/runRegistry.ts`, `src/core/runEvents.ts`, `src/core/runFriction.ts`, `src/channels/liveView.ts`, `src/channels/accessAuth.ts`, `src/channels/http.ts`, `src/channels/mcp.ts`, `src/core/frictionLedger.ts`, `src/core/frictionLedgerWorker.ts`, `src/core/frictionProposals.ts`, `src/core/operations.ts`, `src/core/frictionCommands.ts`, `src/core/repoCommands.ts`, `deploy/cloudflare-memory/worker.ts`, `deploy/cloudflare/worker.ts`, `src/cli.ts`, `src/frictionCli.ts`, `src/core/dispatcher.ts`, `src/index.ts`, `src/config.ts`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Command registry in `src/core/commandRegistry.ts`, not "operations"** (session-settled: user-directed — instantiates KD2; governs R6, R7, R9, R13). `src/core/operations.ts` already names the deterministic repo `test/build` ops. `defineCommand({ id, input, scope, chatGate, effect, surfaces?, describe, handler })`; `CommandRegistry.list()/get(id)/invoke(id, rawInput, caller)`. `invoke` order: auth (403) → parse (400) → handler → map `CommandError` (`not_found` 404, `conflict` 409). Error messages name the field and expected type, never the submitted value. Handlers return plain JSON objects; `renderCompact(output)` is the one text renderer shared by chat and CLI; channel-specific escaping happens in the channel's `ChannelIO.formatter` (`SlackFormatter`), never in the core. Non-string inputs are declared with `z.coerce.*` so HTTP query, CLI, and chat string arguments parse identically to MCP's typed JSON (and survive `z.toJSONSchema`). `invoke` emits one structured audit line per call: `{ commandId, caller.kind, caller.id, effect, outcome }`.
- KTD2. **Mechanical name mapping** (governs R7). `runs.list` → HTTP `/api/runs.list`, MCP `runs_list`, CLI `runs list`, chat `runs list`. `_` for `.` is the only substitution (dots are invalid in MCP tool names). This departs from the agent-tool `verb_noun` style (`list_skills`) deliberately: derivability beats style, and agent tools (`src/tools/`) are a different surface.
- KTD3. **`RunStore` seam, three implementations, `RunHistoryDO` with `runs` + `run_events` tables** (instantiates KD3; governs R3, R4). `src/core/runRecord.ts` (node-free, Worker-importable) owns `RunRecord`, `RunListItem` (record minus `events`, **includes `diagnosis`**), `isRunRecord` (requires a valid `FrictionDiagnosis`), `applyRetention`, `fitRecordToBudget`. `src/core/runStore.ts` owns the interface plus `InMemoryRunStore` and `FileRunStore`; `src/core/runStoreWorker.ts` the HTTPS client. The DO `put` is one `transactionSync`: upsert the `runs` row → skip event rewrite if `event_count`/`finished_at` unchanged → else `DELETE run_events WHERE run_id` → batched `INSERT` (batch size pinned to the DO bound-parameter limit) → trim by policy from both tables → orphan sweep → return `{ ok, retained, stored, rewritten }`. Per-route body cap 2 MB for `/runs/put` applied after routing and before `request.json()`; the global 411 rule stays. Byte caps are measured in bytes on both sides (`Buffer.byteLength` / `TextEncoder`). wrangler migration `v4`, `new_sqlite_classes: ["RunHistoryDO"]`, binding `RUNS`, store key `runs:default`. `RunStore` also exposes `events(id, { afterSeq, limit })` backed by `POST /runs/events` (`WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`), `list` caps rows at 200 and accepts `before` cursor pagination, and `POST /runs/delete {id}` (bearer-gated like `put`) removes a run and its events — the incident lever for a redaction miss. Capacity arithmetic: 5000 runs × 1.5 MB worst case is 7.5 GB, so `maxBytes` (default 2 GB) is the binding bound and must stay under the pinned per-object SQLite limit; the limits page is read in U12 and the numbers recorded there. Route contract: unknown id is `{ record: null }` with 200; a 404 means the route does not exist.
- KTD4. **Record built synchronously at finish; write deferred with bounded retries** (governs R3). The dispatcher publishes the `assistant` message, then calls `registry.finish`, then immediately builds the `RunRecord` from `registry.snapshot` — inside the run's try/catch so failed runs take the same path — and hands it to `writeRunRecord`, which runs after the reply is sent. Retries: two, jittered (1 s, 4 s), on network error/408/429/5xx only; never on 4xx. A 404 from `/runs/put` is `RouteMissingError`: logged once per process, no retry, `degraded` flag set. `pendingHistoryWrites()` increments before `activeRuns` decrements and is awaited by the shutdown drain; `runHistoryWriteFailures` counts permanent losses.
- KTD5. **The DO owns the retention policy; sweep by alarm** (governs R4, R11). A `meta` table holds `{ retentionDays, maxRuns, maxBytes, policyUpdatedAt }`, clamped to `retentionDays [1, 365]`, `maxRuns [1, 20000]`, `maxBytes [16 MB, 8 GB]`. Only `put` may carry a policy proposal, accepted when `policyUpdatedAt` is strictly newer and clamped to the DO clock (`min(proposed, now)`); `get`/`list` never send one. Reads apply the persisted policy; `put` trims at most 500 rows per call (deletion fence, logged); a DO `alarm()` every 6 h deletes everything outside policy so the tooltip's "then deleted" is true. `FileRunStore` runs the same sweep on process start and every 6 h from a timer started by `buildRunStore`. Cutoffs use the DO clock; `finished_at` more than 24 h in the future is clamped and `stored_at` (DO clock) is recorded.
- KTD6. **Sync live path, async history path** (governs R12). `RunsService.authorizeLive(id, token)` is synchronous and returns the registry subscription, so `serveEvents` stays byte-identical and its red-verified tests stay green; `sink.onClose` registration precedes any await. When it returns null, the handler falls to async `serveHistoryEvents`, which knows every event before writing a head. `serveIndexEvents` is untouched.
- KTD7. **Token-free projection** (governs R10). `RunsService` returns `RunRecord`/`RunListItem`; `RunSummary` (with token) stays internal to `runRegistry` and the live-row HTML renderer. The registry gains token-free `getById`/`snapshotById`/`requestStopById` for the service — a deliberate capability-model change: the registry enforces *capability OR operator*, with operator enforced by the command layer plus the Access gate; token-gated methods stay for the HTML path's defense in depth.
- KTD8. **Message events** (instantiates KD1; governs R1, R2). `RunEvent` gains `{ type: "message"; role: "user"|"context"|"assistant"; text: string; seq: number; at?: number }`; every published event gets a monotonic `seq`. Text cap 16 KB via `redactAndCap`; context items are text parts only, at most 20 items and 256 KB total, attachments reduced to `{ name, mime, bytes }`; `runHistory.persistContext: false` suppresses context events. `analyzeRunFriction` ignores `message` events for `firstAt`/`lastAt`/`eventCount` so the `long_run` metric is unchanged. `message` events never feed `lastActivity`, the status card, or the per-event `console.log` (log type/role/byte length only).
- KTD9. **The registry backlog is the only backlog, bounded by count and bytes** (governs R3). `backlogLimit` 5000 and `backlogBytes` 4 MB; the dispatcher's `runEvents` ring is deleted; friction diagnosis and persistence read `registry.snapshot`. Live SSE replays at most the newest 1000 frames with a leading "replaying last N of M" note; the full stream is available via `runs.events {afterSeq}` and the history replay. Per-run subscriber fan-out is exception-isolated like `notifyIndex`. `RunRegistry.markPersisted(id)` (called by `writeRunRecord` on success) sets `persisted: true` on the summary and emits an index `upsert`, which is how the `?all=1` client learns a row is store-confirmed.
- KTD10. **Per-command scopes and chat gates** (governs R9, R13). Each command declares `scope: "<group>:<read|write>"` and a `chatGate` (`open`, `operator`, or `repoManager` = the existing `canManageRepos` set). Caller → authorization: `mcp:*` and `access:svc:*` must hold the scope in their token's `scopes` (`SWITCHBOARD_INGRESS_TOKENS` default `["dispatch"]`; Access service tokens map `common_name` → scopes in config); browser `access:<sub>` holds all `read` scopes and holds `write` scopes only when `permissions.operators` lists the identity; `cli:local` holds all scopes; `slack:*` callers are checked against the command's `chatGate` via a public fail-closed `ConfigStore.isOperator(userId)` (backed by `permissions.admins`) or `canManageRepos`. A pinned `channel` on an ingress token is compared as the namespaced id `http:<channel>` and filters every command whose output derives from run data (`runs.*`, `friction.report`). Registrations: `runs.list/get/events/friction` = `runs:read`/chat `operator`; `runs.stop` = `runs:write`/chat `operator`; `friction.report` = `friction:read`/chat `open`; `friction.propose` = `friction:write`/chat `repoManager`; `repo.list` = `repo:read`/chat `open`.
- KTD11. **zod v4 `z.toJSONSchema` derives MCP `inputSchema`** (governs R7). zod `^4.4.3` is already a dependency; `tools/list` is derived at request time; `dispatch` stays hand-written. A command may pin a hand-written schema if derivation fails (stop condition b).
- KTD12. **`RunStoreFrictionLedger` is field-explicit and contract-preserving** (instantiates KD3; governs R5). `recent()` reads `store.list` (never `get`), default limit `DEFAULT_LEDGER_MAX` (500), reverses after limiting with the `runId` tie-break, unions `legacyLedger.recent()` deduped by id with the run-store row winning, and projects only `{ runId, label, agent, finishedAt, diagnosis }` — message text never reaches a `FrictionRunRecord` or an issue body. `record()` continues to write `FrictionDO` until decommission (KD3 call-out). `validateConfig` warns when `selfImprovement.ledgerMax` is set alongside `runHistory`.
- KTD13. **One route predicate, gated at the edge and in-process** (governs R7, R10). `commandHttp.ts` exports `isCommandPath(pathname)`; `src/index.ts` gates on that function (not a second prefix list) and the handler claims all of `/api/*`, answering its own 404 so nothing falls through to `200 ok`. The Cloudflare Access application is extended to `/api/*` before the bot deploy (Verification Contract gate). `verifyAccessJwt` accepts Cloudflare Access service-token JWTs (empty `sub`, non-empty `common_name`) as `access:svc:<common_name>` — the machine credential for `/api/*`. Under `ACCESS_DEV_BYPASS`, `/api/*` and history reads (`/runs?all=1`, persisted `/runs/:id` and `/runs/:id/events`) are served only when `req.socket.remoteAddress` is loopback and `PUBLIC_BASE_URL` is unset/localhost; otherwise 403.
- KTD14. **Config, not env, for retention and store selection** (governs R4). `runHistory: { retentionDays?, maxRuns?, maxBytes?, persistContext?, store?: "worker"|"file", worker?: { baseUrl, tokenEnv? } }` in `AppConfig`; bearer stays `MEMORY_TOKEN` (already forwarded by the container shim — no new secret). With no `runHistory` section history is **off** (live-only, as today); `store: "file"` is an explicit opt-in that writes `data/runs/<id>.json` (0600, dir 0700, temp-then-rename) plus `data/runs/index.jsonl` of `RunListItem`s.
- KTD15. **HTTP write safety** (governs R7). `effect: "write"` commands are POST-only (405 on GET), require `content-type: application/json`, reject a foreign `Origin`/`Sec-Fetch-Site`, and never receive CORS headers. Every `/api/*` response carries `Cache-Control: no-store`. The adapter reuses `readBody` with a cap and authorizes before buffering.
- KTD16. **No registry command starts an agent run** (governs Scope Boundaries). The auth-class enum has no class that authorizes a run; `defineCommand` documents the prohibition; anything that runs an agent goes through `dispatch()` where invariant 3 lives.
- KTD17. **Untrusted content on machine surfaces** (governs R10). `runs.list` returns metadata only; message bodies require `runs.get {include:"messages"}` or `runs.events`. Every stored free-text field returned over MCP/CLI/chat is wrapped in an explicit untrusted-content delimiter with a fixed preamble; Slack escaping is applied by `SlackFormatter` through the `ChannelIO.formatter` seam, not by the core.
- KTD18. **Chat exposure of run data is minimal** (governs R9, R11). `runs.get`, `runs.events`, `runs.friction` opt out of chat (`surfaces.chat: false`); `runs.list` in chat renders short id, agent, status, duration only — no `channelId`, `userId`, `threadKey`, or label — because the gate is on the caller, not the audience.
- KTD19. **Two-stage chat fast-path chain with reserved prefixes** (governs R7, R13). Stage A (text-only, before `io.history()`): config → repo → friction → registry chat commands. Stage B (history-dependent): `recognizeOperation` natural language, unchanged. `parseChatCommand` refuses groups owned by a legacy parser (`config`, `repo`, `friction`) until U9 transfers ownership by removing the prefix from the reserved list; it recognizes registered ids only, whole-message anchored, never natural language.

### High-Level Technical Design

```mermaid
flowchart TB
  subgraph surfaces[Thin adapters]
    HTTP["/api/&lt;id&gt; JSON<br/>(Access gate; writes POST-only)"]
    MCP["MCP tools/list + tools/call<br/>(bearer + scopes)"]
    CLI["commandCli &lt;group&gt; &lt;verb&gt;<br/>(cli:local)"]
    CHAT["chat fast-path stage A<br/>(isOperator gate)"]
    HTML["/runs HTML + SSE<br/>(Access gate; token for live)"]
  end
  REG["CommandRegistry<br/>auth → parse → handler → error map"]
  HTTP --> REG
  MCP --> REG
  CLI --> REG
  CHAT --> REG
  HTML --> SVC
  REG -->|runs.*| SVC["RunsService<br/>list/get/events/friction/stop<br/>authorizeLive (sync)"]
  REG -->|friction.*, repo.*| OTHER["existing core handlers"]
  SVC --> RR["RunRegistry (live, sync)<br/>backlog 5000 / 4 MB, seq"]
  SVC --> RS["RunStore seam"]
  RS --> MEM["InMemoryRunStore"]
  RS --> FILE["FileRunStore<br/>data/runs/&lt;id&gt;.json + index"]
  RS --> WK["WorkerRunStore → RunHistoryDO<br/>runs + run_events + meta, alarm sweep"]
  DISP["dispatcher"] -->|publish message/tool events| RR
  DISP -->|writeRunRecord (retry, drain-tracked)| RS
  FL["RunStoreFrictionLedger"] --> RS
  FL -.->|union, one window| LEG["FrictionDO (legacy)"]
```

Run lifecycle and the single write:

```mermaid
sequenceDiagram
  participant D as dispatcher
  participant R as RunRegistry
  participant A as runner
  participant C as channel
  participant S as RunStore
  D->>R: create(redacted label) → id, token
  D->>R: publish(message:context ×≤20, message:user)
  D->>A: runAgent(control)
  A->>R: publish(tool_call / tool_result / run_note …)
  A-->>D: reply (or throw)
  D->>R: publish(message:assistant)   — inside the try, before finish
  D->>R: finish(id)
  D->>D: record = fitRecordToBudget(snapshot + status + diagnosis)
  D->>C: sendAnswer(reply)
  D->>S: writeRunRecord(record)  (after reply; retries; drain-tracked)
```

Read merge for `runs.list {status:"all"}`: live rows from `registry.listActive()`; persisted rows from `store.list()`; union by id with the live row winning; sort `startedAt desc`; `limit` after the merge. If the store is unavailable the result carries `storeUnavailable: true` with live rows only; the default `active` view never touches the store.

### System-Wide Impact

**Interfaces and owners**

| Surface | Owner | Consumers | Note |
|---|---|---|---|
| `RunEvent` + `message`, `seq` | `src/core/runEvents.ts` | runner, registry, liveView (server + client), friction analyzer, `RunStore`, `frictionCli.ts` | Additive; every consumer ignores unknown `type` |
| `RunRecord`/`RunListItem`/`isRunRecord`/`applyRetention`/`fitRecordToBudget` | `src/core/runRecord.ts` | bot + state Worker by relative path | Cross-deployable; changes need a coordinated Worker+bot deploy |
| `RunStore` (3 impls) | `src/core/runStore.ts` | dispatcher, `RunsService`, `RunStoreFrictionLedger` | Invariant 2 |
| `RunsService` | `src/core/runsService.ts` | liveView, `runs.*` commands | A composition over two seams, not a boundary — one implementation is correct |
| `CommandRegistry` + 4 adapters | `src/core/commandRegistry.ts` | HTTP/MCP/CLI/chat | The adapter set is the boundary; the contract test is the parity proof |
| `Caller` | `src/core/commandRegistry.ts` | adapters, `stop_requested.actor`, persisted record | Platform-namespaced ids (invariant 4) |
| `ConfigStore.isOperator`, `IngressIdentity.scopes` | `src/config.ts`, `src/channels/http.ts` | chat adapter, MCP adapter | Both fail-closed |

**Entry points.** `/api/*` is a fourth authenticated ingress and the first that does not funnel through `dispatch()` — hence KTD16. `src/commandCli.ts` is a third CLI entry that builds deps in-process, including `buildRunStore`. MCP `tools/list` grows from one tool to one plus the registry.

**Callbacks and fan-out.** `RunRegistry.publish` → per-run subscribers becomes exception-isolated (KTD9). Index upsert rate is unchanged (already per event). `writeRunRecord` is fire-and-forget but drain-counted (KTD4).

**State lifecycle.** A run lives in the registry (live → finished → evicted at 60 s) and in the store (written after reply → retention). The finish→put window is live-listed but unpersisted; put→eviction is in both (merge, live wins). If `put` fails permanently the run vanishes at eviction — counted, logged. In `?all=1` the client suppresses `removed` only for rows flagged `persisted` via `markPersisted` (KTD9), so no ghost rows survive reload. Index rows are one normalized `IndexRow` projection for both live and persisted sources.

**Failure propagation**

| Failure | Behavior |
|---|---|
| No `runHistory` config | History off; live-only; logged at startup |
| Store down mid-run | reply unaffected; retries; then counted loss; `FrictionDO` write still lands (KD3 call-out) |
| Store down at read | `active` view unaffected; `all`/`runs.list` return live rows + `storeUnavailable` |
| Worker 413 | prevented bot-side by `fitRecordToBudget`; if still 413, no retry, counted |
| Bot deployed before the Worker with run-history routes | `/runs/put` 404 → `RouteMissingError`, one log, no retry; `/healthz` `features` probe at boot logs the ordering error; friction writes unaffected |
| `ACCESS_DEV_BYPASS` with a non-loopback remote address | `/api/*` and history reads refused (403) |

**Parity surfaces.** One `renderRunPage` (token optional, stop hidden when finished). `?all=1` index SSE: live rows stay live; persisted rows refresh on reload (`subscribeIndex` knows only registry runs). `runs.events` is not chat-renderable and opts out (KTD18).

**Deploy plumbing that does not change.** `deploy/cloudflare/worker.ts` already forwards `MEMORY_TOKEN`; only `deploy/cloudflare-memory/` and the Access application change.

### Assumptions

- Every `runs.*` caller is operator-class, so DM-sourced runs are listed as they are on today's live index; chat rendering hides identifying fields (KTD18). Revisit if a `user` class is added.
- A 1.5 MB bot-side record budget under a 2 MB Worker cap, with head+tail truncation, fits normal long runs; the `truncated` flag makes exceptions visible.
- zod v4's `z.toJSONSchema` handles the flat command inputs in this plan.
- Cloudflare DO SQLite bound-parameter and per-object storage limits are read from the current limits page in U12 (they fix the retention and budget helpers) and recorded in KTD3, not guessed; the defaults assume on the order of 100 runs/day.

### Sequencing

Phase 1 (U12 first; then U2 → U14 → U3 in parallel with U1 → U11; then U4 → U5) makes the record canonical and durable; U3 (the Worker) deploys before U4 (the bot write). U14 carries the friction-ledger adapter so the store engine (U2) merges independently of the ledger migration. Phase 2 (U6 → U7 → U13 → U8) adds the registry, adapters, and the dashboard toggle. Phase 3 (U9 → U10) migrates existing commands and finalizes docs.

---

## Implementation Units

### U12. `runRecord.ts` — node-free record type, validator, retention and budget helpers

- **Goal:** The cross-deployable contract both the bot and the Worker import.
- **Requirements:** R3, R4 (KTD3, KTD5)
- **Dependencies:** none
- **Files:** `src/core/runRecord.ts` (new), `src/core/runRecord.test.ts` (new), `features/run-history.md` (new; started here)
- **Approach:**
  1. `RunRecord = { id, label?, agent?, model?, channelId, userId, threadKey, repo?, startedAt, finishedAt, status, eventCount, storedEventCount, truncated, events, diagnosis }`; `RunListItem` omits `events`; `RetentionPolicy = { retentionDays, maxRuns, maxBytes }`.
  2. `isRunRecord` requires a valid `FrictionDiagnosis` (reuse `isDiagnosis`).
  3. `applyRetention(items, policy, now)` — the one function both sides run.
  4. `fitRecordToBudget(record, maxBytes)` — drop events from the middle, keep head (request, context, first tools) and tail (terminal notes), set `truncated`, keep `eventCount`; per-event cap 64 KB.
- **Patterns to follow:** `frictionProposals.ts` (node-free, Worker-imported).
- **Test scenarios:**
  - A 4 MB event list fits under 1.5 MB, keeps first and last events, sets `truncated`, preserves `eventCount`.
  - `applyRetention` hides a record 31 days old under `retentionDays: 30` and keeps the newest 3 of 4 under `maxRuns: 3`; `maxBytes` trims large runs before `maxRuns`.
  - `isRunRecord` rejects a record whose `diagnosis` lacks a `byCategory` key.
- **Verification:** `npm test`; the file has no `node:` import.

### U1. Message events in the run stream

- **Goal:** The stream carries request, context, and reply so live and history show the full exchange.
- **Requirements:** R1, R2 (KD1, KTD8)
- **Dependencies:** U12
- **Files:** `src/core/runEvents.ts`, `src/core/runEvents.test.ts`, `src/core/runRegistry.ts`, `src/core/runRegistry.test.ts`, `src/core/runFriction.ts`, `src/core/runFriction.test.ts`, `src/core/dispatcher.ts`, `src/core/dispatcher.test.ts`, `src/channels/liveView.ts`, `src/channels/liveView.test.ts`, `features/run-visibility.md`
- **Approach:**
  1. Add the `message` variant; `RunRegistry.publish` assigns `seq`; `create()` redacts the label.
  2. Dispatcher publishes `context` (text parts only, ≤20 items / 256 KB, attachments as metadata, gated by `persistContext`) and `user` after `create`; publishes `assistant` **inside the try before `registry.finish`** (moving `finish` out of the inner `finally` onto the success and catch paths).
  3. `analyzeRunFriction` skips `message` events for timing and count.
  4. `message` events bypass `lastActivity`, the status card, and the per-event log (type/role/bytes only).
  5. `liveView` renders `message` events as escaped text nodes in both the server HTML and the client script; never inside the inline `<script>`; fix the misleading `JSON.stringify` comment.
- **Patterns to follow:** `run_note` emission; `redactAndCap` ordering; server/client mirror tests.
- **Test scenarios:**
  - Publishing after `finish` is a no-op (registry); an `assistant` message published in the normal dispatcher path appears in `snapshot` (red-verifiable by restoring the old `finish` position).
  - A 20 KB user message is capped at 16 KB after redaction; a full PEM block, a multi-line `.env` paste, and `{"password":"…"}` inside a 16 KB message are absent from the stream.
  - Label containing a secret is redacted at `create()`.
  - A run with an image and a document yields context events with no base64 and no file body; a 50-message thread yields ≤20 context events within 256 KB; `persistContext: false` yields none.
  - Friction `runMs`/`eventCount` are identical with and without message events.
  - `</script><script>alert(1)</script>` and `"><img src=x onerror=alert(1)>` render inert on the page (AE9).
  - A multi-line message does not produce multiple log lines.
- **Verification:** `npm test`; a local run's page shows request, steps, reply.

### U11. Registry backlog consolidation and live SSE replay budget

- **Goal:** One backlog, bounded by count and bytes, with a bounded live replay.
- **Requirements:** R3 (KTD9)
- **Dependencies:** U1
- **Files:** `src/core/runRegistry.ts`, `src/core/runRegistry.test.ts`, `src/core/dispatcher.ts`, `src/core/dispatcher.test.ts`, `src/channels/liveView.ts`, `src/channels/liveView.test.ts`, `features/live-view.md`
- **Approach:**
  1. `backlogLimit` 5000, `backlogBytes` 4 MB (drop oldest past either).
  2. Delete the dispatcher `runEvents` ring; friction diagnosis reads `registry.snapshot`.
  3. Live SSE replay caps at the newest 1000 frames with a leading note; index stream unchanged.
  4. Wrap per-run subscriber fan-out in try/catch like `notifyIndex`.
- **Test scenarios:**
  - 5001 events drop the oldest one; 4 MB + 1 byte drops until under budget.
  - A late subscriber to a 3000-event run receives the note plus the newest 1000 frames; `snapshot` still returns all 3000.
  - A throwing subscriber does not break `publish` for other subscribers or the publisher.
  - Dispatcher friction diagnosis equals the diagnosis computed from `registry.snapshot`.
- **Verification:** `npm test`.

### U2. `RunStore` seam: in-memory, file, and Worker client

- **Goal:** Store interface with three implementations and config.
- **Requirements:** R3, R4 (KD3, KTD3, KTD14)
- **Dependencies:** U12
- **Files:** `src/core/runStore.ts` (new), `src/core/runStore.test.ts` (new), `src/core/runStoreWorker.ts` (new), `src/core/runStoreWorker.test.ts` (new), `src/config.ts`, `src/config.test.ts`, `config/config.example.yaml`, `config/config.production.yaml`, `features/run-history.md`
- **Approach:**
  1. `interface RunStore { put(record): Promise<PutResult>; get(id): Promise<RunRecord|null>; list(opts): Promise<RunListItem[]>; events(id, opts): Promise<{ events, nextAfterSeq? }>; delete(id): Promise<void>; }`; every implementation rejects an `id` failing `^[A-Za-z0-9_-]{1,64}$` before touching storage.
  2. `InMemoryRunStore`; `FileRunStore` as a directory store (`data/runs/<id>.json` temp-then-rename, 0600/0700; `data/runs/index.jsonl` of list items; retention unlinks files and compacts the index; torn files skipped; sweep on start and every 6 h per KTD5).
  3. `WorkerRunStore`: `POST /runs/put|get|list|events|delete`, string body with numeric `Content-Length`, 10 s timeout, bearer; only `put` sends `policy`; 404 → `RouteMissingError`; 5xx/408/429/network → `TransientStoreError`.
  4. `runHistory` config + `validateConfig` (`retentionDays ≥ 1`, `maxRuns ≥ 1`, `ledgerMax` deprecation warning) + `buildRunStore` (returns `null` when unconfigured; `store: "file"` opt-in; worker with empty token → null + warning naming the env var); `/healthz` `features` probe logged at boot; `worker.baseUrl` must be `https:`.
- **Patterns to follow:** `frictionLedger.ts`, `frictionLedgerWorker.ts` (`errorSuffix`), `buildFrictionLedger` warnings.
- **Test scenarios:**
  - 2 MB record round-trips in memory and file stores without reading other records; a truncated `<id>.json` is skipped by `get` and absent from `list` while others read; a stale index line is healed on the next `put`.
  - Expired record absent from `list`/`get`; a later `put` unlinks it.
  - Shrinking then growing `retentionDays` does not resurrect deleted records.
  - Created file mode is 0600; directory 0700.
  - `WorkerRunStore.put` of a 1.9 MB record sends a string body with numeric `Content-Length`; `get`/`list` send no policy; 404 → `RouteMissingError`; 503 → `TransientStoreError`.
  - `get("../../etc/x")` returns not-found without touching the filesystem outside `data/runs/`.
  - With no writes for `retentionDays + 1` days, the timer sweep unlinks expired files.
  - `events(id, {afterSeq: 10, limit: 5})` returns five events with `seq > 10` and `nextAfterSeq`.
  - `http://` `baseUrl` is rejected by config validation.
  - `buildRunStore` matrix: unconfigured → null; file opt-in → file; worker without token → null + warning; worker with token → worker.
  - Config rejects `retentionDays: 0`; warns on `ledgerMax` + `runHistory`.
- **Verification:** `npm test`, `npm run typecheck`.

### U14. `RunStoreFrictionLedger` adapter

- **Goal:** The friction ledger reads from the run store without changing its consumers.
- **Requirements:** R5 (KD3, KTD12)
- **Dependencies:** U2
- **Files:** `src/core/frictionLedger.ts`, `src/core/frictionLedger.test.ts`, `src/frictionProposeCli.ts`, `features/self-improvement.md`
- **Approach:**
  1. `RunStoreFrictionLedger` per KTD12 (union with an optional legacy ledger; `list` fetch bounded to the 500 default).
  2. `frictionProposeCli`'s JSONL detector rejects `RunRecord`-shaped lines explicitly.
- **Test scenarios:**
  - `recent()` with no options returns ≤500, oldest-first, identical ordering to `FileFrictionLedger.recent()` over the same fixture (differential test).
  - Union prefers the run-store row; a legacy-only run still appears; message text never appears in a projected record.
  - With a null run store the ledger falls back to the legacy Worker ledger unchanged.
- **Verification:** `npm test`.

### U3. `RunHistoryDO` on the state Worker

- **Goal:** Durable SQLite store owning the retention policy, with alarm sweep.
- **Requirements:** R3, R4 (KTD3, KTD5)
- **Dependencies:** U12
- **Files:** `deploy/cloudflare-memory/worker.ts`, `deploy/cloudflare-memory/wrangler.jsonc`, `deploy/cloudflare-memory/runs.test.ts` (new), `deploy/cloudflare-memory/vitest.config.ts`, `features/run-history.md`
- **Approach:**
  1. Tables `runs` (summary columns, `bytes`, `stored_at`, JSON summary), `run_events(run_id, seq, json, PRIMARY KEY(run_id, seq))`, `meta(key, value)`; index on `finished_at`; orphan sweep on every `put`.
  2. `put` transaction per KTD3; `stored: false` when the record falls outside policy in its own transaction; `rewritten: false` on identical retry.
  3. Policy handling per KTD5 (clamp, `policyUpdatedAt` monotonic, deletion fence K, `alarm()` every 6 h).
  4. Routes `/runs/put|get|list|events|delete`; `list` caps at 200 rows with a `before` cursor; per-route 2 MB cap after routing, before parse; `/healthz` returns `features: ["memory","friction","runs"]`.
  5. Read path tolerates a corrupt `run_events` row (skip, like `FrictionDO.recent`).
  6. wrangler `v4` migration, `RUNS` binding; add `runs.test.ts` to the include list.
- **Patterns to follow:** `FrictionDO`, `parseScopeKey`, `Validated<T>`, `friction.test.ts` (unique key per test); alarm precedent in `deploy/cloudflare-resident/worker.ts`.
- **Test scenarios:**
  - `put` then `get` returns events in `seq` order; 5000 events insert inside one `transactionSync`.
  - Two `put`s for the same id with different event sets leave exactly one coherent set; an identical repeat `put` reports `rewritten: false`.
  - A failed mid-`put` (constraint violation) leaves no `runs` row.
  - Conflicting policies: the older `policyUpdatedAt` is ignored; `retentionDays: 0` → 400; a shrink that would drop >25% deletes at most K per `put` while `list` already hides them; `get` with a generous body policy cannot resurrect a hidden row.
  - After a `maxRuns` or `retentionDays` trim, `run_events` for the evicted run is empty; a re-`put` with 3 events leaves 3 rows.
  - `finishedAt` one year in the future is clamped; `stored_at` recorded.
  - Alarm fires with no writes → expired rows deleted; `get` not-found.
  - Body at cap succeeds; +1 byte → 413; a 1.9 MB multibyte body is measured in bytes; missing `Content-Length` → 411; unknown route → 404; unknown id → `{ record: null }` 200.
  - Corrupt event row → run still returns with remaining events.
  - `/healthz` lists `runs`.
  - `list` with `limit: 1000` returns at most 200 rows and a cursor; `events` pages by `seq`; `delete` removes the run and all its `run_events`.
  - A policy proposal dated one year ahead is stored with the DO clock so a later, correctly dated proposal still wins.
- **Verification:** `cd deploy/cloudflare-memory && npm run typecheck && npm test`; deployed before U4 merges; `/healthz` shows `runs` in production.

### U4. Dispatcher write path and drain tracking

- **Goal:** Every finished run is persisted once, after the reply, with retries, without affecting reply latency or failure semantics.
- **Requirements:** R3, R5 (KTD4, KTD12)
- **Dependencies:** U1, U11, U2, U14, U3 (deployed)
- **Files:** `src/core/dispatcher.ts`, `src/core/dispatcher.test.ts`, `src/core/runHistoryWriter.ts` (new), `src/core/runHistoryWriter.test.ts` (new), `src/index.ts`, `src/cli.ts`, `features/run-history.md`
- **Approach:**
  1. `CoreDeps.runStore?: RunStore`; `src/index.ts` builds it via `buildRunStore`, wires `RunStoreFrictionLedger` (with the legacy Worker ledger as union source) as the friction ledger while keeping the `FrictionDO` `record()` write.
  2. Inside the run try/catch: publish `assistant`, `finish`, build `RunRecord` from `snapshot` + `analyzeRunFriction` + status, `fitRecordToBudget`. After `sendAnswer`: `writeRunRecord` with KTD4 retries (on success `registry.markPersisted(id)`); increment `pendingHistoryWrites` before `activeRuns--`. The failure branch (outer catch) calls the same `writeRunRecord` after its error reply.
  3. Shutdown drain waits on `pendingHistoryWrites()`; `runHistoryWriteFailures` exposed for the startup/periodic log.
- **Patterns to follow:** `scheduleReflection`/`pendingReflectionCount`, existing best-effort ledger write.
- **Test scenarios:**
  - Completed run → one `put` with `status: "completed"`, `eventCount` equal to published count, events including `user` and `assistant`.
  - Soft-stopped → `stopped_soft`; provider throw → `failed` and the record is still written; reply path still runs.
  - A `sendAnswer` slower than the registry TTL (inject `ttlMs: 10`) still yields a full record (record built at finish, not after reply).
  - 6000 published events into a 5000 backlog → `eventCount: 6000`, `storedEventCount: 5000`, `truncated: true`.
  - `put` 503 twice then 200 → one record, counter back to 0; 413 → no retry, one warn, failures counter +1; 404 → `RouteMissingError`, one log, no retry, friction ledger write unaffected.
  - SIGTERM during retry backoff → drain waits then exits within the deadline.
- **Verification:** `npm test`; locally with `store: "file"`, a run creates `data/runs/<id>.json`.

### U5. `RunsService` in the core

- **Goal:** One async service owning live+persisted reads, token-free projections, sync live authorization, and stop with actor.
- **Requirements:** R8, R9, R10, R12 (KTD6, KTD7, KTD10)
- **Dependencies:** U2, U4
- **Files:** `src/core/runsService.ts` (new), `src/core/runsService.test.ts` (new), `src/core/runRegistry.ts`, `src/core/runRegistry.test.ts`, `src/core/runEvents.ts`, `features/run-history.md`
- **Approach:**
  1. `createRunsService({ registry, store, analyze, now })` → `listRuns(opts)`, `getRun(id, { include })`, `getRunEvents(id, { afterSeq, limit })` (page cap 500 events / 256 KB, `nextAfterSeq`), `getRunFriction(id)`, `stopRun(id, mode, actor)`, sync `authorizeLive(id, token)`.
  2. Registry gains `getById`/`snapshotById`/`requestStopById(id, mode, actor)`; `stop_requested` note carries structured `actor { kind, id }` (charset-restricted, capped).
  3. Merge per HLTD, fetching at most `limit + activeCount` persisted rows; `storeUnavailable` degradation; persisted `getRunEvents` uses `store.events` (never a full-record fetch); results as `Result<T, "not_found"|"conflict">`.
- **Patterns to follow:** `analyzeRunFriction` purity; `testRegistry()` clock injection.
- **Test scenarios:**
  - Live run → record with `finished: false`, no `token` property; persisted run → same shape.
  - Run in both registry and store → once, live stop state, same `eventCount` before and after eviction.
  - `active`/`finished`/`all` filters; `agent`/`channel`/`sinceMs` filters; `limit` applied after merge.
  - `getRunEvents(afterSeq: 10)` returns `seq > 10` (strict) for live and persisted; a 5000-event run returns a bounded page with `nextAfterSeq`.
  - `stopRun` live → `stop_requested` with actor; finished/persisted → `conflict`; unknown → `not_found`; expired → `not_found`.
  - Store rejecting → `listRuns({status:"all"})` returns live rows + `storeUnavailable: true`; `listRuns({status:"active"})` never calls the store.
  - Every serialized output lacks the fixture token.
  - `listRuns({limit: 10})` against a 5000-run store fetches a bounded page.
- **Verification:** `npm test`.

### U6. Command registry

- **Goal:** The open/closed seam: register once, available everywhere.
- **Requirements:** R6, R7, R8, R9 (KD2, KTD1, KTD2, KTD10, KTD11, KTD16, KTD17)
- **Dependencies:** U5
- **Files:** `src/core/commandRegistry.ts` (new), `src/core/commandRegistry.test.ts` (new), `src/core/commands/runs.ts` (new), `src/core/commands/runs.test.ts` (new), `src/config.ts`, `src/config.test.ts`, `src/channels/http.ts`, `src/channels/http.test.ts`, `features/command-registry.md` (new)
- **Approach:**
  1. `defineCommand` (with `scope`, `chatGate`, `effect`, `surfaces`), `CommandRegistry`, `Caller` (with `scopes`), `CommandError` with HTTP status mapping, the audit line; `toSurfaceNames(id)`; `jsonSchemaFor(cmd)`; `renderCompact(output)`; untrusted-content wrapper for free-text fields.
  2. `ConfigStore.isOperator(userId)` public, fail-closed; `permissions.operators` for Access identities; `IngressIdentity.scopes` parsed from `SWITCHBOARD_INGRESS_TOKENS` (default `["dispatch"]`).
  3. Register `runs.*` per R8/R9/KTD18 (`surfaces.chat: false` on get/events/friction); `runs.stop` passes the caller as actor; channel-pinned callers filter reads.
- **Patterns to follow:** `structuredMessage.ts` zod usage; `frictionCommands.ts` pure-parse style; `canManageRepos` fail-closed shape.
- **Test scenarios:**
  - Duplicate id registration throws at startup.
  - Non-operator caller → `unauthorized` with neither handler nor parse spy called; `{status:"bogus"}` → `invalid_input` naming the field, not echoing the value.
  - `runs.get` unknown → `not_found`; `runs.stop` finished → `conflict`.
  - `toSurfaceNames("friction.report")` yields the four names; `jsonSchemaFor(runs.list)` has a three-value `status` enum.
  - A `dispatch`-only MCP caller is refused on `runs_list` and `runs_stop`; a `runs:read` caller pinned to channel X (`http:X`) gets no channel-Y runs; a `runs:write` caller is refused on a `friction:write` command.
  - Every invocation emits one audit line with command, caller, effect, outcome and no payload.
  - `limit="10"` (string) and `limit: 10` parse to the same input.
  - `runs.list` output contains no message text; `runs.get {include:"messages"}` wraps each text field in the untrusted delimiter.
  - `isOperator` is false when `permissions.admins` is absent.
- **Verification:** `npm test`, `npm run typecheck`.

### U7. HTTP, MCP, and CLI adapters and the shared contract test

- **Goal:** Generic adapters that wire every registered command with no per-command code.
- **Requirements:** R7, R9, R10 (KTD2, KTD11, KTD13, KTD15, KTD17)
- **Dependencies:** U6
- **Files:** `src/channels/commandHttp.ts` (new), `src/channels/commandHttp.test.ts` (new), `src/channels/mcp.ts`, `src/channels/mcp.test.ts`, `src/commandCli.ts` (new), `src/commandCli.test.ts` (new), `src/index.ts`, `src/channels/accessAuth.ts`, `src/channels/accessAuth.test.ts`, `src/channels/commandContract.test.ts` (new), `features/command-registry.md`, `features/mcp-ingress.md`, `features/access-gate.md`
- **Approach:**
  1. **HTTP:** `createCommandHttpHandler(registry)` claims all of `/api/*` (own 404); GET for `read` commands (query params), POST-only for `write` (KTD15); caller from the Access identity; `no-store`; `readBody` cap; exports `isCommandPath`. `src/index.ts` gates on `isCommandPath` and disables `/api/*` under dev bypass on non-loopback.
  2. **MCP:** `tools/list` = `[DISPATCH_TOOL, ...registry]`; `tools/call` invokes with `{kind:"mcp", id, scopes, channel}`; result text = one-line header + JSON body.
  3. **CLI:** `src/commandCli.ts` with pure `parseCommandArgs(argv)`; in-process deps like `cli.ts`; `--json` or `renderCompact`; exit 1 on command error, 2 on usage.
  4. **Contract test:** fixture registry + store (one live, one persisted run) driven through HTTP, MCP, CLI, and (after U13) chat; assert the `invoke` JSON deep-equal per row, text surfaces render from that object, and no token anywhere. Table-driven, one row per adapter.
- **Patterns to follow:** `authorizeRequest`; `handleMcpRequest` harness; `frictionCli.ts` parsing and exit codes.
- **Test scenarios:**
  - `GET /api/runs.list?status=all` → 200 JSON with `no-store`; `GET /api/runs.stop` → 405; `POST /api/runs.stop` with foreign `Origin` → 403 and no note published (AE8); bad mode → 400 `{error, code:"invalid_input"}`; `/api/unknown.cmd` → 404 (not 200 ok).
  - Every registry-derived path, plus `/api`, `//api/runs.list`, `/api/runs.list/`, and a percent-encoded prefix, is refused without an Access identity.
  - Dev bypass with a non-loopback remote address → `/api/*` refused; a service-token JWT (empty `sub`, `common_name`) yields caller `access:svc:<name>` and is honored; an Access browser identity without `permissions.operators` gets 200 on `runs.list` and 403 on `POST /api/runs.stop`.
  - MCP `tools/list` includes `runs_list` with derived schema; `runs_get` unknown → JSON-RPC error with `code:"not_found"`; `dispatch` unchanged.
  - CLI `runs list --status=all --json` equals the HTTP JSON; `runs frobnicate` exits 2.
  - Contract rows pass; a deliberately added `token` field fails the no-token assertion (red-verified once).
- **Verification:** `npm test`, `npm run typecheck`; production receipt of an un-authed 403 and an authed 200 on `/api/runs.list` after the Access application covers `/api/*`.

### U13. Chat adapter and the ordered fast-path chain

- **Goal:** Registry commands reachable from chat with unambiguous precedence and minimal data exposure.
- **Requirements:** R7, R9 (KTD18, KTD19)
- **Dependencies:** U6
- **Files:** `src/core/commandChat.ts` (new), `src/core/commandChat.test.ts` (new), `src/core/dispatcher.ts`, `src/core/dispatcher.test.ts`, `src/channels/commandContract.test.ts`, `features/command-registry.md`, `features/routing-and-config.md`
- **Approach:**
  1. `parseChatCommand(text, registry, reserved)` — registered ids only, whole-message anchored, `key=value` args, null for prose and for reserved groups.
  2. Dispatcher stage A chain: config → repo → friction → registry; stage B unchanged. Caller `{kind:"chat", id: msg.userId, operator: config.isOperator(msg.userId)}`.
  3. Reply via `renderCompact` as plain text; the Slack channel's `SlackFormatter` escapes mrkdwn; commands with `surfaces.chat: false` are not recognized.
- **Patterns to follow:** `frictionCommands.ts`; `recognizeOperation` anchoring.
- **Test scenarios:**
  - `runs list` from a non-admin → unauthorized text; from an admin → compact list with no `slack:D…`, `userId`, `threadKey`, or label.
  - `runs get id=…` is not recognized in chat.
  - `friction report --top 3` is handled by the legacy parser while `friction` is reserved; after U9 removes the reservation, by the registry, same reply.
  - Prose containing "runs list" mid-sentence is not recognized; `recognizeOperation` and the registry never both claim a message.
  - A stored label containing `<!channel>` renders inert.
- **Verification:** `npm test`; contract test gains the chat row.

### U8. Live view on `RunsService`: history pages and the index toggle

- **Goal:** `/runs` shows active by default with a "show all" toggle and truthful retention tooltip; persisted runs render as finished live runs.
- **Requirements:** R10, R11, R12 (KTD6, KTD7)
- **Dependencies:** U1, U5
- **Files:** `src/channels/liveView.ts`, `src/channels/liveView.test.ts`, `src/index.ts`, `features/live-view.md`
- **Approach:**
  1. `createLiveViewHandler(service, { retention })`; friction computation and 404/409 mapping move behind the service.
  2. Live runs: token required as today via `authorizeLive`; finished/persisted runs: `getRun` without token. Persisted page renders from the record through the single `renderRunPage` (stop controls hidden); `serveHistoryEvents` writes the stored stream then `SSE_END`; `stop` → 409.
  3. Index: one `IndexRow` projection for live and persisted sources; default `active` (no store call); `?all=1` uses `listRuns({status:"all"})`; rows gain status icon, duration, finished-at; toggle `title` = retention sentence; `?stream=1&all=1` keeps live rows live and suppresses `removed` only for store-confirmed rows.
  4. Live rows keep token hrefs; finished rows link `/runs/:id` without token.
- **Patterns to follow:** `indexRowHtml`/`fill()` mirror; `?stream=1` query-flag convention.
- **Test scenarios:**
  - Persisted run page → 200 with request/reply/tool events as text nodes; `events` → replay then `SSE_END`; `stop` → 409; friction → stored diagnosis.
  - Unknown, expired, and wrong-token-on-live → identical 404 body; live run without token → 404.
  - Default index lists only active and never calls the store; `?all=1` lists both; server row and client `fill()` row remain mirror-equal for finished rows.
  - Tooltip text equals "Finished runs are kept for 30 days, then deleted" for `retentionDays: 30`.
  - No `token` in any finished row's HTML; XSS payloads inert in index rows (AE9).
  - A truncated record renders head and tail with an "N events omitted" marker (AE11).
  - Under dev bypass with a non-loopback remote address, a persisted run page is 403.
  - A row flagged `persisted` survives its `removed` event in `?all=1`; an unflagged row does not.
  - Existing `serveEvents` tests unchanged and green.
- **Verification:** `npm test`; open a finished run's page > 60 s after completion locally.

### U9. Migrate existing chat commands onto the registry

- **Goal:** `friction report`, `friction propose`, `repo list` become registry commands with unchanged syntax and gates, gaining HTTP/MCP/CLI.
- **Requirements:** R13 (KD2, KTD10, KTD19)
- **Dependencies:** U7, U13
- **Files:** `src/core/commands/friction.ts` (new), `src/core/commands/repo.ts` (new), their tests, `src/core/frictionCommands.ts`, `src/core/frictionCommands.test.ts`, `src/core/repoCommands.ts`, `src/core/dispatcher.ts`, `src/channels/commandContract.test.ts`, `features/self-improvement.md`, `features/resident-repos.md`
- **Approach:**
  1. `friction.report {sinceMs?, limit?}` (`friction:read`, chat `open`), `friction.propose {dryRun?, repo?}` (`friction:write`, chat `repoManager`), `repo.list {}` (`repo:read`, chat `open`), delegating to existing pure handlers.
  2. Remove `friction` and `repo list` from the reserved-prefix list; legacy parsers translate remaining `repo` verbs only; delete redundant reply-formatting branches.
  3. Contract-test rows for each migrated command.
- **Test scenarios:**
  - `friction report` chat reply is byte-identical to the pre-migration golden output, for admin and non-admin callers (AE10).
  - `GET /api/friction.report?limit=5` returns JSON; CLI `friction report --json` matches.
  - `friction_report`, `repo_list`, `friction_propose` over MCP from a `dispatch`-only token → unauthorized; `friction_propose` from `runs:write` → unauthorized; from `friction:write` → runs (AE12).
  - A `repoManagement`-listed non-admin runs `friction propose` in chat as before; a channel-X-pinned token's `friction.report` shows no channel-Y labels.
  - `repo list` chat reply unchanged; `repo.list` over HTTP returns the same repos array.
- **Verification:** `npm test`; existing friction/repo command tests pass.

### U10. Feature specs, AGENTS map, README (residual)

- **Goal:** Docs describe the shipped behavior; the reversed "live-only" design is rewritten, not annotated.
- **Requirements:** all
- **Dependencies:** U8, U9
- **Files:** `features/run-history.md`, `features/command-registry.md`, `features/live-view.md`, `features/README.md`, `AGENTS.md`, `README.md`, `config/config.example.yaml`
- **Approach:**
  1. Finalize validation tables: every `[unit]` receipt names an existing test; `[agent]` rows: open a finished run > 60 s after completion; `?all=1`; `curl /api/runs.list` un-authed 403 / authed 200; MCP `tools/list` shows `runs_*`; CLI `runs list`; `/healthz` lists `runs`; alarm sweep observed via a short test retention.
  2. `AGENTS.md`: map rows for `runRecord`, `runStore`, `runsService`, `commandRegistry`, adapters; invariant 6 map note updated; add KTD16 as guidance.
  3. `README.md`: state-plane node (memory / friction / run-history DOs) in the architecture diagram; fix "a restart loses nothing except in-flight runs".
  4. `features/README.md` index rows for both new files.
- **Test expectation:** none — documentation.
- **Verification:** links resolve; index updated.

---

## Verification Contract

| Gate | Command | Applies to | Done signal |
|---|---|---|---|
| Bot unit tests | `npm test` | U1, U2, U4–U9, U11–U13 | green; tests named in `features/*.md` exist |
| Typecheck | `npm run typecheck` | all | clean |
| Build excludes tests | `npm run build` then `find dist -name '*.test.js'` | all | zero matches |
| State Worker tests | `cd deploy/cloudflare-memory && npm run typecheck && npm test` | U3 | green in workerd, including the 5000-event and 1.9 MB round-trips |
| Contract test | `npm test -- src/channels/commandContract.test.ts` | U7, U13, U9 | one row per adapter, JSON deep-equal, no token |
| Red steps | revert the KTD7 projection, the retention cutoff, or the assistant-publish position and observe the named tests fail | U1, U5, U8 | no-token, expired-404, and assistant-in-snapshot tests go red |
| Deploy ordering | state Worker (migration `v4`) deployed; production `/healthz` lists `runs`; Access application covers `/api/*`; an Access service token exists for the `[agent]` curl | before U4 / U7 merge | receipts on the PRs |
| Live `[agent]` receipts | finished run page after 60 s; `?all=1`; `/api/runs.list` 403/200; MCP `tools/list`; CLI `runs list --json` | U3, U7, U8 | receipts in `features/run-history.md` and on [#157](https://github.com/coreplanelabs/switchboard/issues/157) |

---

## Definition of Done

- All R1–R13 traced to merged units; each PR carries the feature-file updates for the behavior it changes.
- Contract test proves parity across HTTP, MCP, CLI, and chat for every registered command; no surface output or persisted row contains a capability token.
- A run finished more than 60 s ago renders fully on `/runs/:id` in production, with a receipt on [#157](https://github.com/coreplanelabs/switchboard/issues/157); the matrix row in [#81](https://github.com/coreplanelabs/switchboard/issues/81) flips to ✅.
- `friction report` output is served from the run store (union with legacy); `FrictionDO` writes continue until the deferred decommission issue is filed.
- No dead code from abandoned approaches remains (dispatcher `runEvents` ring, hand-written per-surface run handlers, redundant chat reply formatting).
- Worklog entry per merged PR.

---

## Open Questions

- **Deferred:** Hide DM-sourced runs from a future `user`-class caller; today every caller is operator-class and chat rendering already hides identifying fields.
- **Deferred:** Date for decommissioning `FrictionDO` writes and the legacy union (after one retention window).
- **Deferred:** Whether a provisional pre-reply `put` is worth the double write to close the finish→put crash window.
- **Deferred:** Record `actor.id` as Access `sub` (chosen default) or `email` (better audit trail) for HTTP callers.

---

## Risks and Dependencies

- **Capability-token leak** through any new serialization of `RunSummary` — KTD7 type separation plus the no-token contract assertion.
- **Crash window:** a record is durable only after `put` returns; a process kill between finish and write loses that run (at most one per in-flight run) — counted and logged; provisional write deferred.
- **Record size:** a pathological run can exceed the 1.5 MB budget even after truncation; the DO 413s, counted. Specified fallback if this recurs: chunked `begin/append/commit` with `INSERT OR IGNORE` on `(run_id, seq)`, `complete` flag filtered on every read, and a sweep of incomplete runs older than one hour — not built now.
- **DO hot spot:** one `runs:default` object serves all writes and reads; identical-retry fast path and batched inserts bound the cost; the trigger for sharding by month key is p95 `/runs/put` or `/runs/list` latency above 2 s, and sharding is a follow-up project (cross-shard `list` fan-out plus row migration), not a config flip.
- **Access boundary widens:** Access identity alone now authorizes 30 days of transcripts (previously 60 s of tool summaries plus a token). The Access application's policy audience is reviewed and recorded in `features/access-gate.md` as a rollout gate.
- **Redaction at 16 KB:** regexes tuned for 200-char summaries; at-rest coverage tests (PEM, `.env`, JSON credential) added in U1; `persistContext: false` is the deployment-level fallback.
- **Self-improvement metric stability:** message events are excluded from analyzer timing (KTD8) so `long_run` is comparable across the change; the population is unchanged only while the union read is in place — the deferred decommission must first satisfy R5's 500-run floor (raise `retentionDays` or read count-based).
- **SSE contract:** the live path stays byte-identical by construction (KTD6); only the history path is new.
- **Deploy ordering:** Worker before bot; the `/healthz` probe and `RouteMissingError` make a wrong order loud and non-destructive.
- **zod v4 JSON-Schema derivation:** per-command hand-written schema fallback (stop condition b).

---

## Addendum — phase 4 (typed commands)

The product owner's principle, verbatim intent: *"the lowest level is just TypeScript. Each command is a method with statically typed ARGUMENTS and OPTIONS. CLI is a thin wrapper; camelCase in TypeScript, kebab-case in the CLI, snake_case in MCP, or whatever makes sense — i.e. commands, params, args. commandCli is wrong: the CLI itself is the thin wrapper."* Phase 4a rebuilt the registry around it; phase 4b migrates the remaining chat verbs (memory, config, repo-mutating) and the standalone CLIs.

### Key Technical Decisions (continued)

- KTD20. **Typed command model.** `defineCommand({ id, args?: [{ name, schema, describe, rest? }], options?: z.object({ camelCase }), scope, chatGate, effect, surfaces?, describe, handler({ args, options, caller, deps }), render? })`. `args` are positional and ordered (required unless the schema accepts `undefined`; required before optional; the last may be `rest: true` = free text joined from the remaining tokens); `options` is one camelCase `z.object`. The handler's `args` (an object keyed by argument name) and `options` are inferred from the zod declarations — a `const` type parameter on `defineCommand`/`commandDefiner<D>()` keeps the argument names literal. `invoke(id, { args: unknown[], options: Record<string, unknown> }, caller)`: adapters pass parsed-but-untyped values; the registry validates (`parseInput`: positionals by order, options strict — an unknown key is `unexpected option`). Definition-time checks reject a malformed id, a required-after-optional argument, a non-last `rest`, non-camelCase names, and an argument/option name clash (the JSON surfaces address both by name). A command's own `.refine(…, message)` text survives `describeIssue` (zod `custom` issues carry authored text, never the value).
- KTD21. **Everything derived, one grammar, one naming table.** `src/core/commandSurface.ts` is the only place a surface name or a grammar exists: `camelToKebab`/`kebabToCamel`/`cliFlag`, `mcpToolName` (`group_verb`), `httpPath` (`/api/group.verb`), `cliWords`/`chatForm`; `tokenize` (quotes, Slack smart quotes normalized); `parseInvocation` — the ONE binder for CLI argv and chat text (`<positional…> [--flag value | --flag=value | --bool | --no-bool]…`, `--` ends options, `--help`, dotted keys nest, structured usage errors that never echo a value); `namedToInput` for the JSON surfaces (HTTP query/body, MCP arguments address arguments and options by name in one flat object — kebab-case query keys, camelCase JSON); `jsonSchemaFor` (arguments + options merged, `required`, `additionalProperties: false`); `usageLine`/`helpText`/`catalogueText` from the definitions and zod `.describe()` texts. Adapters call these and add transport only. The legacy `friction … --flags` translator (`frictionCommands.ts`) is deleted: its flags ARE the derived grammar now. Alternative rejected: a `{ args: [...], options: {...} }` POST body shape distinct from MCP's by-name object — one by-name shape for every JSON surface is simpler, and argument names are already load-bearing in the schema.
- KTD22. **`src/cli.ts` is the CLI, with one built-in.** The derived CLI (`npx tsx src/cli.ts <group> <verb> [args…] [--option value…] [--json]`; exit 1 on command error, 2 on usage; `help` and `<group> <verb> --help` derived) replaces `commandCli.ts`, and `buildCoreCommands` moves to `src/core/commandCatalogue.ts`. The old "send a message" behavior is the ONE built-in beside the derived commands: `npx tsx src/cli.ts ask [--thread <key>] "<text>"` runs `dispatch()` on a `ConsoleIO` channel. It is deliberately NOT a registry command (an `ask.send`/`agent.run` registration was considered and rejected): KTD16 stands unbroken — no registry command starts an agent run; `ask` is a channel (like MCP's hand-written `dispatch` tool beside the registry tools), never in a catalogue, never reachable through `invoke`. The `SWITCHBOARD_THREAD` env default is dropped (`--thread` is the option).
- KTD23. **Chat: a recognized command with a malformed tail is a usage reply, never a model turn.** `parseChatCommand` recognizes `<group> <verb>` for registered, chat-exposed, non-reserved ids at the START of the message and binds the rest with the shared grammar; unknown flags, surplus words, missing arguments reply with the derived usage (values never echoed) and are not runs. Prose (unknown verb/group, mid-sentence mention) is still never a command. Consequences accepted: `runs list please` is now corrected rather than sent to the model; the two friction-specific legacy sentences (`🚫 Filing friction proposals …`, bare `⚠️ <message>`) give way to the shared wording (``🚫 `friction propose` is restricted…``, ``⚠️ `friction propose`: <message>``); `--top` on `friction report` (always ignored) is now `unknown option --top`; the whole-`friction`-group claim (`friction bogus` → usage) is gone — an unknown verb is prose like any other group.
- KTD24. **Chat gates widen for 4b.** `ChatGate` gains `channelConfig` (`canEditChannelConfig`, open when `permissions.channelConfig` is absent) and `agentRun` (`canRunAgent(userId, "coding")`), resolved by `ConfigStore.chatGateFor`; no phase-4a command uses them. The positional binder already supports what 4b's `config instructions <scope> <text…>` and `--models.coding=x` need (trailing free text, dotted option keys).

### Phase 4b — every remaining command on the registry (done)

Migrated: `help.show` (bare `help` in chat), `config.show|set|clear|instructions`, `memory.list|forget`, `repo.onboard|offboard|reconfigure|rebuild` (`repoManager`), `repo.test|build` (`agentRun`, `repo:exec`), `schedule.list`, `friction.analyze` (CLI-only, ex-`frictionCli`), `deploy.plan` (all surfaces) / `deploy.all` (CLI-only, ex-`npm run deploy:all`), `env.bootstrap` (CLI-only, ex-`agent-env-bootstrap`). Deleted: `handleConfigCommand` + `helpText` (dispatcher), `repoCommands.ts` (parser/handler; the admin client + validators moved to `residentAdmin.ts`), `memoryCommands.ts`, `frictionCli.ts`, `frictionProposeCli.ts`, `deploy/deployAllCli.ts` (runner → `deploy/run.ts`), `agentEnv/bootstrapCli.ts` (host half → `agentEnv/host.ts`), the `agent-env-bootstrap` / `deploy:all` npm scripts, `RESERVED_CHAT_COMMANDS`, `CoreDeps.residentAdmin|operations` (now `CoreCommandWiring`), `bootstrap.ts`'s `parseArgs`/`USAGE`. The dispatcher's stage A is the registry's chat adapter and nothing else. Still open from the 4b list: whether MCP's `dispatch` and HTTP `/ingress` should share the `ask` channel code path (unchanged; both remain channel built-ins).

- KTD25. **Chat: no reserved forms, one help word.** `parseChatCommand(text, catalog)` drops the `reserved` set: a `<group> <verb>` is a command iff registered and chat-exposed. The bare word `help` maps to `help.show` (only when registered + chat-exposed; `help me` stays prose). Since no legacy parser exists, "reserved for a legacy parser" has no meaning; migrating a verb is registering it.
- KTD26. **One grammar means one spelling — accepted wording/grammar changes.** The former `key=value` forms are gone: `config set me --agent review` (not `agent=review`), `--models.coding p/m` (dotted keys nest), `repo onboard acme/api --ref main --test "npm test"` (not `ref=main test="…"`), `memory list --scope me` (not `memory list me`), `config instructions me "…"` is its own verb (not `config set me instructions …`; `--instructions` on `config set` is `unknown option`). Quotes are the tokenizer's: `"a" or "b"` binds as `a or b` (the legacy `unquote` kept inner quotes). Error wording is the shared chat wording: `⚠️ \`config set\`: effort: expected one of "low", "medium", "high"` (was `Unknown effort \`turbo\`…`), `⚠️ \`repo onboard\`: slug: expected a GitHub owner/name slug` (was a bespoke sentence), `🚫 \`repo test\` is restricted…` for a user without coding access (was the coding-agent allowlist sentence), `⚠️ \`repo test\`: op-refused …` for a policy refusal (was `🚫`). Alternatives rejected: keeping `key=value` as a second accepted form (two grammars), or a per-command tokenizer for `instructions` (one grammar is the point).
- KTD27. **`Caller.origin`.** A chat caller carries `{ channelId, threadKey, repo?: () => Promise<string | undefined> }`: the default target of channel-scoped config commands, the channel memory scope, the local op workspace, and the lazily resolved thread repo (paid only when `memory list` asks for the repo scope — `io.history()` + `resolveRepoContext`, mirroring #302's "resolve only when a list asks"). Context, not a pin; machine callers have none and must say `--channel` / `--repo`. Alternative rejected: always-on `Caller.channel` for Slack humans (it is the authorization pin for `runs.*`).
- KTD28. **Handler-decided refusals.** `CommandError` gains `invalid_input` and `unauthorized`; `InvokeResult` failures carry `decidedBy: "registry" | "handler"`. Chat words a registry refusal as the fixed "is restricted" line and a handler refusal with its reason; machine surfaces see the same status either way. This is how data-dependent gates (`config set channel` under `channelConfig`, `memory forget` on a shared scope, `canUseRepo` on `repo test`) live inside a command that declares an `open`/`agentRun` gate. Alternative rejected: splitting `config.set` into per-scope ids to keep every gate declarative (`config set channel` is one verb with a scope argument).
- KTD29. **CLI-only commands replace the standalone scripts.** `surfaces: { chat:false, mcp:false, http:false }` marks the three that spawn processes or read the operator's disk (`deploy all`, `env bootstrap`, `friction analyze`); everything else is on every surface. The runners are injected deps (`deploy.run`, `env.bootstrap`, `friction.readSource`) so the commands are unit-tested without a process. `deploy all` carries #303's live gate + heartbeat (`src/deploy/run.ts` is the former `deployAllCli` body; `plan.ts`/`liveGate.ts` are taken verbatim from main); its exit codes collapse to the CLI's 1. `frictionProposeCli`'s "propose over saved capture files" mode is retired (the ledger/run store is the source of recent runs on every surface). `deploy/agent-env-bootstrap.sh` execs the registry command.
- KTD30. **Deterministic ops are registry commands with their own scope class.** `CommandScope` gains `<group>:exec`; `repo.test|build` declare `repo:exec` + `agentRun` and run the `Operations` seam (the catalogue's `defaultOperations` mirrors executor selection; tests inject `operations`). Not an agent run — KTD16 stands. The natural-language recognizer (`recognizeOperation`) keeps only the NL forms and translates them into a `repo.test`/`repo.build` invocation; `not_found`/`unavailable` fall through to the agent, everything else replies. `memory.forget` and the mutating/exec `repo.*` verbs join `friction.*` as inline runs (`isInlineRunCommand`).
- KTD31 (phase 5). **One error vocabulary across surfaces.** Amends KTD22/KTD23's "usage": a grammar rejection (`parseInvocation` — unknown option, missing argument, bad flag value, surplus positional, unterminated quote) is `{ kind: "invalid", code: "invalid_input", error }`, the very code the registry's `parseInput` gives the same fault from a query string or a JSON body; the CLI and chat differ from HTTP/MCP only in the message (the usage hint). The CLI exits 2 for `invalid_input` from either source (2 = rejected invocation, 1 = ran and failed); chat's reply carries `error: "invalid_input"`. `usage` survives only where the registry has no equivalent (no `<group> <verb>`, an unknown command, a malformed `ask`). The conformance suite (features/command-registry.md item 25) expects one code per variant on every exposed surface and asserts no matrix row has two exposed cells that disagree.
- KTD32. **`deploy restart` — a rotated bot secret goes live without an image build.** `wrangler secret put` updates the Worker env; a running container keeps the env it started with, and Cloudflare rolls a container only on an image/config change. The documented restart is the Container DO calling `stop()` (SIGTERM → the bot's drain) and the next request starting it with envVars computed AT START from the DO's current env (deploy/cloudflare/worker.ts `containerEnv`/`startBot` — no longer set in the constructor). The Worker exposes it as `POST /admin/restart` (`{force?}` → 202 stopping / 409 refused / 200 not-running), authorized by a `SWITCHBOARD_INGRESS_TOKENS` bearer whose identity carries `deploy:write` — the very scope the `deploy.restart` command declares (an Access JWT cannot be checked in the Worker: the operator rule lives in the container's config.yaml; a fresh secret was rejected because the bot already has a scoped machine-identity map). The registry command `deploy.restart` (CLI only, like `deploy all`) POSTs it with `$SWITCHBOARD_DEPLOY_TOKEN`, waits out a 409 with the deploy heartbeat, and is done only once `/healthz` (which gains `startedAt`, the process start) answers not draining with a LATER `startedAt` — `build.commit` is unchanged by a restart, so it cannot be the identity (`src/deploy/liveGate.ts` `decideRestarted`, sharing `decideLive`'s core). The keep-alive cron (every minute) and the CLI's poll are what trigger the restart after the drain exits. Not built: a push-reload of env into a running container, or a service-binding indirection — neither is Cloudflare's model.
- Memory scopes (#302): `memory list --scope <me|org|repo|channel|all>` (+ `--repo`) carries #302's `repo`/`channel` scopes on the typed model, keyed by the same `deriveScopeKey` derivers the read/write paths use; the thread's repo is resolved lazily through `Caller.origin.repo` (main's `resolveRepoForCommand`), exactly when #302 resolved it — only for a list that asks for the repo scope.
