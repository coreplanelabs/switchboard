---
title: Native operation recovery requires the original process receipt
status: proposed
date: 2026-10-11
pattern: Original-owner journal and compare-and-swap settlement
---

# Native operation recovery requires the original process receipt

## Context

The deploy fence in [record 0086](0086-deploy-fence-separates-execution-from-workspace-retention.md) distinguishes retained workspaces from executing or unknown work. [Record 0095](0095-identity-allocation-is-separate-from-active-work.md) retains native-operation holds after an isolate reset. Those holds previously contained only an owner. The caller could acknowledge completion, but a later operator could not identify or confirm the original native process.

[Record 0090](0090-one-unit-lifetime-keeps-effects-and-settlement-under-existing-owners.md) keeps uncertain effects and settlement with the original owner. A new controller, expired marker, ended run or empty process listing cannot supply that owner's missing outcome.

## Decision

Reuse the existing Resident journal and admin/read permission seam. Thread and disposable operator requests share one closure path. The durable pending-attempt set replaces the separate in-memory native echo counter, so admission and recovery use one source of truth. Persist each native admission before submission. For acknowledged process launches, retain only the SDK process identity: ID, PID and start time from the original runtime-bound process handle. The pinned SDK can retrieve that process and report the complete supervised process group's terminal status without executing its command again. Store no commands, output or credentials.

A bounded read-scoped inventory reports exact record hashes and available identities using DO storage only. Explicit admin recovery reads original native process statuses. Every outstanding admission must have a matching terminal result. The final DO transaction compares the exact original record and current owner, archives the original record with the receipt, and removes only its unresolved entry. Future admissions against the removed or closed record refuse. A changed record or owner, an active request, incomplete status or unreadable native result leaves the record held. Neither the native receipt nor recovery credits a run verdict or discards a workspace.

Keep non-process admissions opaque. In particular, publication's existing separate hold remains unresolved after an uncertain remote effect even when its shell process ended. A file-write reply is not replaced by a process receipt.

## Consequences

- No new result service, scheduler, lifecycle controller, grants or automatic recovery is introduced.
- Recovery can settle a lost collection reply when the original process identity was recorded, including after an isolate restart.
- A lost launch acknowledgement, lost identity observation, legacy record or retired runtime without an original terminal result remains unknown. There is no blind acknowledgement or replay path.
- Original identity observation adds one SDK status read to each scoped process launch. Reads without a request scope do not pay this cost.
- Existing deploy and workspace preservation checks remain. Installing this capability is a separate deployment; it does not resolve a live legacy blocker.

## Alternatives

A native-side result protocol would cover more launch-loss cases, but the pinned exec API does not accept a caller-selected process ID. Building another execution protocol now duplicates the SDK. Replaying the command, guessing from age or clearing on terminal run status can lose or repeat effects. Runtime retirement is a separate safety policy, not an original completion receipt.

## Proofs

The living [Resident spec](../reference/specs/resident-repos.md#native-operation-recovery) binds inventory, exact receipts, race refusals and retained private bytes to targeted tests. Live acceptance remains a separate gap.
