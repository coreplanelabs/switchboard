import { describe, expect, it } from "vitest";
import {
  createOrchestratorDecisions,
  type OrchestratorCommandDecision,
  type OrchestratorDecision,
} from "./orchestratorDecisions.js";

const owner = {
  runId: "main-run",
  requesterId: "slack:UREADER",
  channelId: "slack:DTEST",
  threadKey: "slack:DTEST:1.0",
};
const decision = (call = "first"): OrchestratorCommandDecision => ({
  version: 1,
  id: JSON.stringify(["main-run", call]),
  owner,
  source: { kind: "request", messageId: "1", textHash: "a".repeat(64) },
  command: "config.show",
  line: "config show",
  inputHash: "b".repeat(64),
  contextHash: "c".repeat(64),
});

describe("orchestrator decision records", () => {
  it("uses one history and identity space for commands and worker decisions", async () => {
    let stored: readonly OrchestratorDecision[] = [];
    const writer = createOrchestratorDecisions({
      owner,
      save: async (entries) => {
        stored = entries;
        return true;
      },
    });
    const { command: _command, line: _line, ...source } = decision("worker");
    const worker = { ...source, tool: "work_start" as const, targetHash: "d".repeat(64) };
    expect(await writer.record(worker)).toBe(true);
    expect(await writer.record(decision("command"))).toBe(true);
    expect(await writer.record(decision("worker"))).toBe(false);
    expect(stored.map((entry) => ("tool" in entry ? entry.tool : entry.command))).toEqual([
      "work_start",
      "config.show",
    ]);
    const restored = createOrchestratorDecisions({ owner, previous: stored, save: async () => true });
    expect(await restored.record(worker)).toBe(true);
    expect(await restored.record({ ...worker, targetHash: "e".repeat(64) })).toBe(false);
    const snapshot = restored.snapshot();
    snapshot[0].owner.requesterId = "slack:UOTHER";
    expect(restored.snapshot()[0].owner.requesterId).toBe("slack:UREADER");
  });
  it("retains concurrent selections and reuses only an identical saved decision", async () => {
    let stored: readonly OrchestratorDecision[] = [];
    const writer = createOrchestratorDecisions({
      owner,
      save: async (entries) => {
        stored = entries;
        return true;
      },
    });
    expect(await Promise.all([writer.record(decision("first")), writer.record(decision("second"))])).toEqual([
      true,
      true,
    ]);
    const restored = createOrchestratorDecisions({
      owner,
      previous: stored,
      save: async (entries) => {
        stored = entries;
        return true;
      },
    });
    expect(await restored.record(decision("first"))).toBe(true);
    expect(await restored.record({ ...decision("first"), inputHash: "d".repeat(64) })).toBe(false);
    expect(stored.map((entry) => entry.id)).toEqual(['["main-run","first"]', '["main-run","second"]']);
  });

  it("refuses another owner or an identity outside the original run", async () => {
    let stored: readonly OrchestratorDecision[] = [];
    const writer = createOrchestratorDecisions({
      owner,
      save: async (entries) => {
        stored = entries;
        return true;
      },
    });
    expect(await writer.record({ ...decision(), owner: { ...owner, requesterId: "slack:UOTHER" } })).toBe(false);
    expect(await writer.record({ ...decision(), id: '["another-run","first"]' })).toBe(false);
    expect(await writer.record(decision())).toBe(true);
    expect(stored[0].owner).toEqual({
      runId: "main-run",
      requesterId: "slack:UREADER",
      channelId: "slack:DTEST",
      threadKey: "slack:DTEST:1.0",
    });
  });

  it.each([
    null,
    {},
    [null],
    [{ ...decision(), owner: null }],
    [{ ...decision(), source: null }],
    [{ ...decision(), version: 2 }],
    [decision(), decision()],
  ])("holds malformed or unsupported history: %j", async (previous) => {
    const held = createOrchestratorDecisions({ owner, previous, save: async () => true });
    expect(await held.record(decision("next"))).toBe(false);
    expect(() => held.snapshot()).toThrow("The retained orchestrator decisions could not be verified.");
    const current = createOrchestratorDecisions({ owner, previous: [decision()], save: async () => true });
    expect(await current.record(decision("next"))).toBe(true);
  });

  it.each([false, "throw"])("stops further admissions after a failed acknowledgement: %s", async (failure) => {
    let accepted = false;
    const writer = createOrchestratorDecisions({
      owner,
      save: async () => {
        if (failure === "throw") throw new Error("store failed");
        return accepted;
      },
    });
    expect(await writer.record(decision())).toBe(false);
    accepted = true;
    expect(await writer.record(decision("second"))).toBe(false);
    const fresh = createOrchestratorDecisions({ owner, save: async () => accepted });
    expect(await fresh.record(decision())).toBe(true);
  });

  it("refuses capacity overflow while retaining the accepted records", async () => {
    let stored: readonly OrchestratorDecision[] = [];
    const writer = createOrchestratorDecisions({
      owner,
      save: async (entries) => {
        stored = entries;
        return true;
      },
    });
    for (let i = 0; i < 256; i++) expect(await writer.record(decision(`call-${i}`))).toBe(true);
    expect(await writer.record(decision("overflow"))).toBe(false);
    expect(stored.length).toBe(256);
    expect(stored.at(-1)?.id).toBe('["main-run","call-255"]');
  });

  it("holds a selection that would exceed the metadata byte budget", async () => {
    const largeOwner = {
      ...owner,
      requesterId: "slack:U" + "x".repeat(400),
      channelId: "slack:D" + "x".repeat(400),
      threadKey: "slack:D" + "x".repeat(400),
    };
    let stored: readonly OrchestratorDecision[] = [];
    const writer = createOrchestratorDecisions({
      owner: largeOwner,
      save: async (entries) => {
        stored = entries;
        return true;
      },
    });
    let held = false;
    for (let i = 0; i < 256; i++) {
      const entry = { ...decision(`bytes-${i}`), owner: largeOwner, line: "x".repeat(1_024) };
      if (!(await writer.record(entry))) {
        held = true;
        break;
      }
    }
    expect(held).toBe(true);
    expect(stored[0].id).toBe('["main-run","bytes-0"]');
    expect(new TextEncoder().encode(JSON.stringify(stored)).byteLength <= 262_144).toBe(true);
  });
});
