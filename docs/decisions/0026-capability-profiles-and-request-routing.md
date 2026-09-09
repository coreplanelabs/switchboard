---
title: A run is a capability profile over three axes, named agents become presets, and a routing stage picks the profile
status: proposed
date: 2026-09-09
pattern: Strategy as data + a routing filter in the pipeline; RBAC on the preset, admission boundaries on the axes
---

# A run is a capability profile over three axes, named agents become presets, and a routing stage picks the profile

**The ask.** Decide: adopt capability profiles as the unit of configuration, with authorization unchanged (who may run a preset) and admission boundaries on the axes (what any run in a scope may have), routing over presets first; approve slice one (two new machine classes, budget as a profile field, one long-investigation preset) before the next comparison run against a hosted assistant. Owner: the maintainer. Needed before that run. Written for an engineer who knows the dispatch pipeline and the policy table. The frame is assumed from the session that produced this record.

Success criteria: (1) a request needing a shell, web search, a read-only credential and two hours runs without a new agent being written; (2) no run holds a machine, credential scope or budget above what every boundary on its path allows, whatever a router or a directive says; (3) every actor that may run an agent today, over every surface, may run the same preset after; (4) a deployment that sets no boundary and names no router behaves byte for byte as today.

## TL;DR

The request that started this, validate a CI audit by running the pipeline locally for two hours, fits none of the five agents: none has both a shell and more than 45 minutes. The bet is that an agent is already three things, what it reaches, who it acts as, how long it runs, so that triple becomes the **profile** the pipeline carries, the five agents become presets over it, and a router picks a preset when none is named. Who may run a preset stays the policy table's question; how much a run may have is a **boundary** per scope that caps and never grants. The cost is one intersecting rule beside the config layers' overriding one and a mechanical pass over the stages that read agent fields. Decided: the axes, presets, intersecting boundaries, routing over presets. Open: the router's model.

## Today at `ec170a3`

| Fact the design changes or depends on | Where |
|---|---|
| An agent is `{ name, description, system, toolset, maxTurns, maxTokens, maxMinutes, effort?, cacheTtl?, resources?: { repo?: "required" \| "none" }, residentSystem? }` | `src/agents/registry.ts:7-38` |
| Five fixed toolsets; `bash` only in `full` and `readonly`, `web_search` only in `web` | `src/tools/workspace.ts:501-531` |
| Single-agent budgets: general 5 min, coding 45, review 25, research 8. The ship pipeline runs 120 minutes across coding and review rounds, each child clipped to the remainder; it is the only configurable budget | `src/agents/registry.ts:236-299`, `src/core/shipPipeline.ts:66,173`, `src/config.ts:161-168` |
| Directives: `agent`, `model`, `effort`. Thread stickiness is derived by scanning the thread's user text for them; bot text is never scanned; the sticky agent enters resolution as the request's own | `src/directives.ts:23-40`, `src/core/dispatch/resolve.ts:76-89`, `src/channels/slack.ts:630` |
| Every config layer overrides the one below it: the most specific scope that sets `agent`, `model` or `effort` wins; one scope field, `agent`, is both a force and a default (`request ?? user ?? channel ?? defaults.agent`) | `src/config.ts:673`, routing-and-config spec item 2 |
| A scope holds `agent, model, models, effort, efforts, instructions, mcpServers` and nothing quantitative; channel scope writes need `config:write` | `src/config.ts:44-77`, authorization spec item 4 |
| The executor follows the agent: no `repo: "required"` → null executor; a serviceable resident when the repo is onboarded, else a per-thread sandbox. A coding message that names no repo already gets a per-thread sandbox with an empty workspace and a write token: an undeclared blank machine with the wrong identity | `src/execution/factory.ts:146-168,220` |
| Repo resolution vets a bare `owner/name` against the resident registry, and an unanswered registry refuses the run (`repo_unverified`), for every agent that requires a repo | `src/core/dispatch/resolve.ts:134-150`, `src/core/dispatch/authorize.ts:137-160` |
| Credential scope, read-only worktree, PR-run detection and the review post policy are all string tests on the toolset name; the scope is derived by negation, so any toolset but `readonly` mints a write token if it ever reaches an executor | `src/execution/factory.ts:181,466`, `src/core/dispatch/provision.ts:476`, `src/core/dispatch/run.ts:176`, `src/core/dispatcher.ts:514`, `src/core/reviewRound.ts:61` |
| Which agents an actor may run is an action, `agent:run:<name>`, open unless `restrict.agents` names it; grants have three axes; a credential's baseline is empty and a browser session's holds only reads, so no baseline carries `agent:run` and every actor runs the unrestricted agents by the open rule | authorization spec items 4, 9; `src/core/authz/grants.ts:23,221-225,266-268` |
| Nine production reads of `agent.toolset`, two of `agent.resources`, the budget in six modules | grep at this sha |
| The cold sandbox is one `standard-4` class (4 vCPU, 12 GiB, 20 GB) with one hand-edited Dockerfile; a rollout kills in-flight sandboxes | `deploy/cloudflare-sandbox/wrangler.template.jsonc`, execution spec item 6 |
| A command runs at most 20 minutes; a `setsid -f` process outlives it, `nohup … &` does not; the sandbox Worker's timeout hint still says `nohup` | `src/execution/bashTimeout.ts:15`, `deploy/cloudflare-sandbox/docker-wrapper.sh:8-10`, `deploy/cloudflare-sandbox/worker.ts:404` |

