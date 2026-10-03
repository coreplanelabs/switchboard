---
title: Review selects verified defects before applying severity
status: accepted
date: 2026-10-03
pattern: Evidence filter followed by severity policy
---

# Review selects verified defects before applying severity

## Context

The review prompt asked for every issue, including uncertain and low-severity observations. Its broad quality checklist encouraged optional improvements to become findings. Raising the action threshold would leave that noise in the review and also discard useful minor defects.

Finding selection, impact classification, and the decision to request changes are separate concerns. The model judges evidence and impact; deterministic code validates the finding vocabulary and shape, applies the configured severity floor to an approval, and binds the posted verdict to its reviewed head.

## Decision

Use one review agent with an evidence and impact filter. A finding must be introduced by the change, supported by a concrete failure path or an explicit applicable repository rule, and worth fixing. Before publishing it, check relevant callers, guards, contracts, and PR intent for evidence that disproves it. Realistic input or state-dependent failures qualify. Verification reads answer specific candidate questions and have no arbitrary count within the existing run budget.

Omit uncertain suspicions, pre-existing issues, cosmetic preferences, optional cleanup, generic test wishes, and failures already reported by automated checks. The explicit spec, test-guard, and unit-contract review obligations still apply. Report every qualifying finding, once per cause, or approve with none.

Keep `blocking|major|minor|nit`, finding IDs and case tables, read-scoped execution, exact-head guards, and the structured verdict contract. Severity describes impact; a minor is a bounded actionable defect. The default review omits polish suggestions. Keep `review.addressSeverity` at its existing default, `minor`, and add no reporting threshold. An explicit `request_changes` still enters the existing findings loop; this change does not redefine that override.

Own the short `code-review-and-quality` skill locally so its policy can be tuned without modifying a vendored file. All three review prompts carry the same selection policy, including when a skill store is unavailable. Specialized security and performance skills remain available; their candidates must pass this policy.

## Sources and alternatives

- Adapt the issue-selection criteria from the [public Codex review rubric](https://github.com/openai/codex/blob/447eac3b81183b32c1a09f5fba9617abfacbebe3/codex-rs/prompts/templates/review/rubric.md): actionable, introduced, evidenced, appropriate to the repository, and something the author would fix.
- Borrow candidate verification from [hosted Claude Code Review's documented method](https://support.claude.com/en/articles/14233555-set-up-code-review-for-claude-code). Its specialized agents, verification, and deduplication are a product design; its system prompt is not published in that documentation. The [public Claude code-review plugin](https://github.com/anthropics/claude-code/blob/1c229fcd1e1e4e452e29a8f116b45fe4cfe2c528/plugins/code-review/commands/code-review.md) is a separate implementation. This change does not claim to reproduce the hosted product.
- A self-assigned numeric confidence cutoff provides no demonstrated calibration for our models. Require supporting evidence instead.
- A display threshold can reduce visible comments after review, but does not by itself reduce investigation or token use. Defer it until presentation needs justify another control.
- Multiple reviewer personas and a separate classification agent would change orchestration and cost. Start with the existing agent and canonical schema; evaluate before expanding the architecture.

## Consequences and proof

Focused tests prove that the selection policy reaches every review path and preserves the existing submission contract. They do not prove improved review quality. Targeted verification can consume more reads while excluding weak findings; no latency or token savings are claimed.

Evaluate the previous and revised policies on the same representative PR heads before making a quality claim. Include dismissed low-value findings, real major defects, useful minor defects, intentional changes, existing guards, and realistic state-dependent bugs. Judge actionable findings, false or low-value comments, and missed known defects; record runtime and tokens. A clean review is valid, and a smaller finding count alone is insufficient evidence of improvement.
