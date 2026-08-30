# Item 12 live-validation probe

Scratch file for validating agent-review.md item 12 in production (PR #308,
live build 29a4afb). This PR is never merged; it exists so a review can run
while its head moves.

- Scenario A: the head is replaced by an equivalent commit mid-review
  (same message, same files) — the review must be carried to the new head.
- Scenario B: a new commit lands mid-review — the same run must re-review.

Second commit so the PR has more than one commit in its compare lists.
