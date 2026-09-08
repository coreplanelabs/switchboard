# How Switchboard improves itself

After every agent run Switchboard diagnoses where the time went, keeps that diagnosis with the run, and on a schedule (or on demand) looks for friction that recurs across runs and files each recurring pattern as a labelled GitHub issue with evidence and a suggested fix, for a person to triage. This page is why the loop is shaped that way and where each piece runs. The contract is the [self-improvement spec](../reference/specs/self-improvement.md); the per-run diagnosis it builds on is [run friction](../reference/specs/run-friction.md).

## Why it proposes and never fixes

The only side effect is opening a labelled issue. It never opens a pull request, never merges, never edits config. The fix is a separate, human-initiated step, typically pointing `agent:coding` or `agent:ship` at the filed issue.

That narrowing is a safety boundary, not an unfinished feature. A self-modifying system with an automatic pull-request arm would need its own review, budget and rollback story. A person is the gate between "we noticed this keeps happening" and "we changed something": observe, diagnose, propose, with the arrow into *fix* held by a human.

```mermaid
flowchart TB
    RUN["Agent run<br/>(coding, review, ship, general…)"]
    OBS["Observe<br/>run-event stream:<br/>tool calls, results, timings,<br/>budget and infra notes"]
    DIAG["Diagnose<br/>analyzeRunFriction<br/>slow tools, failed tools, retries,<br/>installs, wrap-up, budget hits"]
    MEM["Remember<br/>diagnosis stored with the run record<br/>(RunHistoryDO)"]
    CLUS["Cluster<br/>same friction in ≥2 distinct runs<br/>→ ranked pattern"]
    PROP["Propose<br/>GitHub issue per pattern:<br/>evidence + suggested fix,<br/>deduped by marker"]
    HUMAN{{"Human triage"}}
    FIX["Fix<br/>hand-written, or agent:coding /<br/>agent:ship pointed at the issue"]

    RUN --> OBS --> DIAG --> MEM --> CLUS --> PROP --> HUMAN
    HUMAN -->|accept| FIX -->|next runs have less friction| RUN
    HUMAN -->|close| PROP

    style HUMAN fill:#fde68a,stroke:#b45309,color:#111
    style FIX stroke-dasharray: 5 5
```

Everything left of the human gate is automatic. *Fix* is dashed because Switchboard does not perform it; the loop closes only when a person acts on the issue.

## Where each piece runs

```mermaid
flowchart TB
    subgraph triggers ["Triggers"]
        SLACK["Slack<br/>@switchboard friction report | propose"]
        CLI["CLI<br/>npm run cli -- friction propose --dry-run"]
        API["HTTP /api/friction.propose<br/>MCP friction_propose"]
        CRON["Worker shim cron<br/>weekly<br/>POST /ingress 'friction propose'<br/>as the cron identity (granted channels: all)"]
    end

    subgraph bot ["Bot process — one container"]
        DISP["dispatcher<br/>runs the agent, then at finish:<br/>analyzeRunFriction(events) → diagnosis"]
        LEDGER["FrictionLedger<br/>reads the run listing, never events"]
        CMD["friction.report / friction.propose<br/>registry commands (one definition, every surface)"]
        PURE["Pure core<br/>clusterFriction → proposeImprovements → dedupeProposals<br/>no clock, no I/O"]
        TRACKER["GithubIssueTracker<br/>REST, GitHub App installation token"]
    end

    subgraph state ["State Worker — Durable Objects, bearer-gated"]
        HDO[("RunHistoryDO<br/>every finished run's record,<br/>diagnosis included")]
        SDO[("ScheduleDO<br/>firing records for the<br/>/runs Scheduled panel")]
    end

    GH["GitHub Issues<br/>label: self-improvement<br/>marker: an HTML comment<br/>naming the pattern key"]

    SLACK & CLI & API & CRON --> CMD
    DISP -->|after every run: the run record, diagnosis included| HDO
    CMD --> LEDGER
    LEDGER -->|list recent runs| HDO
    LEDGER --> PURE
    PURE -->|fresh proposals| TRACKER -->|create issue| GH
    TRACKER -->|list open labeled issues for dedupe| GH
    CRON -.->|firing outcome| SDO
```

Two facts worth holding onto:

- **The bot container is stateless for this feature.** A redeploy loses nothing: the diagnoses live on the state Worker's Durable Objects, so `friction report` after a restart sees the same runs as before ([Runs: live, then remembered](runs-live-and-history.md)).
- **The analysis is a pure function.** Clustering, ranking, rendering and dedupe take ledger records in and produce proposals out, with no clock and no network. That is why the whole pipeline is unit-tested against recorded runs, and why a dry run is exactly the real run minus the final `create issue` call.

## A scheduled pass, step by step

