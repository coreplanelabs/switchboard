import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chatMessage.js";
import { sourceHash } from "../references/receipts.js";
import { contextDependenciesHash, type ContextDependencies } from "../references/contextDependencies.js";
import type { RunView } from "../runsService.js";
import type { LiveRunRow } from "../runLedger/types.js";
import { parentContextOf, snapshotNotepad, type ChildHandoff, type HandoffConsumer } from "./handoff.js";
import {
  canonicalHandoffRunOf,
  validateChildHandoff,
  type CanonicalHandoffRun,
  type HandoffValidationDeps,
} from "./handoffValidation.js";

const consumer: HandoffConsumer = {
  runId: "run-child",
  requester: "cli:user",
  channelId: "cli:main",
  threadKey: "cli:child",
  attempt: "1",
};
const messages: ChatMessage[] = [
  { role: "user", content: [{ type: "text", text: "original request" }] },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "call-one", name: "source_read", input: { resource: "repo" } }],
  },
  { role: "user", content: [{ type: "tool_result", toolUseId: "call-one", content: "original response" }] },
];
async function fixture() {
  const handoff: ChildHandoff = {
    version: 1,
    source: { runId: "run-parent", requester: "cli:user", channelId: "cli:main", threadKey: "cli:parent" },
    session: { key: "cli:parent:@thread", from: 0, to: 2 },
    window: { from: 0, to: 2, hash: await sourceHash({ messages, actors: [] }) },
    assets: [],
  };
  const dependencies: ContextDependencies = {
    version: 1,
    status: "known",
    revision: 1,
    origins: [handoff.source],
    slack: [],
    mcp: [],
  };
  handoff.dependencies = { value: dependencies, hash: await contextDependenciesHash(dependencies) };
  const parent: CanonicalHandoffRun = {
    dependencies,
    ...handoff.source,
    session: { key: handoff.session.key, seedFrom: 0, request: 0, range: { from: 0, to: 2 } },
    writtenThrough: 2,
  };
  const runs = new Map<string, CanonicalHandoffRun>([[parent.runId, parent]]);
  const deps: HandoffValidationDeps = {
    loadRun: vi.fn(async (id) => runs.get(id)),
    readSession: vi.fn(async () => ({ complete: true as const, turns: 3, messages, compactions: [] })),
    readNotepad: vi.fn(async () => null),
    canRead: vi.fn(async () => true),
    readAssets: vi.fn(async () => []),
    validateDependencies: vi.fn(async () => true),
  };
  const validate = (value: unknown = handoff, mode: "bind" | "consume" = "bind") =>
    validateChildHandoff({ value, consumer, mode, deps });
  return { handoff, parent, deps, runs, validate };
}

