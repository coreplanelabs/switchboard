# Item 12 live-validation probe

Scratch file for validating agent-review.md item 12 in production (PR #308,
live build 29a4afb). This PR is never merged; it exists so a review can run
while its head moves.

- Scenario A: the head is replaced by an equivalent commit mid-review
  (same message, same files) — the review must be carried to the new head.
- Scenario B: a new commit lands mid-review — the same run must re-review.

Second commit so the PR has more than one commit in its compare lists.

## Scenario B marker

This section lands in a NEW commit pushed while a review is in flight — the
same run must notice, re-review at the new head, and post one review pinned
to it. If a reviewer is reading this sentence, it is reviewing the post-move
head.