## The shape

A **profile** is what a run may reach, who it acts as, and how long it may run: **reach** is a set of tool bundles plus a **machine class** (`none`, `blank`, `repo-cold`, `repo-resident`); **identity** is the credential scope minted for the run (`none`, `read`, `write`); **budget** is minutes, turns and tokens. A **preset** is a named profile with a prompt; the five agents are the first five presets and behave as today. Two questions decide a run, asked by two different mechanisms. Authorization, the policy table, answers who: `has-grant(agent:run:<preset>)`, exactly as today. Admission answers how much: a **boundary** is a cap on the three axes (`maxMinutes`, `maxIdentity`, `machines`) that any scope may set (defaults, channel, user), and the **effective profile** is the intersection of the preset, the request's directives and every boundary on the path. Identities are ordered `none < read < write`; a preset's single machine class must be in every boundary's `machines` set. A boundary never grants; a directive never widens; the executor is provisioned from the effective profile and nothing else. The **router** is a filter that picks a preset when nothing but `defaults.agent` would have; its output is a preset like any other.

The closest known shape is an IAM permissions boundary over an identity policy: the identity policy (here the preset, admitted by RBAC) says what may be done, the boundary caps it, and the effective permission is their intersection. Where the axis is quantitative the shape is a Kubernetes LimitRange: a per-namespace cap the admission step applies to every pod, separate from RBAC. The one way this differs from both: a budget above the cap is clipped with a visible note rather than rejected, because a shorter run still ends in a useful write-up by the runner's own design, while an identity or machine class above the cap is rejected, because a preset that needs to push cannot do its job with a read token.

## One trace

The motivating request on the case most likely to be wrong: the router picks a preset whose budget exceeds the channel's boundary, and the repository named is an onboarded resident.

