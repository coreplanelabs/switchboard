---
title: One authorization model (actor / action / resource) - Plan
type: feat
date: 2026-09-03
artifact_contract: ce-unified-plan/v1
artifact_readiness: review-ready
product_contract_source: session 2026-09-03 (Justin + Claude), issue #395
execution: code
---

# One authorization model (actor / action / resource) - Plan

## Goal Capsule

- **Objective**: Replace Switchboard's several authorization mechanisms — command `chatGate`s, machine token `scopes`, the machine-caller channel pin, and the `canRunAgent` / `canUseRepo` / `canManageRepos` / `canEditChannelConfig` helpers — with one `authorize(actor, action, resource)` decision over a policy table, so that identity is resolved once per surface, every gate is a policy row, and channel visibility is a relation that holds on every surface. Closes [#395](https://github.com/coreplanelabs/switchboard/issues/395) as a consequence, not as a special case.
- **Authority**: this plan > `features/*.md` and AGENTS.md invariants > issue prose. Invariant 4 (platform-namespaced ids) and the fail-closed defaults are preserved verbatim.
- **Stop conditions**: a requirement that needs an external policy engine (Cedar, OPA) to express; a Slack API limit that makes channel membership unknowable within a request budget; any unit that cannot keep its behavior-preserving tests green except at the three deliberate changes named in R12.
- **Execution profile**: TDD per `features/README.md`. A new spec `features/authorization.md` carries the criteria; each unit lands its failing tests first.
- **Tail ownership**: each PR runs the pr-lifecycle review loop to LGTM; live receipts land on a `Receipts: features/authorization.md` issue in the project tracker.

---

## Product Contract

### Summary

Introduce a typed `Actor`, typed `Resource`s, and a policy table of rules whose conditions come from a small fixed vocabulary (`has-grant`, `member-of`, `is-self`, `owner-of`). One function decides point checks; the same table compiles into store predicates for list queries. Adapters (Slack, HTTP ingress, MCP, Cloudflare Access, CLI, the schedule shim) resolve identity into one `Actor` shape and stop making authorization decisions. Channel visibility becomes membership: a Slack user sees runs in channels they are a member of, a token sees the channels its grants name, a fleet operator or the weekly cron sees all. The Access API and memory reflection, which today have no channel boundary, get the same one.

### Problem Frame

Today there are four caller kinds and three ways of deciding what a caller may do: chat gates resolved from `permissions.*` lists, machine token scopes, and implicit browser-session reads plus `permissions.operators` writes. Channel visibility exists in three unrelated forms: an ad hoc filter written by hand in `runs.ts` and `friction.ts` for machine callers only (`chatCallerFor` pins every `http:` / `mcp:` caller), scope-key partitioning for memory, and nothing at all for humans or Access callers on run surfaces. Consequences observed:

