import { describe, expect, it } from "vitest";
import { mergeSessionSources, sourcesBelongToSession } from "./receipts.js";
import { testSessionSources } from "../testing/slackSources.js";

describe("source metadata belongs to the persisted session owner", () => {
  const address = { channelId: "slack:D1", threadKey: "slack:D1:1.0", userId: "slack:U11" };
  const sources = testSessionSources(address);
  const owner = {
    key: "plan-p:unit:coding",
    threadKey: address.threadKey,
    channelId: address.channelId,
    requester: address.userId,
  };

  it("keeps whole-context completeness independent of a changed direct Slack tracker binding", () => {
    const context = { version: 1 as const, status: "known" as const, revision: 0, origins: [], slack: [], mcp: [] };
    const first = { ...testSessionSources(address), context };
    const next = { ...testSessionSources({ ...address, userId: "slack:OTHER" }), context };
    expect(mergeSessionSources(first, next, false)).toMatchObject({ status: "unknown", context: { status: "known" } });
    expect(mergeSessionSources(first, { version: 1, status: "revoked", context }, false).context?.status).toBe(
      "revoked",
    );
  });

  it("accepts a canonical working lane using its claimed requester and thread", () => {
    expect(sourcesBelongToSession(owner.key, sources, owner)).toBe(true);
    expect(sourcesBelongToSession(owner.key, sources)).toBe(false);
  });

  it("never falls back to a matching legacy prefix after an owner check failed", () => {
    const key = `${address.threadKey}:coding`;
    expect(sourcesBelongToSession(key, sources)).toBe(true);
    expect(sourcesBelongToSession(key, sources, null)).toBe(false);
    expect(sourcesBelongToSession(key, sources, { ...owner, key, requester: "slack:OTHER" })).toBe(false);
    expect(sourcesBelongToSession(key, sources, { ...owner, key, threadKey: "slack:D2:2.0" })).toBe(false);
    expect(sourcesBelongToSession(key, sources, owner)).toBe(false);
  });
});
