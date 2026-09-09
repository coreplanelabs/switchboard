---
title: A run is a capability profile over three axes, named agents become presets, and a routing stage picks the profile
status: proposed
date: 2026-09-09
pattern: Strategy as data + a routing filter in the pipeline, gated by the policy table
---

# A run is a capability profile over three axes, named agents become presets, and a routing stage picks the profile

**The ask.** Decide: adopt capability profiles as the unit of configuration and authorization, with routing over presets first, and approve slice one (two new machine classes, budget as a profile field, one long-investigation preset) before the next comparison run against a hosted assistant. Owner: the maintainer. Needed before that run. Written for an engineer who knows the dispatch pipeline and the policy table. The frame is assumed from the session that produced this record.

Success criteria: (1) a request needing a shell, web search, a read-only credential and two hours runs without a new agent being written; (2) no run reaches a machine, credential scope or budget its caller may not hold, whatever a router says; (3) every actor that may run an agent today, over every surface, may run the same preset after; (4) a deployment that adds no restriction and names no router behaves byte for byte as today.

## TL;DR

The request that started this, validate a CI audit by running the pipeline locally for two hours, fits none of the five agents: the two with a shell ship PRs or read diffs, and none runs past 45 minutes. The bet is that an agent is already three things, what it reaches, who it acts as, how long it runs, so we make that triple the **profile** the pipeline carries and gates, keep the five agents as presets over it, and add a router that picks a preset when none is named. The cost is a wider action vocabulary in the policy table and a mechanical pass over the stages that read agent fields. Decided: the axes, presets, the budget ladder, routing over presets, directives that only narrow. Open: the router's model.

## Today at `ec170a3`

| Fact the design changes or depends on | Where |
|---|---|
| An agent is `{ name, description, system, toolset, maxTurns, maxTokens, maxMinutes, effort?, cacheTtl?, resources?: { repo?: "required" \| "none" }, residentSystem? }` | `src/agents/registry.ts:7-38` |
| Five fixed toolsets; `bash` only in `full` and `readonly`, `web_search` only in `web` | `src/tools/workspace.ts:501-531` |
| Single-agent budgets: general 5 min, coding 45, review 25, research 8. The ship pipeline runs 120 minutes across coding and review rounds, each child clipped to the remainder; it is the only configurable budget | `src/agents/registry.ts:236-299`, `src/core/shipPipeline.ts:66,173`, `src/config.ts:161-168` |
| Directives: `agent`, `model`, `effort`. Thread stickiness is derived by scanning the thread's user text for them; bot text is never scanned; the sticky agent enters resolution as the request's own | `src/directives.ts:23-40`, `src/core/dispatch/resolve.ts:76-89`, `src/channels/slack.ts:630` |
| One scope field, `agent`, is both a force and a default: `request ?? user ?? channel ?? defaults.agent` | `src/config.ts:673` |
| The executor follows the agent: no `repo: "required"` → null executor; a serviceable resident when the repo is onboarded, else a per-thread sandbox. A coding message that names no repo already gets a per-thread sandbox with an empty workspace and a write token: an undeclared blank machine with the wrong identity | `src/execution/factory.ts:146-168,220` |
| Repo resolution vets a bare `owner/name` against the resident registry, and an unanswered registry refuses the run (`repo_unverified`), for every agent that requires a repo | `src/core/dispatch/resolve.ts:134-150`, `src/core/dispatch/authorize.ts:137-160` |
| Credential scope, read-only worktree, PR-run detection and the review post policy are all string tests on the toolset name | `src/execution/factory.ts:181,466`, `src/core/dispatch/provision.ts:476`, `src/core/dispatch/run.ts:176`, `src/core/dispatcher.ts:514`, `src/core/reviewRound.ts:61` |
| Which agents an actor may run is an action, `agent:run:<name>`, open unless `restrict.agents` names it; grants have three axes; a credential's baseline (ingress, MCP, service, schedule) is empty and a browser session's holds only reads, so no baseline carries `agent:run` and every actor runs the unrestricted agents by the open rule | authorization spec items 4, 9; `src/core/authz/grants.ts:23,221-225,266-268` |
| Nine production reads of `agent.toolset`, two of `agent.resources`, the budget in six modules | grep at this sha |
| The cold sandbox is one `standard-4` class with one hand-edited Dockerfile; a rollout kills in-flight sandboxes | `deploy/cloudflare-sandbox/wrangler.template.jsonc`, execution spec item 6 |
| A command runs at most 20 minutes; a `setsid -f` process outlives it, `nohup … &` does not; the sandbox Worker's timeout hint still says `nohup` | `src/execution/bashTimeout.ts:15`, `deploy/cloudflare-sandbox/docker-wrapper.sh:8-10`, `deploy/cloudflare-sandbox/worker.ts:404` |

