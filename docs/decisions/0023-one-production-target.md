---
title: Cloudflare is the one supported production target; docker compose is the local loop
status: accepted
date: 2026-09-09
pattern: One way to do it
---

# Cloudflare is the one supported production target; docker compose is the local loop

## Context

The bot is an ordinary container, and Socket Mode is outbound-only, so the process can run anywhere that runs a container. For a while the tree said so in three forms at once: a Cloudflare deployment with its own Workers, a Fly.io machine config, and a compose file offered as "any VPS". Each was a claim that the product supported that host. Only the Cloudflare path had a deploy runner, a secrets path, preflights, a live gate, a release workflow and pages that described them; the other two had a config file and a paragraph.

Everything the product does beyond answering in Slack — durable config and run history, resident repositories, per-thread sandboxes, an identity gate in front of the dashboards, a docs site — is a Cloudflare Worker. A bot on another host runs with every one of those capabilities off. Offering that as a peer of the full deployment described a product that does not exist.

## Decision

Cloudflare is the one supported production target. The deploy tooling (`deploy init`, `deploy secrets`, `deploy config`, `deploy all`), the release workflow, the secrets manifest and the operator pages describe it and nothing else.

`docker-compose.yml` stays as the local loop: the same image on a dev box, or on one host a single trusted operator administers, with the optional capabilities off. It is documented as that, never as a production option.

No other host's configuration lives in the tree. The image runs elsewhere, and the docs say what any host must provide, but nothing is built or tested for it.

## Consequences

- One deploy path to keep correct, test and document; the deploy classifier, the manifest and the pages have one shape to agree on.
- An operator who wants another host is told plainly that they are on their own, instead of finding a config file that implies support.
- A capability an operator wants that lives in a Worker has one answer: deploy that Worker.
- The Fly.io config was removed rather than kept as an example, because a checked-in config is a claim the tooling does not back.

## Alternatives rejected

- **Several supported hosts.** Each multiplies the runner, the secrets path, the preflights and the docs, for no installation that exists.
- **A platform-neutral deploy abstraction.** The Workers are not portable; abstracting the one long-lived container would leave every capability behind.
- **Keeping the Fly.io file as a reference shape.** A config file in the tree reads as supported however it is labelled.

## Pattern

One way to do it: a single supported path, and the tree carries nothing that suggests a second.
