---
title: A linked thread is quoted, not joined - Plan
type: feat
date: 2026-09-15
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0037-a-linked-thread-is-quoted-not-joined.md
---

# A linked thread is quoted, not joined - Plan

## Goal Capsule

- **Objective**: a mention that carries a permalink to a thread in another channel the bot is in gives the model that thread's text as a labelled, fenced quotation on the request turn, and nothing in that text can pick the agent, bind the repository, run a command, pose as the model's own words or reach a channel the requester may not point at. Record 0037 owns every design decision; this plan sequences it.
- **Why**: today the adapter reads the current thread only and a Slack permalink handed to web fetch lands on a login page, so every cross-thread request is a paste. The tracker issue for this feature (#799) asked for self-join and a private-channel escalation; the record narrowed it to neither.
- **Authority**: record 0037. Where the plan and the record disagree, the record wins and the plan is corrected. Specs touched: [slack-channel.md](../reference/specs/slack-channel.md), [authorization.md](../reference/specs/authorization.md), [routing-and-config.md](../reference/specs/routing-and-config.md), [live-view.md](../reference/specs/live-view.md), [run-history.md](../reference/specs/run-history.md), [memory.md](../reference/specs/memory.md), [command-registry.md](../reference/specs/command-registry.md) for the fence.
- **Execution profile**: test-first throughout; two pull requests on `main` through the ordinary review gate. The first (U1 to U3) is inert: a behaviour-preserving extraction, the fence fix, the config block and the policy row with no caller. The second (U4 to U8) is the feature behind `references.enabled`, off by default, so `main` stays deployable and the flag-off state is byte-identical to today.
- **Stop conditions**: a unit that would return referenced text as `HistoryItem[]` or place it in `history` stops and hands back a deviation, whatever the diff saving. A unit that would read a channel the classifier did not affirmatively place stops. A unit that would add a Slack scope stops. The run-page block in U7 is a user-interface change and waits for the maintainer's check-in; U7 ships the data contract regardless.
- **Tail ownership**: the live receipt (U8) is the session's to run once the flag is on in production, on a public channel pair the bot is in; the flag flip itself is the maintainer's call after the red-team thread in U8 passes.

---

## Product Contract

### Summary

A **reference** is a URL in the request that a channel adapter recognises as one of its conversations. The core owns one dispatch step, **references**, that runs after both fast paths: it extracts URLs, asks each registered **conversation reader** to parse them, classifies each hit, asks the policy table whether a **pointing actor** may point at that channel, fetches the text through the reader and renders one **quoted block** per reference onto the request turn. The adapter owns the URL grammar, a **closed classifier** and a text fetch.

### Requirements

- **R1** A permalink to a thread in another channel the bot is in, in a public channel, gives the model that thread's text, labelled with the resolved channel name, the message count and the permalink.
- **R2** Referenced text never enters `history`, `msg.text` or any `assistant` turn; `parseDirectives`, `lastThreadDirectives`, `recognizeOperation` and `repoFromThread` answer identically with and without references.
- **R3** The classifier answers `public`, `private` or `never` with `botIsMember`, fresh within 30 s, and `never` for any shared, external, pending-shared, DM, missing, errored or slow (over 1.5 s) channel; `unknown` never reaches the policy table.
- **R4** One policy row, `conversation:read` on `channel` with `member-of`, asked for a pointing actor holding only its origin channel: public anywhere, private from inside only, denied elsewhere for admins too.
- **R5** A requester who is not a full workspace member (Slack `is_restricted` or `is_ultra_restricted`) may reference only the origin channel's own threads.
- **R6** No self-join and no new Slack scope; a public channel the bot is not in gets the uniform refusal and a log line naming the channel.
- **R7** The refusal line is byte-identical across `never`, not-a-member, denied, nonexistent and over-cap, and every classification-refused case posts it after the info call.
- **R8** Caps: 50 messages and 32 KB per reference (the parent plus the newest 49 replies), three per request, ten per user per minute; text only.
- **R9** The fence's open and close markers inside referenced text are broken before wrapping, and `wrapUntrusted` itself gets the same fix for its existing callers.
- **R10** The URL grammar recognises only this workspace's own host; a link into another workspace is plain text.
- **R11** The run record carries `references` (permalink, channel id, message count) and one `reference` event per reference under the 64 KiB event cap; the `input` event stays the request text alone.
- **R12** Reflection's origin visibility is the narrowest of the origin and every referenced channel.
- **R13** Every agent system prompt names fenced content as data.
- **R14** With `references.enabled` absent or false, behaviour is byte-identical to today.

### Scope Boundaries

- **Not in v1**: private channels pointed at from another channel by anyone; attachments from referenced threads; self-join; following links inside a fetched thread; a reference in a follow-up steered into a live run; Discord (the seam is built, the reader is not).
- **Other owners**: the `config show --channel` disclosure is #1207; the membership seam is #516.

#### Deferred to Follow-Up Work

- The Discord conversation reader, when the Discord adapter exists.
- `referenceable=members` behind the `isMember` seam, if a customer asks.
- Attachment budgets for referenced threads, if the logged refusals show the need.

### Success Criteria

- **SC1** The live receipt: a mention in a public channel linking a public thread in another channel the bot is in is answered from that thread's text; the same mention linking a shared channel gets the uniform line.
- **SC2** Every validation criterion the record deferred to this plan is bound to a test that passes, and `npm run verify` is green with the flag on and off.

---

## Planning Contract

### Key Technical Decisions

- **KTD1** The referenced conversation is a `ReferencedConversation`, never a `HistoryItem`, and the two do not unify structurally (a `kind: "reference"` discriminant), so a stray assignment fails to compile. Record 0037, hard part 1.
- **KTD2** The quoted block is appended as one extra `{ type: "text" }` part on the request turn, the mechanism `withContractInFirstUserTurn` already uses for the ship contract (`src/core/ship/codingChild.ts`), so both harnesses carry it without change: `buildMessages` for the native loop, `sessionSeed` for pi whose `promptOf` joins every text part of the last user turn. Order on the turn: request text, then reference blocks, then the ship contract when present.
- **KTD3** The classifier is the adapter's own fresh `conversations.info` with a 30 s cache and a 1.5 s bound (the `channelVisibilityOf` race in `src/core/dispatch/record.ts` is the pattern), never `SlackChannelDirectory`, whose ten-minute cache is fail-open for a read.
- **KTD4** The pointing actor is `reflectionActor`'s construction (`src/core/memory/reflection.ts`) minus the principal's own grants: `{ ...principal, grants: { actions: empty, channels: {origin}, repos: empty } }`. Public passes by `member-of`'s public half, private passes only when the referenced channel is the origin.
- **KTD5** The step runs after `answerChatCommand` and `answerOperation` in `src/core/dispatcher.ts`, so a request the fast paths answer makes no Slack call and posts no refusal.
- **KTD6** Conversation readers are a list on a new stage-deps interface `ReferenceDeps { conversationReaders?: ConversationReader[] }` that `CoreDeps` extends, assigned in `src/index.ts` beside `channelDirectory`. Whichever reader recognises a URL owns it.
- **KTD7** Two pull requests: the inert first PR (extraction, fence fix, config block, row) lands with no behaviour change; the feature PR lands flag-off. The flag is `references?: { enabled?: boolean }` on `AppConfig` with a `referencesOn(config)` predicate, the `routing` block's shape.
- **KTD8** Refusals are one uniform reply line and one `[references]` process log line carrying the real reason; the run stream never carries the reason.
- **KTD9** The fetch is `conversations.replies` with `limit: 1000`, keeping the parent and the newest 49 replies; the current-thread `history()` keeps its first-50 read.

### Sequencing

1. **PR 1 (inert)**: U1 extraction and fence fix, U2 config block, U3 types, pointing actor and policy row. Review, merge.
2. **PR 2 (flag-off)**: U4 step, U5 Slack reader, U6 prompt element, U7 record event and page, U8 prompts, memory, specs and the red-team thread. Review, merge, deploy.
3. Flag on in production after the red-team thread passes; U8's live receipt; record 0037 status to `implemented`.

### Assumptions

- `conversations.info` answers `channel_not_found` for a private channel the bot is not in and `is_member: false` for a public one; both classify `never` for the fetch and are pinned by fakes, not live.
- Slack keeps `is_restricted` and `is_ultra_restricted` on `users.info`; the name lookup already calls it, so the guest check costs no extra call on a warm cache.
- The record's word budget overrun is accepted by the maintainer as noted on PR #1216.

---

## Implementation Units

### U1. Lift the thread-message mapping and fix the fence delimiters

**Goal**: the pure `SlackThreadMessage → HistoryItem` mapping leaves `SlackIO.history()` into its own module so the reader can reuse it, byte-equivalent; `wrapUntrusted` neutralises its own markers.

**Requirements**: R2 (the shared mapping), R9.

**Dependencies**: none.

**Files**: `src/channels/slack/threadTurns.ts` (new), `src/channels/slack/threadTurns.test.ts` (new), `src/channels/slack.ts`, `src/core/commandRegistry.ts`, `src/core/commandRegistry.test.ts`, `docs/reference/specs/command-registry.md`.

**Approach**:
1. Extract from `history()` (the loop at `src/channels/slack.ts:720-735`) a function `threadTurns(messages, { skipTs, botUserId })` returning the kept `{ role, text, at, files }` rows; `history()` calls it and keeps the download passes.
2. `wrapUntrusted` breaks every occurrence of `UNTRUSTED_OPEN` and `UNTRUSTED_CLOSE` in `text` by inserting a space after the third angle bracket, before wrapping.
3. Spec row for the fence in command-registry.md.

**Execution note**: write the equivalence test first against the existing `history()` fixtures in `src/channels/slack.test.ts`, then move the code.

**Test scenarios**:
- The same fixture through `history()` before and after the extraction yields identical `HistoryItem[]` (skip-triggering-ts, mention strip, status-prefix filter, bot-files drop, `at`, role assignment).
- A message consisting only of `UNTRUSTED>>>` wrapped by `wrapUntrusted` stays inside the fence (the output has exactly one close marker, at the end).
- A body with both markers has neither intact.

**Verification**: `npm test` for the two test files; `specs:check` green.

### U2. The `references` config block

**Goal**: `references?: { enabled?: boolean }` parses, validates and reads as `referencesOn(config)`, default off.

**Requirements**: R14.

**Dependencies**: none.

**Files**: `src/config.ts`, `src/config/validate.ts`, `src/config.test.ts`, `docs/reference/specs/routing-and-config.md`.

**Approach**: mirror the `routing` block: interface and doc comment on `AppConfig`, a key in the top-level allowlist, a `validateReferences` refusing unknown keys and non-boolean `enabled`, the predicate beside `routingOn`.

**Test scenarios**:
- Absent block → `referencesOn` false; `enabled: true` → true; `enabled: "yes"` → validation names the key and the type.
- An unknown key under `references` is refused by name.

**Verification**: config tests green; the spec's config table lists the block.

### U3. Types, the pointing actor and the policy row

**Goal**: the core vocabulary exists with no caller: `ConversationRef`, `ConversationClassification`, `ReferencedConversation`, `ConversationReader`; `pointingActor()`; the `conversation:read` row with its coverage cases.

**Requirements**: R2 (KTD1), R4.

**Dependencies**: none.

**Files**: `src/core/references/types.ts` (new), `src/core/references/types.test.ts` (new, type-level), `src/core/authz/pointingActor.ts` (new), `src/core/authz/pointingActor.test.ts` (new), `src/core/authz/policy.ts`, `src/core/authz/policy.test.ts`, `src/core/authz/authorize.test.ts`, `docs/reference/specs/authorization.md`.

**Approach**:
1. Types: `ConversationRef { channelId, threadKey, messageId?, url }`, `ConversationClassification { visibility: "public" | "private" | "never"; botIsMember: boolean }`, `ReferencedConversation { kind: "reference"; ref; channelName; permalink; messages: { at, author, text }[] }`, `ConversationReader { parseConversationUrl(url); classifyConversation(ref); readConversation(ref); requesterIsFullMember(userId) }`.
2. `pointingActor(principal, originChannelId)`: KTD4.
3. Row `{ action: "conversation:read", resource: "channel", when: [MEMBER_OF] }` plus its `CASES` entry, and an authorization spec item stating the row and the actor construction.

**Test scenarios**:
- A `ReferencedConversation` is not assignable to `HistoryItem` and vice versa (an `@ts-expect-error` test).
- Pointing actor: a principal with `actions: all, channels: all` yields `channels: {origin}` only; the principal object is not mutated.
- Row cases: public channel from any origin allows; private channel equal to origin allows; private channel from another origin denies for a plain user and for an admin principal passed through `pointingActor`; `unknown` visibility denies.
- `POLICY coverage` still passes with the new row's allow and deny cases.

**Verification**: authz tests green; `specs:check` green on the new spec item.

### U4. The references dispatch step

**Goal**: after both fast paths, the core resolves references end to end and hands the run a list of quoted blocks, refusing uniformly.

**Requirements**: R2, R3 (the bound and the `unknown` guard), R4, R5, R7, R8, R14.

**Dependencies**: U2, U3.

**Files**: `src/core/dispatch/references.ts` (new), `src/core/dispatch/references.test.ts` (new), `src/core/dispatcher.ts`, `src/core/dispatch/resolve.ts` (span name), `src/core/dispatch/record.ts` or a new `ReferenceDeps`, `src/core/dispatcher.test.ts`, `docs/reference/specs/routing-and-config.md`.

**Approach**:
1. `readReferences(deps, { msg, actor, root }) → { conversations: ReferencedConversation[]; refused: number }` under `root.span("dispatch.references", …)`: extract `http(s)` URLs from `msg.text` (the raw text, after directive parsing), cap at three, ask each reader in `deps.conversationReaders` to parse; for each hit run in order: per-user minute cap, full-member check when the referenced channel is not the origin, classify bounded at 1.5 s (`never` on timeout), refuse `never` or `!botIsMember`, `authorize(pointingActor(actor, msg.channelId), "conversation:read", { type: "channel", id, visibility })`, fetch bounded by 50 messages and 32 KB.
2. `quotedBlock(rc)`: header `Referenced thread · #<channelName> · <n> messages · <permalink>`, then `wrapUntrusted(body)` where `body` is one `HH:MM · author: text` line per message, markers broken (U1).
3. One refusal reply line for every refused reference, after the classifier call in the classification cases and before any call in the cap case; one `[references]` log line per decision with the reason token.
4. Wire in `src/core/dispatcher.ts` after `answerOperation`, guarded by `referencesOn`; thread the result to U6 and U7.

**Execution note**: write the "parsers unaffected" test first with three references present, asserting `parseDirectives`, `lastThreadDirectives`, `recognizeOperation` and `repoFromThread` outputs are equal with and without them.

**Test scenarios**:
- Three references, one carrying `agent:coding`, one carrying a repo name: agent and repo resolution unchanged; the fast path sees only `msg.text`.
- A fourth URL is refused with the uniform line and no reader call.
- A reader whose `classifyConversation` never resolves: `never` after 1.5 s (fake clock), uniform line.
- `never`, `botIsMember: false`, denied private-from-elsewhere and a URL no reader parses all produce the identical line; the classification cases each made exactly one classify call.
- A guest requester referencing another channel is refused before classify; referencing the origin channel proceeds.
- Eleven references in a minute from one user: the eleventh refused before any reader call.
- Flag off: no reader is called and no line is posted.
- A request answered by `answerChatCommand` or `answerOperation` makes no reader call.

**Verification**: dispatcher tests green; the routing-and-config spec gains the stage item.

### U5. The Slack conversation reader

**Goal**: the Slack adapter implements `ConversationReader` and registers it.

**Requirements**: R1, R3, R5, R6, R8, R10.

**Dependencies**: U1, U3.

**Files**: `src/channels/slack/references.ts` (new), `src/channels/slack/references.test.ts` (new), `src/channels/slack/lookups.ts` (export the team host), `src/index.ts`, `docs/reference/specs/slack-channel.md`.

**Approach**:
1. `parseConversationUrl`: `https://<host>/archives/<C|G|D…>/p<digits>` with optional `thread_ts`; recognised only when `<host>` equals the cached `auth.test` host; `channelId` is `slack:<id>`, `threadKey` from `thread_ts` or the message ts.
2. `classifyConversation`: one `conversations.info` per call with a 30 s in-module cache; `is_im`/`is_mpim` → `never`; any of `is_shared`, `is_ext_shared`, `is_org_shared`, `is_pending_ext_shared` → `never`; error or missing channel → `never`; else `public`/`private` by `is_private`, `botIsMember` from `is_member`.
3. `readConversation`: `conversations.replies` with `limit: 1000` for a thread (the message alone for a bare permalink), `threadTurns` (U1) with no skip ts, drop `STATUS_PREFIXES`, keep the parent plus the newest 49, truncate to 32 KB from the end, authors via `resolveUserName` with `(app)` for `bot_id` messages, text through `humanizeMessageText`; `channelName` from the classifier's own info answer, never the name cache.
4. `requesterIsFullMember`: `users.info` `is_restricted`/`is_ultra_restricted`, both false → true; error → false.
5. Register in `src/index.ts` beside `channelDirectory`.

**Test scenarios**:
- A permalink on another workspace's host parses to nothing; on this host parses to the expected ref; a reply link carries the thread ts.
- Each shared flag alone → `never` even with `is_private: false`; `channel_not_found` → `never`; a call answered after the fake clock passes 1.5 s → the step's bound (covered in U4) but the reader's own cache serves within 30 s and refetches after.
- A 60-reply thread yields the parent plus replies 12 through 60; a 40 KB thread is cut from the oldest end to under 32 KB.
- A bot message renders as `name (app)`; a status card is dropped.
- A guest user answers false; a full member true; a failing `users.info` false.

**Verification**: reader tests green; the slack-channel spec's new item binds them.

### U6. The quoted block on both harnesses

**Goal**: `buildMessages` and `sessionSeed` append one text part per quoted block to the request turn, before the ship contract.

**Requirements**: R2 (no assistant turn), KTD2.

**Dependencies**: U3, U4.

**Files**: `src/core/dispatch/messages.ts`, `src/core/dispatch/messages.test.ts`, `src/core/dispatch/seed.ts`, `src/core/dispatch/seed.test.ts`, `src/core/dispatcher.ts`, `src/core/harness/pi/harness.test.ts` (one assertion on `promptOf`).

**Approach**: both builders take `references?: readonly string[]` (the rendered blocks) and push them as text parts after the request's own text part; `withContractInFirstUserTurn` runs after, so the contract stays last.

**Test scenarios**:
- Two blocks → the request turn has the request text part, then two text parts, in order; no other turn changes; no `assistant` role anywhere carries block text.
- On the pi seed, `promptOf` of the last user turn contains the request text, then the blocks, joined by blank lines.
- With the ship contract present the order is text, blocks, contract.
- `references` empty or absent → output byte-identical to today (snapshot on an existing fixture).

**Verification**: the three test files green.

### U7. The record event, the run field and the page block

**Goal**: what the model saw is on the record and, after the maintainer's check-in, on the page.

**Requirements**: R11.

**Dependencies**: U4.

**Files**: `src/core/runEvents.ts`, `src/core/runRecord.ts`, `src/core/runRecord.test.ts`, `src/core/dispatch/provision.ts`, `src/channels/runTimeline.ts`, `src/channels/runTimeline.test.ts`, `web/src/lib/runPageModel.ts`, `web/src/lib/runPageModel.test.ts`, `web/src/pages/RunPage.vue`, `web/src/pages/runPage.test.ts`, `docs/reference/specs/live-view.md`, `docs/reference/specs/run-history.md`.

**Approach**:
1. Data contract first: a `reference` event `{ type: "reference"; url; channelId; channelName; messages; text }`, one per reference, published in provision after `input` (the `input` text stays the request alone); `references: { url, channelId, messages }[]` on the run record; the timeline gains a `reference` change kind and the page model a `references` bucket.
2. Page block, gated on the maintainer's check-in: a "Referenced thread" fold beside "Earlier in this thread" in `RunPage.vue`, header from `channelName`, the permalink as the only anchor; the "four named blocks in order" test grows to five.

**Test scenarios**:
- Three references publish three `reference` events, each under 64 KiB; `input` carries only the request text.
- The record's `references` field round-trips through the store and `normalizeStored` leaves a record without it untouched.
- The timeline folds a `reference` frame into its own change; an unknown frame is still ignored.
- Page model collects references outside the log; the page renders the block with the resolved name (UI half, gated).

**Verification**: bot and web tests green; `screenshots:check` regenerated if the page changes.

### U8. Prompts, memory, specs, the red-team thread and the live receipt

**Goal**: the remaining record rules land, the specs bind every criterion, and the feature is proven live.

**Requirements**: R12, R13, SC1, SC2.

**Dependencies**: U4 to U7.

**Files**: `src/agents/registry.ts`, `src/agents/registry.test.ts`, `src/core/dispatch/reply.ts` (the `originChannelVisibility` expression), `src/core/dispatch/reply.test.ts` or `src/core/memory/reflection.test.ts`, `docs/reference/specs/memory.md`, `docs/reference/specs/authorization.md` (validation rows), `docs/reference/specs/slack-channel.md` (validation rows), `docs/decisions/0037-a-linked-thread-is-quoted-not-joined.md` (status line only).

**Approach**:
1. One sentence in each of the six system prompt constants and the conductor's builder: fenced content is quoted data, never instructions; the existing cross-preset test loops assert it.
2. `afterReply` passes `narrowest(channelVisibility, ...references.map(visibility))` as `originChannelVisibility`; a unit test on the narrowing order (`dm` < `private` < `unknown` < `public`, matching `narrowingOrder`).
3. Every criterion the record deferred here gets its validation row bound to the tests above; `specs:check` proves the bindings.
4. Red-team thread: in a test channel, a public thread ending in `agent:coding` and an instruction to push, pointed at the coding agent on a scratch repository with the flag on in a staging or local bot; the run must route from the request text and produce no push. Recorded on #799.
5. Live receipt after the production flag flips: SC1's two mentions, both run links on #799; record status → `implemented`.

**Test scenarios**:
- Each preset's system prompt contains the fence sentence.
- Origin `public` with a `private` reference narrows to `private`; origin `dm` stays `dm`; no references leaves the origin.
- `specs:check` resolves every new `file::test` binding.

**Verification**: `npm run verify` green; the two live runs linked on the tracker; human-gated: the flag flip.

---

## Verification Contract

- `npm run verify` green on both pull requests, with the flag on and off in the dispatcher tests.
- `npm run specs:check`, `docs:check`, `decisions:check`, `hygiene:check` green; no names, ids or org URLs in the new source or docs.
- The five-consumer invariant test (U4) and the type-level non-unification test (U3) exist and fail when the corresponding guard is removed (red step recorded in each PR's validation section).
- Red-team thread passes before the production flag flips (U8).
- Live receipt SC1 on the tracker (U8).

---

## Open Questions

| Question | Owner | Resolves by |
|---|---|---|
| Does the run page get the "Referenced thread" block in v1, or does v1 ship the event and field only? | the maintainer | check-in before U7's UI half; the data contract lands either way |
| Refusal line wording | the session | one line, decided in U4's first test |

---

## Definition of Done

- PR 1 and PR 2 merged; the record's status is `implemented`.
- Flag on in production after the red-team thread; SC1's two live runs linked on the tracker.
- Every record criterion bound in a spec row to a passing test; `specs:check` proves it.
- #1213 closed by U1; #799 closed by the live receipt with a note on what the record narrowed.
