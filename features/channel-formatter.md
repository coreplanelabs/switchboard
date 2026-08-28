# Channel-agnostic output formatter

Agents stop guessing a channel's markup. Instead of the model emitting a
channel-*formatted* string (the old prompts said "use Slack-friendly formatting
`*bold*`, no headers, …" — fragile and wrong across channels), the answer becomes
a **channel-agnostic structured representation** (blocks), and each channel owns a
**formatter** that renders that structure to its own guaranteed-correct format.
The model's structured output is **zod-validated with a fixed-retry self-heal
loop** before any formatter runs, so malformed output is corrected — or safely
degraded — instead of shipped.

- **Code**: `src/core/structuredMessage.ts` (schema + `ChannelFormatter` seam + `PlainTextFormatter`), `src/core/structuredOutput.ts` (validation + fixed-retry self-heal + provider-backed producer), `src/channels/slackFormatter.ts` (`SlackFormatter`), wiring in `src/core/dispatcher.ts` (`sendAnswer`) and each adapter (`src/channels/slack.ts`, `src/cli.ts`, `src/channels/http.ts`, `src/channels/mcp.ts`).
- **Docs**: [AGENTS.md invariants 1 & 2](../AGENTS.md), [routing-and-config.md](routing-and-config.md), [issue #76](https://github.com/coreplanelabs/switchboard/issues/76).
- **Tests**: `src/core/structuredMessage.test.ts`, `src/core/structuredOutput.test.ts`, `src/channels/slackFormatter.test.ts`, `src/core/dispatcher.test.ts`.

## Behavior

1. **Structured message schema (zod).** The minimal channel-agnostic shape that
   covers today's messages: an ordered, non-empty list of blocks, each one of
   `heading` · `paragraph` · `bullets` (items) · `code` (code + optional
   language) · `link` (url + optional text) · `status` (state
   `ok|warn|error|info` + text; covers review verdicts). A discriminated union on
   `type`, so an unknown block type is rejected with a legible error.
2. **`ChannelFormatter` seam — ≥2 implementations** (invariant 2).
   `format(message) → native payload string`.
   - `SlackFormatter` (structured → Slack mrkdwn): headings → `*bold*` (Slack has
     no headers), bullets → `•`, links → `<url|text>`, code → a bare fence (Slack
     fences take no language tag), status → ✅/⚠️/❌/ℹ️. Lives in `src/channels/`
     (invariant 1: no platform formatting in the core).
   - `PlainTextFormatter` (structured → plain text) for CLI/HTTP/MCP, and the
     core's default when a channel declares no formatter.
3. **Validation + fixed-retry self-heal.** The model's structured output is
   parsed (JSON string or object; a stray ```` ```json ```` fence is tolerated)
   and zod-validated. On failure the specific error is fed back and the model is
   re-asked — a **fixed** `MAX_STRUCTURE_RETRIES = 2` times (total 3 attempts),
   **not exponential backoff** (this is a formatting correction, not a contended
   resource). After exhaustion it **falls back gracefully** to a plain-text
   render of the raw answer plus a logged warning — the run never fails over
   formatting.
4. **Flag-gated** (`output.structured`, default **false**). Off → the Markdown
   answer is sent verbatim via `io.reply`, exactly as before (zero behavior
   change, and **no** extra model call). On → `dispatch` runs the structuring
   pass and routes the result through the channel's `formatter` +
   `sendFormatted` (Slack posts the mrkdwn verbatim rather than re-running the
   Markdown→mrkdwn converter).

## Deferred (documented, not built here)

This PR lands the seam, schema, validation/retry infrastructure, and both
formatters behind the flag. Not yet done:

- **Native structured emission from the agent loop.** Today the flag-on path adds
  a constrained *structuring pass* (a second model call that converts the agent's
  free-form answer to the schema). The larger follow-up is to have the runner
  emit the structured message directly and remove the channel-formatting
  instructions from agent prompts (the issue's end state). The retry/self-heal
  infrastructure is built to serve that path unchanged.
- **The status card** still renders via `StatusUpdate`/`render()` in the Slack
  adapter; only the final reply is structured so far.
- **Slack Block Kit payloads.** `ChannelFormatter.format` returns a string
  (mrkdwn) for now; a richer `object[]` Block Kit payload is future work.
- **Rich inline spans** (bold/italic *inside* a paragraph). Paragraph text is
  plain; emphasis is expressed structurally (headings, status) for now.
- **Discord and other adapters**: a Discord formatter is the natural third
  implementation once that channel exists.

## Validation criteria

| Criterion | Proof |
|---|---|
| Schema accepts the full block set; rejects unknown type, empty blocks, missing blocks, empty text, empty bullets, bad URL, out-of-set status, non-object | `[unit]` `src/core/structuredMessage.test.ts::validateStructuredMessage (zod schema)::*` |
| `PlainTextFormatter` renders every block type (and multi-block separation) | `[unit]` `src/core/structuredMessage.test.ts::PlainTextFormatter::*` |
| `SlackFormatter` renders every block type to correct mrkdwn (≥2 impls exercised) | `[unit]` `src/channels/slackFormatter.test.ts::SlackFormatter::*` |
| Fixed-retry loop: first-try success; fails schema N times then succeeds; feeds the error back on each re-ask | `[unit]` `src/core/structuredOutput.test.ts::produceStructured (fixed-retry self-heal)::*` |
| Graceful fallback to plain text after the fixed budget is exhausted (+ warning); default N honored; thrown attempts retried | `[unit]` `src/core/structuredOutput.test.ts::produceStructured (fixed-retry self-heal)::falls back… / honors the default… / treats a thrown producer error…` |
| Parse tolerates JSON string, a ```` ```json ```` fence, and reports bad JSON without throwing | `[unit]` `src/core/structuredOutput.test.ts::parseStructured::*` |
| Provider-backed producer uses the structuring system prompt and threads feedback into the re-ask | `[unit]` `src/core/structuredOutput.test.ts::providerProducer::*` |
| Flag OFF (default) → answer sent verbatim, no structuring model call (identical to today) | `[unit]` `src/core/dispatcher.test.ts::structured output (channel formatter, #76)::flag OFF (default)…` |
| Flag ON → answer routed through the channel formatter + `sendFormatted` | `[unit]` `src/core/dispatcher.test.ts::structured output (channel formatter, #76)::flag ON: routes…` |
| Flag ON → graceful fallback (no crash) when the model never returns valid JSON | `[unit]` `src/core/dispatcher.test.ts::structured output (channel formatter, #76)::flag ON: falls back…` |
| Live end-to-end structured output on Slack (structuring pass renders correctly in a real thread) | `[gap]` Enable `output.structured` on a deployment and mention the bot; confirm the reply renders correctly with no raw JSON and no double-converted markup. |
