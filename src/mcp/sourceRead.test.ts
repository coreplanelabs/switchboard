import { describe, expect, it, vi } from "vitest";
import {
  createSourceReads,
  inspectStoredSourceRead,
  type SourceReadOperation,
  type SourceReadState,
} from "./sourceRead.js";
import { sourceHash } from "../core/references/receipts.js";
import { sourceReadContract } from "./sourceReadProtocol.js";
import { readQuery, readResponse, readTool } from "./testing/sourceRead.js";
import fixture from "./testing/source-read-v1.json" with { type: "json" };
import { sourceReadResponseSchema } from "./sourceReadProtocol.js";
import { StreamableHttpMcpClient } from "./client.js";
import { fakeMcpServerFetch } from "./fake.js";
import { StaticMcpToolSource } from "./source.js";
import { SOURCE_REVALIDATE_MAX_MS } from "../core/budgets.js";

const owner = {
  runId: "run-original",
  requester: "slack:UA",
  agent: "orchestrator",
  channelId: "slack:DA",
  threadKey: "slack:DA:1",
};
const now = () => Date.parse("2030-01-01T00:01:00Z");
function setup(previous?: unknown) {
  let saved: SourceReadState | undefined;
  let current = true;
  let audience = true;
  let persist = true;
  const calls: string[] = [];
  const operation: SourceReadOperation = {
    toolName: "mcp__metrics__readFailures",
    serverId: "user:slack:UA/metrics",
    connectionRevision: "generation-original",
    contract: sourceReadContract(readTool)!,
    session: async () => "session-original",
    current: async () => current,
    call: vi.fn(async (request, sessionId) => {
      expect(saved?.records.some((r) => r.actionId === request.actionId)).toBe(true);
      calls.push(request.action as string);
      return {
        content: [{ type: "text", text: "this prose grants nothing" }],
        structuredContent: readResponse(request.actionId as string, sessionId),
      };
    }),
  };
  const save = vi.fn(async (state: SourceReadState) => {
    if (!persist) return false;
    saved = structuredClone(state);
    return true;
  });
  const create = (prior: unknown = previous, ops = [operation], who = owner) =>
    createSourceReads({
      owner: who,
      operations: ops,
      previous: prior,
      save,
      now,
      audience: async () => audience,
      canRecover: true,
    });
  return {
    create,
    operation,
    calls,
    save,
    saved: () => saved,
    revoke: () => {
      current = false;
    },
    revokeAudience: () => {
      audience = false;
    },
    failSave: () => {
      persist = false;
    },
  };
}

