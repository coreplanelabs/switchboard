import { describe, expect, it, vi } from "vitest";
import { loadOperatorContext } from "./operatorContext.js";
import { InMemoryMemoryStore } from "../memory/stores.js";
import { memoryContextBlock } from "../memory/index.js";

const known = { version: 1 as const, status: "known" as const, revision: 0, origins: [], slack: [], mcp: [] };
const request = {
  organization: "acme",
  requester: "slack:UA",
  channelId: "slack:CA",
  text: "fix the billing retry",
};

describe("loadOperatorContext", () => {
  it("preserves every admitted component dependency and omits unproved bytes", async () => {
    const origin = { runId: "original", requester: "slack:UA", channelId: "slack:CA", threadKey: "slack:CA:1" };
    const result = await loadOperatorContext({
      ...request,
      readNotes: async () => ({ notes: [{ session: "one", text: "unproved", updatedAt: 1 }], unavailable: [] }),
      readMemory: async () => ({ memory: "admitted", unavailable: [], context: { ...known, origins: [origin] } }),
    });
    expect(result.notes).toEqual([]);
    expect(result.memory).toBe("admitted");
    expect(result.context?.origins).toEqual([origin]);
    expect(result.unavailable.join(" ")).toContain("unproved");
  });

  it("loads durable notes independently of transcript compaction and retains their source", async () => {
    const readNotes = vi.fn(async () => ({
      notes: [{ session: "slack:CA:1:coding", text: "Billing lives in acme/payments", updatedAt: 7 }],
      unavailable: [],
      context: known,
    }));
    const context = await loadOperatorContext({ ...request, readNotes });
    expect(readNotes).toHaveBeenCalledOnce();
    expect(context.notes).toEqual([
      { session: "slack:CA:1:coding", text: "Billing lives in acme/payments", updatedAt: 7 },
    ]);
  });

  it("retrieves the caller's configured org, channel, user and authorized repository memory", async () => {
    const memory = new InMemoryMemoryStore([], { now: () => 100 });
    for (const scopeKey of ["org:acme", "channel:slack:CA", "user:slack:UA", "repo:acme/payments", "user:slack:UB"])
      await memory.write(scopeKey, [
        { kind: "fact", text: `billing retry ${scopeKey}`, sourceThreadKey: "slack:CA:1" },
      ]);
    const context = await loadOperatorContext({
      ...request,
      readMemory: async () => ({
        memory: await memoryContextBlock("acme", { enabled: true }, memory, request.text, request.requester, {
          channelId: request.channelId,
          repo: "acme/payments",
        }),
        unavailable: [],
        context: known,
      }),
    });
    for (const value of ["org:acme", "channel:slack:CA", "user:slack:UA", "repo:acme/payments"])
      expect(context.memory).toContain(value);
    expect(context.memory).not.toContain("user:slack:UB");
  });

  it("keeps source-denied notes out while retaining readable context and the omission", async () => {
    const context = await loadOperatorContext({
      ...request,
      readNotes: async () => ({
        notes: [{ session: "public-session", text: "billing context", updatedAt: 9 }],
        unavailable: ["Saved source access changed; fetch that source again."],
        context: known,
      }),
    });
    expect(context.notes).toHaveLength(1);
    expect(context.unavailable).toContain("Saved source access changed; fetch that source again.");
  });

  it("keeps memory disabled by configuration and continues when notes are unavailable", async () => {
    const memory = new InMemoryMemoryStore();
    const retrieve = vi.spyOn(memory, "retrieve");
    const context = await loadOperatorContext({
      ...request,
      readMemory: async () => ({
        memory: await memoryContextBlock("acme", undefined, memory, request.text, request.requester),
        unavailable: [],
        context: known,
      }),
      readNotes: async () => {
        throw new Error("temporarily unavailable");
      },
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(context.notes).toEqual([]);
    expect(context.memory).toBeUndefined();
    expect(context.unavailable).toEqual(["Working notes could not be read."]);
  });
});