```mermaid
sequenceDiagram
    autonumber
    participant Shim as Worker shim cron
    participant Bot as Bot (dispatcher)
    participant Store as RunHistoryDO
    participant Core as pure core
    participant GH as GitHub Issues
    participant SDO as ScheduleDO

    Shim->>Bot: POST /ingress "friction propose" (cron bearer)
    Note over Bot: Admission: the `friction:write` grant.<br/>Visibility: the authorization policy — the caller's run-read<br/>predicate (channels: all for the cron) is pushed into the store
    Bot->>Store: list recent runs the caller may read (diagnosis rides the listing)
    Store-->>Bot: run records, oldest first
    Bot->>Core: clusterFriction(records, minRuns=2)
    Core-->>Bot: ranked patterns (+ long_run outliers)
    Bot->>Core: proposeImprovements(top=3)
    Core-->>Bot: issue proposals with marker
    Bot->>GH: list open issues with label + 30 newest unfiltered
    GH-->>Bot: open issues
    Bot->>Core: dedupeProposals(proposals, openIssues) by marker
    loop each fresh proposal
        Bot->>GH: create labeled issue
    end
    Bot-->>Shim: {run: {id, status}} + report text
    Shim->>SDO: record firing (time, run id, outcome)
```

The firing is an ordinary run: it gets a record on `/runs`, its answer is the report text, and the Scheduled panel shows when it fired and what came of it. If the cron identity lacks the grant, the run finishes `failed` with the refusal as its answer and nothing is filed. If it lacks `channels: all`, the pass runs and analyzes zero runs; the installation's config grants it to the cron identity, and the schedule registry declares the same for the schedule's own actor. If there is no cron token at all, nothing runs and the firing is recorded `misconfigured`.

## Why a noisy command becomes a stable pattern

Real agents chain the same work differently every run, so an exact-command key never recurs. The signature reduces each command to its program heads:

```mermaid
flowchart LR
    E1["Run A event<br/>$ cd /tmp/ws && npm test 2>&1 | tail -20<br/>→ ok, 41 s"]
    E2["Run B event<br/>$ cd ~/repo; npm test 2>/dev/null<br/>→ ok, 38 s"]
    F1["Finding<br/>slow_tool · 41 s · medium"]
    F2["Finding<br/>slow_tool · 38 s · medium"]
    SIG["Signature<br/>drop cd / tail / redirects / flags<br/>keep ordered program heads<br/>both runs → <b>slow_tool:npm test</b>"]
    PAT["Pattern<br/>key seen in ≥2 distinct runs<br/>runs ↓ · peak severity ↓ · time ↓"]
    ISSUE["Issue<br/>[friction] slow tool call recurs in 8 of 109 runs: npm test<br/>Pattern · Evidence table · Suggested fix · Provenance<br/>hidden marker: switchboard-friction-pattern: slow_tool:npm test"]

    E1 --> F1 --> SIG
    E2 --> F2 --> SIG
    SIG --> PAT --> ISSUE
```

Three consequences for reading a filed issue:

- **Recurrence counts distinct runs.** A command that was slow ten times inside one run counts once toward "recurs", though all ten occurrences and their time are reported. Recurring means a process problem, not one bad run.
- **`long_run` is the cost proxy.** There is no per-run token accounting, so a run at least twice the median wall time (and at least ten minutes) is flagged per agent as a cost-spike stand-in.
- **Dedupe is by marker, not title.** Titles change as run counts grow; the HTML comment in the body is the identity. Closing an issue makes its pattern eligible to be filed again, which is the intended "we fixed it, tell us if it comes back" behaviour.

## Triggers and gates

| Surface | Command | Who may run it |
|---|---|---|
| Slack (any channel the bot is in) | `@switchboard friction report [--since-ms n] [--limit n] [--min-runs n]` | anyone (read-only, GitHub never consulted) |
| Slack | `@switchboard friction propose [--dry-run] [--top n] [--min-runs n] [--repo o/n]` | actors granted `friction:write` (admins through `all`) |
| CLI (no bot needed) | `npm run cli -- friction propose --dry-run` | the local operator; without `--repo` or config it is a pure dry run |
| HTTP / MCP | `POST /api/friction.propose`, tool `friction_propose` | tokens holding `friction:write` |
| Schedule | the `self-improvement` entry of the schedule registry, weekly | the `cron` ingress identity, whose `grants` entry (`http:cron`) holds `friction:write` and `channels: all` |

Who may call a command is the table above; what it analyzes is the [authorization policy](../reference/specs/authorization.md): the caller's run-read predicate, pushed into the run store. An admin or the cron sees the fleet; a token granted one channel sees that channel; a caller granted no channel sees only its own runs. All of these are the same registered command with the same JSON output and the same rendered text ([One definition, every surface](one-command-many-surfaces.md)).

## What it deliberately does not do

- Open pull requests, push commits, or merge anything.
- Change agent prompts, the agent contract, config, or sandbox images.
- Post to a channel when it files. The issues are the notification.
- Read message text into the ledger. A ledger row carries `{ runId, label, agent, finishedAt, diagnosis }` and nothing else, so an issue body can never leak a conversation or grant live-view access.

## Further reading

- [Self-improvement](../reference/specs/self-improvement.md): the contract, every edge case, and the validation criteria with their tests.
- [Run friction](../reference/specs/run-friction.md): the per-run diagnosis, its categories and thresholds, and `friction analyze` for one saved stream.
- [Run history](../reference/specs/run-history.md): where the diagnoses persist and for how long.