## The shape

A **profile** is what a run may reach, who it acts as, and how long it may run: **reach** is a set of tool bundles plus a **machine class** (`none`, `blank`, `repo-cold`, `repo-resident`); **identity** is the credential scope minted for the run (`none`, `read`, `write`); **budget** is minutes, turns and tokens, with minutes on a fixed ladder (5, 8, 25, 45, 120). A **preset** is a named profile with a prompt; the five agents are the first five presets and behave as today. The pipeline carries the resolved profile: authorize asks the policy table one question per axis the profile uses, provision picks the executor from the machine class and mints the identity, run hands the runner the bundles and the budget. The **router** is a filter that picks a preset when nothing but `defaults.agent` would have; its output is a preset like any other and meets the same gates. A directive may narrow any axis of the preset it names and never widen one.

The closest known shape is Claude Code's subagent file: a name, a model and a tool list, chosen by the main agent from the task. The one difference is that here the choice is gated after it is made, because the caller is a chat user and the tools include a write credential to the organization's repositories. The router emits a name; authorize decides.

## One trace

The motivating request on the case most likely to be wrong: the router picks a preset the caller may not hold, and the repository named is an onboarded resident.

1. A person mentions the bot with a link to a CI audit and "run our CI locally with act and validate the claims." No directive; the channel sets no agent.
2. Resolve settles `(model, effort)` as today. No directive, no sticky preset, no user or channel `agent`: the agent would have come from `defaults.agent`, so the router runs, between `resolveRun` and repo resolution, which needs the preset's machine class to know whether to run at all.
3. The router calls the deployment's fast model with the text, the thread's last directives and the preset table (name, description, profile), and answers `explore` with a one-line reason. The card gains `explore · routed: a shell and web reads for two hours`.
4. Authorize asks, against the caller: `has-grant(reach:machine)`, `has-grant(credential:read)`, `has-grant(budget:120)`. Each is open unless restricted, like an agent. This deployment lists `120` under `restrict.budgets`, and the caller holds no `budget:120`.
5. Refusal, naming the axis and the fix: `🚫 explore needs a 120-minute budget, closed here. Ask an admin for budget:120, or send agent:explore budget:45.` No executor exists. The property: a routed profile cannot widen what the caller holds, and the failure says which axis.
6. The caller re-sends `agent:explore budget:45`. A directive names the preset and narrows one axis (a directive can only narrow); the router is skipped; authorize asks for the 45 rung and passes.
7. Provision reads machine class `repo-cold`: identity `read` mints a token with `contents`, `actions` and `checks` read, the repository is verified against GitHub with that token (identity `none` verifies anonymously, so a private repository needs `read`), the resident registry is never asked, and a per-thread sandbox is provisioned even though a resident exists. The card says so.
8. The runner gets the `shell`, `files`, `web` and `github-read` bundles and a 45-minute deadline; the prompt is the preset's: claim table, commands and numbers, `setsid -f` for jobs over 20 minutes, no PR.
9. At 42 minutes the wrap-up warning fires (three minutes before the deadline, the runner's rule). The model writes the table with 11 of 16 claims checked and names what a follow-up should do.
10. The reply lands; the record stores `{ preset: explore, routed: false, budget: 45 (directive) }`. The card's label carries the preset, and the sticky scan reads it, so "continue" in this thread lands on `explore`.

## The difficulty map

Ranked by risk of being wrong.

1. Gating the axes: open-unless-restricted actions per axis, stepped budgets, every gate on the profile. Section "Gating the axes."
2. The machine class: `blank` and `repo-cold` without touching the resident path reviews depend on, and without the registry vet. Section "The machine class."
3. Routing: a wrong route visible and sticky, never silent. Section "Routing."
4. Threading the profile through the stages: nine `toolset` reads, the budget in six modules. Most work, least risk; the plan owns it.

## Gating the axes

The constraint comes from the authorization record: grants have three axes, agents are actions, and a condition that needs an external policy engine is that record's own stop condition. A router that picks a profile is therefore a bypass unless each part of a profile is an action the table can ask about.

The design widens the action vocabulary and changes nothing else in the table: `reach:machine`, `reach:repo`, `credential:read`, `credential:write`, and one action per rung of the budget ladder, `budget:5` through `budget:120`. All are **open unless restricted**, exactly the agent rule today, through new `restrict.budgets` and `restrict.credentials` lists beside `restrict.agents`; the baselines of every actor kind are unchanged, so an ingress token or a schedule that runs coding today runs the coding preset tomorrow. A grant for a rung covers every rung below it, resolved when grants load (the grant `budget:120` expands to the set of rungs at or under 120), so the table still asks `has-grant(budget:45)` and never compares numbers. The actions a profile needs derive from its class, identity and budget, never from its bundles: any class but `none` asks `reach:machine`, the two `repo-*` classes ask `reach:repo`, the identity asks its `credential:*`, the budget asks its rung; bundles only constrain which classes are valid (`shell` and `files` need a machine). A directive may narrow an axis of the preset it names (a lower rung, `read` instead of `write`) and never widen one, so the actions asked for any run are at most the preset's declared actions, whether the preset came from a directive, a scope or the router; widening is a grant on the caller or a different preset, never a token in a message. `authorizeAgent` becomes `authorizeProfile`: one `has-grant` per axis the profile uses, before any executor exists, the refusal naming the first missing one; `agent:run:<preset>` stays as the preset gate, so `restrict.agents` keeps its meaning. The ship pipeline declares `budget:120` as its profile and admits its children under the parent's admitted profile, clipped to the remainder as today; its `AgentDef.maxMinutes` placeholder goes away.

Invariants: (a) for every preset and every actor kind, `authorizeProfile` under an unchanged configuration admits exactly where `canRunAgent` admits at this sha; (b) the actions asked for a run are a subset of its preset's declared actions, however the preset was chosen and whatever directives rode along; (c) no executor is constructed and no token minted for a profile `authorizeProfile` refused, proven as the dispatcher proves "no registry command starts a run": the factory stubbed, asserted never called on a refusal. A `blank` profile never asks `reach:repo`; there is no repo resource to ask about.

Failure modes: a preset declares a bundle no action covers, and load fails naming it, as an unknown `restrict.agents` entry fails today; a deployment restricts `budget:120` and the ship preset becomes admin-only, which is the correct reading of that restriction and is named on the card.

The alternative this beats: keep `agent:run:<preset>` as the only action and let the router choose among presets. It is exactly today's gate, and it cannot express the one composition the trace needs today, a caller narrowing a preset's budget and a deployment closing a rung, without a rule per axis anyway. The rungs are the budgets that exist (5, 8, 25, 45, and 120, the ship pipeline's cap); 120 is the `explore` preset's because the hosted assistant's run of the motivating request passed 85 minutes.

## The machine class

Two implicit rules decide the machine today. "No repo declared means no machine" makes a machine without a repository undeclarable, though a coding message with no repo gets one by accident, with a write token. "A serviceable resident wins" sends a two-hour, memory-hungry investigation onto a container shared with every review of that repository, whose image pins a 1.5 GB Node heap and one test worker.

The design names four classes and the factory branches on them. `none`: the null executor. `blank`: a per-thread sandbox with an empty workspace, no repo resolution, a token only if identity says so. `repo-cold`: a per-thread sandbox with the checkout; the repository is verified against GitHub with the run's credential, and the resident registry is never consulted, so a registry outage cannot refuse or delay it. `repo-resident`: today's coding and review path, resident when onboarded and serviceable, else the cold fallback with its note, registry vet included. Repo resolution reads the class instead of `resources.repo` to decide whether it runs.

Invariants: a `blank` run makes no GitHub call before the model's first turn; a `repo-cold` run makes no request to the resident Worker; the factory tests that assert resident selection for coding and review pass unchanged with `repo-resident` as their class.

Failure mode: a `repo-cold` run names a repository the credential cannot see. GitHub answers 404 at verification and the refusal names the repository and the installation, the wording the GitHub tools already use.

The alternative it beats: a boolean `preferCold` on the agent. It covers this case and cannot say `blank`, which is the next request shape (a URL, a binary). Four names cost one enum.

## Routing

The router runs a fast model over untrusted text and its answer shapes a run, so it must be cheap, allowed to be wrong, and harmless when wrong.

It is a filter after `resolveRun` and before repo resolution, run only when the agent would otherwise be `defaults.agent`: a directive, the thread's sticky preset (which enters resolution as the request's own agent), a user `agent` or a channel `agent` each skip it, and `defaults.agent` stays the answer when the router is off or fails. It sees the request text, the thread's last directives and the preset table, on the model named by `defaults.models.router` (the fast model general uses today: about 1,500 input tokens, well under a second, a fraction of a cent per mention; how many undirected mentions a day pay it is read from run history before slice two). It returns a preset name and a reason; a name outside the table or a parse failure falls back to `defaults.agent` with `routed: fallback (router said "…")`. Every routed run says so on the card and in the record, and the card's label carries the preset so the sticky scan, which today reads only user text, reads the bot's own label too and a routed thread stays on its preset.

Invariants: the router never emits a profile, only a name; any directive beats it; a routed thread is sticky; the record carries the reason.

Failure mode: the router sends a question to `coding`. The card shows `coding · routed: …` within a second, the coding prompt asks its one clarifying question and stops, and the user answers with `agent:general`. One cheap turn, visibly labeled.

The alternative it beats: no router, users type `agent:explore`. That is where slice one lands. It is not the end state because the person who asked the motivating question did not know or care which agent existed.

## Why not X

**Why not add an `investigate` agent with a 120-minute budget?** It closes this week's request and is the sixth name for a task. Every restricting deployment learns a sixth name, the next request shape (a URL, a binary) is a seventh, and each is still a whole agent when the difference is one axis. Slice one is the same code as that agent plus the axes stated.

**Why not one agent with every tool and a budget directive?** Reach must be gated before the model runs. A write credential and a machine are decisions the caller's grants make; a model choosing them from untrusted text is the injection hole the read-scoped token exists to close.

**Why not the meta-agent from the run-coordination epic?** A different substrate (agent to agent, a thread index, a board), and it still needs a way to say what each child may reach. Profiles are what a coordinator hands its children.

**Why not a budget directive on the existing agents?** A directive raises a number without a gate. The budget axis exists so the number is grantable and restrictable, which today's 120-minute ship pipeline is not.

## Boundaries

Not in scope: spawning and awaiting runs and the board; reading a thread in another channel (waits on real membership); per-run cost accounting; interim messages from a running agent. What a machine has installed is the physical half of reach and gets its own record: a declarative manifest per image class (apt, npm, pip, verified binaries, copied files) rendered into the Dockerfile by `deploy:gen`, with the default cold image growing Python, a headless browser and build tools against a measured cold-start budget. The five agents keep their names and prompts; nothing changes for a deployment that adds no restriction and names no router. Migration is one release; the run record gains a `profile` field.

## What would change our mind

| Assumption | Cheapest test | When |
|---|---|---|
| A detached process survives across tool calls for a run's whole life, so no background mode is needed | one cold run: start a 25-minute job detached, poll it to completion | before slice one ships |
| A 4 vCPU / 12 GiB sandbox runs a large monorepo's typecheck sequentially | the comparison run | the comparison run |
| A fast model routes five presets with under 5 percent error | replay the last 200 requests from run history offline against the directive or agent they ran on | before slice two |

Reversibility: presets over the existing agents revert to names; the actions are additive and open by default; the router is one stage to delete.

## Rollout

Slice one, before the comparison run: the four machine classes in the factory and repo resolution; the budget ladder as a profile field the runner and the ledger read; `authorizeProfile` with the new open-unless-restricted actions; the `explore` preset (shell, files, web fetch and search, GitHub reads; `repo-cold`; identity `read`; 120 minutes); the sandbox Worker's timeout hint corrected to `setsid -f`. No router; `agent:explore` names it. Three PRs, a few days: the classes and repo resolution; the vocabulary, the ladder and `authorizeProfile`; the preset and the budget field. Slice two: the router behind `defaults.models.router`, off when unset, with the sticky label. The image manifest is its own record and slice. Each slice is its own plan through the review loop; the routing-and-config, execution, authorization and agent specs change in the same PRs.

## Open questions

Decided, revisable: `explore` runs on identity `read` whatever the caller holds; an investigation that must push is a second preset, so a read-only investigation can never be turned into a write by a directive.

| Question | Owner | Resolves it | Before |
|---|---|---|---|
| Which model routes, and is its prompt cached per deployment? | maintainer | the offline replay above | slice two |

## Validation criteria

| Criterion | Proof |
|---|---|
| Every preset admits and refuses per actor kind exactly as `canRunAgent` at `ec170a3` under an unchanged configuration | `[gap]` slice one: a per-actor goldens test beside `src/config.test.ts` |
| A refused profile never reaches the executor factory | `[gap]` slice one: `src/core/dispatcher.test.ts`, factory stubbed |
| `blank` makes no GitHub call before the first turn; `repo-cold` makes no resident request | `[gap]` slice one: `src/execution/factory.test.ts` |
| A grant for a rung covers the rungs below it; `restrict.budgets` closes a rung for the unlisted | `[gap]` slice one: `src/core/authz/grants.test.ts` |
| A directive skips the router; a routed run's card and record carry the reason; a routed thread is sticky; a parse failure falls back with a note | `[gap]` slice two: `src/core/dispatch/route.test.ts` |
| Live: `agent:explore` against a large onboarded monorepo lands in a cold sandbox with a read token, runs a detached job past 20 minutes, and reports a claim table | `[gap]` human-gated, the comparison run |

## Sources

- The gap analysis and live probes of the production sandbox, 2026-09-09.
- [0002](0002-dispatcher-is-the-only-orchestrator.md), [0005](0005-layered-config-effort-first-class.md), [0007](0007-authorization-policy-table.md), [0018](0018-capabilities-computed-once-null-objects.md), [0024](0024-dispatcher-as-a-staged-pipeline.md), [0025](0025-dispatch-pipeline-as-built.md).
- Specs: [routing-and-config](../reference/specs/routing-and-config.md), [authorization](../reference/specs/authorization.md), [execution](../reference/specs/execution.md), [agents and toolsets](../explanation/agents-and-toolsets.md).
- The run-coordination epic in the tracker, with Amp's Puck as its reference shape.
