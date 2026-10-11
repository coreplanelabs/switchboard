---
title: Ordinary MCP confirmation uses the client form
status: accepted
date: 2026-10-10
pattern: One consent policy with native host input
---

# Ordinary MCP confirmation uses the client form

## Context

[Record 0099](0099-command-confirmation-is-shared-across-all-surfaces.md) unified command admission, but required an authenticated browser for every MCP confirmation. That protected against automatic client acceptance at the cost of making an ordinary client confirmation an external interaction. MCP provides form elicitation for client input and URL elicitation for external authentication or sensitive information.

## Decision

This record supersedes only record 0099's browser-only MCP consent clause. Its shared registry gate, durable table, verified personal delegation, frozen input/context, current authorization and atomic one-use execution remain. [Record 0007](0007-authorization-policy-table.md) remains the single authorization table. [Record 0044](0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md) retains command-declared risk, the graded boundary and the organization floor that lower scopes cannot loosen.

Use the maintained SDK's form elicitation for ordinary personal MCP confirmations. The exact saved offer id is opaque request state; requester, credential and original tool/argument hash must match. The host returns a schema-valid approve/cancel response outside ordinary tool arguments. The store accepts form consent only for a server-minted form challenge. A capability claim, a prose yes, a confirm boolean or calling the continuation tool cannot create consent.

Recorded consent is transport-neutral. Older browser-approved rows remain readable. Already-approved exact actions resume directly, still subject to current permissions and context. Standing consent remains server-issued and cannot override always-confirm metadata. Clients unable to display form input receive a named refusal before a new offer, while permitted reads/routine writes continue normally.

The authenticated MCP host owns the human interaction or its prior approved interaction scope. Its response is not cryptographic proof that a person clicked. The server independently enforces rights, exact targets and replay protection. Host tool-allow settings alone do not disable server consent policy. Browser connection setup, OAuth and retained browser forms remain separate.

## Evidence and boundary

The MCP-ingress spec covers accept, cancel, unsupported hosts, invalid content, target/connection mismatch, revoked user/credential rights, concurrency, restart and legacy browser rows. The existing Memory Worker SQLite test proves consent provenance and atomic consumption. These are isolated source proofs; live client, staging, release and production validation remain separate. Organization-native admission and source ownership stay with their existing implementation; its integration uses the same consent predicate.

## Sources

- [MCP elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).
- [MCP request-state and replay requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr).
- [Codex client elicitation](https://learn.chatgpt.com/docs/app-server).