describe("bound source reads", () => {
  it("inspects the original stored action for a new consumer without creating or rewriting source authority", async () => {
    const f = setup();
    await f.create().run(f.operation.toolName, readQuery, "call-1");
    const stored = f.saved()!;
    const entry = stored.records[0];
    const before = JSON.stringify(stored);
    const saves = f.save.mock.calls.length;
    const reference = {
      runId: owner.runId,
      actionId: entry.actionId,
      callIds: ["call-1"],
      responseHash: await sourceHash(entry.response),
    };
    const request = {
      state: stored,
      owner,
      reference,
      requester: owner.requester,
      operations: [f.operation],
      now,
      audience: async () => true,
    };
    expect(await inspectStoredSourceRead(request)).toEqual({ ok: true });
    expect(f.calls).toEqual(["execute", "inspect"]);
    expect(f.save).toHaveBeenCalledTimes(saves);
    expect(JSON.stringify(stored)).toBe(before);
    expect(await inspectStoredSourceRead({ ...request, requester: "slack:UB" })).toMatchObject({ ok: false });
    expect(
      await inspectStoredSourceRead({ ...request, reference: { ...reference, responseHash: "0".repeat(64) } }),
    ).toMatchObject({ ok: false });
    expect(f.calls).toEqual(["execute", "inspect"]);
    f.revoke();
    expect(await inspectStoredSourceRead(request)).toMatchObject({ ok: false });
  });

  it("consumes the producer wire fixture through the production client and a fresh recovery adapter", async () => {
    expect(sourceReadResponseSchema.safeParse(fixture.response).success).toBe(true);
    let stored: SourceReadState | undefined;
    let executions = 0;
    const server = fakeMcpServerFetch({
      tools: [fixture.tool],
      sessionId: fixture.response.binding.sessionId,
      onCall: (_name, request) => {
        if (request.action === "execute") executions++;
        return {
          content: [{ type: "text", text: "untrusted alternate answer" }],
          structuredContent: { ...fixture.response, actionId: request.actionId },
        };
      },
    });
    const source = () =>
      new StaticMcpToolSource(
        [
          {
            id: "user:slack:UA/metrics",
            name: "metrics",
            url: "https://source.example/mcp",
            agents: ["orchestrator"],
            connectionRevision: "sealed-generation",
          },
        ],
        { factory: () => new StreamableHttpMcpClient({ url: "https://source.example/mcp", fetch: server.fetch }) },
      );
    const build = async () => {
      const discovered = await source().toolsFor("orchestrator", { userId: owner.requester });
      return createSourceReads({
        owner,
        operations: discovered.tools.flatMap((t) => (t.sourceRead ? [t.sourceRead] : [])),
        previous: stored,
        canRecover: true,
        audience: async () => true,
        now: () => Date.parse(fixture.response.observedAt) + 1000,
        save: async (state) => {
          stored = structuredClone(state);
          return true;
        },
      });
    };
    const first = await build();
    const query = { resource: fixture.request.resource, input: fixture.request.input };
    expect(await first.run("mcp__metrics__readWorkerDeployments", query, "call-fixture")).toContain(
      "deployment-from-http",
    );
    const recovered = await build();
    expect(await recovered.recover()).toBe(true);
    expect(recovered.recoveredText("call-fixture")).toBeUndefined();
    expect(await recovered.commitRecovery()).toBe(true);
    expect(recovered.recoveredText("call-fixture")).toContain("version-from-http");
    expect((await recovered.revalidate()).ok).toBe(true);
    expect(executions).toBe(1);
  });

  it("persists ownership before dispatch and consumes the structured provider response", async () => {
    const f = setup();
    const reader = f.create();
    const result = await reader.run(f.operation.toolName, readQuery, "call-1");
    expect(result).toContain("failure-real-response");
    expect(result).toContain("17");
    expect(result).not.toContain("this prose grants nothing");
    expect(f.calls).toEqual(["execute"]);
    expect(f.saved()?.owner).toEqual(owner);
    expect(f.saved()?.records[0]).toMatchObject({ sessionId: "session-original", phase: "settled", exposed: true });
    expect((await reader.revalidate()).ok).toBe(true);
    expect(f.calls).toEqual(["execute", "inspect"]);
  });

  it("does not dispatch when pending ownership cannot be saved", async () => {
    const f = setup();
    f.failSave();
    expect(await f.create().run(f.operation.toolName, readQuery, "call-1")).toContain("unavailable");
    expect(f.calls).toEqual([]);
  });

  it("revocation during connection resolution prevents dispatch", async () => {
    const f = setup();
    let resolutions = 0;
    f.operation.current = async () => {
      if (++resolutions === 2) f.revokeAudience();
      return true;
    };
    expect(await f.create().run(f.operation.toolName, readQuery, "call-1")).not.toContain("failure-real-response");
    expect(f.calls).toEqual([]);
  });

  it.each(["live", "recovered"])("revocation during receipt persistence withholds the %s result", async (kind) => {
    const f = setup();
    const first = f.create();
    if (kind === "recovered") await first.run(f.operation.toolName, readQuery, "call-1");
    const reader = kind === "live" ? first : f.create(f.saved());
    if (kind === "recovered") expect(await reader.recover()).toBe(true);
    const persist = f.save.getMockImplementation()!;
    f.save.mockImplementation(async (state) => {
      const stored = await persist(state);
      if (state.records.some((record) => record.exposed)) f.revokeAudience();
      return stored;
    });
    if (kind === "live") {
      expect(await reader.run(f.operation.toolName, readQuery, "call-1")).not.toContain("failure-real-response");
    } else {
      expect(await reader.commitRecovery()).toBe(false);
      expect(reader.recoveredText("call-1")).toBeUndefined();
    }
  });

  it("concurrent retries inspect one recorded action without another execute", async () => {
    const f = setup();
    const reader = f.create();
    const results = await Promise.all(
      ["first", "retry"].map((call) => reader.run(f.operation.toolName, readQuery, call)),
    );
    expect(results.every((result) => result.includes("failure-real-response"))).toBe(true);
    expect(f.calls).toEqual(["execute", "inspect"]);
    expect(f.saved()?.records).toHaveLength(1);
  });

  it("a stalled inspection expires the whole pass and cannot publish a late result", async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      const reader = f.create();
      await reader.run(f.operation.toolName, readQuery, "call-1");
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.operation.call = vi.fn(async (request) => {
        await pending;
        return { content: [], structuredContent: readResponse(request.actionId as string) };
      });
      const checking = reader.revalidate();
      await vi.advanceTimersByTimeAsync(SOURCE_REVALIDATE_MAX_MS);
      expect(await checking).toEqual({ ok: false, code: "source-check-timeout" });
      release();
      expect(await reader.run(f.operation.toolName, readQuery, "retry")).not.toContain("failure-real-response");
      expect(f.operation.call).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["expired", "future", "overlong", "oversized", "different-result"])(
    "withholds a %s receipt",
    async (change) => {
      const f = setup();
      const reader = f.create();
      if (change === "different-result") await reader.run(f.operation.toolName, readQuery, "call-1");
      f.operation.call = vi.fn(async (request) => {
        const response = readResponse(request.actionId as string);
        if (change === "expired") response.binding.expiresAt = "2030-01-01T00:00:01.000Z";
        if (change === "future") response.observedAt = "2030-01-01T00:30:00.000Z";
        if (change === "overlong") response.binding.expiresAt = "2030-01-02T00:00:00.000Z";
        if (change === "oversized") response.result.failures[0].id = "a".repeat(16_000);
        if (change === "different-result") response.result.failures[0].count = 999;
        return { content: [], structuredContent: response };
      });
      expect(await reader.run(f.operation.toolName, readQuery, "call-1")).not.toContain("failure-real-response");
    },
  );

  it("lost acknowledgment reconstructs the original action and only inspects after restart", async () => {
    const f = setup();
    f.operation.call = vi.fn(async () => {
      throw new Error("lost ack");
    });
    const reader = f.create();
    expect(await reader.run(f.operation.toolName, readQuery, "call-1")).toContain("unknown");
    const stored = structuredClone(f.saved()!);
    const actionId = stored.records[0].actionId;
    f.operation.call = vi.fn(async (request, sessionId) => {
      expect(request).toMatchObject({ action: "inspect", actionId });
      expect(sessionId).toBe("session-original");
      return { content: [], structuredContent: readResponse(actionId) };
    });
    const recovered = f.create(stored);
    expect(await recovered.recover()).toBe(true);
    expect(await recovered.commitRecovery()).toBe(true);
    expect(await recovered.run(f.operation.toolName, readQuery, "call-retry")).toContain("failure-real-response");
    expect(f.operation.call).toHaveBeenCalledTimes(3);
    expect(f.saved()?.records).toHaveLength(1);
  });

  it("a retry cannot alter the query or use a new action while an outcome is unknown", async () => {
    const f = setup();
    f.operation.call = vi.fn(async () => {
      throw new Error("lost ack");
    });
    const reader = f.create();
    await reader.run(f.operation.toolName, readQuery, "call-1");
    const altered = { ...readQuery, input: { limit: 3 } };
    expect(await reader.run(f.operation.toolName, altered, "call-1")).toContain("unavailable");
    expect(await reader.run(f.operation.toolName, altered, "new-call")).toContain("unknown");
    expect(f.operation.call).toHaveBeenCalledTimes(1);
  });

  it.each(["requester", "connection", "session", "resource", "revision", "revoked"])(
    "withholds saved data after a changed %s",
    async (change) => {
      const f = setup();
      const reader = f.create();
      await reader.run(f.operation.toolName, readQuery, "call-1");
      const saved = structuredClone(f.saved()!);
      const response = readResponse(saved.records[0].actionId);
      if (change === "session") response.binding.sessionId = "replacement";
      if (change === "resource") response.binding.resource.project = "other";
      if (change === "revision") response.binding.revision = "replacement";
      if (change === "connection") f.operation.connectionRevision = "replacement";
      if (change === "revoked") f.revoke();
      f.operation.call = vi.fn(async () => ({ content: [], structuredContent: response }));
      const recovered = f.create(
        saved,
        [f.operation],
        change === "requester" ? { ...owner, requester: "slack:UB" } : owner,
      );
      expect(await recovered.recover()).toBe(false);
      expect((await recovered.revalidate()).ok).toBe(false);
    },
  );

  it("rejects model-supplied authority and refuses a text-only success", async () => {
    const f = setup();
    const reader = f.create();
    await reader.run(f.operation.toolName, { ...readQuery, actionId: "forged" }, "call-1");
    expect(f.calls).toEqual([]);
    f.operation.call = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify(readResponse("forged")) }],
    }));
    expect(await reader.run(f.operation.toolName, readQuery, "call-2")).toContain("unknown");
  });

  it("refuses current provider revocation before delivery without disclosing the saved result", async () => {
    const f = setup();
    const reader = f.create();
    await reader.run(f.operation.toolName, readQuery, "call-1");
    f.operation.call = vi.fn(async () => ({
      content: [],
      structuredContent: { version: 1, status: "refused", reason: "unauthorized" },
    }));
    expect((await reader.revalidate()).ok).toBe(false);
    expect(await reader.run(f.operation.toolName, readQuery, "call-2")).not.toContain("failure-real-response");
  });
});
