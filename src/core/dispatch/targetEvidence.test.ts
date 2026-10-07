import { describe, expect, it } from "vitest";
import { verifyPrTargetEvidence, inspectPrTargetEvidence } from "./targetEvidence.js";

describe("requester-authored PR links", () => {
  it.each([
    "",
    "/",
    "/changes",
    "/changes/",
    "/files",
    "/commits",
    "/checks",
    "/files/?diff=split#diff-abc",
    "?tab=files#discussion_r123",
    "/commits/0123456789abcdef0123456789abcdef01234567",
  ])("accepts a PR page suffix %j while retaining the authored destination", (suffix) => {
    const quote = `https://github.com/acme/api/pull/124${suffix}`;
    const evidence = { number: 124, source: "request" as const, quote };
    expect(
      verifyPrTargetEvidence(evidence, {
        requestText: `review <${quote}|github.com/acme/api/pull/124${suffix}>`,
        repo: "acme/api",
      }),
    ).toEqual(evidence);
  });

  it("requires the whole authored destination and matching requester, repository and number", () => {
    const quote = "https://github.com/acme/api/pull/124/changes";
    const requestText = `review <${quote}|github.com/acme/api/pull/124/changes>`;
    const evidence = { number: 124, source: "request" as const, quote };
    expect(
      verifyPrTargetEvidence({ ...evidence, quote: quote.replace("/changes", "") }, { requestText, repo: "acme/api" }),
    ).toBeUndefined();
    expect(verifyPrTargetEvidence({ ...evidence, number: 12 }, { requestText, repo: "acme/api" })).toBeUndefined();
    expect(verifyPrTargetEvidence(evidence, { requestText, repo: "acme/other" })).toBeUndefined();
    expect(
      verifyPrTargetEvidence(
        { ...evidence, source: "thread" },
        {
          requestText: "review it",
          repo: "acme/api",
          requesterId: "slack:UOWNER",
          tail: [{ actor: "slack:UOTHER", text: requestText }],
        },
      ),
    ).toBeUndefined();
    expect(
      verifyPrTargetEvidence(
        { ...evidence, source: "thread" },
        {
          requestText: "review it",
          repo: "acme/api",
          requesterId: "slack:UOWNER",
          tail: [{ actor: "slack:UOWNER", text: requestText }],
        },
      ),
    ).toEqual({ ...evidence, source: "thread" });
  });

  it.each([
    "https://evil.test/acme/api/pull/124/changes",
    "https://github.com.evil.test/acme/api/pull/124/changes",
    "https://evil.test/?next=https://github.com/acme/api/pull/124/changes",
    "https://user:password@github.com/acme/api/pull/124/changes",
    "https://github.com:444/acme/api/pull/124/changes",
    "https://github.com/acme/api/pull/1240/changes",
    "https://github.com/acme/api/pull/124.evil/changes",
    "https://github.com/acme/api/pull/124/unknown",
    "https://github.com/acme/api/pull/124/changes/pull/99",
    "https://github.com/acme/api/pull/124/commits/not-a-commit",
    "https://github.com/acme/api/pull/124//changes",
  ])("rejects an unrelated or malformed destination %s", (quote) => {
    expect(
      verifyPrTargetEvidence(
        { number: 124, source: "request", quote },
        { requestText: `review ${quote}`, repo: "acme/api" },
      ),
    ).toBeUndefined();
  });
});

describe("PR target diagnostic preserves admission", () => {
  const quote = "https://github.com/acme/api/pull/7";
  const valid = { number: 7, source: "request", quote };
  const context = {
    requestText: `Review ${quote}`,
    repo: "acme/api",
    requesterId: "slack:UOWNER",
    tail: [
      { actor: "slack:UOWNER", text: `user: Review ${quote}` },
      { actor: "slack:UBOT", text: "assistant: https://github.com/acme/old/pull/7 is historical" },
    ],
  };
  it.each([valid, { ...valid, source: "thread" }])("retains exact authored evidence %j", (evidence) => {
    expect(inspectPrTargetEvidence(evidence, context)).toEqual({ ok: true, evidence });
    expect(verifyPrTargetEvidence(evidence, context)).toEqual(evidence);
  });
  it.each([
    [null, "invalid_shape"],
    [{ ...valid, number: 0 }, "invalid_shape"],
    [{ ...valid, source: "assistant" }, "invalid_shape"],
    [{ ...valid, quote: "x".repeat(513) }, "invalid_shape"],
    [{ ...valid, quote: ` ${quote}` }, "invalid_shape"],
    [{ ...valid, quote: `${quote} at head abc` }, "invalid_identifier"],
    [{ ...valid, quote: "acme/api#not-a-number" }, "invalid_identifier"],
    [{ ...valid, source: "thread", quote: "https://github.com/acme/old/pull/7" }, "not_requester_authored"],
    [{ ...valid, quote: "https://github.com/acme/other/pull/7" }, "not_requester_authored"],
    [{ ...valid, number: 8 }, "identity_mismatch"],
  ])("keeps the target refused and supplies only a closed diagnosis %j", (evidence, reason) => {
    expect(verifyPrTargetEvidence(evidence, context)).toBeUndefined();
    expect(inspectPrTargetEvidence(evidence, context)).toEqual({ ok: false, reason });
  });
  it("retains same-requester historical PR evidence when a later review uses the thread", () => {
    const evidence = { ...valid, source: "thread" };
    const later = { ...context, requestText: "Review it again." };
    expect(inspectPrTargetEvidence(evidence, later)).toEqual({ ok: true, evidence });
    expect(verifyPrTargetEvidence(evidence, later)).toEqual(evidence);
  });
  it("wrong source actor and repository remain refusals", () => {
    expect(
      inspectPrTargetEvidence({ ...valid, source: "thread" }, { ...context, requesterId: "slack:UOTHER" }),
    ).toEqual({ ok: false, reason: "not_requester_authored" });
    expect(
      verifyPrTargetEvidence({ ...valid, source: "thread" }, { ...context, requesterId: "slack:UOTHER" }),
    ).toBeUndefined();
    expect(inspectPrTargetEvidence(valid, { ...context, repo: "acme/other" })).toEqual({
      ok: false,
      reason: "identity_mismatch",
    });
    expect(verifyPrTargetEvidence(valid, { ...context, repo: "acme/other" })).toBeUndefined();
  });
});
