---
title: The public tree carries no imprint of the company that grew it, and a ratchet holds that line
status: accepted
date: 2026-09-08
pattern: Ratchet
---

# The public tree carries no imprint of the company that grew it, and a ratchet holds that line

## Context

Switchboard was built inside one company, by a handful of people, against a private issue tracker and a set of dated planning documents. That history is in the tree: the company's name in workflow files and URLs, people's names in comments, issue numbers as the only explanation for a line of code, plan vocabulary (`KTD16`, `U3`, `R1`) in docstrings, Slack and account identifiers in fixtures, and dated incident retellings where a rule should stand. For a reader outside the company every one of those is noise, and several are leaks.

Scrubbing once is not enough. Every PR after the scrub would add a little back, because "see #457" is the fastest comment to write.

## Decision

Every comment, docstring, fixture and prose line in the public tree is answerable from the repo alone. Five classes are forbidden: company, sibling-product and person names beyond the integrations the code talks to; private tracker references; plan ids; platform ids; and full dates in narrative. Provenance goes to the changelog and to the decision records, which may cite pull requests. A dated incident becomes the timeless rule it taught. Test fixtures use neutral names.

The policy is held by a ratchet, not by review. `npm run hygiene:check` counts every hit per file and class and compares the tree with a committed list that can only shrink: growth fails as new imprint, shrinkage fails until the progress is recorded, and a line that is right as written is allowed by name with its reason beside it. The check lands before the scrub starts, so the tree grows no imprint from that day and every directory's scrub is measurable by the files that leave the list.

## Consequences

- The scrub can run in parallel by directory, each PR shrinking the list, with no coordination beyond regenerating the list before pushing.
- A comment that needs provenance points at a decision record, which is why the records exist before the scrub begins.
- Legitimate exceptions cost a line in the allow file and a sentence of reason. That friction is the point: an exception is a decision, not a habit.
- The regexes are deliberately broad and the allow file absorbs the false positives. A CSS colour that looks like an issue number is allowed once, by name, rather than weakening the class.
- Our own production deployment is one installation of the product. Where a workflow must name our infrastructure, that line is allowed by name and stays visible as the one place the company appears.

## Alternatives rejected

- **A one-time scrub with review discipline.** Lasts until the first busy week.
- **A warn-mode check flipped to error at the end.** Warnings are ignored; the ratchet enforces no-regression from the first day and needs no flip.
- **Narrow regexes with no allow file.** Every false positive would become an argument about the pattern instead of a one-line, reasoned exception.

## Pattern

Ratchet: a measured quantity that is allowed to fall and never to rise, recorded in the tree and checked in CI. The same shape as the wall-clock allowlist ([0020](0020-spans-one-measurement-primitive.md)).
