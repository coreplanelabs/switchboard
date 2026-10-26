# Original write receipts

An operator can read the original storage transaction result after its reply is lost. Missing proof stays unknown.

- **Code**: `src/core/runLedger/writeReceipt.ts`, `src/core/runLedger/ledger.ts`, `src/core/runLedger/inMemory.ts`, `src/core/runLedgerWorker.ts`, `src/core/runsService.ts`, `src/core/commands/runs.ts`, `src/core/storageRequestContext.ts`, `deploy/cloudflare-memory/writeReceipts.ts`, `deploy/cloudflare-memory/worker.ts`.
- **Tests**: `deploy/cloudflare-memory/writeReceipts.test.ts`, `src/core/commands/runs.test.ts`, `src/core/runLedgerWorker.test.ts`, `src/core/commandCapabilities.test.ts`, `src/core/commandConformance.test.ts`, `src/core/capabilitySurfaces.test.ts`, `src/channels/mcp.test.ts`.

## Validation criteria

| Criterion | Proof |
| --- | --- |
| Live-state effects and their exact original receipt commit together. A lost reply can be inspected without repeating the write. Private state is absent from the reply. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipts::reads a committed live-state write after its original reply is discarded` |
| The ingress digest binds actual frozen HTTP bytes. A diagnostic header never supplies body proof. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipt failures::derives request identity from bytes instead of diagnostic headers` |
| Session receipts distinguish rows, attachments, source metadata and source-owner metadata. A refused result can still have committed metadata effects. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipts::records row and source components together without exposing their payloads`; `::original write receipt components and limits::records the original * components`; `::original write receipt failures::records a refused result separately from committed source metadata` |
| A lost session batch reply continues to the run step only after the exact current-original receipt records success and the requested row and attachment counts. The client never resends that batch; missing, changed, partial, refused or unreadable proof keeps the original write uncertain. | `[unit]` `src/core/runLedgerWorker.test.ts::a session step after a lost write reply::*` |
| Receipt insert or prune failure rolls back all effects in the owning transaction. No receipt can attest a rolled-back write. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipt failures::rolls back source and row effects if receipt * fails` |
| A retained duplicate request ID is fenced before mutation. A conflicting digest cannot replace its original receipt. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipt failures::fences duplicate and conflicting IDs without replacing the original receipt` |
| A frozen effect input is followed by owner and revocation checks inside the transaction. A local owner change during hashing saves no success receipt. RunHistory and SessionLog remain separate atomic boundaries. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipt failures::refuses a stale * owner changed during hashing`; `::original write receipt components and limits::refuses a revocation that occurs during session effect hashing`; `::keeps a RunHistory-only owner change separate from SessionLog commit` |
| Current-original point reads discard changing ownership or reader identity. A snapshot of RunHistory metadata is never a SessionLog write permit. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipt failures::discards a session receipt when RunHistory changes during its point read`; `::keeps changed ordinary reader metadata from exposing a prior receipt` |
| Storage retains at most 256 receipts per owning object, each at most4096 UTF-8 bytes. Missing, legacy, evicted or unsupported proof stays unknown. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipt failures::keeps at most256 receipts and leaves evicted requests unknown`; `::keeps legacy writes and precommit failures unknown`; `::original write receipt components and limits::rolls back effects when UTF-8 reader metadata exceeds the receipt byte cap` |
| Canonical run deletion and session revocation remove their receipts. A trace sink failure cannot change the transaction result. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipt components and limits::removes RunHistory receipts with canonical run data deletion`; `::original write receipt failures::removes session receipts on revocation and fences a late write`; `::preserves a committed receipt when the trace sink fails` |
| The command authorizes the canonical ordinary run once, hides private worker evidence and exposes unknown instead of fabricated proof for an unsupported store. The strict client refuses foreign identity and extra private fields. | `[unit]` `src/core/commands/runs.test.ts::runs write receipt access::*`; `src/core/runLedgerWorker.test.ts::original write receipt client::*` |
| Corrupt proof stays unknown and exposes none of its stored fields. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original write receipt corrupt proof::*` |
| The receipt-owner lookup trace names its actual RunHistory target before the wait, receiver entry and safe failure. A failed lookup never claims that the SessionLog write started. Sink failure preserves that behavior. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original receipt owner lookup trace::*` |
| `contextPinningApplied` reports processing, including a valid empty reference set. It never claims that pin rows were written. | `[unit]` `deploy/cloudflare-memory/writeReceipts.test.ts::original receipt context pin processing::*` |

[Design record](../../plans/original-write-receipts.md).

## Operator contract

Use `runs receipt <id> --gen <generation> --operation live-state --request-id <original-request-id> --digest <original-request-digest>` or select `conversation-write`. CLI, HTTP and MCP use the same `runs:read` command. The read selects one current original; it does not list receipts or search newer attempts. A changing owner, phase, session or reader binding discards evidence.

`recorded` means that the original owning transaction saved its result summary and component facts with its effects. `ok:false` can coexist with written metadata. Component counts record writes in that transaction, not current content or client acknowledgement. `contextPinningApplied` and `bytePolicyApplied` report processing, even when that processing writes no rows. `effectDigest` hashes the canonical frozen effect input. `digest` uses the existing HTTP operation/payload witness algorithm. Neither digest comes from the diagnostic header.

The private reader binding remains in storage. Public output contains bounded IDs, digests, closed result values, counts and booleans. It contains no request bytes, state patches, transcript content, source payloads, attachment data, session key, exception prose or credentials.

Legacy requests without a valid request ID, or session requests without canonical store/run/session binding, retain their existing behavior without receipts. The in-memory adapter has no Memory HTTP ingress and reports unsupported. The first-party row writer includes its existing store key. An unavailable older endpoint is not evidence of rollback.

Receipts have a count bound, not a time guarantee. Busy shared objects can evict proof quickly. A retained duplicate ID is fenced without replacing its receipt; an evicted ID has no replay protection from this table. Full reset removes receipts with the owning object data and retains none as installation settings. Historical writes cannot gain receipts after the fact.

Unknown, absent, evicted or unsupported proof never means not committed. A receipt does not prove client acknowledgement, process ending, publication, recovery completion or replay permission. No new automatic retry, settlement or replacement writer is part of this contract.
