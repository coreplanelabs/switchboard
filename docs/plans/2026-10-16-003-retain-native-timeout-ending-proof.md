---
title: Retain original native timeout ending proof
type: design
date: 2026-10-16
status: proposed
surveyed_at: a8a5953576aa530e159029b0c9bce38fae732b31
---

# Retain original native timeout ending proof

Adopt this bounded source repair before publication. The source owner implements it; the release owner qualifies delivery separately. The reader is an engineer familiar with process isolation who has not read the native check path. This record grants no live recovery authority.

Switchboard can close an exact timed-out native attempt and observe its original launcher finish, yet lose the ending proof before a recorded check can use it. The transport returns124, the Worker removes the settled journal entry, and the check reader keeps that interrupted alias pending. Retain the original ending receipt before removal, using the existing native journal and receipt store. This costs one bounded receipt write on an eligible timeout. The original check output remains interrupted, uncertain cleanup stays held, and historical aliases without the proof remain unknown.

## Today at the surveyed commit

| Fact | Source |
| --- | --- |
| On a launch deadline, the native transport submits `kill-attempt` with the original ref and attempt. It validates an empty group and waits for the original launcher before returning124. | `deploy/cloudflare-resident/nativeScope.ts::CloudflareNativeScopeTransport.request` |
| `ResidentDO.run` settles a known native exit except125. Journal settlement removes the attempt; close deletes an empty journal. | `deploy/cloudflare-resident/worker.ts::run`; `nativeOperation.ts::NativeOperationJournal.settle`, `::close` |
| Recorded checks keep124,137 and143 interrupted. Their reader needs a retained native ending receipt and an absent original journal before retiring an alias. | `deploy/cloudflare-resident/checkOperation.ts::RecordedCheckOperation.inspectRecorded` |
| Terminal run-scope retirement preserves unknown operation outcomes. Its physical closure receipt is a different contract from an original native attempt ending. | `docs/plans/2026-10-16-001-terminal-native-retirement-design.md`; `nativeOperation.ts::retireScope`, `::readEnding` |

The baseline regression calls the real transport and extracted Worker run method through the existing harness, then reads the recorded check. At the surveyed commit, the same-attempt empty-group acknowledgment and launcher completion still yield `pending/native_ending_unproven`. That is the recorded RED result. Refused, foreign and launcher-unconfirmed cases retain their original native admissions. This is synthetic source proof. It does not establish any historical production ending.

## The shape

Use a write-ahead ending receipt in the existing `NativeOperationJournal`. The transport returns a typed internal proof only after its existing timeout closure checks pass. The Worker hands that proof to settlement. In one storage transaction, settlement validates the original owner, scope, boot, attempt and journal bytes, writes `{original, receipt}` under the existing native receipt prefix, then removes the pending attempt. The recorded-check reader consumes that qualified receipt through its existing `readEnding` seam.

```mermaid
sequenceDiagram
  participant T as Existing native transport
  participant J as Existing native journal
  participant C as Recorded check reader
  T->>T: Original deadline expires
  T->>T: Same ref/attempt kill ACK says empty; original launcher ends
  T->>J: Settle original attempt with typed timeout proof
  J->>J: Save original snapshot + ending receipt before removal
  J->>J: Remove settled attempt; close journal only when empty
  C->>J: Read original ending and verify original journal is absent
  J-->>C: Retire alias; retain interrupted output and no-repeat identity
```

## The hard case

A command has one pending native attempt. Its deadline expires. The transport receives the exact original ref, boot and attempt back from `kill-attempt`, with `closed:false` and `populated:false`. Its original launcher then completes. The transport returns124 and a separate typed ending proof;124 alone carries no authority.

Settlement reads that attempt's original journal, computes its full-record hash and saves the original snapshot and proof before removing any admission. If the commit reply is lost, settlement reads only that exact receipt and post-state. It neither repeats the kill nor launches another command. A missing or contradictory readback stays unknown.

The operation may still perform normal output salvage. The check cannot retire while its original journal exists. Close removes that journal only after every pending attempt has settled. The saved receipt then lets the check reader retire the interrupted alias without returning a successful command result.

## Where the difficulty is

1. Bind durable proof to the original admission across failed writes and lost acknowledgments.
2. Keep an attempt ending from certifying other pending work or a later operation.
3. Preserve old receipt readers and all uncertain or historical outcomes.

## Receipt and removal rules

The internal timeout proof contains its schema version, exact native scope ref, caller-known attempt, the empty-group acknowledgment fields, and the original launcher exit. Scope ref includes the boot and original owner tuple. The launcher exit must be a valid observed exit and must not be the native refusal code125. The proof contains no command, environment or output bytes.

