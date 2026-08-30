# Channel-agnostic output formatter

Agents stop guessing a channel's markup. Instead of the model emitting a
channel-*formatted* string (the old prompts said "use Slack-friendly formatting
`*bold*`, no headers, …" — fragile and wrong across channels), the answer becomes
a **channel-agnostic structured representation** (blocks), and each channel owns a
**formatter** that renders that structure to its own guaranteed-correct format.
The model's structured output is **zod-validated with a fixed-retry self-heal
loop** before any formatter runs, so malformed output is corrected — or safely
degraded — instead of shipped.

- **Code**: `src/core/structuredMessage.ts` (schema + `ChannelFormatter` seam + `PlainTextFormatter`), `src/core/structuredOutput.ts` (validation + fixed-retry self-heal + provider-backed producer), `src/channels/slackFormatter.ts` (`SlackFormatter`), `src/channels/slackEscape.ts` (shared mrkdwn escaping/encoding), wiring in `src/core/dispatcher.ts` (`sendAnswer`) and each adapter (`src/channels/slack.ts`, `src/cli.ts`, `src/channels/http.ts`, `src/channels/mcp.ts`).
- **Docs**: [AGENTS.md invariants 1 & 2](../AGENTS.md), [routing-and-config.md](routing-and-config.md), [issue #76](https://github.com/coreplanelabs/switchboard/issues/76).
- **Tests**: `src/core/structuredMessage.test.ts`, `src/core/structuredOutput.test.ts`, `src/channels/slackFormatter.test.ts`, `src/core/dispatcher.test.ts`.
- **Receipts**: https://github.com/coreplanelabs/switchboard/issues/226

## Behavior

1. **Structured message schema (zod).** The minimal channel-agnostic shape that
   covers today's messages: an ordered, non-empty list of blocks, each one of
   `heading` · `paragraph` · `bullets` (items) · `code` (code + optional
   language) · `link` (url + optional text) · `status` (state
   `ok|warn|error|info` + text; covers review verdicts). A discriminated union on
   `type`, so an unknown block type is rejected with a legible error. Every block
   object **and** the root are `.strict()`: an unknown/extra key is **rejected**,
   not silently stripped, so the self-heal loop gets corrective feedback on a
   misnamed field (e.g. `txt` for `text`). Sane **upper bounds** reject
   pathological input (→ self-heal, then fallback) rather than accept it: any
   text/code/label string ≤ 12000 chars, a code fence's `language` tag ≤ 40 (a
   short identifier, not prose), url ≤ 2048, ≤ 100 bullet items, ≤ 50 blocks.
2. **`ChannelFormatter` seam — ≥2 implementations** (invariant 2).
   `format(message) → native payload string`.
   - `SlackFormatter` (structured → Slack mrkdwn): headings → `*bold*` (Slack has
     no headers), bullets → `•`, links → `<url|text>`, code → a bare fence (Slack
     fences take no language tag), status → ✅/⚠️/❌/ℹ️. Lives in `src/channels/`
     (invariant 1: no platform formatting in the core). **All record content is
     escaped before it lands in mrkdwn structural syntax** (shared helpers in
     `src/channels/slackEscape.ts`, reused by `mdToMrkdwn`'s link rendering):
     - **Text fields** (heading, paragraph, bullet items, status text, link
       label) → `escapeMrkdwn`: `&`→`&amp;` first, then `<`→`&lt;`, `>`→`&gt;`
       (Slack's own rule). This neutralizes injected `<!channel>` broadcasts,
       `<@U…>` mentions, and forged `<url|label>` links — they become inert
       visible text.
     - **Link url** → `encodeMrkdwnUrl`: percent-encode only `<`→`%3C`, `>`→`%3E`,
       `|`→`%7C`. HTML-escaping the url would corrupt the address; percent-encoding
       stops the url forging a second `|` separator or breaking out of `<…>`, and
       Slack decodes it back when opened.
     - **Code** → `neutralizeCodeFence`: a zero-width space after every backtick,
       so embedded ```` ``` ```` can't close the outer fence early and leak the
       rest as live mrkdwn.
   - `PlainTextFormatter` (structured → plain text) for CLI/HTTP/MCP, and the
     core's default when a channel declares no formatter. (No escaping needed —
     plain text has no structural syntax to inject into.)
3. **Validation + fixed-retry self-heal.** The model's structured output is
   parsed (JSON string or object; a stray ```` ```json ```` fence is tolerated)
   and zod-validated. On failure the specific error is fed back and the model is
   re-asked — a **fixed** `MAX_STRUCTURE_RETRIES = 2` times (total 3 attempts),
   **not exponential backoff** (this is a formatting correction, not a contended
   resource). After exhaustion it **falls back gracefully** to a plain-text
   render of the raw answer plus a logged warning — the run never fails over
   formatting.
4. **Flag-gated** (`output.structured`, default **false**). Off → the Markdown
   answer is converted by `mdToMrkdwn` and sent via `io.reply` with **no** extra
   model call. This default path is fully injection-safe too: `mdToMrkdwn`
   escapes **all prose** (`&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `&` first) —
   including the content inside inline code and code fences — so a bare
   `<!channel>`/`<@U…>`/forged `<url|label>` in the agent's answer becomes inert
   visible text. Only the structural syntax `mdToMrkdwn` itself produces is
   exempt from that escape: generated `<url|label>` links (label `escapeMrkdwn`'d,
   url `encodeMrkdwnUrl`'d but keeping its literal `&` for query params), image
   URLs (also `encodeMrkdwnUrl`'d so an image url of `<!channel>`/`<@U…>` can't
   reach Slack as a live broadcast/mention), and leading blockquote `>` markers
   are stashed before the escape pass and restored after, so they stay functional
   and are never double-escaped. The stash/restore placeholders are private-use
   sentinels (U+E000–U+E003); the raw input is stripped of those chars before any
   stashing, so agent-controlled text carrying them can't collide with a real
   placeholder (which would otherwise throw or cross-splice on restore). On →
   `dispatch` runs the structuring pass and routes the result through the
   channel's `formatter` + `sendFormatted` (Slack posts the mrkdwn verbatim
   rather than re-running the Markdown→mrkdwn converter).

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
  adapter (not through the block schema); only the final reply is *structured* so
  far. Its Block Kit `mrkdwn` **is** now escaped, though: `render()` runs
  `escapeMrkdwn` over both `frame.title` (the run label) and `frame.detail` (tool-
  output summaries + the agent's free-text `update_status`) before they reach the
  `mrkdwn` text fields and the top-level `text` fallback. With the default
  `mdToMrkdwn` reply path now escaping prose too, the injection class
  (`<!channel>`/`<@U…>`/forged `<url|label>`) is closed across **all** of the
  bot's Slack output paths — the structured `SlackFormatter`, this status card,
  and the default reply. The raw detail is sliced to a
  conservative length **before** escaping (escaping can expand up to 5×) and the
  escaped result is hard-capped, so it always stays under Slack's ~3000-char
  section limit.
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
| Strict schema rejects an unknown key in a block and at the root (self-heal feedback, not silent strip) | `[unit]` `src/core/structuredMessage.test.ts::…::rejects an unknown key inside a block (strict) / rejects an unknown top-level key (strict root)` |
| Upper bounds reject an oversized bullets array, an oversized string, and too many blocks | `[unit]` `src/core/structuredMessage.test.ts::…::rejects an oversized bullets array… / rejects an oversized string… / rejects too many blocks…` |
| `SlackFormatter` escapes untrusted content: `<!channel>`/`<@U…>`/`<`,`>`,`&` in text neutralized; link url percent-encoded so its `\|` can't forge a separator; code with embedded ```` ``` ```` can't close the outer fence | `[unit]` `src/channels/slackFormatter.test.ts::SlackFormatter::escapes untrusted content (no injection)::*` |
| Status card `render()` escapes `frame.title` + `frame.detail` (`<!channel>`/`<@U…>`/`<url|label>` neutralized in the block `mrkdwn` and the top-level `text`); intentional `*bold*`/`` `code` `` in the title survives; escaped detail stays under Slack's ~3000 section cap for adversarial input | `[unit]` `src/channels/slack.test.ts::render (status card mrkdwn escaping)::*` |
| Code fence `language` bounded to ≤ 40 chars (rejects 41, accepts 40); link url bound proven at the edge (rejects 2049, accepts 2048) | `[unit]` `src/core/structuredMessage.test.ts::…::rejects a code block with an oversized language… / accepts a code block with a language at the bound… / rejects a link url over 2048 chars…` |
| `mdToMrkdwn` link rendering escapes label + percent-encodes url (same gap, shared helpers) | `[unit]` `src/channels/mrkdwn.test.ts::mdToMrkdwn::escapes link labels and percent-encodes urls…` |
| Default `mdToMrkdwn` reply path escapes **prose** (`<!channel>`/`<@U…>`/`<`,`>`,`&` neutralized) while preserving every structural conversion: generated link url keeps its literal `&` and encodes `<>|`, bold/blockquote markers survive, no double-escape | `[unit]` `src/channels/mrkdwn.test.ts::mdToMrkdwn::escapes bare <!channel>… / preserves a generated link url's literal &… / percent-encodes a generated link url's structural chars… / escapes injected angle brackets inside a bold span… / escapes bare & < > in plain prose… / keeps a leading blockquote marker…` |
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
