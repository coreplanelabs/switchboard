import { describe, it, expect } from "vitest";
import { requestOnlyReviewTarget, isRequestOnlyReviewDecision } from "./requestOnlyReview.js";

const request = "agent:review model:openai/request-model effort:high https://github.com/acme/api/pull/7";
const bind = {
  outcome: "binds",
  binds: [
    {
      line: request,
      preset: "review",
      repo: "acme/api",
      prTarget: { number: 7, source: "request" as const, quote: "https://github.com/acme/api/pull/7" },
    },
  ],
};
describe("request-only Review qualification", () => {
  it.each([
    request,
    "agent:review acme/api#7",
    "agent:review <https://github.com/acme/api/pull/7|current PR>",
    request + "\n> https://github.com/foreign/api/pull/9",
  ])("selects only one current authored complete target: %s", (text) => {
    expect(requestOnlyReviewTarget(text)).toEqual({ repo: "acme/api", number: 7 });
  });
  it.each([
    "review https://github.com/acme/api/pull/7",
    "> agent:review https://github.com/acme/api/pull/7",
    "    agent:review https://github.com/acme/api/pull/7",
    "```\nagent:review https://github.com/acme/api/pull/7\n```",
    "agent:review `https://github.com/acme/api/pull/7`",
    "agent:review PR #7",
    request + " https://github.com/acme/api/pull/8",
    request + " acme/web#8",
    request + " review PR #8",
    request + "\n> model:openai/quoted-model",
    "agent:review https://evil.test/?next=https://github.com/acme/api/pull/7",
    "agent:coding https://github.com/acme/api/pull/7",
  ])("keeps incomplete, quoted or ambiguous input unqualified: %s", (text) => {
    expect(requestOnlyReviewTarget(request)).toEqual({ repo: "acme/api", number: 7 });
    expect(requestOnlyReviewTarget(text)).toBeUndefined();
  });
  it("requires one verified current-request Review decision before execution", () => {
    expect(isRequestOnlyReviewDecision(request, bind)).toBe(true);
    for (const invalid of [
      undefined,
      { outcome: "non_decision" },
      { ...bind, binds: [...bind.binds, ...bind.binds] },
      { ...bind, binds: [{ ...bind.binds[0]!, preset: "coding" }] },
      { ...bind, binds: [{ ...bind.binds[0]!, repo: "foreign/api" }] },
      { ...bind, binds: [{ ...bind.binds[0]!, prTarget: { ...bind.binds[0]!.prTarget, source: "thread" as const } }] },
      { ...bind, binds: [{ ...bind.binds[0]!, prTarget: { ...bind.binds[0]!.prTarget, number: 9 } }] },
    ])
      expect(isRequestOnlyReviewDecision(request, invalid)).toBe(false);
  });
  it.each([
    "agent:review Please review the change below.\nhttps://github.com/acme/api/pull/7",
    `agent:review ${"Please check this change. ".repeat(20)}https://github.com/acme/api/pull/7`,
  ])("validates the full request and typed target when the display receipt is shortened: %s", (text) => {
    expect(
      isRequestOnlyReviewDecision(text, {
        ...bind,
        binds: [{ ...bind.binds[0]!, line: text.split("\n")[0]!.slice(0, 300) }],
      }),
    ).toBe(true);
  });
});
