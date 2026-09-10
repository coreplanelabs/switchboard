# How OpenSwitchboard improves itself

OpenSwitchboard diagnoses every run, clusters friction that recurs across runs, and files each pattern as a labelled GitHub issue for a person to triage.

## It proposes and never fixes

The only side effect is a labelled issue: no pull request, no merge, no config edit, no channel post, and a ledger row carries no message text. An automatic pull-request arm would need its own review, budget and rollback story, so a person is the gate.

```mermaid
flowchart TB
    RUN["Agent run<br/>general · coding · review · ship · research"]
    OBS["Observe<br/>run-event stream"]
    DIAG["Diagnose<br/>analyzeRunFriction"]
    MEM["Remember<br/>diagnosis stored with the run record"]
    CLUS["Cluster<br/>same friction in ≥2 distinct runs → pattern"]
    PROP["Propose<br/>one GitHub issue per pattern, deduped by marker"]
    HUMAN{{"Human triage"}}
    FIX["Fix<br/>by hand, or agent:coding / agent:ship"]

    RUN --> OBS --> DIAG --> MEM --> CLUS --> PROP --> HUMAN
    HUMAN -.->|"accept"| FIX -.->|"less friction"| RUN
    HUMAN -.->|"close"| PROP
```

The dashed arrows are the ones OpenSwitchboard never follows.

## Where each piece runs

```mermaid
flowchart TB
    subgraph triggers ["Triggers"]
        SLACK["Slack<br/>friction report | propose"]
        CLI["CLI<br/>friction propose --dry-run"]
        API["HTTP /api/friction.propose<br/>MCP friction_propose"]
        CRON["Worker shim cron, weekly<br/>POST /ingress as the cron identity"]
    end

    subgraph bot ["Bot process"]
        DISP["Dispatcher<br/>at finish: analyzeRunFriction → diagnosis"]
        LEDGER["FrictionLedger<br/>reads the run listing, never events"]
        CMD["friction.report / friction.propose<br/>registry commands"]
        PURE["Pure core<br/>cluster → propose → dedupe<br/>no clock, no I/O"]
        TRACKER["GithubIssueTracker<br/>REST, App installation token"]
    end

    subgraph state ["State Worker"]
        HDO[("RunHistoryDO<br/>run records, diagnosis included")]
        SDO[("ScheduleDO<br/>firing records")]
    end

    GH(["GitHub Issues<br/>label + hidden marker"])

    SLACK & CLI & API & CRON --> CMD
    DISP -->|"run record after every run"| HDO
    CMD --> LEDGER
    LEDGER -->|"list recent runs"| HDO
    LEDGER --> PURE
    PURE -->|"fresh proposals"| TRACKER -->|"create issue"| GH
    TRACKER -->|"list open issues for dedupe"| GH
    CRON -.->|"firing outcome"| SDO
```

Diagnoses live on the state Worker, so a bot redeploy loses nothing. The analysis is a pure function over ledger records: unit-tested on recorded runs, and a dry run is the real run minus `create issue`.

## A scheduled pass

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
    Note over Bot: admission: the friction:write grant<br/>visibility: the caller's run-read predicate
    Bot->>Store: list recent runs the caller may read
    Store-->>Bot: run records, oldest first
    Bot->>Core: clusterFriction(records, minRuns=2)
    Core-->>Bot: ranked patterns (+ long_run outliers)
    Bot->>Core: proposeImprovements(top=3)
    Core-->>Bot: proposals with marker
    Bot->>GH: list open labeled issues
    GH-->>Bot: open issues
    Bot->>Core: dedupeProposals by marker
    loop each fresh proposal
        Bot->>GH: create labeled issue
    end
    Bot-->>Shim: run id, status, report text
    Shim->>SDO: record firing
```

The firing is an ordinary run: a record on `/runs`, a row in the Scheduled panel. Without `friction:write` it finishes `failed`; without `channels: all` it analyzes zero runs; without a cron token it is recorded `misconfigured`.

## Noisy commands, stable patterns

An exact-command key never recurs, so the signature keeps only each command's ordered program heads:

```mermaid
flowchart LR
    E1["Run A<br/>cd ws && npm test 2>&1 | tail -20<br/>ok, 41 s"]
    E2["Run B<br/>cd repo; npm test 2>/dev/null<br/>ok, 38 s"]
    F1["Finding<br/>slow_tool · 41 s"]
    F2["Finding<br/>slow_tool · 38 s"]
    SIG["Signature<br/>drop cd, tail, redirects, flags<br/>both → slow_tool:npm test"]
    PAT["Pattern<br/>key in ≥2 distinct runs<br/>ranked by runs, severity, time"]
    ISSUE["Issue<br/>[friction] slow tool call recurs in 8 of 109 runs: npm test<br/>hidden marker names the pattern key"]

    E1 --> F1 --> SIG
    E2 --> F2 --> SIG
    SIG --> PAT --> ISSUE
```

- **Recurrence counts distinct runs**; ten slow calls in one run count once.
- **`long_run` is the cost proxy**: a run at twice the median wall time (and at least ten minutes), flagged per agent.
- **Dedupe is by marker, not title**; closing an issue makes its pattern eligible again.

## Triggers and gates

| Surface | Command | Who |
|---|---|---|
| Slack | `friction report` | anyone; read-only |
| Slack | `friction propose [--dry-run] [--top n] [--min-runs n] [--repo o/n]` | `friction:write` (admins through `all`) |
| CLI | `npm run cli -- friction propose --dry-run` | the local operator |
| HTTP / MCP | `POST /api/friction.propose`, tool `friction_propose` | tokens holding `friction:write` |
| Schedule | the `self-improvement` entry, weekly | the `cron` identity, granted `friction:write` and `channels: all` |

A caller analyzes what its run-read predicate allows: an admin or the cron sees the fleet, a token granted one channel sees that channel ([authorization](../reference/specs/authorization.md)). Every surface is [the same registered command](one-command-many-surfaces.md).

## Read next

- [Self-improvement](../reference/specs/self-improvement.md) — the contract.
- [Run friction](../reference/specs/run-friction.md) — categories, thresholds, `friction analyze`.
- [Run history](../reference/specs/run-history.md) — where diagnoses persist and for how long.
