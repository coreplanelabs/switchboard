# Governance

Switchboard is an open-source project stewarded by [Coreplane Labs](https://coreplane.ai).
This document says who decides what, and how that changes.

## Roles

**Users** run Switchboard. Anyone. Their bug reports and questions shape the
roadmap more than anything else.

**Contributors** have had a change merged. Anyone who follows
[CONTRIBUTING.md](CONTRIBUTING.md).

**Maintainers** review and merge changes, triage issues, cut releases, and
decide the roadmap. Maintainers are listed in [`.github/CODEOWNERS`](.github/CODEOWNERS).
Today they are the steward's engineers.

## How decisions are made

- Day-to-day decisions are made by whoever is doing the work, in the pull
  request, with a maintainer's review.
- Decisions that change how the system is put together are written down as a
  record under `docs/decisions/` before or alongside the change, so the reason
  survives the code. A pull request that contradicts a recorded decision either
  updates the record or is not merged.
- Disagreements are resolved by discussion in the pull request or a Discussions
  thread. If maintainers cannot agree, the steward decides.
- The roadmap lives in GitHub Discussions and the milestones on the issue
  tracker, not in a private document.

## Becoming a maintainer

A contributor who has landed several substantial changes, reviews other
people's work with care, and has shown judgement about the project's
invariants can be invited by the existing maintainers. There is no application
form; consistent, visible contribution is what gets noticed.

Maintainers who are inactive for six months are moved to emeritus status and
lose merge rights, with thanks. They can return by asking.

## Releases

Releases follow semantic versioning and are cut by a maintainer from `main`
through the automated release pipeline. Until 1.0, minor versions may change
configuration keys or command syntax; every such change is called out in the
changelog with a migration note.

## Changes to this document

Governance changes are proposed as a pull request against this file and require
approval from a majority of maintainers.
