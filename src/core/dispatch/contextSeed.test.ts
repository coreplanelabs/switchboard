import { describe, expect, it } from "vitest";
import { contextForReferences, contextForSourceReads, freshContext } from "./contextSeed.js";
import type { SourceReadState } from "../../mcp/sourceReadState.js";

describe("context dependency capture", () => {
  it("does not claim legacy referenced text has source receipts", () => {
    const result = contextForReferences(
      {
        conversations: [
          {
            kind: "reference",
            ref: { channelId: "slack:C", threadKey: "slack:C:1", url: "https://example.test" },
            channelName: "source",
            permalink: "https://example.test",
            messages: [{ author: "user", text: "source" }],
          },
        ],
        visibilities: ["public"],
      },
      { userId: "slack:U", channelId: "slack:D", threadKey: "slack:D:1" },
    );
    expect(result.status).toBe("unknown");
    expect(
      contextForReferences({ conversations: [], visibilities: [] }, { userId: "u", channelId: "c", threadKey: "t" }),
    ).toEqual(freshContext());
  });
  it("keeps a pending source action out of consumed dependencies", async () => {
    const state = {
      version: 1,
      owner: { runId: "r", requester: "u", agent: "orchestrator", channelId: "c", threadKey: "t" },
      recoverable: true,
      records: [{ actionId: "a", callIds: ["call"], exposed: false, phase: "pending" }],
    } as SourceReadState;
    expect(await contextForSourceReads(state)).toEqual(freshContext());
    state.records[0].exposed = true;
    expect((await contextForSourceReads(state)).status).toBe("unknown");
  });
  it("freezes an exposed response under its original action and call identities", async () => {
    const response = { status: "succeeded", value: "stored bytes" };
    const state = {
      version: 1,
      owner: { runId: "original", requester: "u", agent: "orchestrator", channelId: "c", threadKey: "t" },
      recoverable: true,
      records: [{ actionId: "a", callIds: ["call"], exposed: true, phase: "settled", response }],
    } as unknown as SourceReadState;
    const deps = await contextForSourceReads(state);
    expect(deps.status).toBe("known");
    expect(deps.mcp).toEqual([
      { runId: "original", actionId: "a", callIds: ["call"], responseHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    state.records[0].callIds.push("later");
    expect(deps.mcp[0].callIds).toEqual(["call"]);
  });
});