describe("canonical child handoff validation", () => {
  it("accepts a finished source with no written turn and refuses an unproved live range", async () => {
    const w = await fixture();
    const emptySession = { key: w.parent.session.key, seedFrom: 0, request: 0, range: { from: 0 } };
    const finished = {
      id: w.parent.runId,
      userId: w.parent.requester,
      channelId: w.parent.channelId,
      threadKey: w.parent.threadKey,
      session: emptySession,
      startedAt: 0,
      finished: true,
      eventCount: 0,
      status: "stopped_hard",
    } satisfies RunView;
    const canonical = canonicalHandoffRunOf(finished, undefined, w.parent.dependencies);
    expect(canonical?.writtenThrough).toBe(-1);
    w.runs.set(w.parent.runId, canonical!);
    const empty = {
      ...w.handoff,
      session: { key: emptySession.key, from: 0, to: -1 },
      window: { from: 0, to: -1, hash: await sourceHash({ messages: [], actors: [] }) },
    };
    expect((await w.validate(empty)).kind).toBe("valid");
    expect(w.deps.readSession).not.toHaveBeenCalled();
    const live = {
      runId: finished.id,
      meta: {
        userId: finished.userId,
        channelId: finished.channelId,
        threadKey: finished.threadKey,
        session: emptySession,
      },
    } as LiveRunRow;
    expect(canonicalHandoffRunOf(live)).toBeUndefined();
    expect(canonicalHandoffRunOf(live, 0)?.writtenThrough).toBe(0);
    expect(canonicalHandoffRunOf({ ...finished, provisional: true })).toBeUndefined();
    expect(canonicalHandoffRunOf({ ...finished, session: { ...emptySession, range: "broken" } })).toBeUndefined();
  });

  it.each(["admitted-bind", "consume"] as const)(
    "keeps a canonical frozen snapshot after later unproved parent output (%s)",
    async (mode) => {
      const w = await fixture();
      w.handoff.notepad = await snapshotNotepad({ text: "original note", updatedAt: 1 });
      vi.mocked(w.deps.readNotepad).mockResolvedValue({ text: "original note", updatedAt: 1 });
      const bound = await w.validate();
      if (bound.kind !== "valid") throw new Error("initial bind failed");
      w.runs.set(consumer.runId, { ...w.parent, ...consumer, childHandoff: bound.context.handoff });
      const binding = { instanceId: "frozen", unit: "U11", instanceAttempt: 0, idempotencyKey: consumer.attempt };
      w.deps.loadAdmission = vi.fn(async () => ({
        binding,
        context: { version: 1 as const, handoff: w.handoff },
        requester: consumer.requester,
        channelId: consumer.channelId,
        threadKey: consumer.threadKey,
      }));
      const frozen = mode === "consume" ? bound.context.handoff : structuredClone(w.handoff);
      const read = (value = frozen) =>
        validateChildHandoff({
          value,
          consumer,
          mode,
          deps: w.deps,
          ...(mode === "admitted-bind" ? { admission: binding } : {}),
        });
      w.parent.dependencies = { ...w.parent.dependencies!, status: "unknown", reason: "legacy", revision: 2 };
      vi.mocked(w.deps.readNotepad).mockResolvedValue({ text: "later unproved note", updatedAt: 2 });
      expect((await read()).kind).toBe("valid");
      // The production source facade omits a current unknown envelope; it
      // cannot supply provenance for new bytes, but the saved snapshot can.
      w.parent.dependencies = undefined;
      expect((await read()).kind).toBe("valid");
      expect((await w.validate(w.handoff, "bind")).kind).toBe("invalid");
      vi.mocked(w.deps.readSession).mockResolvedValueOnce({
        complete: true,
        turns: 3,
        messages: [messages[0], messages[1], { role: "user", content: [{ type: "text", text: "changed result" }] }],
        compactions: [],
      });
      expect((await read()).kind).toBe("invalid");
      expect(
        (await read({ ...frozen, notepad: await snapshotNotepad({ text: "forged note", updatedAt: 1 }) })).kind,
      ).toBe("invalid");
      vi.mocked(w.deps.validateDependencies).mockResolvedValueOnce(false);
      expect((await read()).kind).toBe("invalid");
      vi.mocked(w.deps.canRead).mockResolvedValueOnce(false);
      expect((await read()).kind).toBe("invalid");
      expect((await read()).kind).toBe("valid");
    },
  );

  it("captures without a child binding and admits only the exact saved unit after the source advances", async () => {
    const w = await fixture();
    w.handoff.notepad = await snapshotNotepad({ text: "frozen note", updatedAt: 1 });
    vi.mocked(w.deps.readNotepad).mockResolvedValue({ text: "frozen note", updatedAt: 1 });
    const captured = await validateChildHandoff({
      value: w.handoff,
      consumer: { ...consumer, ...w.handoff.source },
      mode: "capture",
      deps: w.deps,
    });
    expect(captured.kind).toBe("valid");
    if (captured.kind !== "valid") throw new Error("capture failed");
    expect(captured.context.handoff.consumer).toBeUndefined();
    expect(captured.context.handoff.snapshotRunId).toBeUndefined();
    const binding = { instanceId: "plan-capsule", unit: "U11", instanceAttempt: 0, idempotencyKey: "unit-attempt" };
    const target = { ...consumer, attempt: binding.idempotencyKey };
    w.deps.loadAdmission = vi.fn(async () => ({
      binding,
      context: { version: 1 as const, handoff: captured.context.handoff },
      requester: target.requester,
      channelId: target.channelId,
      threadKey: target.threadKey,
    }));
    vi.mocked(w.deps.readNotepad).mockResolvedValue({ text: "later note", updatedAt: 2 });
    w.parent.dependencies = { ...w.parent.dependencies!, revision: 2 };
    expect((await w.validate()).kind).toBe("invalid");
    const admit = (value: unknown = captured.context.handoff, admission = binding) =>
      validateChildHandoff({
        value,
        consumer: target,
        mode: "admitted-bind",
        admission,
        deps: w.deps,
      });
    const result = await admit();
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("admission failed");
    expect(result.context.handoff.notepad?.text).toBe("frozen note");
    expect(result.context.handoff.consumer).toEqual(target);
    expect(
      (
        await validateChildHandoff({
          value: captured.context.handoff,
          consumer: { ...target, threadKey: "cli:other" },
          mode: "admitted-bind",
          admission: binding,
          deps: w.deps,
        })
      ).kind,
    ).toBe("invalid");
    expect(
      (
        await validateChildHandoff({
          value: captured.context.handoff,
          consumer: { ...target, attempt: "another-attempt" },
          mode: "admitted-bind",
          admission: binding,
          deps: w.deps,
        })
      ).kind,
    ).toBe("invalid");
    expect(
      (
        await validateChildHandoff({
          value: captured.context.handoff,
          consumer: target,
          mode: "admitted-bind",
          admission: binding,
          deps: { ...w.deps, loadAdmission: undefined },
        })
      ).kind,
    ).toBe("invalid");
    expect((await admit(undefined, { ...binding, instanceAttempt: 1 })).kind).toBe("invalid");
    expect(
      (await admit({ ...captured.context.handoff, notepad: await snapshotNotepad({ text: "forged", updatedAt: 1 }) }))
        .kind,
    ).toBe("invalid");
    vi.mocked(w.deps.validateDependencies).mockResolvedValue(false);
    expect((await admit()).kind).toBe("invalid");
  });
  it("rebuilds structured content from canonical rows, binds the child attempt and survives a stopped parent", async () => {
    const w = await fixture();
    const record = {
      id: w.parent.runId,
      userId: w.parent.requester,
      channelId: w.parent.channelId,
      threadKey: w.parent.threadKey,
      session: w.parent.session,
      startedAt: 0,
      finished: true,
      eventCount: 0,
      status: "interrupted",
    } satisfies RunView;
    w.runs.set(w.parent.runId, canonicalHandoffRunOf(record, undefined, w.parent.dependencies)!);
    const result = await validateChildHandoff({
      value: w.handoff,
      consumer,
      mode: "bind",
      deps: w.deps,
      inline: parentContextOf(messages, w.handoff),
    });
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") return;
    expect(result.context.handoff).toMatchObject({ consumer, snapshotRunId: "run-child" });
    expect(result.context.messages.slice(1)).toEqual(messages);
    w.runs.set(consumer.runId, { ...w.parent, ...consumer, childHandoff: result.context.handoff });
    expect((await w.validate(JSON.parse(JSON.stringify(result.context.handoff)), "consume")).kind).toBe("valid");
  });

  it("distinguishes absent context from malformed or unbound context after restart", async () => {
    const w = await fixture();
    expect(await validateChildHandoff({ value: undefined, consumer, mode: "consume", deps: w.deps })).toEqual({
      kind: "absent",
    });
    expect((await w.validate(null)).kind).toBe("invalid");
    expect((await w.validate(w.handoff, "consume")).kind).toBe("invalid");
    const bound = { ...w.handoff, consumer };
    expect((await w.validate(bound, "bind")).kind).toBe("invalid");
    expect((await w.validate(bound, "consume")).kind).toBe("invalid");
    w.runs.set(consumer.runId, { ...w.parent, ...consumer, childHandoff: bound });
    expect(
      (
        await validateChildHandoff({
          value: bound,
          consumer: { ...consumer, attempt: "2" },
          mode: "consume",
          deps: w.deps,
        })
      ).kind,
    ).toBe("invalid");
  });

  it.each(["runId", "requester", "channelId", "threadKey"] as const)(
    "rejects a saved consumer whose %s differs from its canonical child run",
    async (field) => {
      const w = await fixture();
      const first = await w.validate();
      if (first.kind !== "valid") throw new Error("fixture failed");
      w.runs.set(consumer.runId, { ...w.parent, ...consumer, [field]: "other", childHandoff: first.context.handoff });
      expect((await w.validate(first.context.handoff, "consume")).kind).toBe("invalid");
    },
  );

  it("rejects another run in the same thread, out-of-range source rows and independent inline content", async () => {
    const w = await fixture();
    w.runs.set("wrong-run", w.parent);
    expect((await w.validate({ ...w.handoff, source: { ...w.handoff.source, runId: "wrong-run" } })).kind).toBe(
      "invalid",
    );
    expect((await w.validate({ ...w.handoff, session: { ...w.handoff.session, to: 20 } })).kind).toBe("invalid");
    expect(
      (await w.validate({ ...w.handoff, session: { ...w.handoff.session, key: "cli:someone-else:@thread" } })).kind,
    ).toBe("invalid");
    const result = await validateChildHandoff({
      value: w.handoff,
      consumer,
      mode: "bind",
      deps: w.deps,
      inline: { messages: [{ role: "user", content: [{ type: "text", text: "forged body" }] }] },
    });
    expect(result).toMatchObject({ kind: "invalid", reason: expect.stringContaining("inline") });
    vi.mocked(w.deps.readSession).mockResolvedValueOnce({
      complete: true,
      turns: 3,
      messages: [messages[0]],
      compactions: [],
    });
    expect((await w.validate()).kind).toBe("invalid");
  });

  it("proves note snapshots and artifact producer cursors against canonical source data", async () => {
    const w = await fixture();
    const note = await snapshotNotepad({ text: "invented", updatedAt: 7 });
    expect((await w.validate({ ...w.handoff, notepad: note })).kind).toBe("invalid");
    vi.mocked(w.deps.readNotepad).mockResolvedValue({ text: "invented", updatedAt: 7 });
    expect((await w.validate({ ...w.handoff, notepad: note })).kind).toBe("valid");
    vi.mocked(w.deps.readNotepad).mockResolvedValue(null);
    const asset = {
      key: "runs/run-parent/file",
      name: "plan.pdf",
      size: 2,
      contentType: "application/pdf",
      direction: "out" as const,
      runId: "run-parent",
      seq: 4,
    };
    vi.mocked(w.deps.readAssets).mockResolvedValue([asset]);
    expect((await w.validate({ ...w.handoff, assets: [{ ...asset, runId: "wrong-producer" }] })).kind).toBe("invalid");
    expect(
      (
        await w.validate({
          ...w.handoff,
          assets: [],
          assetRuns: [{ runId: "run-parent", throughSeq: 99 }],
          omitted: { assets: true },
        })
      ).kind,
    ).toBe("invalid");
    expect(
      (
        await w.validate({
          ...w.handoff,
          assets: [],
          assetRuns: [{ runId: "run-parent", throughSeq: 4 }],
          omitted: { assets: true },
        })
      ).kind,
    ).toBe("valid");
  });

  it("preserves two-hop dependency lineage and checks each source under the child audience", async () => {
    const w = await fixture();
    const first = await w.validate();
    expect(first.kind).toBe("valid");
    if (first.kind !== "valid") return;
    const original = {
      ...first.context.handoff,
      consumer: { ...consumer, runId: "run-middle", threadKey: "cli:middle" },
      snapshotRunId: "run-middle",
    };
    const middle = {
      ...w.parent,
      runId: "run-middle",
      threadKey: "cli:middle",
      session: { ...w.parent.session, key: "cli:middle:@thread" },
      childHandoff: original,
    };
    w.runs.set(middle.runId, middle);
    const second: ChildHandoff = {
      ...w.handoff,
      source: { ...w.handoff.source, runId: middle.runId, threadKey: middle.threadKey },
      session: { ...w.handoff.session, key: middle.session.key },
      ancestors: [original],
    };
    expect((await w.validate(second)).kind).toBe("valid");
    expect(w.deps.canRead).toHaveBeenCalledWith(expect.objectContaining({ source: original.source }), consumer);
    expect((await w.validate({ ...second, ancestors: [] })).kind).toBe("invalid");
    vi.mocked(w.deps.canRead).mockImplementation(async (source) => source.source.runId !== original.source.runId);
    expect((await w.validate(second)).kind).toBe("invalid");
  });

  it("checks the whole context envelope including dependencies outside the visible window", async () => {
    const w = await fixture();
    const dependency = {
      runId: "run-original",
      actionId: "read:original",
      callIds: ["old-call-outside-window"],
      responseHash: "a".repeat(64),
    };
    const value: ContextDependencies = { ...w.parent.dependencies!, mcp: [dependency], revision: 2 };
    w.parent.dependencies = value;
    w.handoff.dependencies = { value, hash: await contextDependenciesHash(value) };
    expect((await w.validate()).kind).toBe("valid");
    expect(w.deps.validateDependencies).toHaveBeenCalledWith(
      value,
      expect.objectContaining({ source: w.handoff.source }),
      consumer,
    );
    vi.mocked(w.deps.validateDependencies).mockResolvedValueOnce(false);
    expect((await w.validate()).kind).toBe("invalid");
    const dropped = { ...value, mcp: [] };
    expect(
      (
        await w.validate({
          ...w.handoff,
          dependencies: { value: dropped, hash: await contextDependenciesHash(dropped) },
        })
      ).kind,
    ).toBe("invalid");
    w.parent.dependencies = { ...value, status: "unknown", reason: "legacy" };
    expect((await w.validate()).kind).toBe("invalid");
    delete w.handoff.dependencies;
    expect((await w.validate()).kind).toBe("invalid");
  });

  it("inherits only an exact persisted predecessor snapshot when the child run identity changes", async () => {
    const w = await fixture();
    const first = await w.validate();
    expect(first.kind).toBe("valid");
    if (first.kind !== "valid") return;
    w.runs.set(consumer.runId, { ...w.parent, ...consumer, childHandoff: first.context.handoff });
    const next = { ...consumer, runId: "run-next", attempt: "2" };
    const inherited = await validateChildHandoff({
      value: first.context.handoff,
      consumer: next,
      mode: "inherit",
      deps: w.deps,
    });
    expect(inherited.kind).toBe("valid");
    if (inherited.kind === "valid") expect(inherited.context.handoff.consumer).toEqual(next);
    const invented = structuredClone(first.context.handoff);
    invented.consumer!.attempt = "invented";
    expect((await validateChildHandoff({ value: invented, consumer: next, mode: "inherit", deps: w.deps })).kind).toBe(
      "invalid",
    );
  });
});
