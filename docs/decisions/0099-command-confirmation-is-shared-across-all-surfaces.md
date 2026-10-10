---
title: One confirmation policy for every command surface
status: accepted
date: 2026-10-09
pattern: One command policy with thin consent adapters
---

# One confirmation policy for every command surface

## Context

Prose commands used durable offers, while direct MCP command tools invoked the registry without that gate. The browser also confirmed by pasting a line. These paths could apply different consent rules to the same operation. A verified person's implicit personal rights cannot be represented by intersecting action grant sets alone.

## Decision

Enforce confirmation after authorization and parsing in `CommandRegistry.invoke`, before any handler. Command metadata and the existing scoped confirmation class determine the requirement. Adapters supply verified identity, display and user input. They never decide which operation requires consent. The operator supplies its saved source dependencies and uses the same command admission path.

Reuse the existing durable confirmation table and shared click executor. Store normalized input, immutable requester/connection and repository context. Atomic consumption supplies one exact permit, not a reusable boolean. Expiry, cancellation, replay refusal and current permission/context checks remain in the common path. Existing admitted row shapes remain readable.

Use the maintained official MCP SDK for current URL elicitation and legacy stateless JSON serving. Client acceptance opens the browser interaction; only authenticated same-origin browser consent approves it. An unsupported client receives a usable link and saved-id continuation, or an explicit refusal before effects. No custom MCP session manager or second approval store is added.

A verified personal credential must satisfy the same policy table as its user and its delegated connection. Compile that conjunction for list reads as well. Keep explicit repo-memory ownership separate from code access and retain credential-owned history aliases. The browser fixes a personal credential's canonical user; model names and email claims cannot establish that identity.

Existing local CLI operator authority and named schedule grants are standing consent, bounded by normal authorization. Commands may require a fresh confirmation with `always`; non-destructive owner-bounded controls such as steering declare their existing scoped consent. No new grant wildcard is needed.

## Evidence and boundary

The command-registry, authorization, MCP-ingress and web-chat specs contain the local proofs. They cover common admission, native SDK auto-accept refusal, browser confirm/cancel, requester/client mismatch, changed arguments, role revocation, concurrency, restart and uncertain-result replay refusal. These are hermetic source proofs, not production acceptance. A person merges; release and deployment remain separate.
