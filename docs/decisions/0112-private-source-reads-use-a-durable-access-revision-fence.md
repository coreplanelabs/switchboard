---
title: Fence private source reads with the durable access revision
status: proposed
date: 2026-10-21
pattern: Causal revision fence with current source proof
---

# Fence private source reads with the durable access revision

Decide before review (Switchboard maintainer): use bounded, fresh source checks with a durable access revision fence for private history. This record is for an engineer new to the organization reader.

Normal private Review source checks were reported at 18–22 seconds, versus 0.35 seconds for a fresh Review. The live 1.307.1 release-smoke Review (workflow run 39569332720) recorded five allowed model checks at 1.6–2.8 seconds and seven at 12.7–15.0 seconds. Its receipt lacks child spans, so the slow inner read remains unknown. That release excludes this change. The organization reader checks retained entries in sequence. This change checks up to eight entries at once and refuses the read if the durable access revision changes. It adds two store reads per successful stream request. Native permission checks remain fresh on every read.

## Today at `3a0c7e673e993926ec7eb615ca1f3d142ffc73a6`

| Fact | Source |
| --- | --- |
| The reader checks each retained entry's provenance and current source identity in sequence. | `src/core/organization/service.ts` (`filterSources`) |
| The organization store increments `accessRevision` for explicit access changes and content deletion. | `src/core/organization/engine.ts` (`access`, `delete`) |
| Stream content expiry removes rows but advances only the general state revision. | `src/core/organization/engine.ts` (`expire`) |
| The production store executes each command in one SQLite transaction; directory changes advance the organization revision in that transaction. | `src/core/organization/sqlite.ts` (`execute`, directory callback) |
| Home checks the captured private epoch before and after history work, and model egress checks the private audience again. | `src/channels/homeHost.ts` (`privateHistory`), `src/core/dispatch/runLoop.ts` (`run.model_source_check`) |

## Shape

The reader uses a **revision fence**: both stream APIs read the owning store's access revision, check each retained source under current native authority with bounded parallel work, then read the access revision again before either releases a result. Access changes, deletion and stream content expiry advance that revision in the same store transaction as the affected rows; the final read observes the committed revision. Entry order remains the store's order. This follows the causal check shape in [Zanzibar](https://www.usenix.org/system/files/atc19-pang.pdf) and SpiceDB's [at least as fresh checks](https://authzed.com/docs/spicedb/concepts/consistency). Unlike a Zanzibar permission store, Switchboard does not own every native permission write. Its access revision fences only changes in its own store; each new read must still ask the native source.

## A revoke during a read

A private history request reads revision 7 and starts checks for 12 retained entries, at most eight at once. A native check for entry one returns allowed. An exact source deletion then removes a copied entry and advances the store access revision to 8 in the same transaction. Even if the remaining checks return allowed, the final revision read differs, so the reader returns `unavailable` and releases no entry. The same rule applies when content expires during a read or the caller uses the identity-selected stream API. Native credential changes are outside this revision: Home's existing epoch scans and the model and publication source checks remain required. This change makes no new claim about a provider's revocation latency or an instant revoke between checks.

## Difficulty map

1. **Native revocation** is the main correctness risk. The local revision cannot report an external ACL change, so it never authorizes a cached native allow.
2. **Partial parallel results** are the next risk. One unavailable provenance or native source withholds the entire response; denied entries remain omitted; successful entries keep their original order.

## Why this boundary

A cache keyed by `ContextDependencies.revision` or `accessRevision` could return an old allow after Slack, GitHub or a native MCP credential changes. Neither revision is a complete revocation feed. Automatically selecting fresh Review context would remove the retained conversation a normal request may need. A new Zanzibar service would still need every native provider to write revocations into it before it could safely replace current source checks.

The new fence covers organization store access changes during a read. Existing native proof, attached context checks, model input checks and publication checks remain in force. Synthetic concurrent checks can prove ordering, refusal and the concurrency bound; they cannot identify the production slow child or prove a live latency reduction. The change stays unmerged until current-head review and required CI pass; release and live acceptance are separate decisions.

## Validation

| Criterion | Proof |
| --- | --- |
| A retained read checks independent entries with bounded concurrency and returns permitted entries in store order. | `src/core/organization/service.test.ts::organization authenticated service::checks retained history in bounded parallel work and returns its original order` |
| A store revoke after native checks withholds all content, and a later fresh allowed read succeeds. | `src/core/organization/service.test.ts::organization authenticated service::withholds a history read when stored source access changes after native checks` |
| The identity-selected stream also withholds after an in-flight revoke. | `src/core/organization/service.test.ts::organization authenticated service::withholds an identity-selected stream when access changes during its source check` |
| Content expiry advances the access revision and withholds a previously checked entry. | `src/core/organization/service.test.ts::organization authenticated service::withholds an entry that expires after its source check` |
| Native source refusal still omits content and an unavailable source still withholds the read. | `src/core/organization/service.test.ts::organization authenticated service::keeps unlinked delegation source-only and applies current authorization and native source proof` |
