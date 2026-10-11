import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chatMessage.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { turnRows } from "../runLedger/transcript.js";
import { sessionCapabilityFor } from "../../tools/session.js";
import { contextDependenciesHash, type ContextDependencies } from "../references/contextDependencies.js";
import { capturePrivateWorkContext } from "./mainContextCapture.js";
import { validateChildHandoff, type CanonicalHandoffRun, type HandoffValidationDeps } from "./handoffValidation.js";
import type { HandoffConsumer } from "./handoff.js";

async function fixture() {
  const ledger = new InMemoryRunLedger();
  const source = { runId: "parent", requester: "cli:owner", channelId: "cli:private", threadKey: "cli:parent" };
  const session = { key: "cli:parent:@thread", seedFrom: 0, request: 0, range: { from: 0, to: 4 } };
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "Investigate the failure; retain the original workspace." }] },
    { role: "assistant", content: [{ type: "tool_use", id: "read", name: "read", input: {} }] },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "read",
          content: "FAIL exact_original_test\n" + "irrelevant exploration\n".repeat(100),
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Correction: use staging only." },
        { type: "document", mediaType: "application/pdf", name: "scope.pdf", data: "cGRm" },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "pending", name: "read", input: { path: "unknown" } }] },
  ];
  for (let idx = 0; idx < messages.length; idx++) {
    const { rows } = turnRows(idx, messages[idx], {}, idx === 0 || idx === 3 ? source.requester : undefined);
    expect(await ledger.appendSession(session.key, `row-${idx}`, rows)).toEqual({ ok: true, appended: true });
  }
  await ledger.claimSession(session.key, source.runId, "generation");
  await ledger.writeNotepad(
    session.key,
    "generation",
    "The failure is retained at turn 2. Keep the workspace; inspect staging.",
    source.runId,
  );
  const reads: [number, number | undefined][] = [];
  const writeThrough = {
    readSession: async (key: string, from: number, to?: number) => {
      reads.push([from, to]);
      return ledger.readSession(key, from, to);
    },
    readSessionTail: async (_key: string, _maxBytes: number) => {
      return { from: 2, transcript: await ledger.readSession(session.key, 2, 4) };
    },
    readNotepad: ledger.readNotepad.bind(ledger),
    searchSession: ledger.searchSession.bind(ledger),
    writeNotepad: (key: string, text: string, runId: string) => ledger.writeNotepad(key, "generation", text, runId),
  };
  const capability = sessionCapabilityFor({ session, runId: source.runId }, writeThrough)!;
  const dependencies: ContextDependencies = {
    version: 1,
    status: "known",
    revision: 1,
    origins: [source],
    slack: [],
    mcp: [],
  };
  const captureDependencies = async () => dependencies;
  const parent: CanonicalHandoffRun = { ...source, session, writtenThrough: 4, dependencies };
  const runs = new Map([[source.runId, parent]]);
  let access = true;
  const deps: HandoffValidationDeps = {
    loadRun: async (id) => runs.get(id),
    readSession: ledger.readSession.bind(ledger),
    readNotepad: ledger.readNotepad.bind(ledger),
    canRead: async () => access,
    readAssets: async () => [],
    validateDependencies: async () => access,
  };
  const consumer: HandoffConsumer = {
    runId: "child",
    requester: source.requester,
    channelId: source.channelId,
    threadKey: "cli:child",
    attempt: "1",
  };
  return {
    ledger,
    source,
    session,
    capability,
    writeThrough,
    dependencies,
    captureDependencies,
    reads,
    runs,
    deps,
    consumer,
    revoke: () => {
      access = false;
    },
  };
}