The receipt contains the original native key, the SHA-256 of the saved original journal bytes, that original journal, the typed proof, and `originalOperationOutcome:unknown`. It uses the existing native receipt store with `purpose:native-timeout-ending` and a typed `nativeEnding` field. Its encoded `{original, receipt}` envelope is capped at 64 KiB before writing and reading. This is a new conservative policy, matching the existing terminal-preparation size budget; an oversized envelope keeps the admission held. Existing SDK process receipts retain their current shape and validation.

Eligibility requires one remaining pending process attempt with the selected ID, no contradictory SDK tuple, and exact scope/thread/run/owner binding. A second pending attempt or a different existing receipt refuses. This bounded repair retains one timeout receipt per native operation. A later second timeout under the same operation refuses instead of overwriting the first proof. Normal output salvage can finish under the still-open journal; an unknown salvage attempt prevents whole-operation retirement.

The current capped-command wrapper makes at most one output-salvage call after a timeout. The frequency of a second timeout within that same operation is unknown; the release owner can measure it from existing timeout-output recovery diagnostics. This repair deliberately keeps that case held. Supporting several timeout receipts per original operation would need a separate bounded retention decision.

The receipt becomes immutable when its settlement transaction commits. This does not close the enclosing journal or the run scope. `begin` can still admit normal salvage under that existing open journal; `open` cannot reopen the same native key after it closes. The receipt write and pending-attempt removal share one transaction, with the write first. Existing process recovery must also refuse a journal that already has a receipt, before lookup/control and again before its archive write, so it cannot replace the timeout proof with an empty process archive.

| Observed original state | Required result |
| --- | --- |
| No receipt; selected attempt is the only pending admission; exact proof | Save original snapshot and receipt, then remove that attempt in one transaction. Keep an open journal for salvage; remove a closed journal only when empty. |
| Transaction fails before commit | Roll back receipt and admission changes. Keep the original hold. |
| Commit reply lost; exact receipt and removal are readable | Acknowledge the original commit from readback. Submit no mutation again. |
| Receipt differs, readback is unavailable, or the selected attempt remains pending | Keep the caller's outcome unknown. Do not overwrite, remove, or retry. |
| Receipt exists; matching late settlement sees that attempt absent | Return the original acknowledgment without a write. |
| Receipt exists; normal salvage remains pending | Keep the journal. Check inspection cannot retire the alias while that journal exists. |
| Receipt exists; a second timeout or process recovery attempts another receipt | Refuse without overwriting the first receipt or removing new pending work. |
| Receipt exists; all subsequent work settled and journal closed | Existing check inspection can retire only the same original alias; command output remains interrupted. |

A changed scope/boot or owner, multiple pending admissions, partial group acknowledgment, or unconfirmed launcher cannot gain authority. Late callbacks cannot rewrite the receipt.

`readEnding` validates the original key/hash, original admission and full timeout proof before returning native ending. The recorded-check reader still requires canonical original source, matching check context, and absence of the original journal. Its interrupted output remains interrupted. Generic physical retirement, an empty inventory, a missing journal, exit124 alone, and a successful later command cannot supply this proof.

Cached recovery must use the same validated ending reader. Matching only a stored `recordHash` is insufficient when a saved scope or attempt has changed. Both the ending reader and the check reader refuse whole-operation ending while the original journal still exists.

## Alternatives and boundaries

Treating124 as completion would admit ambiguous interruptions. Increasing the timeout changes when uncertainty occurs. Reusing the terminal-scope retirement path would confuse later physical cleanup with original attempt evidence. A new supervisor or reconciliation controller would duplicate the journal that already owns admission and removal.

This repair changes the Resident transport, its existing settlement callback and journal reader. The core still treats interrupted command output as unknown and can fail that review; operators gain original native-ending evidence for the existing check-retirement path. It adds no runtime command, SDK, image, credential, timeout, model, controller or live probe. Deployment is separate. Older readers that cannot validate the new receipt variant must keep it unavailable. No old missing receipt is backfilled, and no historical alias or operation is settled by this source change.

After first use, rollback must retain the receipt reader and recovery no-overwrite guards. Disabling the new producer is safe; returning to an older recovery writer can replace evidence while an open journal remains. Retain the existing receipt/no-repeat storage. Its production growth is unknown and stays part of release acceptance through existing diagnostics; garbage collection is outside this repair.

## Verification boundary

The behavioral row for original recorded check inspection in `docs/reference/specs/resident-repos.md` must cover the new eligible timeout receipt. The existing named native/check tests must prove the acknowledged path, original write failure, lost acknowledgment/readback, changed ref/boot/attempt/hash, multiple pending work, late settlement/reopen, and no extra launch. Refused kill, foreign acknowledgment and unconfirmed launcher must keep their existing holds. Neighbor journals and private bytes must remain unchanged.

The source proof is local and synthetic. Independent design reading, current-head PR review and CI, containing release, deployment and live acceptance are separate evidence. A deployed fix does not reconstruct the missing proof of an older operation.
