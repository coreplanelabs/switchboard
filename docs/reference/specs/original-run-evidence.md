# Original run evidence

An operator can inspect a current original's stored boundary without repeating its writes or changing its outcome.

- **Code**: `src/core/harness/facts.ts`, `src/core/runLedger/originalEvidence.ts`, `src/core/runLedger/originalEvidenceReader.ts`, `src/core/runLedger/ledger.ts`, `src/core/runLedger/inMemory.ts`, `src/core/runLedgerWorker.ts`, `src/core/runsService.ts`, `src/core/commands/runs.ts`, `src/core/storageRequestContext.ts`, `src/core/storageTransport.ts`, `src/core/storageFailureDiagnostic.ts`, `deploy/cloudflare-memory/worker.ts`.
- **Tests**: `src/core/harness/facts.test.ts`, `deploy/cloudflare-memory/runLedger.test.ts`, `src/core/commands/runs.test.ts`, `src/core/runLedger/seedVerification.test.ts`, `src/core/runLedgerWorker.test.ts`.

## Validation criteria

| Criterion | Proof |
| --- | --- |
| A current original is selected by run ID and generation. The read exposes only bounded metadata and does not change canonical state. | `[unit]` `deploy/cloudflare-memory/runLedger.test.ts::original run evidence::reads a fenced original boundary without exposing private state or changing it` |
| The command authorizes the canonical ordinary-run resource once and hides private worker evidence. No broad live listing is needed. | `[unit]` `src/core/commands/runs.test.ts::runs original evidence::*`; `src/core/runLedgerWorker.test.ts::bounded original evidence client::*` |
| Step and state digests identify observed canonical values. They hash stored JSON values, not HTTP operation/payload witnesses. Event frontiers are observations, not append acknowledgements. | `[unit]` `deploy/cloudflare-memory/runLedger.test.ts::original run evidence::hashes the stored value separately from the failed HTTP request witness`; `::reports a canonical step and recorded producer without acknowledging an unknown append` |
| Prepared, committed and confirmed promotion receipts remain separate from recorded source verification and matched source release. The source read does not reverify transcript payloads or release them. | `[unit]` `deploy/cloudflare-memory/runLedger.test.ts::original workspace durability in real SQLite::reads prepared original bytes without treating preparation as a committed claim`; `::reads original source receipt phases without verifying or releasing their payload`; `::keeps original source metadata honest for * receipts`; `src/core/runLedger/seedVerification.test.ts::receiver confirmation and authenticated source release::reads original evidence without adopting or releasing the recorded source` |
| A stored launch intent never proves process start, no launch, or physical ending. | `[unit]` `deploy/cloudflare-memory/runLedger.test.ts::original run evidence::reads a fenced original boundary without exposing private state or changing it` |
| Missing or oversized cells and a changing owner remain unavailable. A newer owner cannot supply the original's proof. | `[unit]` `deploy/cloudflare-memory/runLedger.test.ts::original run evidence::*`; `deploy/cloudflare-memory/runLedger.test.ts::original workspace durability in real SQLite::discards original evidence when its owner changes during the source read` |
| The exact failed request remains unbound when its original bytes are unavailable. Reading evidence grants no replay or settlement authority. | `[unit]` `deploy/cloudflare-memory/runLedger.test.ts::original run evidence::reads a fenced original boundary without exposing private state or changing it` |
| Seed guard traces identify the actual calling and target objects, the original run and request, and the recorded-release or verification branch. Missing or corrupt receipts and a failed log sink preserve the original held result. | `[unit]` `deploy/cloudflare-memory/runLedger.test.ts::original workspace durability in real SQLite::traces the original seed guard target and * branch without changing its result`; `::keeps the original seed guard held with * trace input` |
| Live-state and session-write traces join the original request to actual object entry, validation, transaction return and result return. A failed sink preserves stored results; a failed transaction preserves its original error. | `[unit]` `deploy/cloudflare-memory/runLedger.test.ts::original write stage traces::*`; `deploy/cloudflare-memory/runLedger.test.ts::write trace failure propagation::*` |

## Operator contract

Use `runs original <run-id> --gen <original-generation>` through CLI or MCP. It is a read of the current original only. Missing or deleted originals are unavailable. It does not search newer or historical attempts.

The result contains bounded metadata and hashes. `prepared-recorded`, `commit-recorded` and `confirmation-recorded` name stored receipts. `verification-recorded` does not claim that the source transcript was reverified. `release-recorded-matched` means that the stored release matches the selected original confirmation. The consistency is per boundary. A changing owner, phase, stop or selected boundary discards the combined result.

The read limits each state or allocation cell to 1 MiB, step and source metadata cells to 64 KiB, and the result to 8 KiB. Oversized proof stays unavailable. No private prompt, source messages, session key, process path, PID or bearer enters the operator result.

`failedRequestBinding` remains `unknown`, `appendAcknowledgement` remains `not-recorded`, and `physicalEnding` remains `not-assessed`. A stored launch intent, producer receipt or event frontier grants no retry, handoff, termination or settlement authority. The original owner's retained expectation and existing reconciliation path remain separate prerequisites.

## Seed guard trace

The Memory log event `storage.seed_guard.progress` records the `source-receipt`, `promotion-read` and `source-proof` stages before an awaited call, then records `completed`, `held` or `failed`. The caller and receiver share an opaque `guardId`. Actual object IDs identify the source SessionLog and any callback to RunHistory without exposing the session key. The branch distinguishes a recorded release from source verification, a missing receipt, a mismatch, corruption or cancellation.

The trace carries the original run and generation, a validated request ID when supplied, and a validated request digest when already available. Each event has fixed fields and closed stage, outcome, branch and error-class values. It contains no source payload, private key, bearer, exception message or stack. Failure of the log sink cannot change the guard result. A completed guard stage proves only that the read returned; it is not a write acknowledgement, process-ending proof or recovery authority.

## Write stage trace

The Memory log event `storage.write.progress` records promotion preflight, source-owner lookup and the live-state or session-write RPC before each existing wait. Receivers record entry, validation, source proof, transaction return and result return. Actual object and incarnation IDs distinguish the target and its current runtime. Session writes expose only row and attachment counts and whether source metadata is present.

For these two write endpoints, the client sends its already-computed request digest in `x-switchboard-storage-request-digest`. The receiver checks its format and uses it only to correlate logs with the original request ID, run and generation. It does not authenticate the body, authorize a write or settle an outcome. Logging adds no wait, retry or recovery action. `returned` describes the server's local observation, never a client acknowledgement or a durable original-request receipt. Missing log events and missing receipts leave the write outcome unknown.

Exact original transaction outcomes use the separate [write receipt contract](write-receipts.md). This evidence reader continues to report request binding as unknown.
