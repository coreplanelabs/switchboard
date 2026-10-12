---
title: Rebuild modes and exact operation termination share existing recovery
status: proposed
date: 2026-10-11
pattern: Explicit destructive mode and original-runtime process capability
---

# Rebuild modes and exact operation termination share existing recovery

## Context

A snapshot rebuild deliberately keeps thread bindings and stored operation evidence. Clearing all resident state required a separate offboard and onboard, with registration settings copied by the operator. A saved operation with unknown outcome can also block deployment after its run ends. [Record 0101](0101-native-operation-recovery-requires-the-original-process-receipt.md) added its original process identity and exact-result recovery; an active original process still needed a supported termination action.

## Decision

Keep one `repo rebuild` command. Its default repairs the container and snapshot while retaining bindings and operation records. Explicit `--full` keeps the registry settings but reuses confirmed teardown before reprovisioning, deleting resident workspaces, bindings, operation records and backups. Both modes support a deletion plan. Full rebuild refuses active requests, active lifecycle cycles and incomplete cleanup. A reset is not evidence of an earlier operation's successful result.

Extend the existing exact-operation recovery route with an explicit `terminate` option. Compare the original journal hash, process ID, PID, start time and current owner before admitting a kill. Persist a separate control receipt before invoking the SDK process capability. That capability is bound to its existing runtime incarnation; it cannot wake a replacement or signal an unrelated reused PID. Persist acknowledged or unknown control outcomes, and refuse another termination request for the same identity after an uncertain reply. Read-only recovery can later archive the original terminal result. Opaque effects and legacy identities remain unsupported.

Deployment readback includes bounded stored operation identities and recovery reasons. Its safety decision remains unchanged. Native control failures expose a bounded error class and code without storing commands, output or credentials.

## Consequences

No new scheduler, credentials, policy grants or automatic reset is introduced. The full mode uses a dedicated Worker route so an old Worker cannot silently perform a less complete rebuild. Repository configuration stays durable if teardown or reprovisioning fails. A confirmed process kill still requires its terminal result before journal settlement and establishes no task verdict or remote-effect outcome.

## Proofs

The [Resident spec](../reference/specs/resident-repos.md) binds full rebuild, exact termination, uncertainty, metadata readback and original-owner refusals to targeted command and Worker tests. Deployment and live process-control proof remain separate.
