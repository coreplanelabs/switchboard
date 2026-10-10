---
title: The browser cutover keeps the current execution engine
status: accepted
date: 2026-10-10
pattern: Replace presentation and shared orchestration while preserving execution owners
---

# The browser cutover keeps the current execution engine

## Context

The recovered Browser Home plan assumes immutable plan digests and different
repositories for units in one pipeline. The current execution engine stores one
repository on the pipeline and retains its seeded dependencies. Implementing the
assumed model would change execution and migration authority.

## Decision

Replace the frontend and add organization orchestration against the current
execution engine. Keep durable pipelines, unit threads, rounds, original effect
owners, existing authorization and saved command confirmation. Describe legacy
plan provenance accurately. Do not add fictional digest or per-unit repository
fields to make the interface resemble an unimplemented model.

Defer immutable plan pinning and multi-repository execution to a separate
migration. Record 0077 continues to describe that destination; this decision
changes its delivery order. Supersede record 0070's per-person orchestrator and
plane-first navigation at cutover: the organization has one durable logical
identity, while private addressed streams and every act preserve their actual
requester and authority.

Home reads durable authorized work. One explicit destination controls replies.
Proof-based identity links join private streams without granting authority.
Execution continues through the dispatcher, original unit owners and common
confirmation store. A durable ingress receipt binds its original execution owner. An answer stays
an event on the original unit and creates no new model run. Uncertain effects
remain visible and never trigger a blind second dispatch.

Organization access uses the same policy table. Authenticated issuer membership
is a human fact; service credentials need an explicit organization scope and
action grant. Each delegated credential and principal must pass separately.
Account linking addresses only the authenticated human's exact identity, never
an alias or view-as target. Organization predicates cannot become run filters.

## Validation and boundary

Keep the replacement beside the current frontend until its authenticated paths
pass. Port the independent metrics dashboard through its existing route. Remove
the superseded frontend only after the combined candidate passes review and
staging acceptance. This decision authorizes neither production merge nor
production deployment.
