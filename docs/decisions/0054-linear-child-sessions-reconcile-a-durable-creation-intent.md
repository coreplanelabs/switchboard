---
title: Linear child sessions reconcile a durable creation intent
status: implemented
date: 2026-09-17
pattern: Durable intent and reconciliation before retrying an external effect
---

# Linear child sessions reconcile a durable creation intent

The shared dispatcher opens a separate channel conversation for child work.
Linear can create a native agent session on a root comment, but its public
session-creation input has no caller-supplied id. Repeating that mutation after
a lost response could create another session. Its creation webhook could also
start the same child again if treated as a new human request.

The adapter records an intent before writing the comment. The intent binds a
comment UUID to the installation, parent session, human requester, issue and
lead. The comment mutation uses that UUID. A durable atomic claim permits only
one session-creation attempt; retries read the comment's associated session.
An uncertain result stays explicit until that observation resolves it. There
is no automatic second session-creation attempt.

A coordinator supplies a stable channel idempotency key for its thread-opening
step. Linear derives the comment UUID from that key, requester and parent;
ordinary child opens use a fresh UUID. Reusing a key with a different lead or
identity fails. Other adapters may ignore this optional channel capability.

Session reads recognize a managed child through the durable intent and the
app-owned comment in the current installation and issue. Intake consumes that
session's creation notification without dispatching it. The original caller
alone starts the child through the shared dispatcher; later human prompts and
Stop use normal intake, fresh access checks and authorization.

This costs one durable record per child conversation and an observation query
when creation is retried. A crash before an unkeyed caller receives the child
can leave a visible conversation without a run; it must not be silently
reexecuted. Coordinators can reconcile their keyed steps after a restart.
Record pruning must preserve live/retryable conversations and is future work.

Rejected: treating app-created webhooks as commands under the app's authority;
that loses the human requester and creates a second orchestrator. Also rejected:
blindly repeating session creation, or trusting a marker in comment text as
proof that a session belongs to an internal child.

Sources: [native sessions](https://linear.app/developers/agent-interaction) and
the public [GraphQL schema](https://raw.githubusercontent.com/linear/linear/refs/heads/master/packages/sdk/src/schema.graphql),
including `CommentCreateInput`, `AgentSessionCreateOnComment` and `Comment.agentSession`.
