---
title: Load harness refusal tokens - Plan
type: feat
date: 2026-09-12
status: proposed
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
extends: ../decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md
---

# Load harness refusal tokens - Plan

## Goal Capsule

- **Objective**: The load harness names rate limiting as a refusal of its own (`rate-limited`) instead of folding it into `timeout` or `unknown`, and the load-harness spec states how a refusal's token is recovered from a client error, bound to the tests that prove it. Two small units; the second depends on the first.
- **Why this plan, and why now**: the harness spike measured exactly these two tasks on both harnesses, and neither arm pushed its branch, so the work is proven twice and landed nowhere. The plan runner ([record 0031](../decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md)) carries a plan's units in dependency order, one thread and one branch per unit, and this is the first plan it runs in production: small, real, and verifiable by the ordinary gate.
- **Authority**: record 0031 (the runner walks a plan; a release PR is never its merge); [load-harness.md](../reference/specs/load-harness.md) (the spec these units change).
- **Stop conditions**: a unit that cannot pass `npm run verify` without touching anything outside its listed files stops and hands back a deviation; nothing here changes a Worker, a deploy or a credential.

---

## Implementation Units

### U1. Recognize rate limiting as a named refusal

- **Goal**: `reasonOf` in `src/load/reasons.ts` returns `rate-limited` for an error whose message carries an HTTP 429 or the words `rate limit` (case-insensitive), decided before the timeout rule, so the harness counts rate limiting by token rather than as `timeout` or `unknown`.
- **Dependencies**: none.
- **Files**: `src/load/reasons.ts` (`KNOWN_REASONS` gains `rate-limited`; one rule for `429` and `rate limit` placed after the token loop and before the timeout regex); `src/load/reasons.test.ts`.
- **Approach**:
  1. Tests first: the shapes below fail against the current module.
  2. Add `rate-limited` to `KNOWN_REASONS` so a message that already carries the literal token resolves through the existing loop.
  3. Add the rule `/\b429\b|rate limit/i` after the loop and before the timeout regex, so a message carrying both a rate limit and a timeout resolves to the refusal.
- **Patterns to follow**: the `fleet-busy` and `not-onboarded` message fallbacks already in `reasonOf`: a regex on the message after the token loop, one line each, no new module.
- **Test scenarios**:
  - `src/load/reasons.test.ts`: `HTTP 429 Too Many Requests` is `rate-limited`; `Rate Limit exceeded, retry later` is `rate-limited`; `rate limit hit: request timed out` is `rate-limited` (the refusal wins over the timeout wording); a plain `request timed out` is still `timeout`; a folded resident message carrying the literal token `rate-limited` resolves through the loop.
  - Edge: a message with `429` inside a longer number (`14290 ms`) is not `rate-limited` (the word boundary).
- **Verification**: `npx vitest run src/load/reasons.test.ts` green, red first; `npm run verify` green.

### U2. Bind the refusal-token recovery to the load-harness spec

- **Goal**: `docs/reference/specs/load-harness.md` states how a refusal's token is recovered from a client error (the token list, `rate-limited` among them, the message fallbacks, `timeout`, `unknown`) and binds one validation row to the real tests in the spec's `file::describe::it` proof form.
- **Dependencies**: U1 (the item names `rate-limited`, which does not exist before U1 lands).
- **Files**: `docs/reference/specs/load-harness.md` (one new Behavior item after the last numbered item, and one Validation row for it).
- **Approach**:
  1. Read the spec's existing items and match their voice: one bold lead, the mechanism in a sentence or two, no dates, no issue numbers.
  2. The validation row's proof names `src/load/reasons.test.ts` and a real `describe`/`it` (a `::*` wildcard over the describe is acceptable where the spec already uses one).
- **Patterns to follow**: item 13 and its rows in the same spec (a behavior stated once, every claim bound to a test).
- **Test scenarios**:
  - `npm run specs:check` resolves the new proof reference; `npm run specs:coverage -- --changed HEAD --test-guard` reports the changed spec covered and no verification removed.
- **Verification**: `npm run specs:check`, `npm run docs:check` and `npm run verify` green.

---

## Definition of Done

- Both units merged on `main` through the ordinary review gate; `reasonOf` recognizes rate limiting; the spec states the recovery and its row resolves.
- The runner's record for this plan shows two units, the second started only after the first merged.
