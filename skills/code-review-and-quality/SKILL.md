---
name: code-review-and-quality
description: Review changed code for verified, consequential defects and applicable project-rule violations while filtering noise.
agents: [review]
---

# High-signal code review

Issue selection adapts [OpenAI's public Codex review rubric](https://github.com/openai/codex/blob/447eac3b81183b32c1a09f5fba9617abfacbebe3/codex-rs/prompts/templates/review/rubric.md). Candidate verification follows the method described for [Claude Code Review](https://support.claude.com/en/articles/14233555-set-up-code-review-for-claude-code). Switchboard's system prompt defines the existing exact-head, read-only review and structured verdict contracts.

## Select findings

For each possible finding, ask:

1. **Introduced here?** Trace it to the PR diff. Do not report a pre-existing problem merely because a changed file exposed it.
2. **Verified?** Read enough of the relevant caller, callee, test, or contract to show the failure. Name the input or state and the wrong result. For a project-rule violation, identify the exact rule that applies to this file. Discard a suspicion you cannot substantiate in the review.
3. **Consequential?** Would the author reasonably fix this PR for the demonstrated defect, security risk, data loss, broken behavior, significant performance regression, or explicit project contract? Respect the rigor and conventions already used in this repository. Leave out cosmetic preferences, optional cleanup, speculative improvements, and issues that formatting, lint, typecheck, or CI already reports. Identify the affected caller or behavior; the possibility that something elsewhere could break is insufficient.

Before publishing a candidate, try to disprove it. Check for an existing guard, a caller that rules out the proposed input, a contract that permits the result, or an intentional behavior change described by the PR. Read enough related code to resolve the claim. Discard a candidate whose failure path or practical impact remains unsupported. A bug that needs a particular realistic input or existing state is valid when you can show that path; it need not fail for every input.

Severity describes verified impact, not confidence. Keep the canonical `blocking|major|minor|nit` vocabulary and the configured severity gate. A `minor` is a real, bounded defect worth fixing; optional polish does not become a minor because you are certain it would improve the code. The normal review omits polish suggestions instead of producing a nit list.

Switchboard's explicit spec, test-guard, and unit-contract checks remain applicable project rules. Verify their scope and the diff before filing their required findings. Do not turn a generic wish for more tests into a finding when no behavior, proof, or project rule requires them.

## Report

Submit one structured finding per distinct cause, with the failure scenario, impact, and a practical fix. Collapse duplicate symptoms under one finding. Do not inflate severity to force a fix round. If nothing passes the filter, approve with an empty findings list. Follow the system prompt's `submit_verdict`, head, severity-gate, and final-message contracts.
