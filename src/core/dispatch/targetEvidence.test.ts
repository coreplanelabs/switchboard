import { describe, expect, it } from "vitest";
import { verifyPrTargetEvidence } from "./targetEvidence.js";

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