- The weekly self-improvement cron is pinned to `http:cron`, whose only runs are its own firings, so it has analyzed 0 runs every time ([#395](https://github.com/coreplanelabs/switchboard/issues/395)).
- An Access operator can `runs get --include messages` on a run from a private Slack channel or DM.
- Reflection routes a fact to the shared `org` memory scope on the model's audience judgment, so a fact learned in a private conversation can become org knowledge.
- The same ingress token is authorized two different ways: `friction propose` as text through `/ingress` needs `http:<subject>` listed in `permissions.repoManagement`; the MCP tool `friction_propose` needs the token scope `friction:write`.

The pieces were each built for a real reason (KD6 in the golden plan: machines get their own gated identities; KTD10 in the run-history plan: a token must not read another team's runs). The shape is the problem, not the intent.

### Requirements

**Model**

- R1. One decision function `authorize(actor, action, resource) → allow | deny(reason)`. No command handler, adapter, or store compares identities or channel ids by hand.
- R2. Actors have a kind — `user`, `service`, `schedule`, `agent` — and a platform-namespaced id (invariant 4). An `agent` actor carries the principal it acts on behalf of; its effective grants are the intersection of the agent's own grants and that principal's grants, never a superset.
- R3. Actions keep today's vocabulary: the command id and its effect class (`<group>:read|write|exec`), plus `agent:run`, `repo:use`, `memory:write`. No new action vocabulary is invented for existing behavior.
- R4. Resources are typed with attributes: `run { id, channelId, userId, repo? }`, `channel { id, visibility: public | private | dm | machine }`, `memory-scope { key, kind: org|user|repo|channel }`, `repo { owner, name }`, `config-scope { kind: channel|user, id }`, `agent { name }`, `command { id }` (for list-shaped actions with no single resource).
- R5. Channel visibility is the relation `member-of(actor, channel)`. A run is readable when the actor is a member of its channel or holds the `all-channels` grant. A denied point read renders as `not_found`, never `forbidden` (existence is not revealed). This holds on every surface, the Access API included.
- R6. List-shaped reads push the policy down as a store predicate. No surface loads records and filters afterwards.
- R7. Fail-closed defaults are unchanged: an unresolvable actor has no grants; a missing grant denies; no admins means no operators; unknown membership means not a member; a schedule with no token sends nothing.

**Configuration**

- R8. One `grants` shape describes what any actor may do — actions, channel memberships or `all-channels`, repos, agents — and is the source for humans (`permissions.*`), ingress tokens, Access identities and service tokens, and schedule actors. The existing keys (`permissions.admins|operators|repoManagement|channelConfig|agents`, token `scopes` / `channel`) translate deterministically at config load via a documented table, and are removed in the last unit.
- R9. The schedule registry names each schedule's actor and grants. A firing's authorization is decided by the same table as everything else; no permissions list needs to hand-name `http:cron`.

**Surfaces**

- R10. Slack supplies channel visibility and membership as adapter facts (`conversations.info` for `is_private` / `is_im` / `is_mpim`, `conversations.members` for membership), cached with a TTL; an adapter that cannot supply them yields `unknown` → not a member. The seam is the same for a future SMS or Discord adapter.
- R11. Memory reflection writes are gated by policy: a fact originating in a `private` or `dm` channel may be written to the `user`, `channel`, or `repo` scope but never to `org`; the model's `audience` is a hint the policy may narrow, never widen. Reads are unchanged.

**Migration**

- R12. Every unit is behavior-preserving under the existing test suite except three deliberate changes, each with a red-first test: (a) the cron actor analyzes the fleet; (b) Access callers and Slack users are bound by channel membership on run reads; (c) reflection cannot write private-channel facts to `org`.
- R13. The command conformance suite enumerates actor kind × action × resource from the policy table, so a new command, actor kind, or resource type is covered automatically or fails loudly.

### Scope Boundaries

- No external policy engine. The table is TypeScript data with a fixed condition vocabulary.
- No UI work (the Vue frontend port is separate and on hold for check-in); the `/runs` page keeps consuming the same commands and inherits the policy through them.
- No new ingress surfaces; only the membership seam a new adapter would implement.
- Agent tool-level authorization (which repo a coding agent may push to inside a run) stays with the resident and the compound gate for now; the `agent` actor kind is introduced so that can move here later without a second model.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Policy is data with a closed condition vocabulary.** A rule is `{ actorKind?, grant?, action, resource, when: Condition[] }` where `Condition ∈ { has-grant(g), member-of(resource.channelId), is-self(resource.userId), owner-of(resource.repo), all-channels }`. Because conditions are closed, every rule can be evaluated against one resource AND compiled to a store predicate (`channelId IN (...)`, `userId = ...`, no constraint). Arbitrary predicates are not allowed in rules; a need for one is a stop condition to revisit the vocabulary.
- KTD2. **One table, two evaluators, one public function.** `authorize` is the only export command code uses. `predicateFor(actor, action, resourceType)` exists inside the store adapters (`RunsService`, `RunStoreFrictionLedger`, memory stores) and is derived from the same rules; it is not callable from handlers.
- KTD3. **Adapters resolve identity, never authority.** Each adapter returns an `Actor` from what it can prove: Slack user id + workspace; ingress token entry; Access identity (browser `sub` or service token `common_name`); `cli:local`; the schedule registry entry. Grants are attached by one resolver from config, never by the adapter.
- KTD4. **Membership is an adapter capability with a cache.** `ChannelDirectory { info(channelId) → { visibility } | unknown; isMember(actorId, channelId) → boolean | unknown }`. Slack implements it with `conversations.info` / `conversations.members` and a TTL cache (membership changes rarely; a stale-allow window of minutes is accepted and documented). Machine channels (`http:*`, `mcp:*`) are `machine` visibility with membership = the tokens granted them.
- KTD5. **`chatGate` leaves `defineCommand`.** Today's gates become rows: `open` → any actor; `operator` → `has-grant(operator)`; `repoManager` → `has-grant(repo:write)`; `channelConfig` → `has-grant(config:write) ∧ member-of(channel)` or the open default when no `channelConfig` list exists (the added `member-of` is behavior-preserving, not a fourth R12 change: `config set channel` targets the channel the message came from, and a chat caller is trivially a member of the channel it is speaking in, while a machine caller's target channel is the one its token grants — the condition can only deny a case that cannot occur today); `agentRun` → `has-grant(agent:run:<name>)`. Scopes on machine tokens become grants of the same names. One vocabulary.
- KTD6. **Backward-compatible config translation.** At load, `permissions.admins` → grants `{ all-actions, all-channels }`; `permissions.operators` → `{ runs:*, all-channels }` (see OQ1); `permissions.repoManagement` → `{ repo:write, friction:write }`; `permissions.channelConfig` → `{ config:write }`; `permissions.agents.<name>` → `{ agent:run:<name> }`; token `scopes` → grants of the same names; token `channel` → `member-of` that channel (namespace pin unchanged). The translation table is a unit-tested pure function and is documented in `features/authorization.md`; the old keys are deleted in U7 after one release with both accepted.
- KTD7. **Runs carry channel visibility at write time.** The run record gains `channelVisibility` (from the adapter at dispatch), so the store predicate for memory-write gating and for `dm` handling never needs a Slack call at read time. Existing records without it are treated as `unknown` → private for writes, membership-gated for reads.
- KTD8. **Deny renders as `not_found` for point reads** (unchanged from KTD10) and as an empty page for lists. Audit lines record the deny reason; the reply never does.

### High-Level Technical Design

```
adapter (slack | http | mcp | access | cli | schedule)
   └─ resolves ──▶ Actor { kind, id, onBehalfOf? }
                         │
                 grantsFor(actor, config)  ──▶ Actor.grants
                         │
   command handler ──▶ authorize(actor, action, resource) ──▶ allow | deny(reason)   [point]
   store adapter   ──▶ predicateFor(actor, action, type)  ──▶ where-clause           [list]
                         ▲
                 POLICY TABLE (data; closed condition vocabulary)
                         ▲
                 ChannelDirectory (membership + visibility; adapter-supplied; cached)
```

New module `src/core/authz/`: `actor.ts` (types + resolver), `resource.ts`, `policy.ts` (the table), `authorize.ts`, `predicate.ts`, `channelDirectory.ts` (seam + in-memory impl), `translateLegacyConfig.ts`. `src/channels/slack.ts` gains `SlackChannelDirectory`. `src/core/commandRegistry.ts` drops `chatGate` and `Caller.channel`; `Caller` becomes `Actor`.

### Sequencing

U1 (core, no wiring) → U2 (actor resolution behind a flag-free adapter change with compat translation) → U3 (runs + friction through the store predicate; Access covered; #395 closes) → U4 (chat gates → rows; conformance suite) → U5 (Slack directory + memory write gate) → U6 (spec, docs, AGENTS.md) → U7 (legacy config keys removed) → U8 (live receipts). U1–U3 can ship as a `gh stack`; U4 onward target main independently.

---

## Implementation Units

### U1. Policy core

`src/core/authz/`: `Actor`, `Resource`, `Condition`, the policy table, `authorize`, `predicateFor`, `grantsFor`. Pure, node-free, no I/O.

- Tests: every rule row has a positive and a negative test; `predicateFor` ⇔ `authorize` differential (for a fixture of runs, filtering by the predicate equals filtering by point authorize); an unknown actor kind denies everything; the condition vocabulary is closed (a rule with an unknown condition fails at module load).
- Done when: the module exists with 100% of rules exercised and nothing imports it yet.

### U2. Actors on every surface

Each adapter returns an `Actor`; `grantsFor` attaches grants from config. U2 also owns the native `grants` config shape end to end — the zod schema, `validateConfig` rules, and the `config.example.yaml` block — alongside `translateLegacyConfig` for the old keys, so from U2 onward both shapes are accepted (native wins on conflict, and `validateConfig` warns when both name the same identity). This is the dual-acceptance release U7 depends on. `Caller` becomes a type alias for `Actor` so U2 compiles without touching handlers. Schedule registry entries gain `actor: { kind: "schedule", id, grants }`.

- Tests: adapter tests assert the resolved `Actor` (id, kind, grants) for Slack admin / plain user, token with and without `channel`, Access browser / service token, `cli:local`, the `self-improvement` schedule; the translation table test enumerates every legacy key; a native `grants` block and its legacy equivalent resolve to the same `Actor.grants` (differential); an identity named by both shapes warns and takes the native grants.
- Done when: the full existing suite is green with no handler changed.

### U3. Run and friction reads through the policy

`RunsService` and `RunStoreFrictionLedger` take `predicateFor`; `runs.ts` and `friction.ts` lose their hand-written channel comparisons; the Access-routed `/api/runs.*` path is covered because it flows through the same handlers.

- Red-first tests: (a) the `schedule` actor for `self-improvement` sees runs from every channel (fails today); (b) an Access operator without `all-channels` gets `not_found` on a run from a channel they are not a member of (fails today); (c) a pinned token still sees only its channel (must stay green).
- Live receipt: temporarily reschedule the cron, observe `[schedule] self-improvement → completed run … — 🔍 N runs analyzed` with N > 0, revert. Closes #395.

### U4. Chat gates become rows

Remove `chatGate` from `defineCommand`; each command declares only `action`. The conformance suite (`src/core/commandConformance.test.ts`) enumerates actor kind × action × resource from the table and asserts the derived decision on every surface.

- Tests: the golden reply texts for refusals are unchanged (shared 🚫 wording); every command in `commands/all.ts` has a rule; a command with no rule fails the suite loudly.

### U5. Channel directory + memory write gate

`SlackChannelDirectory` (info + members, TTL cache); dispatch stamps `channelVisibility` onto the run and the reflection input; reflection's write routing calls `authorize(actor, "memory:write", memory-scope)` per candidate and narrows `org` → the narrowest allowed scope for private/DM origins.

- Red-first test: a reflection from a `dm` channel with an `org`-audience fact writes to `user`, never `org` (fails today).
- Tests: cache TTL and `unknown` handling; a Slack API failure yields not-a-member, never allow.

### U6. Spec + docs

New `features/authorization.md` (behavior, the policy table rendered, the translation table, criteria with tests); `features/command-registry.md` item 6 rewritten to point at it; `features/http-ingress.md` / `mcp-ingress.md` / `self-improvement.md` item 7 updated; AGENTS.md invariants row; `docs/self-improvement-architecture.md` "Known gap" section removed.

### U7. Legacy config keys removed

Delete `permissions.admins|operators|repoManagement|channelConfig|agents` and token `scopes`/`channel` translation one release after U2 shipped the native shape; `config.example.yaml` shows only `grants`; `validateConfig` names any leftover legacy key with the replacement.

### U8. Live receipts

On the receipts issue: cron pass with N > 0; Access operator `not_found` on a private-channel run; DM run visible to its user only; `friction report` from Slack reflects the caller's memberships.

---

## Verification Contract

- Unit: the U1 differential (predicate ⇔ point) is the load-bearing test; the conformance suite is the regression net.
- Integration: `deploy/cloudflare-memory` run-store tests confirm the predicate compiles to the DO's `list` filters without a full scan (a `channelId IN (...)` path, indexed).
- Live: U3 and U8 receipts as listed.

## Definition of Done

- `grep -rn "caller.channel\|chatGate" src/` returns nothing outside `src/core/authz/`.
- #395 closed by the U3 receipt.
- `features/authorization.md` exists and every criterion names its test.
- One release shipped with both config shapes accepted before U7 removes the legacy keys.

## Risks & Dependencies

- **Slack membership lookups**: `conversations.members` is paginated and rate-limited; mitigated by the TTL cache and by checking only the requesting actor's membership (one `conversations.members` page per channel per TTL, or `users.conversations` per actor). If the budget is untenable, fall back to `channel.visibility` only (public channels = everyone; private/DM = the run's own user) and record it as a documented approximation.
- **Behavior narrowing for Access operators** (OQ1) is a visible change for Justin's own operator sessions.
- **Config migration** touches the prod secret `SWITCHBOARD_INGRESS_TOKENS` and `config.yaml`; the translation layer means no flag day, but U7 needs a coordinated secret edit (human-manual, see the secrets memory).
- **Agent actors** are introduced but not yet used for tool-level gating; the risk is a half-built concept. Mitigated by keeping the kind minimal (id + `onBehalfOf`) until the resident gating moves.

## Open Questions (for Justin)

- OQ1. Do Access operators keep fleet-wide run reads (today's behavior) via a default `all-channels` grant, or become membership-bound like Slack users? Recommendation: admins get `all-channels`; operators are membership-bound unless granted `all-channels` explicitly.
- OQ2. `friction report` is open to every Slack user today and its examples name runs. Under the model it computes over the runs the actor can see. Accept that the aggregate becomes per-actor, or make it an `all-channels`-gated fleet view? Recommendation: per-actor; a fleet view is one grant away.
- OQ3. Should membership be Slack membership (truthful, costs API calls) or channel visibility only (public = everyone, private/DM = the run's user) as the first cut? Recommendation: visibility-only first (covers the leak with zero API cost), membership in U5 behind the same seam.
