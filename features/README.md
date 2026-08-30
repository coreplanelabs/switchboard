# Feature specs

The behavioral contract of Switchboard, versioned with the code. Every file in this directory states what a feature is supposed to do, why, and **how to prove it still does** — so at any git SHA, the validation criteria describe exactly the code at that SHA, and an agent (or human) can verify behavior for any moment in history.

**Specs, not ledgers.** A feature file holds behavior, criteria, and the *kind* of proof each criterion has. It never holds the proof itself: no receipts, dates, run links, incident narratives, or "validated on …" notes. Those are tracking, they change on every prod validation, and keeping them in VCS turned every receipt into a PR that conflicted with parallel work. Receipts live in the tracker — see rule 6.

## The rules

1. **Same-PR updates.** A PR that changes behavior updates the matching feature file in that PR — new criteria for new behavior, edits for changed behavior, deletions for removed behavior. A feature file that describes code that no longer exists is a bug.
2. **TDD from the spec.** New behavior starts as validation criteria here, then failing tests, then implementation to green. Unit tests are the preferred proof; each criterion names its test (`file::test name`).
3. **Agent-runnable validation for the rest.** Criteria that genuinely can't be unit-tested (live Slack flows, sandbox infrastructure, deploy-gated behavior) carry explicit `[agent]` instructions an agent can execute — the exact commands/messages to run and the expected observable result. The instructions are timeless: they say *how* to prove it, never *when it was last proven*.
4. **Grow and prune.** Files are added when features ship and deleted when features are removed. History lives in git, not in dead prose.
5. **Link, don't duplicate.** Feature files own *behavioral expectations*; the technical *how* lives in [README.md](../README.md) (architecture, diagrams) and [AGENTS.md](../AGENTS.md) (invariants, map). Each feature file links to its code and docs.
6. **Receipts go to the tracker, not the spec.** Every feature file has a receipts issue in the [Switchboard: Golden Product](https://github.com/orgs/coreplanelabs/projects/1) project, linked from its header. A live validation of an `[agent]` criterion is a *comment* on that issue (criterion number, date, deploy SHA, evidence link) — append-only, no PR, no conflicts. Gaps that need work are issues on the same project, linked from the `[gap]` criterion. Incident write-ups and A/B campaigns are issues too (e.g. the [Claude Tag parity matrix](https://github.com/coreplanelabs/switchboard/issues/81)). A PR that adds a receipt line to a feature file is a review finding.

## Criterion labels

- `[unit]` — proven by a named test in the suite (`npm test`).
- `[agent]` — proven by following the written validation instructions against a live deployment.
- `[gap]` — known-untested; a criterion we hold but haven't yet encoded. Gaps are work items, not decoration — link the tracker issue when one exists.

Nothing else goes on a criterion: no dates, no receipt links, no "observed live" prose. Proof *status* is read from the receipts issue and the test suite, not from the spec.

## Index

| Feature | What it covers |
|---|---|
| [routing-and-config.md](routing-and-config.md) | Directives, config layers, thread stickiness, permission gates, config commands, config awareness, custom instructions |
| [slack-channel.md](slack-channel.md) | Triggers (mention/DM/follow-up), ack reaction, status cards, formatting, attachments |
| [channel-formatter.md](channel-formatter.md) | Channel-agnostic structured output (zod schema), `ChannelFormatter` seam (Slack + plain), fixed-retry self-heal, flag-gated (#76) |
| [run-visibility.md](run-visibility.md) | Typed run-event stream (tool calls + redacted result summaries); live in-channel status card |
| [live-view.md](live-view.md) | External live run page: per-run capability token, SSE stream, in-memory live-only registry (#43); the `/runs` "Scheduled" panel — schedule registry, next fire, last firing + run link (#244) |
| [run-loop.md](run-loop.md) | Turn/time budgets, wrap-up behavior, forced write-up, refusal/truncation handling |
| [run-friction.md](run-friction.md) | Run-friction analyzer (#84, Area 7b first piece): pure deterministic diagnosis of delay causes from the run-event stream (slow/failed tools, retries, setup/install, wrap-up, budget hits, infra failures); `at`/`infra`/`run_note` stream extensions; read-only `GET /runs/:id/friction` + `frictionCli` |
| [self-improvement.md](self-improvement.md) | Self-improvement proposals (#84, Area 7b second piece): friction ledger of every run's diagnosis; pure cross-run clustering/ranking of recurring patterns (+ `long_run` cost-spike proxy); `friction report` / `friction propose` chat commands and `frictionProposeCli` that file labeled, marker-deduped GitHub issues with evidence + suggested fix — proposals only, human-gated |
| [execution.md](execution.md) | Per-thread workspaces, sandbox timeouts (exit 124), heartbeat streaming, session recovery, GitHub identity |
| [costs.md](costs.md) | Costs dash: Access-gated `GET /costs` + JSON twin — per-day spend for a named group (Workers' DOs + container apps + Anthropic workspace) priced live from Cloudflare's billing datasets and the Anthropic Admin cost report |
| [resident-repos.md](resident-repos.md) | Resident repo environments: auth scopes, atomic cap, lifecycle engine, thread data plane, bot-side selection, `repo onboard/offboard/rebuild/list` chat commands (fail-closed gate, --dry-run plans) |
| [agent-general.md](agent-general.md) | Default passthrough agent |
| [agent-review.md](agent-review.md) | Code review agent |
| [agent-coding.md](agent-coding.md) | Coding agent (ships PRs) |
| [validated-review.md](validated-review.md) | Distilled diff digest in PR bodies (R14) + review agent runs tests/build in its warm worktree and reports pass/fail (R15) |
| [agent-env-bootstrap.md](agent-env-bootstrap.md) | Materialize a downstream service's UAT env vars into the agent's execution environment from 1Password via a read-only, UAT-vault-scoped service account (#72): JSONC manifest, UAT-only allowlist, dry-run default, chmod-600 env file, `buildAgentEnv` integration hook |
| [memory.md](memory.md) | Cross-session self-learning memory (#85): `MemoryStore` seam, read path (keyword+recency scorer, hard budget, org-scoped advisory context block) and write path (post-reply async reflection on `memory.model`, validated + secret-redacted candidates, dedup/supersede on write, shutdown-drain tracked). Flag-gated OFF by default (byte-identical to memory-off). Durable store: the Memory Worker (`deploy/cloudflare-memory/`, one SQLite Durable Object per scope, FTS5) behind `WorkerMemoryStore`, sharing one engine with the in-process store. User scope (#107 PR B): org + the requesting user's own records, `audience`-routed on write, isolated by construction. Repo + channel scopes (#253): `repo:owner/name` / `channel:slack:C…` shared by everyone who runs there, `audience`-routed on write. Human controls (#278): `memory list [me\|org\|repo\|channel] [--limit] [words]` / `memory forget <id>` (own scope free, shared scopes admin-gated, other users unreachable; soft-delete). Per-scope cap (#253): `memory.maxRecordsPerScope` (default 500), LRU soft-eviction on write in both stores. No open `[gap]` |
| [skills.md](skills.md) | Skill loading (#100, supersedes #98): `SkillStore` seam (bundled + in-memory), seeded addyosmani lifecycle skills, `list_skills`/`use_skill` read-only tools, per-agent scoping, progressive-disclosure prompt block (names+descriptions in-prompt, bodies on demand). Durable user-uploaded store (PR2) is `[gap]` |

## Milestones

| # | Goal | Status |
|---|---|---|
| 1 | [Review, general, and coding agents work as designed and are obviously better than Claude Tag](milestone-1-vs-claude-tag.md) | in progress |
