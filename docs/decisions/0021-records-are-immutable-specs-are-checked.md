---
title: Records are immutable and specs are checked; documentation drift is prevented by CI, not discipline
status: implemented
date: 2026-09-08
pattern: Two kinds of document
---

# Records are immutable and specs are checked; documentation drift is prevented by CI, not discipline

## Context

Markdown in a repository drifts. Plans describe a design that was later reversed, specs describe behavior that no longer exists, and proposals get lost because nobody knows whether they were accepted. The format was never the problem; the lifecycle was. Every attempt to fix it with a convention ("update the doc when you change the code") failed at the first busy week.

## Decision

There are two kinds of document, never mixed.

**Records** (decision records under `docs/decisions/`, dated plans under `docs/plans/`) are written once. Each carries frontmatter `status` from the closed set `proposed | accepted | implemented | superseded`, a `date`, and `superseded_by` when superseded. After acceptance only those status lines may change. A record cannot drift because it is never edited; when a decision stops holding, a new record supersedes it.

**Living specs** (one per feature) carry behavior, invariants and validation criteria, and every criterion is bound to a named proof: a test id in the form `file::test name`. A PR that changes behavior updates the covering spec in the same PR.

Both are held by checks under the one `verify` gate, not by discipline:

- `decisions:check` fails when a record lacks a status or date, when a superseded record names nothing that resolves, and when a record already accepted on `origin/main` has a changed body or a status that moves backwards.
- `specs:check` fails when a spec's proof reference names a test that does not exist.
- `specs:coverage` maps a PR's changed paths to the specs that cover them, so a changed source path with no covering spec is visible.
- `docs:check` fails when a generated region, including the decision index, is out of date.
- `agents:check` holds the always-loaded agent contract under a hard size budget, so the index stays an index and bodies load on demand.

## Consequences

- A proposal is never lost: it is a record with a status, and the status is checked.
- Every validation criterion is either proven by a named test or visibly unbound.
- Writing a record is a commitment: fixing a typo in an accepted record means a superseding record. The friction is intentional and small.
- The diff-gated spec review, where the review agent is handed only the specs covering a PR's changed paths and asked whether the diff contradicts them, is the piece that catches semantic drift the mechanical checks cannot.

## Alternatives rejected

- **Editable design docs with a "last updated" line.** The last-updated line is the first thing to drift.
- **Specs without proof bindings.** A criterion nobody can run is an aspiration.
- **One big always-loaded document for agents.** Retrieval quality beats volume; the budget forces the split.

## Pattern

Two kinds of document: immutable records and living specs with bound proofs. Generated regions with `gen` and `check` for everything derivable from code.
