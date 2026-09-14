# Migration notes

What an operator changes when a release breaks something: one section per such release, newest first, headed by the bare version (`## 1.14.0`). After the public launch a breaking change is a major — a title with `!` after its type — and the `title` check refuses such a PR until the section for the release it will cut exists; the first breaking PR of a cycle creates it, each later one adds its lines ([the rule](../../CONTRIBUTING.md#the-pr-title-is-the-changelog-line)). Until the launch the 1.x line moves by minors, the next release is pinned in `release-please-config.json`, no title carries `!`, and a breaking cleanup writes its section under the pinned version. The changelog's **⚠ BREAKING CHANGES** entry, when there is one, says what broke; the section here says what to do about it.

A section says, in this order: what no longer works as it did, what replaces it, and the smallest edit that gets an installation from one to the other — a config key to rename, a command to re-run, a secret to add. Nothing else: history and reasons live in the changelog and the [decision records](../explanation/design-decisions.md).

## 1.217.0

- A follow-up in a thread whose newest run is on the pi harness continues that run's agent and its conversation ([session-log](specs/session-log.md) item 9): the agent is sticky by transcript, the router is not asked, and the model starts from the session log's newest turns, the lines written since and the reply instead of the thread's Slack history; the record says `seed: session`. A thread on the native loop behaves as before. Nothing for an operator to change; a deployment with no pi preset (`harness:` unset) sees no difference.

## 1.215.0

- The plan runner's `fix` round is gone: after a review that requests changes the runner dispatches the findings into the unit thread as `agent:coding` (the `findings` step, [agent-ship](specs/agent-ship.md) item 7) and every review round runs in a review thread of its own (item 5). A plan running across this deploy meets the change mid-flight: a unit sitting in a fix round replays against step names it does not know (`<unit>/<n>/findings` in place of `<unit>/<n>/fix`), its `fix` brief is refused `400` by the bot, and a re-review's `prior.fixRunId` is ignored, so that unit ends `aborted` or `interrupted` and its dependents block. Before deploying, let live plans finish or stop them; afterwards re-issue any plan that ended that way (`agent:ship plan <path>.md units …` reruns the units not merged, [agent-ship](specs/agent-ship.md) item 16), and resume a task's review loop with `agent:ship <pull request url>` in its thread (item 10). Nothing stored changes shape: unit rows written before this release gain their review thread at the unit's next start or first review spawn.

## 1.213.0

- A plain message — no `agent:` directive, no sticky preset, no channel or user `agent` — now picks its own preset through the fast model on every installation, not only where `routing: { auto: true }` was set: the card reads `routed: <reason>` and ends with `reply agent:<preset> to run it another way`, the record carries a `route` event, a routed `coding` opens a pull request at once, `agent:` still wins, and `ship` is never routed ([routing-and-config.md](specs/routing-and-config.md) item 21). Each plain message in a fresh thread costs one small call to `defaults.models.general` (or `routing.model`). To keep every plain message on `defaults.agent`, add `routing: { auto: false }` to `config.yaml` — one line; a deployment that already set `auto: true` changes nothing. `help` in chat no longer lists the commands: it says how to ask; `help commands` lists them.

## 1.208.0

- `ship.coordinator` is gone from `config.yaml`, and the load refuses it by name (`ship.coordinator is no longer a key — every agent:ship request runs on the plan runner; remove it`). The in-process ship round loop it switched off no longer exists: every `agent:ship` request — a task, `plan <path>.md [units …]`, or a ship pull request's URL to resume at review — runs on the plan runner, whose rounds are child runs of their own ([agent-ship.md](specs/agent-ship.md) item 16). Delete the key from the `ship` block. A deployment that ran ship without the runner must now carry the runner's prerequisites — a `coordinator` entry in `SWITCHBOARD_INGRESS_TOKENS` with `grants.http:coordinator: { actions: [coordinator:step] }` (add `plan:merge` for the runner to merge plan branches), `PUBLIC_BASE_URL`, and run history on the state Worker ([Turn features on and off](../how-to/turn-features-on-and-off.md), the `coordinator` row) — or `agent:ship` is refused naming the missing one; nothing else about the request's shape changes.

## 1.15.0

- Run records written before span schema 2 (no `schema` field, or a lower one) show no timing: the run page's Timeline reads `no timing data` with no shape, and their stored friction diagnosis stands as written; the transcript, the call cards and `runs get`/`runs events` are unchanged. Nothing to edit — leave them, and they age out with `runHistory.retentionDays`. The `turn` and `mcp_tool_use` event kinds are gone; a saved JSONL capture that carries them is analyzed by `friction analyze` with those lines skipped and counted, and its model time comes from `model.turn` spans only.

## 1.14.0

- A `config.yaml` top-level key the document does not define — `permissions:` included — is an unknown key and fails the load by name; write who holds what as `grants` and what is closed as `restrict` ([authorization](authorization.md)).
- A token entry's `scopes` in `SWITCHBOARD_INGRESS_TOKENS` is ignored like any field other than `subject` and `channel`; the token holds exactly its `grants.http:<subject>` / `grants.mcp:<subject>` entry ([Ingress tokens are credentials, not grants](authorization.md#ingress-tokens-are-credentials-not-grants)).
- A `selfImprovement` field other than `repo`, `label`, `minRuns`, `top` fails the load by name; the friction ledger is `runHistory`.
