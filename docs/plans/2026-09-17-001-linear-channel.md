---
title: Native Linear channel
type: feat
date: 2026-09-17
status: proposed
---

# Native Linear channel

## Outcome

An installed Switchboard app accepts delegated issues and mentions in Linear,
runs the existing dispatcher with the requesting person's authority, and keeps
the conversation, progress, clarification, stop controls and deliverables in
Linear. Slack and Linear use the same agents, providers, executors and policy.
Registration alone is not completion.

## Delivery sequence

1. OAuth installation with browser-bound, expiring, single-use state and PKCE;
   durable per-workspace credentials; refresh and revocation. Register the
   production callback `/oauth/linear/callback` and the same path on
   `http://localhost:8080` for local development.
2. Signed `/webhooks/linear` intake at the Worker, before container startup.
   Commit events before acknowledgement, deduplicate deliveries, acknowledge
   sessions within ten seconds and retain failed deliveries for retry.
3. A Linear `ChannelIO`: session-scoped history and namespaced identity,
   dispatch, status activities, final responses, errors, questions and stops.
   Keep the requesting user distinct from the OAuth app's API identity.
4. Channel-aware startup, directory composition and restart recovery. A Linear
   session remains addressable after a container roll. Follow-ups use the
   durable inbox; unrelated sessions on an issue do not share a conversation.
5. Issue actions, delegated-work listing, repository selection, attachments,
   subissues and linked pull requests. Preserve the human assignee. A finished
   session is distinct from an issue being Done; a PR awaiting review is not
   completed implementation. Existing command confirmations remain authorized
   and bound to their requesting person when rendered in Linear.
6. Deploy and install in the target workspace, then collect live receipts for
   each requirement below. Keep the goal open until those receipts exist.

## Acceptance ledger

All rows currently need implementation and live proof. Unit proofs belong in
`docs/reference/specs/linear-channel.md` as each behavior is built.

| Requirement | Required evidence |
|---|---|
| OAuth and local callback | Successful production and localhost installation; mismatched, expired and replayed state rejected; credentials absent from URLs/logs/browser responses |
| Delegation and mentions | A delegated issue and an issue comment mention each produce one authorized run and a response in the correct Linear session |
| Context and routing | Description, instructions, relevant history and attached files reach the selected agent; configured repository and model layers still apply |
| Progress and deliverables | Timely acknowledgement, progress, PR and run-page links, and final outcome visible inside Linear |
| Follow-up and clarification | Mid-run prompt reaches the existing run; answer to a question resumes the conversation; post-completion prompt starts the next turn |
| Stop and removal | Linear Stop aborts work; removing delegation or team access prevents further unauthorized work |
| Issue actions and queue | Read/update issues, create subissues, return files, and list issues delegated to the app without confusing delegate with assignee |
| Recovery | Duplicate webhook delivery causes no duplicate task; a container roll preserves prompts, context and the output destination; transient API failure retries |
| Authorization and privacy | An unauthorized requester/repository is refused; private team context and run history stay private; revoked installation cannot refresh or run |
| Additional mention surfaces | Document/project mentions tested explicitly; unsupported event shapes receive an honest response rather than silent success |
| Slack compatibility | Relevant existing Slack, dispatcher, authorization and recovery tests pass, followed by a live Slack smoke test |
| Operations | CI green, reviewed changes merged, deployed build identified, installation and smoke-test receipts recorded |

## Boundaries

Linear-specific API shapes stay under the channel adapter. Durable stores have
in-memory test and Worker implementations. Credentials remain outside agent
executors. The edge handles OAuth and incoming event durability; the existing
dispatcher remains the only place that starts an agent. Any extensions needed
by typed questions, session metadata or recovery are channel-neutral seams.

Sources: [Linear agent setup](https://linear.app/developers/agents),
[session protocol](https://linear.app/developers/agent-interaction),
[interaction guidance](https://linear.app/developers/agent-best-practices),
[signals](https://linear.app/developers/agent-signals),
[OAuth](https://linear.app/developers/oauth-2-0-authentication).
