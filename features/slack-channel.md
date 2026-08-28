# Slack channel

Slack is a pure transport: it turns Slack events into `IncomingMessage`s, renders replies/status back, and adds nothing else. All Slack-specific behavior — triggers, receipts, formatting, attachments — lives here.

- **Code**: `src/channels/slack.ts`, `src/channels/mrkdwn.ts`
- **Docs**: [README — Architecture](../README.md#architecture), [AGENTS.md invariant 1](../AGENTS.md)
- **Tests**: `src/channels/mrkdwn.test.ts`, `src/channels/slack.test.ts`

## Behavior

1. **Triggers**: (a) channel mention (`@switchboard …`); (b) DM; (c) thread follow-up in a thread the bot participates in — no re-mention needed. Top-level channel posts still require a mention; bot messages and non-`file_share` subtypes are ignored. Participation is re-derived from the thread itself (`botInThread`), never from in-memory state.
2. **Acceptance receipt**: the moment a message is accepted for handling, the bot reacts 👀 (`eyes`) on it — before any model/tool work. Fire-and-forget: missing `reactions:write` scope or a duplicate reaction logs and never blocks handling.
3. **Status card**: one bot message per run, edited in place — spinner + agent + model + elapsed seconds headline; body is the agent's own ✓/✱/○ checklist (via `update_status`). A ticking card means the run is alive; error paths mark ❌. Slack's native shimmer status is re-upped every 75s during long runs.
4. **Formatting**: agents write standard Markdown; the adapter converts to mrkdwn (bold/italic/strike/headers/links/bullets) and **never rewrites code** (fenced or inline). Replies over 3500 chars are chunked at line boundaries.
5. **Attachments**: images on the triggering message and thread history are downloaded (needs `files:read`) and passed to the model, budgeted (≤10/message, ≤5MB each; thread-wide ≤20 images/24MB, newest-first). Skipped attachments are named to the model so it never claims a file "didn't come through".
6. **Display-name resolution**: the adapter resolves the channel's name (`conversations.info`, needs `channels:read`/`groups:read`) and the sender's display name (`users.info`, needs `users:read`; `profile.display_name` → `real_name` → handle) and passes them to the core as `IncomingMessage.channelName`/`userName` (for the live-view run label). Best-effort and **cached** (module-level `Map`s, one API call per new id, bounded to 1000 entries FIFO): a lookup failure leaves the field undefined — the core falls back to the raw id — and never delays or fails a dispatch. The core stays channel-agnostic; these are optional hints.

## Validation criteria

| Criterion | Proof |
|---|---|
| Markdown→mrkdwn conversions; code fences and inline code untouched | `[unit]` `src/channels/mrkdwn.test.ts` |
| Mention triggers a run; reply lands in-thread | `[agent]` Mention the bot in a channel with a trivial request; expect a status card then a reply in the same thread. |
| Thread follow-up works without re-mention | `[agent]` After a completed run, reply in-thread without mentioning the bot; expect a new run. (Shipped in PR [#26](https://github.com/coreplanelabs/switchboard/pull/26).) |
| 👀 reaction lands on acceptance, before the status card | `[agent]` Mention the bot; the 👀 reaction must appear on your message before/with the status card. (Mechanism validated 2026-08-21 with the original ☎️ emoji, [receipt](https://github.com/coreplanelabs/switchboard/pull/28#issuecomment-5375988280); emoji changed to 👀 — re-verify the glyph after the next deploy.) Without `reactions:write`, expect a `[ack] missing_scope` log line and otherwise unchanged behavior. |
| Trigger gating (no bot-loop, no un-mentioned top-level posts, no mention double-handling) | `[unit]` `src/channels/slack.test.ts::classifyMessage` + `::threadIncludesBot` — the gating decision is a pure exported function the Bolt handler calls. |
| Image passthrough within budgets (types, size, count, thread byte budget, login-page detection, failed downloads) | `[unit]` `src/channels/slack.test.ts::fetchImages` (stubbed fetch fixtures). Live spot-check remains: attach a PNG and ask "what does this show?". |
| Mention stripping | `[unit]` `src/channels/slack.test.ts::stripMention` |
| Display-name resolution: channel + user names resolved and cached (one API call per new id), display_name→real_name→name preference, API error → undefined without throwing, failure not cached | `[unit]` `src/channels/slack.test.ts::resolveChannelName / resolveUserName (best-effort, cached)::*` |
