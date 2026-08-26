# Routing & configuration

Every message resolves to exactly one (agent, model) pair through layered config, and permission gates run against the *resolved* agent so no layer can smuggle a restricted agent past them.

- **Code**: `src/directives.ts`, `src/config.ts`, `src/core/dispatcher.ts`, `src/core/repoCommands.ts`, `src/core/operations.ts`
- **Docs**: [README — Configuration layers](../README.md#configuration-layers), [AGENTS.md invariants 3, 4, 7](../AGENTS.md)
- **Tests**: `src/directives.test.ts`, `src/config.test.ts`, `src/core/dispatcher.test.ts`

## Behavior

1. Inline directives (`agent:review model:provider/model`, anywhere in the message) set agent/model for that request and are stripped from the text the model sees. Unknown agents are rejected with the available list; unknown models pass through (the provider errors).
2. Resolution precedence: **request directive > thread-sticky > user scope > channel scope > defaults**. Model additionally honors forced models (`user.model`/`channel.model`) over per-agent maps.
3. **Thread stickiness**: a follow-up without directives runs on the agent/model the thread last used — derived from the thread's own history (user turns, last directive wins) on every message, never stored. Assistant turns can't set it; unknown agents in history are skipped, never thrown.
4. **Permission gates** run post-resolution: agent allowlists admit listed users + admins; absent allowlist = open. `config set channel` is gated by `channelConfig` (empty list = admins only). Per-repo access for resident environments follows the same shape (`permissions.repos`, slug → user IDs; KD7): absent map or unlisted repo = open to every allowed coding-agent user; a listed repo refuses non-listed users with a **named** 🚫 refusal in the dispatcher before any executor is created — never a silent per-thread fallback (admins always pass). **Repo management is the one FAIL-CLOSED gate** (`permissions.repoManagement`, KTD9): key absent or empty = admins only — `repo onboard`/`rebuild` provision billable always-on compute and bind GitHub credentials, so the default deliberately inverts every other gate's open-when-absent.
5. **Config commands** (`help`, `config show/set/clear channel|me`) are answered inline and never reach a model. Runtime overrides persist to `data/overrides.json` and win over static config for the same scope.
6. **Repo-management commands** (`repo list/onboard/offboard/reconfigure/rebuild`, U8) are config-family: inline replies, no model turn, gated per item 4 (only `repo list` is open). Details and validation live in [resident-repos.md](resident-repos.md) items 32–36; `help` lists them.
7. **Deterministic ops fast-path** (U6, KTD8): `repo test <owner/name> [<ref>]` / `repo build <owner/name> [<ref>]` — and conservative natural asks like "run the tests on main in acme/api" — execute the repo's onboarded command through the `Operations` seam and post the result with ZERO model turns, mirroring the config-command reply shape. Operator-level, not admin: only the model call is skipped — the implicit target agent is coding, so `canRunAgent(user, "coding")` and `canUseRepo` (KD7) both run first and refuse by name. Anything ambiguous or non-matching falls through to the agent (KD3: never guess); an explicit `agent:`/`model:` directive disables the natural-language recognizer. Mechanics and validation live in [resident-repos.md](resident-repos.md) items 37–41.

## Validation criteria

| Criterion | Proof |
|---|---|
| Directives extract and strip; unknown agent rejected with list | `[unit]` `src/directives.test.ts::parseDirectives` |
| Sticky derivation: last-wins, user-turns-only, lenient | `[unit]` `src/directives.test.ts::lastThreadDirectives` |
| Full precedence matrix incl. forced vs per-agent models | `[unit]` `src/config.test.ts::layered resolution` |
| Runtime overrides beat static config and clear cleanly | `[unit]` `src/config.test.ts::runtime overrides` |
| Allowlists, admin bypass, `channelConfig` empty = admins-only | `[unit]` `src/config.test.ts::permission gates` |
| Per-repo access: open-when-absent, allowlist admits members + admins, named refusal without an executor | `[unit]` `src/config.test.ts::per-repo access (canUseRepo)`, `src/core/dispatcher.test.ts::resident repo dispatch::a canUseRepo refusal is a named reply and no executor is created` |
| Repo management fail-closed: absent/empty `repoManagement` = admins only; `repo list` open | `[unit]` `src/config.test.ts::repo management gate (canManageRepos)`, `src/core/repoCommands.test.ts::KTD9 fail-closed gate`, `src/core/dispatcher.test.ts::repo management commands (U8)` |
| Config commands never call a model | `[unit]` `src/core/dispatcher.test.ts::answers config commands inline` |
| Deterministic ops answer with zero model turns; gates still apply | `[unit]` `src/core/dispatcher.test.ts::deterministic ops fast-path (U6)` (F3 zero-provider-calls, coding-allowlist + per-repo refusals, ambiguous fallthrough, named refusals for hostile refs), `src/core/operations.test.ts`; live receipt in [resident-repos.md](resident-repos.md) (U6: F3 row). |
| Denied agents produce 🚫 without a model call | `[unit]` `src/core/dispatcher.test.ts::denies restricted agents` |
| Follow-ups stick; explicit directive overrides; gate still applies | `[unit]` `src/core/dispatcher.test.ts::thread follow-ups stick / explicit directive / permission gate` |
| Live: `agent:review` thread + directive-free follow-up shows `review` on the status card | `[agent]` In Slack: open a thread with `@switchboard agent:review run \`echo A\``, wait for ✅, reply `now run \`echo B\`` with no directive. The follow-up's status card must show `review`, not `general`. (Validated 2026-08-21, [receipt](https://github.com/coreplanelabs/switchboard/pull/34#issuecomment-5375104802).) |
