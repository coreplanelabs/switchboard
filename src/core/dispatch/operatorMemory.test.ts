import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../memory/types.js";
import { InMemoryMemoryStore } from "../memory/stores.js";
import { readOperatorMemory } from "./operatorMemory.js";
import { createHash } from "node:crypto";
import { memoryContent } from "../memory/provenance.js";

const request = {
  organization: "acme",
  requester: "slack:UA",
  channelId: "slack:CA",
  text: "billing retry",
  repo: "acme/api",
  memoryConfig: { enabled: true },
  canReadScope: () => true,
};
const record = (over: Partial<MemoryRecord> = {}): MemoryRecord => {
  const value: MemoryRecord = {
    id: "mem:org:acme:1",
    scopeKey: "org:acme",
    kind: "fact",
    text: "Billing retry uses exponential backoff.",
    keywords: ["billing", "retry"],
    sourceThreadKey: "slack:CA:1.0",
    sourceRunId: "run-a",
    createdAt: 1,
    useCount: 0,
    status: "active",
    ...over,
  };
  if (!Object.hasOwn(over, "provenance"))
    value.provenance = {
      version: 1,
      scopeKey: value.scopeKey,
      contentHash: createHash("sha256")
        .update(JSON.stringify(memoryContent(value.scopeKey, value)))
        .digest("hex"),
      dependencies: { version: 1, status: "known", revision: 1, origins: [], slack: [], mcp: [] },
    };
  return value;
};

