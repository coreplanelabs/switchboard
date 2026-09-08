---
title: A sandbox Worker/image rollout never looks like a dead or silent sandbox - Plan
type: fix
date: 2026-09-07
status: implemented
execution: code
---

# A sandbox Worker/image rollout never looks like a dead or silent sandbox - Plan

Tracking issue: [#569](https://github.com/coreplanelabs/switchboard/issues/569). Three read-only investigations (SDK version-check mechanics, the sandbox deploy live gate, the empty-error rendering path) and one adversarial review shaped this plan; the review's required changes are folded in below and the rejected alternatives are recorded.

## The failure, mechanically

1. `wrangler deploy` of the sandbox Worker uploads new Worker code and starts an image rollout. Cloudflare replaces instances in waves (`rollout_step_percentage` default `[10, 100]`; each instance: SIGTERM → its own exit grace → SIGKILL → a new instance). Cloudflare's own words: "new Worker code can still reach container instances on the previous image until the rollout finishes."
2. A Durable Object created in that window (the #520 review, 111 s after the upload) was placed on a container still running the previous image (the 0.3.7 server). The 0.12.9 SDK's `onStart` version check asked `/api/version`, got a 404, logged `container=unknown` at info level, and did nothing else.
3. `exec` → `createSession` succeeded (the 0.3.7 server accepts that body) → `POST /api/execute {command, sessionId}` → the 0.3.7 handler wants `{id, command}` → 400 `{"error": "Session ID and command are required"}` → the client built `new SandboxError(errorResponse)` with `message = undefined` → `""`. Every exec, 6–32 ms, for 90 s.
4. The Worker's catch computed `raw = shape.message ?? String(err)` → `""` (a string, so `??` never fired), no classifier matched, and `/exec` finished `{error: "", stdout: "", stderr: "", exitCode: 127}`.
5. The executor throws `ExecInfraError` only for a truthy `data.error`, so the body fell through to a normal `exit 127:\n`; `ExecHealthTracker` counted a success and reset the streak; the runner showed seven silent red `exit 127` rows; the model reported "my workspace shell was down".
6. The rollout wave then SIGTERMed the old instance, the DO was re-instantiated on a new-image container, and the run recovered by luck.

## Fixes

### L1 — never an empty failure text (Worker)

`thrownText(shape)` in `src/execution/sandboxErrors.ts`: the SDK message when present, else `sandbox exec failed with no message from the SDK (<name>[, code <code>]); the container may still be running a previous image while a Worker/image rollout is in progress — retry in a minute`. Both Worker catches use it; classifiers keep reading the raw shape. The SDK's destroy-time disconnect text (`The sandbox was destroyed while the operation was pending.`) joins the recycle shapes. Static guard: the Worker source contains `thrownText(` and no `.message ?? String(err)`.

### L2 — the executor names a present-but-empty error (executor)

An `/exec` body that carries an `error` key whose value is the empty string is the Worker's failure shape with its message missing (a success body has no `error` key at all), so `send()` throws `ExecInfraError("sandbox worker /exec: failure with an empty message")`. Rejected: classifying a bare `exitCode 127` with no output as infra — `foo 2>/dev/null` and a literal `exit 127` are legitimate silent 127s, and two in a row would abort a healthy run.

### L3 — the rollout window closes, and a skewed container heals itself once (Worker)

- `deploy/cloudflare-sandbox/wrangler.jsonc` gets `"rollout_step_percentage": 100`: old instances are replaced in one wave, so the window in which a NEW thread can be placed on an old-image instance shrinks from minutes to seconds. In-flight commands on old instances die in either mode (the rollout SIGTERMs every old instance eventually; the grace period is already 0); this only moves that moment earlier. This is the layer that closes the window.
- `SwitchboardSandbox.onStart()` logs only: `await super.onStart()`, then `client.utils.getVersion()` compared with the pinned SDK version (imported from the Worker's own `package.json`, the pin `check:sandbox-pair` enforces; `resolveJsonModule` on) → `sandbox.version-skew container=<v> sdk=<pin>` at warn level. No `destroy()` here. Rejected: destroying in `onStart` — it runs inside `blockConcurrencyWhile`, `destroy()` is unbounded and coalesced callers hang until eviction, a fresh placement during a gradual wave can land on the old image again (the incident's DO was brand new), and the healthy-but-not-running state after a destroy takes the SDK's stale-state path, which can `ctx.abort()` the DO.
- `SwitchboardSandbox.exec()`: when `super.exec` rejects with the legacy shape — `err instanceof Error && err.name === "SandboxError" && err.message === "" && err.code === undefined` (`SandboxError` is not exported; inside the DO the prototype and getters are intact) — the command never dispatched (the 400 is pre-dispatch), so: `Promise.race([this.destroy(), 10 s])`, then retry ONCE; a second failure propagates and L1 names it. A concurrent exec on the same DO would be rejected with the destroy disconnect text, which L1's recycle shapes now cover; the thread-admission rule (one live run per thread) makes that concurrency rare.

### L4 — the sandbox deploy is live only when the Worker, the rollout and a probe agree (deploy CLI)

`deploy all` gains a `liveGate` for the sandbox (today only the bot has one; the sandbox is reported "uploaded"). Within the shared 20-min deadline, 15 s poll:

1. `GET /healthz` with the `SANDBOX_TOKEN` bearer (the bearer-aware read `run.ts` already has for the affected probe) → `build.commit` matches HEAD via `decideLive`.
2. Rollout complete: `wrangler containers instances <appId> --json` — every instance with `state === "running"` reports `version === <app version from containers info --json>`; other states are ignored. App id by name (`switchboard-sandbox-switchboardsandbox`) via `containers list --json`, as the bot preflight does.
3. Probe: `POST /exec` with `x-thread-key: deploy-gate:<commit>` and `{command: "echo ok", timeoutMs: 60000}` → `exitCode 0`, `stdout ok`; then the probe's instance (`name` = thread key) reports the app version. `reason: "fleet-busy"`, `Container is starting`, any `{error}` body or a nonzero exit → `waiting`, never a failure, until the deadline.
4. `SANDBOX_TOKEN` becomes `requiredEnv` for the sandbox step (the secret exists; the workflow header says optional — update it).
5. The result lands in the results table and job summary like the bot's; later Workers are not attempted on a gate failure (existing order semantics). The probe holds one fleet slot for the 5-min idle window per deploy — named in the spec.

## Spec, tests, receipts

- `features/execution.md`: item 3 gains the never-empty rule; item 6 rewrites the sandbox rollout window from "known operational property" to a named, closed-and-gated property; item 9 gains the present-but-empty classification and the destroy disconnect shape; rows bind each behaviour to its test.
- `features/release-and-deploy.md`: new item "the sandbox is live when the Worker, the rollout and a probe agree"; `plan.test.ts` stops pinning "only the bot has a live gate".
- Tests first: `sandboxErrors.test.ts::thrownText`; `cloudflareSandbox.test.ts::in-body empty error`; `sandboxKeepalive.test.ts` static guards (`thrownText(`, `getVersion(`, `legacyContainerError(`); a pure `legacyContainerError(err)` predicate; `liveGate.test.ts::decideSandboxLive` with `waitUntilLive` given injectable deps; `plan.test.ts`.
- Receipts (#228, #505): the next sandbox deploy's gate output; L3's receipt is the absence of empty-tailed `sandbox.exec error` lines across the next rollout plus any `sandbox.version-skew` line.

## Sequencing

- PR A: L1 + L2 + L3 + this record + spec.
- PR B: L4 + spec, independent; exercised by the deploy that ships PR A.
