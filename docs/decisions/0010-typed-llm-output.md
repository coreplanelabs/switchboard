---
title: Every model output is a typed contract, normalized once at the answer boundary
status: implemented
date: 2026-09-08
pattern: Strategy per output type
---

# Every model output is a typed contract, normalized once at the answer boundary

## Context

Every call to a language model returns text the system then assumes something about: that it is Markdown a channel can render, that it is JSON with certain fields, that a review verdict has a known shape. Those assumptions used to be implicit and scattered. Two concrete failures forced the design: Slack renders `*x*` as bold while the run page renders it as italic, so the same answer looked different on each surface; and structured outputs were parsed ad hoc at each call site with each site deciding on its own what to do with a malformed reply.

## Decision

Every model output is an explicit contract. A per-datatype module implementing `OutputType<T>` declares the expected shape, classifies deterministically what came back (`syntax` failure, `schema` failure, or ok), normalizes it to one canonical form, and hands downstream a typed value. The run record keeps both the raw text and the canonical form.

The control loop, `acceptOutput`, is deterministic and type-blind: parse; if ok, done; if failed, re-ask only when the caller supplied a `reask`, the type says the failure is retryable, and attempts remain; when exhausted or non-retryable, return the failure rather than throw, so the caller decides between fail-open and fail-closed. All knowledge of what is valid lives in the type module; the loop only sequences.

Markdown normalizes and never fails, because there is no invalid Markdown. Canonicalization is parser-guided (`mdast-util-from-markdown`) and positional: single-asterisk emphasis becomes double-asterisk by inserting two characters, everything else stays byte-identical, and emphasis inside code fences is never touched. It happens once, at the answer boundary, before the `answer` event is published, so the event text, the channel reply, the GitHub post and the memory reflection all read the same bytes. The raw text rides on the event only when normalization changed something, and is dropped if it would push the event over the size cap.

JSON is retryable, unlike prose.

## Consequences

- Adding a structured output means writing an `OutputType`, never putting a model between the record and a surface.
- Per-surface renderers stopped disagreeing because they receive one canonical form.
- Nested emphasis and `***bold-italic***` are left alone: rewriting nested marker runs risks re-parse ambiguity, and the cost of leaving them is cosmetic.
- Every caller has to handle a returned failure. That is the point; a thrown parse error at a call site was the previous, worse, behavior.

## Alternatives rejected

- **Regex rewriting of Markdown.** Touches code blocks and URLs; the parser-guided approach cannot.
- **Retrying every malformed output.** Prose has no schema to retry against, and unbounded retries spend the run's budget.
- **Normalizing per surface.** Each renderer keeps its own opinion and the run record stores a shape no surface shows.

## Pattern

Strategy per output type behind one seam; a Tolerant Reader normalizer for Markdown; the loop is a template over the type's classification.
