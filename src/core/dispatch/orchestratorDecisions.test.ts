import { describe, expect, it, vi } from "vitest";
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

const workProposal = () => ({
  source: {
    messageId: "original-message",
    userId: owner.requesterId,
    channelId: owner.channelId,
    threadKey: owner.threadKey,
    text: "Original request",
  },
  callId: "work-one",
  action: { tool: "work_start" as const, target: { repo: "acme/api" } },
  input: { words: "original input" },
  context: { revision: 1, origins: ["first"] },
});
const expectedWork = {
  version: 1,
  id: '["main-run","work-one"]',
  owner,
  source: {
    kind: "request",
    messageId: "original-message",
    textHash: "4f318d080bff7a037e6456a9c358e2cf675f0d4ce5b215b63baed68536eb6a67",
  },
  tool: "work_start",
  targetHash: "8dd1a390ef1282d683f233877c83288e159521806b8bc72bd59ddb14f9a95908",
  inputHash: "52f0b7748bf5ce9fcfbec7c6198b08f4e35d784b8a9051ddb223df087a59cf92",
  contextHash: "815520ced84e57311cbc7519cb2d23be8358d47aff36476204d9843268e156a6",
};

describe("work decision construction", () => {
  it("keeps validation before and after the owner-fenced save", async () => {
    let allowed = false;
    const writer = createOrchestratorDecisions({
      owner,
      save: async () => {
        allowed = false;
        return true;
      },
    });
    expect(await writer.recordWork(workProposal(), async () => allowed)).toBe(false);
    expect(writer.snapshot()).toEqual([]);
    allowed = true;
    expect(await writer.recordWork(workProposal(), async () => allowed)).toBe(false);
    expect(writer.snapshot()).toEqual([expectedWork]);
  });

  it("refuses an uncloneable work proposal without blocking a later valid decision", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("private log error");
    });
    try {
      const writer = createOrchestratorDecisions({ owner, save: async () => true });
      expect(await writer.recordWork(new Proxy(workProposal(), {}), async () => true)).toBe(false);
      expect(await writer.recordWork(workProposal(), async () => true)).toBe(true);
      expect(writer.snapshot()).toEqual([expectedWork]);
      expect(warning.mock.calls.map(([value]) => JSON.parse(value as string))).toEqual([
        { event: "orchestrator.decision.refused", cause: "uncloneable-proposal" },
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  it("captures the complete proposal before asynchronous context validation", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const writer = createOrchestratorDecisions({ owner, save: async () => true });
    const proposal = workProposal();
    const pending = writer.recordWork(proposal, async () => {
      if (first) {
        first = false;
        entered();
        await held;
      }
      return true;
    });
    await started;
    proposal.source.userId = "slack:FOREIGN";
    proposal.source.messageId = "later-message";
    proposal.source.text = "Later request";
    proposal.callId = "later-call";
    proposal.action.target.repo = "acme/other";
    proposal.input.words = "later input";
    proposal.context.origins.push("later");
    release();
    expect(await pending).toBe(true);
    expect(writer.snapshot()).toEqual([expectedWork]);
  });

  it("keeps later fields fixed while an earlier field hash awaits", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
      if (new TextDecoder().decode(bytes) === '"Original request"') {
        entered();
        await held;
      }
      return digest(algorithm, bytes);
    });
    try {
      const writer = createOrchestratorDecisions({ owner, save: async () => true });
      const proposal = workProposal();
      const pending = writer.recordWork(proposal, async () => true);
      await started;
      proposal.action.target.repo = "acme/other";
      proposal.input.words = "later input";
      proposal.context.revision = 2;
      release();
      expect(await pending).toBe(true);
      expect(writer.snapshot()).toEqual([expectedWork]);
    } finally {
      release();
      spy.mockRestore();
    }
  });
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
    expect(
      stored.map((entry) => ("tool" in entry ? entry.tool : "command" in entry ? entry.command : entry.kind)),
    ).toEqual(["work_start", "config.show"]);
    const restored = createOrchestratorDecisions({ owner, previous: stored, save: async () => true });
    expect(await restored.record(worker)).toBe(true);
    expect(await restored.record({ ...worker, targetHash: "e".repeat(64) })).toBe(false);
    const snapshot = restored.snapshot();
    snapshot[0].owner.requesterId = "slack:UOTHER";
    expect(restored.snapshot()[0].owner.requesterId).toBe("slack:UREADER");
    const spawn = {
      ...source,
      id: JSON.stringify([owner.runId, "spawn"]),
      tool: "spawn_run" as const,
      targetHash: "f".repeat(64),
    };
    expect(await restored.record(spawn)).toBe(true);
    const rehosted = createOrchestratorDecisions({ owner, previous: restored.snapshot(), save: async () => true });
    expect(await rehosted.record(spawn)).toBe(true);
    expect(rehosted.snapshot().at(-1)).toMatchObject({ tool: "spawn_run", targetHash: "f".repeat(64) });
    const steer = {
      ...source,
      id: JSON.stringify([owner.runId, "steer"]),
      tool: "send_to_run" as const,
      targetHash: "a".repeat(64),
    };
    expect(await rehosted.record(steer)).toBe(true);
    const restoredSteer = createOrchestratorDecisions({ owner, previous: rehosted.snapshot(), save: async () => true });
    expect(await restoredSteer.record(steer)).toBe(true);
    expect(restoredSteer.snapshot().at(-1)).toMatchObject({ tool: "send_to_run" });
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
