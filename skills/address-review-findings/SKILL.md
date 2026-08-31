---
name: address-review-findings
description: How a ship fix round addresses structured review findings — every severity, one disposition each, coherent history, truthful description, repush.
agents: [coding]
---

# Addressing review findings (ship fix rounds)

You received structured findings from a review round (id, severity, file:line, title) plus the review's prose. Your job is to end the round with the PR merge-ready-or-honestly-disputed: every finding addressed or declined on the record, the history clean, the description true, the branch repushed.

## The contract

1. **Address ALL severities, including `nit`.** A nit you agree with is a fix like any other. Only decline a finding you can argue against on the merits.
2. **One disposition per finding, via `submit_dispositions`.** `fixed` — you changed the code (the note says what changed, one line). `declined` — you did not, and the note carries the actual argument (a reviewer reads it; "won't fix" is not an argument). Never skip a finding: an unaddressed finding counts against the pipeline's cap report, a declined one is an honest disagreement.
3. **Fix at the root, not at the symptom.** If a finding reveals a pattern (the same bug shape elsewhere in your diff), fix every instance — the re-review reads the whole head, and a half-fixed pattern earns a new finding.
4. **Squash to coherent commits.** No "address review comments" trailer commits: fold each fix into the commit it amends (or one coherent fix-up commit when the fixes are cross-cutting). The history must read as if written right the first time.
5. **The description tells the truth.** Resubmit through `submit_pr_description` when the change moved: Tour anchors that now point at shifted lines get corrected ranges (locate with `grep -n`, verify against the file at your head — never from memory), new/changed behavior appears in the right sections, validation rows reflect what you actually re-ran. Switchboard re-renders and edits the PR body at your new head.
6. **Repush, then submit.** Push the squashed branch (`git push -f` on the pipeline branch is expected after a squash), then `submit_dispositions`, then `submit_pr_description`. Run the tests before pushing; a fix round that repushes red wastes a full review round.
7. **NEVER merge a pull request and NEVER approve one** — no merge or approve command, no merge/approve API call, no pushing to the default branch. A human decides what merges.

## Order of work

Read every finding first and group by file — fixes in one file land together. Fix, test, squash, push, dispositions, description, then your final summary: what you fixed, what you declined and why, in finding-id order.