describe("operator memory source reads", () => {
  it("renders a record only after authorizing its exact stored source identity", async () => {
    const authorizeSource = vi.fn(async () => ({ ok: true as const }));
    const memory = new InMemoryMemoryStore([record()]);
    const result = await readOperatorMemory({ ...request, memory, authorizeSource });
    expect(result.memory).toContain("Billing retry uses exponential backoff.");
    expect(authorizeSource).toHaveBeenCalledExactlyOnceWith({
      runId: "run-a",
      threadKey: "slack:CA:1.0",
      scopeKey: "org:acme",
      candidate: expect.objectContaining({ id: "mem:org:acme:1", text: "Billing retry uses exponential backoff." }),
      dependencies: expect.objectContaining({ status: "known", origins: [], slack: [], mcp: [] }),
    });
    expect(result.unavailable).toEqual([]);
    expect(result.context?.memoryScopes).toEqual(["org:acme"]);
  });

  it("omits denied and missing source provenance while preserving independently authorized memory", async () => {
    const memory = new InMemoryMemoryStore([
      record(),
      record({ id: "missing", text: "Billing retry hidden legacy.", sourceRunId: undefined }),
      record({ id: "denied", text: "Billing retry hidden revoked.", sourceRunId: "run-denied" }),
      record({ id: "no-thread", text: "Billing retry hidden no thread.", sourceThreadKey: "" }),
    ]);
    const authorizeSource = vi.fn(async ({ runId }: { runId: string }) =>
      runId === "run-a" ? { ok: true as const } : { ok: false as const, code: "github-access-lost" as const },
    );
    const result = await readOperatorMemory({ ...request, memory, authorizeSource });
    expect(result.memory).toContain("Billing retry uses exponential backoff.");
    expect(result.memory).not.toContain("hidden");
    expect(result.unavailable.length).toBeGreaterThan(0);
    expect(authorizeSource).toHaveBeenCalledTimes(2);
  });

  it("applies current source checks to the repository window as well as keyword retrieval", async () => {
    const memory = new InMemoryMemoryStore([
      record({ id: "repo-ok", scopeKey: "repo:acme/api", text: "Repository retries use a queue." }),
      record({
        id: "repo-denied",
        scopeKey: "repo:acme/api",
        text: "Restricted repository fact.",
        sourceRunId: "denied",
      }),
    ]);
    const result = await readOperatorMemory({
      ...request,
      memory,
      authorizeSource: async ({ runId }) =>
        runId === "run-a" ? { ok: true } : { ok: false, code: "saved-context-unproved" },
    });
    expect(result.memory).toContain("Repository retries use a queue.");
    expect(result.memory).not.toContain("Restricted repository fact.");
  });

  it("rejects an unadmitted scope before storage and rejects records returned under a different scope", async () => {
    const memory = new InMemoryMemoryStore([record()]);
    const retrieve = vi
      .spyOn(memory, "retrieve")
      .mockResolvedValue([record({ scopeKey: "user:slack:UB", text: "Foreign billing retry." })]);
    const list = vi.spyOn(memory, "list");
    const authorizeSource = vi.fn(async () => ({ ok: true as const }));
    const result = await readOperatorMemory({
      ...request,
      memory,
      canReadScope: (scope) => scope === "user:slack:UA",
      authorizeSource,
    });
    expect(result.memory).toBeUndefined();
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0][0].scopeKey).toBe("user:slack:UA");
    expect(list).not.toHaveBeenCalled();
    expect(authorizeSource).not.toHaveBeenCalled();
  });

  it("isolates unavailable source and store reads without discarding other admitted scopes", async () => {
    const memory = new InMemoryMemoryStore([
      record({ scopeKey: "repo:acme/api" }),
      record({ sourceRunId: "unavailable" }),
    ]);
    const original = memory.retrieve.bind(memory);
    vi.spyOn(memory, "retrieve").mockImplementation((query) =>
      query.scopeKey.startsWith("user:") ? Promise.reject(new Error("store unavailable")) : original(query),
    );
    const result = await readOperatorMemory({
      ...request,
      memory,
      authorizeSource: async ({ runId }) => {
        if (runId === "unavailable") throw new Error("source unavailable");
        return { ok: true };
      },
    });
    expect(result.memory).toContain("Billing retry uses exponential backoff.");
    expect(result.unavailable.length).toBeGreaterThan(0);
  });

  it("does not touch memory or source capabilities when disabled", async () => {
    const memory = new InMemoryMemoryStore([record()]);
    const retrieve = vi.spyOn(memory, "retrieve");
    const authorizeSource = vi.fn(async () => ({ ok: true as const }));
    expect(await readOperatorMemory({ ...request, memoryConfig: { enabled: false }, memory, authorizeSource })).toEqual(
      { unavailable: [] },
    );
    expect(retrieve).not.toHaveBeenCalled();
    expect(authorizeSource).not.toHaveBeenCalled();
  });

  it("omits legacy and modified revisions before invoking the current source capability", async () => {
    const changed = record({ id: "changed" });
    changed.text = "Billing retry hidden tampered content.";
    const memory = new InMemoryMemoryStore([record(), record({ id: "legacy", provenance: undefined }), changed]);
    const authorizeSource = vi.fn(async () => ({ ok: true as const }));
    const result = await readOperatorMemory({ ...request, memory, authorizeSource });
    expect(authorizeSource).toHaveBeenCalledTimes(1);
    expect(result.memory).toContain("exponential backoff");
    expect(result.memory).not.toContain("hidden");
    expect(result.unavailable).toEqual([expect.stringContaining("revision dependencies are unproved")]);
  });

  it("returns the admitted dependency union for downstream producers and an empty envelope when no bytes were read", async () => {
    const admitted = record();
    admitted.provenance!.dependencies.origins = [
      { runId: "old-source", requester: "slack:UA", channelId: "slack:CA", threadKey: "slack:CA:1.0" },
    ];
    const denied = record({ id: "denied", sourceRunId: "denied" });
    denied.provenance!.dependencies.origins = [
      { runId: "denied-source", requester: "slack:UB", channelId: "slack:CB", threadKey: "slack:CB:1.0" },
    ];
    const result = await readOperatorMemory({
      ...request,
      memory: new InMemoryMemoryStore([admitted, denied]),
      authorizeSource: async ({ runId }) =>
        runId === "denied" ? { ok: false, code: "saved-context-unproved" } : { ok: true },
    });
    expect(result.context?.origins.map((origin) => origin.runId)).toEqual(["old-source"]);
    const empty = await readOperatorMemory({
      ...request,
      memory: new InMemoryMemoryStore(),
      authorizeSource: async () => {
        throw new Error("no source should be checked");
      },
    });
    expect(empty.context).toEqual({ version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] });
  });

  it("checks the exact immutable snapshot and preserves original dependencies across asynchronous storage mutation", async () => {
    const value = record();
    const memory = new InMemoryMemoryStore([value]);
    const result = await readOperatorMemory({
      ...request,
      memory,
      authorizeSource: async ({ candidate, dependencies }) => {
        expect(Object.isFrozen(candidate)).toBe(true);
        expect(Object.isFrozen(dependencies)).toBe(true);
        value.text = "Billing retry later unverified value.";
        value.provenance!.dependencies.status = "revoked";
        expect(candidate.text).toContain("exponential backoff");
        expect(dependencies.status).toBe("known");
        return { ok: true };
      },
    });
    expect(result.memory).toContain("exponential backoff");
    expect(result.memory).not.toContain("unverified");
  });
});
