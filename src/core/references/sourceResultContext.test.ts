import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { LEASE_MS } from "../runLedger/types.js";
import { testSessionSources } from "../testing/slackSources.js";
import { describe, expect, it } from "vitest";
import { uncoveredSourceResult, verifiedSourceResults } from "./sourceResultContext.js";
import { sourceHash } from "./receipts.js";
import { assembleTranscript, turnRows } from "../runLedger/transcript.js";
import { parentContextOf } from "../dispatch/handoff.js";
import type { ContextDependencies } from "./contextDependencies.js";

const use = (name = "mcp__slack__read") => ({
  idx: 0,
  part: 0,
  json: JSON.stringify({ role: "assistant", part: { type: "tool_use", id: "call", name, input: {} } }),
});

describe("public GitHub result receipts", () => {
  const publicContext = { ...context, mcp: [], githubRepos: ["acme/api"] };
  const receipt = async () => ({
    version: 1 as const,
    runId: "current",
    callId: "call",
    tool: "github_file",
    repos: ["acme/api"],
    resultHash: await sourceHash("source bytes"),
  });
  it("requires the exact bytes, producer, call, tool and admitted repository", async () => {
    const row = { ...result(), json: JSON.stringify({ ...JSON.parse(result().json), sourceResult: await receipt() }) };
    const verified = await verifiedSourceResults([row]);
    expect(uncoveredSourceResult([use("github_file")], [row], publicContext, "current", verified)).toBe(false);
    expect(uncoveredSourceResult([use("github_file")], [row], publicContext, "other", verified)).toBe(true);
    expect(uncoveredSourceResult([use("github_tree")], [row], publicContext, "current", verified)).toBe(true);
    expect(
      uncoveredSourceResult([use("github_file")], [row], { ...publicContext, githubRepos: [] }, "current", verified),
    ).toBe(true);
    const changed = { ...row, json: row.json.replace("source bytes", "changed bytes") };
    expect(
      uncoveredSourceResult(
        [use("github_file")],
        [changed],
        publicContext,
        "current",
        await verifiedSourceResults([changed]),
      ),
    ).toBe(true);
    expect(
      uncoveredSourceResult(
        [use("github_file")],
        [row, changed],
        publicContext,
        "current",
        await verifiedSourceResults([row, changed]),
      ),
    ).toBe(true);
  });
  it("preserves receipts through assembly and a child's frozen evidence", async () => {
    const proof = await receipt();
    const row = { ...result(), json: JSON.stringify({ ...JSON.parse(result().json), sourceResult: proof }) };
    const transcript = assembleTranscript([use("github_file"), row], []);
    const child = parentContextOf(transcript.messages);
    const rows = child.messages.flatMap((message, idx) => turnRows(idx, message).rows);
    expect(rows.some((item) => JSON.parse(item.json).sourceResult?.resultHash === proof.resultHash)).toBe(true);
    expect(uncoveredSourceResult([], rows, publicContext, undefined, await verifiedSourceResults(rows))).toBe(false);
  });
});
const result = (text = "source bytes") => ({
  idx: 1,
  part: 0,
  json: JSON.stringify({ role: "user", part: { type: "tool_result", toolUseId: "call", content: text } }),
});
const context: ContextDependencies = {
  version: 1,
  status: "known",
  revision: 0,
  origins: [],
  slack: [],
  mcp: [{ runId: "original", actionId: "read", callIds: ["call"], responseHash: "a".repeat(64) }],
};

describe("source result context at the persisted row boundary", () => {
  it("keeps a saved work status opaque without a current source receipt", () => {
    expect(uncoveredSourceResult([use("work_status")], [result("running")], { ...context, mcp: [] }, "current")).toBe(
      true,
    );
  });
  it("does not taint announced calls or covered original seed results", () => {
    expect(uncoveredSourceResult([], [use()], context, "current")).toBe(false);
    expect(uncoveredSourceResult([], [use(), result()], context)).toBe(false);
  });
  it("requires current-writer evidence for newly exposed step results even when an inherited call ID matches", () => {
    expect(uncoveredSourceResult([use()], [result()], context, "current")).toBe(true);
    expect(uncoveredSourceResult([use()], [result()], context, "original")).toBe(false);
    expect(uncoveredSourceResult([use()], [result()], { ...context, mcp: [] })).toBe(true);
  });
  it("accepts exact mirror retries but rejects replacement bytes under the old row", () => {
    expect(uncoveredSourceResult([use(), result()], [result()], context, "current")).toBe(false);
    expect(uncoveredSourceResult([use(), result()], [result("different")], context, "current")).toBe(true);
  });
  it("persists taint before a newly exposed step and preserves covered seed metadata", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const threadKey = "slack:C1:1.0";
    const key = `${threadKey}:coding`;
    await ledger.claim({
      runId: "current",
      threadKey,
      gen: "g1",
      leaseMs: LEASE_MS,
      startedAt: 1,
      meta: {
        userId: "slack:U11",
        channelId: "slack:C1",
        threadKey,
        session: { key, seedFrom: 0, request: 0, range: { from: 0 } },
      },
      system: "work",
      tools: [],
    });
    await ledger.claimSession(key, "current", "g1");
    expect(
      await ledger.writeSessionSources(key, "current", "g1", {
        ...testSessionSources({ userId: "slack:U11", channelId: "slack:C1", threadKey }, []),
        context,
      }),
    ).toEqual({ ok: true });
    const turns = [use(), result()].map((row) => ({
      idx: row.idx,
      message: { role: JSON.parse(row.json).role, content: [JSON.parse(row.json).part] },
    }));
    expect(await ledger.seed("current", "g1", turns, key)).toEqual({ ok: true });
    expect((await ledger.readSessionTail(key, 100_000)).sources?.context?.status).toBe("known");
    expect(
      await ledger.step(
        "current",
        "g1",
        { step: 1, seq: 1, turnIndex: 3, inFlight: [], inboxConsumedSeq: 0, remainingMs: 1, turn: 1, iteration: 1 },
        [{ ...turns[1], idx: 2 }],
        key,
      ),
    ).toEqual({ ok: true });
    expect((await ledger.readSessionTail(key, 100_000)).sources?.context).toMatchObject({
      status: "unknown",
      mcp: context.mcp,
    });
  });

  it("keeps known local tools clean and treats orphan results as unknown", () => {
    expect(uncoveredSourceResult([use("notes")], [result()], context, "current")).toBe(false);
    expect(uncoveredSourceResult([], [result()], { ...context, mcp: [] }, "current")).toBe(true);
  });
});
