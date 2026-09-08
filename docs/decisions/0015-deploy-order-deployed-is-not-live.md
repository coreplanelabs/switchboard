---
title: Releases deploy from CI in one fixed Worker order, and a deploy is done only when the new code is live
status: implemented
date: 2026-09-08
pattern: Derived, not declared
---

# Releases deploy from CI in one fixed Worker order, and a deploy is done only when the new code is live

## Context

Production is several Cloudflare Workers: a state Worker holding Durable Objects, the bot with its container, the resident Worker and the sandbox Worker. Deploying them from a laptop in whatever order came to mind produced two classes of incident. Deploying the bot before the state Worker had migrated was a live `500`, not a graceful degrade. And `wrangler deploy` returning success while the old container kept answering the health check for the whole drain meant "deployed" was routinely claimed minutes before the new code served anything.

## Decision

Merging the release PR tags the version and deploys production from CI. Nobody deploys routine releases from a laptop.

**Which Workers deploy is derived, not declared.** A PR body saying "bot deploy only" is a claim. The diff between what a Worker is serving and the release commit, mapped onto that Worker's real inputs (its bundle's import closure, its image's `COPY` sources, its production dependencies), is a fact. When derivation cannot be sure, the answer is the whole fleet, said out loud, never a silent skip.

**The order is fixed: state → bot → resident → sandbox.** The state Worker goes first because its Durable Object migrations must exist before the bot writes to them. Resident and sandbox come after the bot because they consume bearers the bot's configuration names, and a Worker deploy briefly swaps the isolate under any attach in flight.

**Deployed is not live.** After `wrangler deploy` the old container keeps answering `/healthz` while it drains. The bot step is done only when a non-draining container reports the deployed commit; a same-commit rollout additionally needs a `startedAt` later than the pre-upload reading, because the build commit cannot identify the new instance. A sandbox deploy is two artifacts, the Worker version uploaded at once and the container image rolled out afterwards, so it is live only when the Worker, the rollout and an `echo ok` probe agree.

Every Worker's `wrangler.jsonc` is rendered from the deployment profile, never written by hand. The same preflights and live gates run whether CI or an operator invokes `deploy all`.

## Consequences

- A release is one merge; the pipeline is the same commands an operator can run.
- The bot step used to wait for in-flight runs to reach zero before rolling over. With runs durable across containers ([0019](0019-durable-run-ledger-resume-after-kill.md)) that gate became a warning, and a release no longer waits on a busy bot.
- Derivation can over-approximate. A change to a shared module deploys every Worker that imports it, even when the runtime effect is nil.

## Alternatives rejected

- **Declaring deploy targets in the PR body.** A claim, not a fact.
- **Quiescing the bot to make a rollout safe.** Makes users wait for the deploy.
- **Hand-edited Worker configs.** Drift between environments that no check can see.

## Pattern

Derived, not declared. Each deploy step is measured as a span; the live gate is a readiness check on the new instance rather than on the upload.
