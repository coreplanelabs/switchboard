# Execution & sandboxes

Tools never touch the bot host: every `bash`/`read_file`/`write_file` runs through an `Executor`. Production uses per-thread Cloudflare Sandboxes behind the proxy Worker; a thread's follow-ups reuse its workspace.

- **Code**: `src/execution/` (executor, factory, cloudflareSandbox, e2b, githubApp), `deploy/cloudflare-sandbox/worker.ts` + `Dockerfile`
- **Docs**: [README — Trust model](../README.md#architecture), [AGENTS.md invariants 5, 6](../AGENTS.md)
- **Tests**: none unit-level yet — this layer is dominated by infrastructure behavior; the live checks below are the record.

## Behavior

1. **Per-thread isolation**: one workspace/sandbox per `threadKey`; follow-ups reconnect. Losing a sandbox degrades gracefully — repos re-clone, nothing else is lost.
2. **Command timeout is shell-level and structured**: every `/exec` runs under `timeout -k 10 280` inside the sandbox; a deadline kill is a genuine **exit 124** (137 normalized to 124) with an actionable stderr line. The SDK's `COMMAND_TIMEOUT_MS` (320s, Dockerfile) is a pure backstop. History: the SDK's own timeout surfaces only a useless generic error — see PRs [#27](https://github.com/coreplanelabs/switchboard/pull/27), [#30](https://github.com/coreplanelabs/switchboard/pull/30), [#33](https://github.com/coreplanelabs/switchboard/pull/33).
3. **Heartbeat streaming**: `/exec` responses send headers immediately, a whitespace heartbeat every 15s, then one JSON document — no hop ever sees an idle connection (idle drops lost results in transit; PR [#32](https://github.com/coreplanelabs/switchboard/pull/32)). Failures arrive in-body in a dual shape (`error` + `exitCode: 127`/`stderr`) so old/new executors both render them; in-body errors are never blindly retried.
4. **Session recovery**: a container restart under a live Durable Object orphans the SDK's cached session; the Worker detects the stale-session error (including the SDK's message-erasing file-op variants), resets, and retries once (PR [#31](https://github.com/coreplanelabs/switchboard/pull/31)).
5. **GitHub identity**: a GitHub App mints 1-hour installation tokens on demand, injected into sandboxes as `GH_TOKEN` — never stored on the bot host. Required app permissions: Contents, Pull requests, Issues (all RW) + Actions/Checks/Statuses (read), Workflows (RW). PRs are authored as `<app>[bot]`. **The installation must cover every repo agents are asked about** — with `repository_selection: "selected"`, an uncovered repo 404s on every `gh` call (found live 2026-08-21: the app wasn't installed on `coreplanelabs/switchboard` itself, so the review agent couldn't review this repo's own PRs). Prefer "All repositories" on the org, or audit the selection when adding repos.
6. **Known operational property**: a bot deploy has a **~10–15 min deaf window** (container image rollout); Socket Mode events during it are lost, not redelivered. Sandbox-worker deploys similarly roll containers — in-flight thread sandboxes are recovered by (4) but lose disk.

## Validation criteria

| Criterion | Proof |
|---|---|
| ≤280s commands succeed; >280s return exit 124 + timeout stderr | `[agent]` In Slack: `@switchboard agent:review run \`sleep 45 && echo OK\` then \`sleep 320 && echo NO\`, report raw results`. Expect `OK` then `exit 124: command timed out in the sandbox after 280s…`. (Validated 2026-08-21, [receipt](https://github.com/coreplanelabs/switchboard/pull/33#issuecomment-5375104802); [thread](https://coreplanelabs.slack.com/archives/C0BQS7KPJHK/p1787341095008729).) |
| Long commands stream heartbeats (no `fetch failed`) | `[agent]` Covered by the same run — pre-#32 the 320s case surfaced as `fetch failed`. |
| Session recovery after container replacement | `[agent]` Run a command in a thread, `wrangler deploy` the sandbox worker (replaces containers), run a follow-up in the same thread — it must succeed (repo re-clones), not 500 `Session not found`. |
| Thread workspace reuse | `[agent]` `agent:coding create file /workspace/marker.txt`, then follow-up `cat marker.txt` — must print the content (same sandbox), unless the sandbox expired (then a legible re-clone story, not a crash). |
| Shell quoting through the timeout wrapper | `[unit]`-adjacent: `scratchpad quote suite ran in node:22-bookworm-slim (9/9)` — **`[gap]`**: promote to a committed test that runs in CI on Linux. |
| GH App token minting & caching | `[gap]` unit-testable with a mocked fetch around `src/execution/githubApp.ts`. |
| App installation covers the target repo | `[agent]` `agent:review run \`gh repo view <owner/repo> --json name\`` for each repo agents work on — must return JSON, not 404. Failure signature: "GitHub credentials don't have access" + 404 (observed 2026-08-21 on this repo). |