1. A person mentions the bot with a link to a CI audit and "run our CI locally with act and validate the claims." No directive; the channel sets no agent; the channel's boundary is `maxMinutes: 45`.
2. Resolve settles `(model, effort)` as today. No directive, no sticky preset, no user or channel `agent`: the agent would have come from `defaults.agent`, so the router runs, between `resolveRun` and repo resolution, which needs the preset's machine class to know whether to run at all.
3. The router calls the deployment's fast model with the text, the thread's last directives and the preset table (name, description, profile), and answers `explore` with a one-line reason. The card gains `explore · routed: a shell and web reads for two hours`.
4. Authorize asks the one question it asks today, `has-grant(agent:run:explore)`, against the caller. `explore` is unrestricted; admitted.
5. Admission intersects: `explore` declares 120 minutes, identity `read`, class `repo-cold`; the channel boundary caps minutes at 45; no other layer sets one. The effective profile is 45 minutes, `read`, `repo-cold`. The card says `budget 45 min (channel boundary; preset asks 120)`. No refusal: the property is that a routed profile cannot exceed a boundary and the clip is visible where the run is watched.
6. Had the caller sent `agent:explore budget:30`, the directive would have narrowed further, to 30; a directive `budget:120` narrows nothing and the card says why.
7. Provision reads machine class `repo-cold`: identity `read` mints a token with `contents`, `actions` and `checks` read, the repository is verified against GitHub with that token (identity `none` verifies anonymously, so a private repository needs `read`), the resident registry is never asked, and a per-thread sandbox is provisioned even though a resident exists.
8. The runner gets the `shell`, `files`, `web` and `github-read` bundles and a 45-minute deadline; the prompt is the preset's: claim table, commands and numbers, `setsid -f` for jobs over 20 minutes, no PR.
9. At 42 minutes the wrap-up warning fires (three minutes before the deadline, the runner's rule). The model writes the table with 11 of 16 claims checked and names what a follow-up should do.
10. The record stores `{ preset: explore, routed: true, budget: 45, boundedBy: channel }`. The card's label carries the preset, and the sticky scan reads it (the Routing section), so "continue" in this thread lands on `explore`.

The second hard case behaves differently: a channel bounded to `maxIdentity: read` receives `agent:coding`. Authorize admits the caller; admission finds the preset's identity `write` above the cap and rejects: `🚫 coding needs a write credential; this channel is bounded to read. Run it in a channel that allows write, or ask an admin to raise the channel's boundary.` No executor exists.

## The difficulty map

Ranked by risk of being wrong.

1. Boundaries: intersection over layers that today override, the clip-or-reject rule per axis, and proving an absent boundary is today. Section "Boundaries."
2. The machine class: `blank` and `repo-cold` without touching the resident path reviews depend on, and without the registry vet. Section "The machine class."
3. Routing: a wrong route visible and sticky, never silent. Section "Routing."
4. Threading the profile through the stages: nine `toolset` reads, the budget in six modules. Most work, least risk; the plan owns it.

## Boundaries

The constraint is the one the authorization record states and the one its shape implies. Grants say who may do what; they have three axes and a closed condition vocabulary, and a requirement that needs an external policy engine is that record's stop condition. Quantities do not fit that vocabulary: the first draft of this record put budget rungs into the grants as actions with an expansion step, and that was the smell. Kubernetes and IAM keep the two questions in two mechanisms (RBAC beside LimitRange; identity policies under a permissions boundary that "limits the user's permissions but does not provide permissions on its own"), and the design borrows that split whole: the grants keep exactly three axes, and a boundary is never inside a grants entry.

A boundary is `{ maxMinutes?, maxIdentity?, machines? }`. It lives where the other scope settings live, `defaults`, `channels.<id>`, `users.<id>`, set in `config.yaml` or by a new `--boundary` option on `config set` under the existing `config:write` gate for the channel scope; a boundary for a credential or a schedule actor, if one is ever needed, is a sibling `boundaries.<actorId>` block, never a fourth grants axis. A `maxMinutes` under 2 is refused at load: the bash tool keeps a 60-second reserve, so a shorter run could never execute a command. Resolution differs from every other scope setting on purpose: models and effort take the most specific layer, boundaries intersect across all of them (the smallest `maxMinutes`, the lowest `maxIdentity`, the intersection of `machines`), so a user's boundary can tighten a channel's and never loosen it, and an absent boundary caps nothing. The **effective profile** is preset ∩ directives ∩ boundaries, computed once by an admission step after authorize and before provision. A budget above the cap is clipped and named on the card and in the record (`boundedBy`); an identity or machine class above the cap rejects the run, naming the boundary and its scope, before any executor exists. Directives are the caller's own boundary on one run: `budget:30` narrows; `budget:120` above the preset or a cap changes nothing and says so. The ship pipeline's `ship.maxMinutes` knob becomes the ship preset's declared budget in that deployment, one number instead of a pipeline cap beside a placeholder; its child rounds run under the parent's effective profile, clipped to the remainder as today.

Invariants: (a) for every preset and every actor kind, a configuration with no boundaries admits exactly where `canRunAgent` admits at this sha and runs exactly the preset's declared profile; (b) for any run, every axis of the effective profile is at or under the preset's declaration and at or under every boundary on its path, however the preset was chosen; (c) no executor is constructed and no token minted from anything but the effective profile, proven as the dispatcher proves "no registry command starts a run": the factory stubbed, asserted never called on a rejected profile and always called with the intersected one. A `blank` profile never resolves a repository, so `machines` is the only axis a repository-free run meets.

Failure modes: a boundary names a machine class or identity the code does not know, and the load fails naming it, as an unknown `restrict.agents` entry fails today; a channel bounds `maxMinutes` below a preset's wrap-up reserve, and the run still ends with the forced write-up the runner already guarantees at any budget; the ship preset (120 minutes by default, identity `write`) is clipped or rejected by the same rule as any other preset, so a channel bounded to `read` cannot start a ship run, which is the correct reading of that boundary.

The alternative this beats: caps as grant actions (`budget:120`, `credential:write`), open unless restricted, with a rung expansion so the table never compares numbers. It reused the one table, and it bent the table's vocabulary to carry a number, invented a `restrict.budgets` list beside the scope settings that already exist, and could say "closed unless granted" but not "45 in this channel." Intersection over scopes says that in one field and leaves the policy table exactly as the authorization record wrote it.

## The machine class

Two implicit rules decide the machine today. "No repo declared means no machine" makes a machine without a repository undeclarable, though a coding message with no repo gets one by accident, with a write token. "A serviceable resident wins" sends a two-hour, memory-hungry investigation onto a container shared with every review of that repository, whose image pins a 1.5 GB Node heap and one test worker.

The design names four classes and the factory branches on them. `none`: the null executor. `blank`: a per-thread sandbox with an empty workspace, no repo resolution, a token only if identity says so. `repo-cold`: a per-thread sandbox with the checkout; the repository is verified against GitHub with the run's credential, and the resident registry is never consulted, so a registry outage cannot refuse or delay it. `repo-resident`: today's coding and review path, resident when onboarded and serviceable, else the cold fallback with its note, registry vet included. Repo resolution reads the class instead of `resources.repo` to decide whether it runs.

Invariants: a `blank` run makes no GitHub call before the model's first turn; a `repo-cold` run makes no request to the resident Worker; the factory tests that assert resident selection for coding and review pass unchanged with `repo-resident` as their class.

Failure mode: a `repo-cold` run names a repository the credential cannot see. GitHub answers 404 at verification and the refusal names the repository and the installation, the wording the GitHub tools already use.

The alternative it beats: a boolean `preferCold` on the agent. It covers this case and cannot say `blank`, which is the next request shape (a URL, a binary). Four names cost one enum.

## Routing

The router runs a fast model over untrusted text and its answer shapes a run, so it must be cheap, allowed to be wrong, and harmless when wrong.

It is a filter after `resolveRun` and before repo resolution, run only when the agent would otherwise be `defaults.agent`: a directive, the thread's sticky preset (which enters resolution as the request's own agent), a user `agent` or a channel `agent` each skip it, and `defaults.agent` stays the answer when the router is off or fails. It sees the request text, the thread's last directives and the preset table, on the model named by `defaults.models.router` (the fast model general uses today: about 1,500 input tokens, well under a second, a fraction of a cent per mention; how many undirected mentions a day pay it is read from run history before slice two). It returns a preset name and a reason; a name outside the table or a parse failure falls back to `defaults.agent` with `routed: fallback (router said "…")`. A limitation stated plainly: a channel or user `agent` is a force today, so a deployment that has set one never routes in that scope; splitting force from default on that field is a follow-up, not part of this record. Every routed run says so on the card and in the record, and the card's label carries the preset so the sticky scan, which today reads only user text, reads the bot's own label too and a routed thread stays on its preset. Whatever it picks meets authorization and admission like a typed directive.

Invariants: the router never emits a profile, only a name; any directive beats it; a routed thread is sticky; the record carries the reason.

Failure mode: the router sends a question to `coding`. The card shows `coding · routed: …` within a second, the coding prompt asks its one clarifying question and stops, and the user answers with `agent:general`. One cheap turn, visibly labeled.

The alternative it beats: no router, users type `agent:explore`. That is where slice one lands. It is not the end state because the person who asked the motivating question did not know or care which agent existed.

## Why not X

**Why not add an `investigate` agent with a 120-minute budget?** It closes this week's request and is the sixth name for a task. Every restricting deployment learns a sixth name, the next request shape (a URL, a binary) is a seventh, and each is still a whole agent when the difference is one axis. Slice one is the same code as that agent plus the axes stated.

**Why not put the caps in the grants table as actions?** That was the first draft. Grants answer who; a cap answers how much, per scope, and the two systems that solved this at scale keep them in separate mechanisms for that reason. Merging them forced a rung ladder, an expansion step and a parallel `restrict` list to say what one `maxMinutes` field says.

**Why not one agent with every tool and a budget directive?** Reach must be capped before the model runs. A write credential and a machine are decisions the scope's boundary and the caller's grants make; a model choosing them from untrusted text is the injection hole the read-scoped token exists to close.

**Why not the meta-agent from the run-coordination epic?** A different substrate (agent to agent, a thread index, a board), and it still needs a way to say what each child may reach. Profiles are what a coordinator hands its children.

## Boundaries of the design

Not in scope: spawning and awaiting runs and the board; reading a thread in another channel (waits on real membership); per-run cost accounting; interim messages from a running agent; warn-only or audit-only boundary modes; splitting a scope's `agent` into a force and a default. What a machine has installed is the physical half of reach and gets its own record: a declarative manifest per image class rendered into the Dockerfile by `deploy:gen`, with the default cold image growing Python, a headless browser and build tools against a measured cold-start budget. The five agents keep their names and prompts; nothing changes for a deployment that sets no boundary and names no router. Migration is one release; the run record gains a `profile` field.

## What would change our mind

| Assumption | Cheapest test | When |
|---|---|---|
| A detached process survives across tool calls for a run's whole life, so no background mode is needed (a live probe showed `setsid -f` surviving one call boundary; a two-hour run crosses dozens) | one cold run: start a 25-minute job detached, poll it to completion | before slice one ships |
| A 4 vCPU / 12 GiB sandbox runs a large monorepo's typecheck sequentially | the comparison run | the comparison run |
| Clipping a budget silently enough to be safe and loudly enough to be noticed: a clipped run's write-up is still what the user wanted | the first ten clipped runs in production, read on the run page | after slice one |
| A fast model routes five presets with under 5 percent error | replay the last 200 requests from run history offline against the directive or agent they ran on | before slice two |

Reversibility: presets over the existing agents revert to names; a boundary is one optional field per scope and an absent one is today; the router is one stage to delete.

## Rollout

Slice one, before the comparison run: the four machine classes in the factory and repo resolution; the profile the runner and the ledger read; the boundary field on scopes with the admission step; the `explore` preset (shell, files, web fetch and search, GitHub reads; `repo-cold`; identity `read`; 120 minutes); the sandbox Worker's timeout hint corrected to `setsid -f`. No router; `agent:explore` names it. Three PRs, a few days: the classes and repo resolution; the boundary field, the admission step and the effective profile; the preset and the budget field. Slice two: the router behind `defaults.models.router`, off when unset, with the sticky label. The image manifest is its own record and slice. Each slice is its own plan through the review loop; the routing-and-config, execution, authorization and agent specs change in the same PRs.

## Open questions

Decided, revisable: `explore` runs on identity `read` whatever the caller holds; an investigation that must push is a second preset, so a read-only investigation can never be turned into a write by a directive. Decided, revisable: budgets clip, identities and machine classes reject.

| Question | Owner | Resolves it | Before |
|---|---|---|---|
| Which model routes, and is its prompt cached per deployment? | maintainer | the offline replay above | slice two |

## Validation criteria

| Criterion | Proof |
|---|---|
| With no boundaries set, every preset admits and refuses per actor kind exactly as `canRunAgent` at `ec170a3` and runs its declared profile | `[gap]` slice one: a per-actor goldens test beside `src/config.test.ts` |
| Boundaries intersect across layers: the smallest budget, the lowest identity, the intersection of machine classes; an absent boundary caps nothing; a `maxMinutes` under 2 or an unknown class or identity fails the load by name | `[gap]` slice one: `src/config.test.ts` |
| A budget above a cap is clipped with `boundedBy` on the record and the card; an identity or class above a cap rejects before the factory is called | `[gap]` slice one: `src/core/dispatcher.test.ts`, factory stubbed |
| `blank` makes no GitHub call before the first turn; `repo-cold` makes no resident request | `[gap]` slice one: `src/execution/factory.test.ts` |
| A directive skips the router; a routed run's card and record carry the reason; a routed thread is sticky; a parse failure falls back with a note | `[gap]` slice two: `src/core/dispatch/route.test.ts` |
| Live: `agent:explore` against a large onboarded monorepo lands in a cold sandbox with a read token, runs a detached job past 20 minutes, and reports a claim table | `[gap]` human-gated, the comparison run |

## Sources

- The gap analysis and live probes of the production sandbox, 2026-09-09.
- [0002](0002-dispatcher-is-the-only-orchestrator.md), [0005](0005-layered-config-effort-first-class.md), [0007](0007-authorization-policy-table.md), [0018](0018-capabilities-computed-once-null-objects.md), [0024](0024-dispatcher-as-a-staged-pipeline.md), [0025](0025-dispatch-pipeline-as-built.md).
- Specs: [routing-and-config](../reference/specs/routing-and-config.md), [authorization](../reference/specs/authorization.md), [execution](../reference/specs/execution.md), [agents and toolsets](../explanation/agents-and-toolsets.md).
- IAM permissions boundaries (the effective permission is the intersection; a boundary grants nothing); Kubernetes LimitRange (a per-namespace cap applied by admission, separate from RBAC) and Pod Security Admission (profiles enforced per namespace, with warn and audit modes).
- The run-coordination epic in the tracker, with Amp's Puck as its reference shape.
