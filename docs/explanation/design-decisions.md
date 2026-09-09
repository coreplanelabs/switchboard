# Design decisions

The architecture decision records: one page per decision that shaped Switchboard, with the context it was made in, what was decided, what that costs, the alternatives that were rejected, and the named pattern the decision instantiates so a newcomer can map the code to a concept they already know in one lookup.

A record is written once and never edited. When a decision stops holding, a new record supersedes it and the old one keeps its reasoning with `status: superseded` and a pointer forward. That is checked, not hoped for: `npm run decisions:check` (part of `verify`) fails the build when a record lacks a status, a superseded record names nothing, or an accepted record's body differs from the copy on `main`. The table below is generated from the records' own frontmatter by `npm run docs:gen`.

Statuses: **proposed** (written, not yet agreed), **accepted** (agreed, being built), **implemented** (in the code the record describes), **superseded** (replaced by the record it names).

<!-- generated:decision-records · npm run docs:gen — generated from the code, do not edit by hand -->

| # | Decision | Pattern | Status | Date |
|---|---|---|---|---|
| 0001 | [Every boundary is an interface with at least two implementations](../decisions/0001-seams-with-two-implementations.md) | Ports & Adapters | implemented | 2026-09-08 |
| 0002 | [The dispatcher is the only place an agent run starts](../decisions/0002-dispatcher-is-the-only-orchestrator.md) | Registry with orchestration outside it | implemented | 2026-09-08 |
| 0003 | [Slack is reached over Socket Mode, outbound only, and the gaps it leaves are recovered on reconnect](../decisions/0003-outbound-only-slack-socket-mode.md) | Durable record outside the process | implemented | 2026-09-08 |
| 0004 | [Every identity is a platform-namespaced id](../decisions/0004-platform-namespaced-ids.md) | Namespaced principal identifiers | implemented | 2026-09-08 |
| 0005 | [Model and effort resolve through the same configuration layers](../decisions/0005-layered-config-effort-first-class.md) | Layered configuration resolution | implemented | 2026-09-08 |
| 0006 | [A run has two lives, a live registry and then a history record, behind one read service](../decisions/0006-runs-have-two-lives.md) | Two stores, one facade | implemented | 2026-09-08 |
| 0007 | [Authorization is one policy table over a closed condition vocabulary, asked once per request](../decisions/0007-authorization-policy-table.md) | Rules table | implemented | 2026-09-08 |
| 0008 | [A command is defined once and every surface is derived from it](../decisions/0008-one-command-definition-every-surface.md) | Registry | implemented | 2026-09-08 |
| 0009 | [Residents hold their own GitHub credential; the bot never holds a repo-write token](../decisions/0009-residents-second-credential-domain.md) | Trust boundary per plane | implemented | 2026-09-08 |
| 0010 | [Every model output is a typed contract, normalized once at the answer boundary](../decisions/0010-typed-llm-output.md) | Strategy per output type | implemented | 2026-09-08 |
| 0011 | [One live run per thread; a follow-up steers the run or is refused, never queued as a second run](../decisions/0011-thread-admission-one-live-run.md) | Admission control | implemented | 2026-09-08 |
| 0012 | [Slack itself is the record of what was handled; every reconnect replays what it never saw](../decisions/0012-reconnect-catch-up-as-recovery.md) | External system as durable record | implemented | 2026-09-08 |
| 0013 | [A live run page is opened by an unguessable per-run token; finished runs are read by the policy table](../decisions/0013-capability-tokens-for-live-run-pages.md) | Capability-based security | implemented | 2026-09-08 |
| 0014 | [The dashboard runs under a Content Security Policy that executes no inline script](../decisions/0014-dashboard-csp-script-src-self.md) | Defense in depth | implemented | 2026-09-08 |
| 0015 | [Releases deploy from CI in one fixed Worker order, and a deploy is done only when the new code is live](../decisions/0015-deploy-order-deployed-is-not-live.md) | Derived, not declared | implemented | 2026-09-08 |
| 0016 | [One long-lived bot process plus Durable Objects for what must survive it, not a serverless runtime](../decisions/0016-long-lived-process-not-serverless.md) | State outside the process | implemented | 2026-09-08 |
| 0017 | [Memory is off by default, byte-identical to absent when off, advisory when on, and gated on the way in](../decisions/0017-memory-off-by-default.md) | Null Object | implemented | 2026-09-08 |
| 0018 | [Capabilities are computed once at startup and every off-state is a Null Object](../decisions/0018-capabilities-computed-once-null-objects.md) | Feature toggles resolved once + Null Object | implemented | 2026-09-08 |
| 0019 | [A run outlives the container through a leased, fenced ledger with a write-ahead step record](../decisions/0019-durable-run-ledger-resume-after-kill.md) | Lease with a fencing token | implemented | 2026-09-08 |
| 0020 | [A span is the one measurement primitive; every duration a user sees falls out of it](../decisions/0020-spans-one-measurement-primitive.md) | Execute Around Method | implemented | 2026-09-08 |
| 0021 | [Records are immutable and specs are checked; documentation drift is prevented by CI, not discipline](../decisions/0021-records-are-immutable-specs-are-checked.md) | Two kinds of document | implemented | 2026-09-08 |
| 0022 | [The public tree carries no imprint of the company that grew it, and a ratchet holds that line](../decisions/0022-public-tree-carries-no-imprint.md) | Ratchet | accepted | 2026-09-08 |
| 0023 | [Cloudflare is the one supported production target; docker compose is the local loop](../decisions/0023-one-production-target.md) | One way to do it | accepted | 2026-09-09 |

<!-- /generated:decision-records -->

The dated implementation plans under [`docs/plans/`](../plans/) are records of the same kind — proposals that were reviewed, built, and then frozen with their final status — and are held to the same check. They are working documents for the repository and are not published on this site.
