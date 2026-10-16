// Feature: docs/reference/specs/browser-home.md — protected media marker stays with its original owner.
import { describe, expect, it } from "vitest";
import { originalOrganizationDispatchOf, withOriginalOrganizationDispatch } from "./originalOrganizationInput.js";
describe("Original media input marker", () => {
  it("preserves request-only context only for the same original run and sequence", () => {
    const context = { ingressRunId: "review-B", organizationSequence: 2, contextMode: "request" as const };
    const source = withOriginalOrganizationDispatch({ text: "Review this PR" }, context);
    expect(
      originalOrganizationDispatchOf(
        withOriginalOrganizationDispatch(source, { ingressRunId: "review-B", organizationSequence: 2 }),
      ),
    ).toEqual(context);
    expect(
      originalOrganizationDispatchOf(
        withOriginalOrganizationDispatch(source, { ingressRunId: "other", organizationSequence: 2 }),
      ),
    ).toEqual({ ingressRunId: "other", organizationSequence: 2 });
    expect(
      originalOrganizationDispatchOf(
        withOriginalOrganizationDispatch(source, { ingressRunId: "review-B", organizationSequence: 3 }),
      ),
    ).toEqual({ ingressRunId: "review-B", organizationSequence: 3 });
    expect(
      originalOrganizationDispatchOf({ contextMode: "request", originalOrganizationInput: context }),
    ).toBeUndefined();
  });
  it("keeps saved source A as bounded read provenance only on the same protected execution B", () => {
    const reference = {
      version: 1 as const,
      kind: "confirmed" as const,
      sourceRunId: "source-A",
      sourceSequence: 1,
      sourceDigest: "a".repeat(64),
      confirmationId: "saved-choice",
      intentDigest: "b".repeat(64),
    };
    const context = { ingressRunId: "execution-B", organizationSequence: 2, savedNativeMediaSource: reference };
    const message = withOriginalOrganizationDispatch({ text: "Saved proposal" }, context);
    expect(
      originalOrganizationDispatchOf(
        withOriginalOrganizationDispatch(message, { ingressRunId: "execution-B", organizationSequence: 2 }),
      ),
    ).toEqual(context);
    expect(
      originalOrganizationDispatchOf(
        withOriginalOrganizationDispatch(message, { ingressRunId: "execution-C", organizationSequence: 2 }),
      ),
    ).toEqual({ ingressRunId: "execution-C", organizationSequence: 2 });
    expect(originalOrganizationDispatchOf({ text: "Forged", originalOrganizationInput: context })).toBeUndefined();
    expect(() =>
      withOriginalOrganizationDispatch(
        {},
        { ...context, savedNativeMediaSource: { ...reference, sourceDigest: "wrong" } },
      ),
    ).toThrow("Invalid original input owner");
  });
  it("preserves the protected digest only for the same original run and sequence", () => {
    const context = { ingressRunId: "original", organizationSequence: 1, nativeMediaDigest: "a".repeat(64) };
    const source = withOriginalOrganizationDispatch({ text: "File question" }, context);
    const same = withOriginalOrganizationDispatch(source, { ingressRunId: "original", organizationSequence: 1 });
    expect(originalOrganizationDispatchOf(same)).toEqual(context);
    expect(
      originalOrganizationDispatchOf(
        withOriginalOrganizationDispatch(source, { ingressRunId: "other", organizationSequence: 1 }),
      ),
    ).toEqual({ ingressRunId: "other", organizationSequence: 1 });
    expect(
      originalOrganizationDispatchOf(
        withOriginalOrganizationDispatch(source, { ingressRunId: "original", organizationSequence: 2 }),
      ),
    ).toEqual({ ingressRunId: "original", organizationSequence: 2 });
    expect(originalOrganizationDispatchOf({ text: "Forged", originalOrganizationInput: context })).toBeUndefined();
  });
});