describe("focused child handoff consumers", () => {
  it("captures a bounded brief and reconstructs it on child restart without losing original recall", async () => {
    const w = await fixture();
    const captured = await w.capability.captureHandoff!(w.source, w.captureDependencies, 4);
    expect(captured.messages.slice(1)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Frozen parent working notes (source evidence):\nThe failure is retained at turn 2. Keep the workspace; inspect staging.",
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Investigate the failure; retain the original workspace." }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Correction: use staging only." },
          { type: "document", mediaType: "application/pdf", name: "scope.pdf", data: "cGRm" },
        ],
      },
    ]);
    expect(captured.actors).toEqual([undefined, undefined, "cli:owner", "cli:owner"]);
    expect(w.reads).toEqual([[0, 0]]);
    expect(captured.handoff?.brief?.request).toBe(0);
    expect(JSON.stringify(captured.messages)).not.toContain("exact_original_test");
    const bound = await validateChildHandoff({
      value: captured.handoff,
      consumer: w.consumer,
      mode: "bind",
      deps: w.deps,
      inline: captured,
    });
    expect(bound.kind).toBe("valid");
    if (bound.kind !== "valid") throw new Error("expected bound source");
    w.runs.set(w.consumer.runId, {
      ...w.consumer,
      session: { key: "cli:child:@thread", seedFrom: 0, request: 0, range: { from: 0 } },
      writtenThrough: 0,
      childHandoff: bound.context.handoff,
    });
    const restored = await validateChildHandoff({
      value: JSON.parse(JSON.stringify(bound.context.handoff)),
      consumer: w.consumer,
      mode: "consume",
      deps: w.deps,
    });
    expect(restored.kind).toBe("valid");
    if (restored.kind !== "valid") throw new Error("expected restored source");
    expect(restored.context.messages).toEqual(captured.messages);
    const child = sessionCapabilityFor(
      { runId: w.consumer.runId, session: { key: "cli:child:@thread", seedFrom: 0, request: 0, range: { from: 0 } } },
      {
        readSession: w.ledger.readSession.bind(w.ledger),
        searchSession: w.ledger.searchSession.bind(w.ledger),
        readNotepad: w.ledger.readNotepad.bind(w.ledger),
        writeNotepad: async () => ({ ok: false as const, reason: "fenced" as const }),
      },
      undefined,
      {
        handoff: restored.context.handoff,
        canRead: async () =>
          (
            await validateChildHandoff({
              value: restored.context.handoff,
              consumer: w.consumer,
              mode: "consume",
              deps: w.deps,
            })
          ).kind === "valid",
      },
    )!;
    expect(await child.parent!.readTurn(2)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "read",
          content: "FAIL exact_original_test\n" + "irrelevant exploration\n".repeat(100),
        },
      ],
    });
    w.revoke();
    expect(await child.parent!.readTurn(2)).toBeUndefined();
    expect(
      (
        await validateChildHandoff({
          value: restored.context.handoff,
          consumer: w.consumer,
          mode: "consume",
          deps: w.deps,
        })
      ).kind,
    ).toBe("invalid");
  });

  it("carries the same brief through private main work and a canonical Ship unit admission", async () => {
    const w = await fixture();
    const context = await capturePrivateWorkContext({
      run: {
        tracked: () => true,
        lastCheckpointFailure: undefined,
        checkpointSession: async () => ({ key: w.session.key, through: 4 }),
      },
      capability: w.capability,
      captureDependencies: w.captureDependencies,
      source: w.source,
      validate: async (parent) =>
        (
          await validateChildHandoff({
            value: parent.handoff,
            consumer: { ...w.consumer, runId: w.source.runId },
            mode: "capture",
            deps: w.deps,
            inline: parent,
          })
        ).kind === "valid"
          ? "valid"
          : "invalid",
    });
    expect(context.handoff.brief?.request).toBe(0);
    expect(context.handoff.dependencies?.hash).toBe(await contextDependenciesHash(w.dependencies));
    const binding = {
      instanceId: "ship-instance",
      unit: "implementation",
      instanceAttempt: 1,
      idempotencyKey: "unit-round",
    };
    const consumer = { ...w.consumer, attempt: "unit-round" };
    w.deps.loadAdmission = async () => ({
      binding,
      context,
      requester: consumer.requester,
      channelId: consumer.channelId,
      threadKey: consumer.threadKey,
    });
    const admitted = await validateChildHandoff({
      value: JSON.parse(JSON.stringify(context.handoff)),
      consumer,
      mode: "admitted-bind",
      admission: binding,
      deps: w.deps,
    });
    expect(admitted.kind).toBe("valid");
    if (admitted.kind !== "valid") throw new Error("expected admitted source");
    expect(JSON.stringify(admitted.context.messages)).toContain("Correction: use staging only.");
    expect(JSON.stringify(admitted.context.messages)).not.toContain("irrelevant exploration");
    expect(admitted.context.handoff.session).toEqual({ key: w.session.key, from: 0, to: 4 });
    expect(
      (
        await validateChildHandoff({
          value: context.handoff,
          consumer: { ...consumer, requester: "cli:foreign" },
          mode: "admitted-bind",
          admission: binding,
          deps: w.deps,
        })
      ).kind,
    ).toBe("invalid");
  });

  it("refuses unavailable or changed canonical requests, actors and request indices", async () => {
    const w = await fixture();
    const captured = await w.capability.captureHandoff!(w.source, w.captureDependencies, 4);
    const originalRead = w.deps.readSession;
    w.deps.readSession = async (key, from, to) => {
      const rows = await originalRead(key, from, to);
      return from === 0 && to === 0 ? { ...rows, actors: ["cli:foreign"] } : rows;
    };
    expect(
      (await validateChildHandoff({ value: captured.handoff, consumer: w.consumer, mode: "bind", deps: w.deps })).kind,
    ).toBe("invalid");
    w.deps.readSession = originalRead;
    expect(
      (
        await validateChildHandoff({
          value: { ...captured.handoff, brief: { ...captured.handoff!.brief, request: 3 } },
          consumer: w.consumer,
          mode: "bind",
          deps: w.deps,
        })
      ).kind,
    ).toBe("invalid");
    w.writeThrough.readSession = async () => ({
      complete: false,
      turns: 0,
      messages: [],
      compactions: [],
      gap: "unavailable request",
    });
    await expect(w.capability.captureHandoff!(w.source, w.captureDependencies, 4)).rejects.toThrow(
      "original source request could not be captured",
    );
  });
});
