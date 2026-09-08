---
title: Residents hold their own GitHub credential; the bot never holds a repo-write token
status: implemented
date: 2026-09-08
pattern: Trust boundary per plane
---

# Residents hold their own GitHub credential; the bot never holds a repo-write token

## Context

A resident is a long-lived checkout of a repository, running as a Durable Object with a container, where an agent can attach, run commands and push branches. The bot that talks to Slack is the control plane: it holds the Slack token and the model key and decides what runs. If the bot also held a credential that could push to every repository, then compromising the chatty process would be a way to push code anywhere.

## Decision

Execution and trust are three planes. The bot plane holds no repo-write credential when execution is sandboxed or resident. The resident Worker is a second credential domain: it holds its own GitHub App private key in its own secrets and mints its own short-lived, repo-scoped installation tokens, scoped to exactly the repository being checked out for exactly the duration of one attach. The resident Worker also has its own bearers (`RESIDENT_ADMIN_TOKEN`, `RESIDENT_OPERATOR_TOKEN`), distinct from every bearer the bot holds.

Residency is a generic resource-typed primitive, `<type>:<id>`, with `repo:<owner>/<name>` as the first and so far only type, and the Durable Object's name is the resource id.

## Consequences

- Compromising the bot yields a chatty assistant, not a path to push code.
- The two App credentials authenticate as the same GitHub App but are two secrets, so rotating the bot's key does nothing for the resident's. Both must be rotated, and the operations guide says so.
- The sandbox path still receives a bot-minted, toolset-scoped token per call, so "the bot holds no GitHub token" is true only for the resident path. The topology explanation has to state this precisely.
- Per-repo scoping was a hard prerequisite: no resident executes untrusted repository code until its token can reach only that repository.

## Alternatives rejected

- **Sharing the bot's App key with the resident Worker.** One secret, one rotation, and one compromise reaching both planes.
- **Long-lived per-repo tokens.** Simpler than minting per attach, but a token that survives the attach is a token that can be exfiltrated from a checkout.

## Pattern

Least privilege and blast-radius containment through a trust boundary per plane. Capability-style tokens scoped to one resource for one attach.
