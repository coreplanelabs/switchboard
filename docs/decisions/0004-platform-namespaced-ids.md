---
title: Every identity is a platform-namespaced id
status: implemented
date: 2026-09-08
pattern: Namespaced principal identifiers
---

# Every identity is a platform-namespaced id

## Context

Configuration scopes, grants and memory all key on who or where a request came from. Slack user and channel ids are opaque strings that look nothing like a Cloudflare Access subject, an HTTP bearer's name or a schedule. If each surface passed its raw native id into the core, a rule written for one surface would silently match or miss on another, and every store would need to know which platform an id came from.

## Decision

Ids carry their platform as a prefix, and that prefixed string is the one identity every later decision keys on:

| Prefix | Meaning |
|---|---|
| `slack:U…`, `slack:C…`, `slack:C…:<ts>` | Slack user, channel, thread |
| `http:<subject>`, `http:<channel>`, `http:<channel>:<thread>` | HTTP ingress caller and its channel / thread |
| `mcp:<subject>` | MCP caller |
| `access:<sub>`, `access:svc:<common_name>` | Cloudflare Access user and service token |
| `cli:local` | the local CLI |
| `schedule:<name>`, `agent:<name>` | a schedule or agent acting as a principal |

Grants in configuration, per-user and per-channel config scopes, thread stickiness and memory scopes (`user:slack:U…`, `channel:slack:C…`) all use these ids. A new adapter brings its own prefix and nothing else changes.

## Consequences

- One resolver reads grants for an id, so two surfaces resolving the same person get the same permissions.
- Adding user, channel and repo scopes to memory was a change to the scope derivers, not to the store's schema, because the key shape was already there.
- The HTTP ingress mirrors Slack's `channel` and `thread` shape rather than inventing its own, so everything that works per thread on Slack works per thread over HTTP.
- Ids are strings everywhere, so nothing in the type system stops a caller from passing a bare `U0123`. The adapters are the only place raw ids exist, and tests on each adapter pin the prefix.

## Alternatives rejected

- **Raw platform ids with a separate `platform` field.** Two fields to keep together in every store, every rule and every log line.
- **Internal numeric ids with a mapping table.** A mapping store that every surface must consult before it can do anything, for no benefit the prefix does not already provide.

## Pattern

A rules table over namespaced principals. The id is the correlation identifier that ties a request together across surfaces and stores.
