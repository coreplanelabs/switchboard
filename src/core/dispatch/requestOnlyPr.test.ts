import { describe, it, expect } from "vitest";
import { requestOnlyPrTarget, isRequestOnlyPrDecision, freshReviewRequested } from "./requestOnlyPr.js";

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
describe("request-only PR qualification", () => {
  it("uses fresh context only when the current authored prefix asks for it", () => {
    expect(freshReviewRequested("agent:review review-context:fresh https://github.com/acme/api/pull/7")).toBe(true);
    expect(
      requestOnlyPrTarget(
        "agent:review review-context:fresh model:anthropic/general-model effort:high https://github.com/acme/api/pull/7",
      ),
    ).toEqual({ repo: "acme/api", number: 7, preset: "review" });
    expect(freshReviewRequested("agent:ship review-context:fresh review https://github.com/acme/api/pull/7")).toBe(
      true,
    );
    for (const text of [
      request,
      request + " review-context:fresh",
      "> agent:review review-context:fresh acme/api#7",
      "agent:review review-context:invalid acme/api#7",
      "agent:review review-context:fresh review-context:fresh acme/api#7",
    ])
      expect(freshReviewRequested(text)).toBe(false);
  });
  it("binds only the requested Ship review stage on the current authored PR", () => {
    const text = request.replace("agent:review", "agent:ship review");
    const ship = { ...bind, binds: [{ ...bind.binds[0]!, preset: "ship", shipEntry: "review" }] };
    expect(requestOnlyPrTarget(text)).toEqual({ repo: "acme/api", number: 7, preset: "ship" });
    expect(isRequestOnlyPrDecision(text, ship)).toBe(true);
    for (const stage of ["work", "work_from_thread", "continue", "plan", undefined])
      expect(isRequestOnlyPrDecision(text, { ...ship, binds: [{ ...ship.binds[0]!, shipEntry: stage }] })).toBe(false);
    expect(isRequestOnlyPrDecision(text, bind)).toBe(false);
    for (const invalid of [
      text.replace("ship review", "ship continue"),
      text.replace("ship review", "ship plan"),
      text.replace("ship review", "ship Fix"),
      text + " https://github.com/acme/web/pull/8",
      "agent:ship\n> review https://github.com/acme/api/pull/7",
    ])
      expect(requestOnlyPrTarget(invalid)).toBeUndefined();
  });
  it.each([
    request,
    "agent:review acme/api#7",
    "agent:review <https://github.com/acme/api/pull/7|current PR>",
    request + "\n> https://github.com/foreign/api/pull/9",
  ])("selects only one current authored complete target: %s", (text) => {
    expect(requestOnlyPrTarget(text)).toEqual({ repo: "acme/api", number: 7, preset: "review" });
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
    expect(requestOnlyPrTarget(request)).toEqual({ repo: "acme/api", number: 7, preset: "review" });
    expect(requestOnlyPrTarget(text)).toBeUndefined();
  });
  it("requires one verified current-request Review decision before execution", () => {
    expect(isRequestOnlyPrDecision(request, bind)).toBe(true);
    for (const invalid of [
      undefined,
      { outcome: "non_decision" },
      { ...bind, binds: [...bind.binds, ...bind.binds] },
      { ...bind, binds: [{ ...bind.binds[0]!, preset: "coding" }] },
      { ...bind, binds: [{ ...bind.binds[0]!, repo: "foreign/api" }] },
      { ...bind, binds: [{ ...bind.binds[0]!, prTarget: { ...bind.binds[0]!.prTarget, source: "thread" as const } }] },
      { ...bind, binds: [{ ...bind.binds[0]!, prTarget: { ...bind.binds[0]!.prTarget, number: 9 } }] },
    ])
      expect(isRequestOnlyPrDecision(request, invalid)).toBe(false);
  });
  it.each([
    "agent:review Please review the change below.\nhttps://github.com/acme/api/pull/7",
    `agent:review ${"Please check this change. ".repeat(20)}https://github.com/acme/api/pull/7`,
  ])("validates the full request and typed target when the display receipt is shortened: %s", (text) => {
    expect(
      isRequestOnlyPrDecision(text, {
        ...bind,
        binds: [{ ...bind.binds[0]!, line: text.split("\n")[0]!.slice(0, 300) }],
      }),
    ).toBe(true);
  });
});
