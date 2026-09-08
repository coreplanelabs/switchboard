---
title: The dashboard runs under a Content Security Policy that executes no inline script
status: implemented
date: 2026-09-08
pattern: Defense in depth
---

# The dashboard runs under a Content Security Policy that executes no inline script

## Context

Run pages render text that came from a model, from tool output and from other people's Slack messages. Any of it can be hostile. The earlier pages embedded their script and their data inline, which meant one escaping mistake anywhere was script execution in the operator's browser.

## Decision

Every HTML page ships the policy `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, together with `X-Frame-Options: DENY` and `Cache-Control: no-store`.

No inline JavaScript executes at all. The page's data crosses as a JSON island in a `type="application/json"` block, which is a non-executing data block the policy does not govern, and the serializer escapes every `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX` so hostile text can never close the island. The web app uses `v-html` nowhere; event summaries render as text bindings. Inline style attributes are allowed because the UI library positions floating elements that way. Same-origin connections only, for the event streams. A same-origin form page gets a variant with `form-action 'self'`; a post anywhere else is still blocked.

## Consequences

- Hostile content is data by construction; the browser refuses to run it even if an escaping bug slipped through.
- The one criterion the visibility spec enforces is that no inline script executes under the shell policy, and the test suite exercises it with hostile fixtures.
- Third-party scripts, analytics and embedded frames are impossible without changing the policy. That is intended.
- `style-src 'unsafe-inline'` is the one relaxation, forced by the component library; it permits style injection, not script.

## Alternatives rejected

- **Nonces or hashes for inline script.** Would allow inline script back into the pages; removing inline script entirely is simpler and stricter.
- **Sanitizing rendered HTML.** Sanitizers are where the bugs live; text bindings need none.

## Pattern

Defense in depth: escaping at the serializer, text-only rendering in the components, and a policy that would stop execution if both failed.
