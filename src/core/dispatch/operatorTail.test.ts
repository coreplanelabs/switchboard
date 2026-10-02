import { describe, expect, it, vi } from "vitest";
import type { RunLedger } from "../runLedger/ledger.js";
import type { RunView } from "../runsService.js";
import { contextThreadSessionKey } from "../runLedger/sessionLog.js";
import { testSessionSources } from "../testing/slackSources.js";
import type { IncomingMessage } from "../types.js";
import { freshContext } from "./contextSeed.js";
import type { ContextDependencies } from "../references/contextDependencies.js";
import { readOperatorTailContext } from "./operatorTail.js";

const msg: IncomingMessage = { userId: "slack:UA", channelId: "slack:CA", threadKey: "slack:CA:1", text: "continue" };
const shared = contextThreadSessionKey(msg.threadKey);
const context = {
  ...freshContext(),
  origins: [{ runId: "original", requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey }],
};
const transcript = {
  complete: true as const,
  turns: 1,
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "previous request" }] }],
  compactions: [],
  actors: [msg.userId],
  marks: [{ folded: true as const }],
  contexts: [context],
};
const sources = { version: 1 as const, status: "unknown" as const, context };

describe("operator source-aware tail", () => {
  it("normalizes canonical recent row identities before access checks and merging a long shared history", async () => {
    const contexts = Array.from({ length: 65 }, (_, i) => ({
      ...context,
      origins: [{ ...context.origins[0]!, runId: `run-${i}` }],
    }));
    const latest = { ...contexts[64]!, origins: [{ ...contexts[64]!.origins[0]!, checkpoint: "a".repeat(64) }] };
    const readSessionTail = vi
      .fn<RunLedger["readSessionTail"]>()
      .mockResolvedValueOnce({
        from: 0,
        transcript: {
          ...transcript,
          messages: contexts.map((_, i) => ({ role: "user", content: [{ type: "text", text: `request ${i}` }] })),
          contexts,
        },
      })
      .mockResolvedValueOnce({
        from: 65,
        transcript: { ...transcript, messages: [] },
        sources: { ...sources, context: latest },
      });
    const validateDependencies = vi.fn(async () => ({ ok: true as const }));
    const normalizeDependencies = vi.fn(
      async (admitted: readonly ContextDependencies[], candidates: readonly ContextDependencies[]) => {
        expect(validateDependencies).not.toHaveBeenCalled();
        expect(admitted).toEqual(contexts);
        expect(candidates).toContainEqual(latest);
        return admitted.map(() => latest);
      },
    );
    const result = await readOperatorTailContext({
      ledger: { readSessionTail },
      runs: [],
      msg,
      validateDependencies,
      normalizeDependencies,
    });
    expect(normalizeDependencies).toHaveBeenCalledTimes(1);
    expect(validateDependencies).toHaveBeenCalledExactlyOnceWith(latest);
    expect(result.context?.status).toBe("known");
    expect(result.context?.origins).toEqual(latest.origins);
  });

  it("omits a row outside the proved identity window without tainting its recent neighbor", async () => {
    const latest = { ...context, origins: [{ ...context.origins[0]!, runId: "latest", checkpoint: "a".repeat(64) }] };
    const ancient = { ...context, origins: [{ ...context.origins[0]!, runId: "expired" }] };
    const readSessionTail = vi.fn<RunLedger["readSessionTail"]>().mockResolvedValue({
      from: 0,
      transcript: {
        ...transcript,
        messages: [transcript.messages[0], { role: "user", content: [{ type: "text", text: "recent summary" }] }],
        contexts: [ancient, context],
      },
      sources: { ...sources, context: latest },
    });
    const result = await readOperatorTailContext({
      ledger: { readSessionTail },
      runs: [],
      msg,
      normalizeDependencies: async () => [ancient, latest],
      validateDependencies: async (value) =>
        value.origins[0]?.runId === "latest" ? { ok: true } : { ok: false, code: "saved-context-unproved" },
    });
    expect(result.turns.map((turn) => turn.text)).toEqual(["user: recent summary"]);
    expect(result.context?.status).toBe("known");
    expect(result.context?.origins).toEqual(latest.origins);
    expect(result.unavailable).toHaveLength(1);
  });
  it("does not infer a shared row's provenance from its role or clean aggregate metadata", async () => {
    const readSessionTail = vi
      .fn<RunLedger["readSessionTail"]>()
      .mockResolvedValue({ from: 0, transcript: { ...transcript, contexts: undefined }, sources });
    const validateDependencies = vi.fn(async () => ({ ok: true as const }));
    const result = await readOperatorTailContext({ ledger: { readSessionTail }, runs: [], msg, validateDependencies });
    expect(result.turns).toEqual([]);
    expect(result.unavailable).toHaveLength(1);
    expect(validateDependencies).not.toHaveBeenCalled();
  });

  it("omits only unproved rows while retaining explicitly proved shared conversation", async () => {
    const readSessionTail = vi.fn<RunLedger["readSessionTail"]>().mockResolvedValue({
      from: 0,
      transcript: {
        ...transcript,
        messages: [
          transcript.messages[0],
          { role: "assistant", content: [{ type: "text", text: "unproved command result" }] },
        ],
        contexts: [context, undefined],
      },
      sources: { version: 1, status: "unknown", context: { ...freshContext(), status: "unknown", reason: "legacy" } },
    });
    const result = await readOperatorTailContext({
      ledger: { readSessionTail },
      runs: [],
      msg,
      validateDependencies: async () => ({ ok: true }),
    });
    expect(result.turns.map((turn) => turn.text)).toEqual(["user: previous request"]);
    expect(result.unavailable.join(" ")).toContain("unproved");
    expect(result.context?.origins).toEqual(context.origins);
  });

  it("reads authorized legacy context before a first admitted ingress already in the new shared log", async () => {
    const readSessionTail = vi.fn<RunLedger["readSessionTail"]>(async (key) => ({
      from: 0,
      transcript:
        key === shared
          ? {
              ...transcript,
              messages: [{ role: "user", content: [{ type: "text", text: msg.text }] }],
              contexts: [freshContext()],
            }
          : { ...transcript, contexts: undefined },
      sources,
    }));
    const runs = [
      {
        id: "original",
        userId: msg.userId,
        channelId: msg.channelId,
        threadKey: msg.threadKey,
        session: { key: "old:coding" },
      },
    ] as RunView[];
    const result = await readOperatorTailContext({
      ledger: { readSessionTail },
      runs,
      msg,
      validateDependencies: async () => ({ ok: true }),
    });
    expect(result.turns.map((turn) => turn.text)).toEqual(["user: previous request", `user: ${msg.text}`]);
    expect(result.context?.origins).toEqual(context.origins);
  });

  it("captures bytes before checking fresh metadata and returns all admitted dependencies", async () => {
    const readSessionTail = vi
      .fn<RunLedger["readSessionTail"]>()
      .mockResolvedValueOnce({ from: 0, transcript })
      .mockResolvedValueOnce({ from: 1, transcript: { ...transcript, messages: [] }, sources });
    const validateDependencies = vi.fn(async () => ({ ok: true as const }));
    const result = await readOperatorTailContext({ ledger: { readSessionTail }, runs: [], msg, validateDependencies });
    expect(readSessionTail.mock.calls.map(([key, bytes]) => [key, bytes === 1])).toEqual([
      [shared, false],
      [shared, true],
    ]);
    expect(result.turns).toEqual([{ text: "user: previous request", actor: msg.userId, folded: true }]);
    expect(result.context?.origins).toEqual(context.origins);
    expect(validateDependencies).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ origins: context.origins }));
  });

  it("omits changed source history without falling back around the denied shared log", async () => {
    const readSessionTail = vi.fn<RunLedger["readSessionTail"]>().mockResolvedValue({ from: 0, transcript, sources });
    const result = await readOperatorTailContext({
      ledger: { readSessionTail },
      runs: [],
      msg,
      validateDependencies: async () => ({ ok: false, code: "saved-context-unproved" }),
    });
    expect(result.turns).toEqual([]);
    expect(result.unavailable.join(" ")).toContain("saved-context-unproved");
    expect(readSessionTail).toHaveBeenCalledTimes(2);
  });

  it("migrates only canonical sessions from authorized matching runs and isolates legacy unknown history", async () => {
    const readSessionTail = vi.fn<RunLedger["readSessionTail"]>(async (key) => ({
      from: 0,
      transcript: key === shared ? { ...transcript, messages: [] } : transcript,
      ...(key === "unit:coding" ? { sources } : { sources: testSessionSources(msg, []) }),
    }));
    const run = (id: string, key?: string, userId = msg.userId) =>
      ({
        id,
        userId,
        channelId: userId === msg.userId ? msg.channelId : "slack:CB",
        threadKey: msg.threadKey,
        ...(key ? { session: { key } } : {}),
        agent: "coding",
      }) as RunView;
    const result = await readOperatorTailContext({
      ledger: { readSessionTail },
      runs: [
        run("legacy", "legacy:coding"),
        run("a", "unit:coding"),
        run("b", "unit:coding"),
        run("absent"),
        run("foreign", "other", "slack:UB"),
      ],
      msg,
      validateDependencies: async () => ({ ok: true }),
    });
    expect(result.turns).toHaveLength(1);
    expect(result.context?.origins.map((origin) => origin.runId).sort()).toEqual(["a", "b", "original"]);
    expect(result.unavailable).toHaveLength(1);
    expect(readSessionTail.mock.calls.map(([key]) => key)).toEqual([
      shared,
      "unit:coding",
      "unit:coding",
      "legacy:coding",
      "legacy:coding",
    ]);
  });
});
