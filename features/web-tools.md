# Web tools: URL reading + web search

Agents can read a web page the user links and search the web for current information — provider-agnostically, so the capability works on any configured model, not just those with a vendor-native web tool (Area 5 / R16, "Option B"). Two tools: `web_fetch` (read a URL) and `web_search` (find sources). Web search is a swappable seam (`WebSearch`) with ≥2 implementations (Brave adapter + Null), so a missing key degrades gracefully instead of breaking. Both do network I/O in the bot process — not through the Executor — so the no-repo `research` agent uses them with no workspace.

- **Code**: `src/tools/web.ts` (the `WebSearch` seam, `BraveWebSearch` + `NullWebSearch`, `makeWebCapability`, SSRF guards `assertUrlAllowed`/`assertResolvedIpsAllowed`/`ipInBlockedRange`, `webFetchTool`, `webSearchTool`); `src/tools/workspace.ts` (`ToolContext.web`, `TOOLSETS` wiring); `src/agents/registry.ts` (the `research` agent + `RESEARCH_SYSTEM`, `general` prompt points web asks at it); `src/core/dispatcher.ts` (injects `makeWebCapability(process.env)` into the tool context).
- **Tests**: `src/tools/web.test.ts`.

## Behavior

1. **URL reading is provider-agnostic and in-process** (Option B): `web_fetch` fetches an http(s) URL and returns its text (HTML is stripped to readable text), running in the bot process via an injected `web` capability — no Executor, no workspace. A no-repo agent can use it.
2. **web_fetch is SSRF-hardened**: only `http`/`https` schemes; literal internal addresses (loopback, `10/8`, `172.16/12`, `192.168/16`, link-local `169.254/16` incl. cloud metadata, ULA, IPv4-mapped IPv6) and internal hostnames (`localhost`, `*.local`, `*.internal`) are refused; hostnames are DNS-resolved and refused if any resolved IP is internal (DNS-rebinding guard); redirect targets are re-validated on every hop. Responses are size-capped (~1 MB) and time-bounded (~12 s); blocks/timeouts/HTTP errors return a clear message, never a crash.
3. **web_search is a seam with ≥2 implementations**: `WebSearch` has a real `BraveWebSearch` adapter (keyed by `BRAVE_SEARCH_API_KEY`) and a `NullWebSearch`. `makeWebCapability` selects Brave when the key is present, Null otherwise. With no key, `web_search` returns a clear "not configured" message (and notes URL reading still works) — it never breaks the run.
4. **Enablement matches R16**: `web_fetch` (URL reading) is in the `full` (coding) and `readonly` (review) toolsets — broadly available; `web_search` is gated to the `web` toolset, held by the research-capable agent. The tool-less `general` agent gets neither and stays fast.
5. **A dedicated `research` agent** (`toolset: "web"`, `resources.repo: "none"`) answers research/URL questions with search + fetch and no workspace; `general` directs web-shaped asks to `agent:research`.
6. **The capability is injected, not global**: the dispatcher builds `web` from `process.env` per run; when absent (e.g., a run that didn't inject it), the tools report themselves unavailable rather than throwing.

## Validation criteria

| Criterion | Evidence |
|-----------|----------|
| web_fetch reads a public URL and returns its text; HTML is stripped | `[unit]` `src/tools/web.test.ts::web_fetch tool::fetches a public URL and returns its text`, `::strips HTML to readable text` |
| SSRF: non-http(s) schemes and literal internal IPs/hosts refused without fetching | `[unit]` `::web_fetch tool::refuses SSRF targets without ever fetching`; `::assertUrlAllowed::rejects non-http(s) schemes`, `::rejects internal hosts and literal internal IPs`; `::ipInBlockedRange::flags loopback/private/link-local/metadata/ULA`, `::allows public addresses` |
| SSRF: DNS-rebinding (hostname → internal IP) refused | `[unit]` `::web_fetch tool::refuses DNS-rebinding: hostname resolving to an internal IP` |
| SSRF: redirect targets re-validated; internal redirect refused, public redirect followed | `[unit]` `::web_fetch tool::re-validates redirect targets and refuses an internal redirect`, `::follows a redirect to an allowed URL` |
| Oversized/timeout/HTTP-error handled gracefully | `[unit]` `::web_fetch tool::truncates oversized responses`, `::reports a timeout gracefully`, `::reports non-2xx status` |
| web_search formats seam results; missing key degrades gracefully | `[unit]` `::web_search tool::formats results from the search seam`, `::degrades gracefully when search is not configured`, `::handles empty query and missing capability`, `::reports a generic search failure` |
| Brave adapter calls the API correctly and parses results; ≥2 impls selectable | `[unit]` `::BraveWebSearch adapter::calls the Brave API with the key header and parses results`, `::throws on non-200`; `::makeWebCapability::selects Brave when a key is present, Null otherwise`, `::NullWebSearch throws WebSearchUnavailableError` |
| Enablement: web_fetch broad, web_search gated to research; general stays tool-less | `[unit]` `src/tools/web.test.ts::toolset + agent wiring::*` |
| Live: `agent:research` answers a question / summarizes a URL end-to-end | `[agent]` (post-deploy) — pending; requires the bot deployed. `web_search` half also needs `BRAVE_SEARCH_API_KEY` provisioned (deferred). |
