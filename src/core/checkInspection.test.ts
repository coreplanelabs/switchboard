import { describe, expect, it } from "vitest";
import { captureCheckArchive, selectCheckSource, checkSourceReadOf } from "./checkInspection.js";
import { createCheckExecution } from "./checkExecution.js";
import type { CheckExecutionState } from "./checkExecutionTypes.js";
import type { LiveRunRow } from "./runLedger/types.js";

const owner = { runId: "run-1", requester: "slack:alice", threadKey: "slack:private:1", repo: "acme/repo" };
const result = { stdout: "original output", stderr: "", exitCode: 0, truncated: false };
const metadata = { ...result, stdout: `/work/repo\n${"a".repeat(40)}\n${"b".repeat(40)}\n` };
const selector = { runId: "run-1", callId: "call-1", phase: "command" as const };
async function fixture() {
  const row = {
    runId: "run-1",
    ownerGen: "g1",
    meta: {
      userId: owner.requester,
      channelId: "slack:private",
      channelVisibility: "private",
      repo: owner.repo,
      threadKey: owner.threadKey,
    },
    state: {},
  } as unknown as LiveRunRow;
  const saved: CheckExecutionState[] = [];
  let calls = 0;
  const check = createCheckExecution({
    owner,
    executor: () => ({
      inspectCheckResult: async () => undefined,
      execResult: async () => (++calls === 1 ? metadata : result),
    }),
    workspace: () => "/work/repo",
    recordingAvailable: true,
    authorizeCommand: () => true,
    save: async (state) => {
      saved.push(structuredClone(state));
      row.state.checkExecutions = state;
      return true;
    },
    remainingMs: () => 120000,
    signal: new AbortController().signal,
    clock: () => 100,
  });
  expect(
    await check.run({ command: "printf fixture", purpose: "verification", timeoutMs: 1000 }, "call-1"),
  ).toMatchObject({ kind: "recorded", receipt: { outcome: { kind: "completed", ...result } } });
  return {
    row,
    archive: captureCheckArchive(row, true)!,
    operation: saved.at(-1)!.receipts[0].checkOperation!,
    metadataState: saved.find((state) => state.metadata?.result)!,
  };
}

describe("canonical check selection", () => {
  it("freezes the full private authorization resource and original result from valid producer state", async () => {
    const { row, archive, operation } = await fixture();
    row.meta.channelVisibility = "public";
    row.state.checkExecutions = { version: 1, receipts: [] };
    expect(await selectCheckSource(archive, selector, "terminal")).toEqual({
      kind: "source",
      source: {
        version: 1,
        state: "terminal",
        selector,
        threadKey: "slack:private:1",
        resource: {
          type: "run",
          id: "run-1",
          userId: "slack:alice",
          channelId: "slack:private",
          channelVisibility: "private",
          repo: "acme/repo",
        },
        operation,
        result,
      },
    });
  });

  it.each(["missing-purpose", "missing-input-hash", "forged-key", "duplicate", "foreign-owner"])(
    "refuses %s instead of certifying malformed stored checks",
    async (fault) => {
      const { archive } = await fixture();
      const state = archive.checks as { receipts: Array<Record<string, unknown>> };
      const receipt = state.receipts[0];
      if (fault === "missing-purpose") delete receipt.purpose;
      if (fault === "missing-input-hash") delete receipt.inputHash;
      if (fault === "forged-key") (receipt.checkOperation as { key: string }).key = "f".repeat(64);
      if (fault === "duplicate") state.receipts.push(structuredClone(receipt));
      if (fault === "foreign-owner") (receipt.owner as typeof owner).requester = "slack:other";
      expect(await selectCheckSource(archive, selector, "terminal")).toEqual({ kind: "unavailable" });
    },
  );

  it("verifies the stored metadata phase key without reconstructing absent evidence", async () => {
    const { archive, operation, metadataState } = await fixture();
    expect(await selectCheckSource(archive, { ...selector, phase: "metadata" }, "terminal")).toEqual({
      kind: "unavailable",
    });
    archive.checks = structuredClone(metadataState);
    expect(await selectCheckSource(archive, { ...selector, phase: "metadata" }, "live")).toMatchObject({
      kind: "source",
      source: { result: metadata },
    });
    (archive.checks as CheckExecutionState).metadata!.checkOperation.key = operation.key;
    expect(await selectCheckSource(archive, { ...selector, phase: "metadata" }, "live")).toEqual({
      kind: "unavailable",
    });
  });
});

describe("check archive refusal", () => {
  it("refuses malformed canonical state instead of silently discarding it", async () => {
    const { row } = await fixture();
    row.state.checkExecutions = { version: 1, receipts: [{ callId: "lost" }] };
    expect(() => captureCheckArchive(row, true)).toThrow("canonical check state is unreadable");
  });
  it("does not certify an unsealed snapshot as terminal authority", async () => {
    const { row } = await fixture();
    expect(await selectCheckSource(captureCheckArchive(row), selector, "terminal")).toEqual({ kind: "unavailable" });
    expect(await selectCheckSource(captureCheckArchive(row), selector, "live")).toMatchObject({
      kind: "source",
      source: { result },
    });
  });
  it("accepts semantically equal selectors independent of JSON property order", async () => {
    const { archive } = await fixture();
    const read = await selectCheckSource(archive, selector, "terminal");
    expect(checkSourceReadOf(read, { phase: "command", callId: "call-1", runId: "run-1" })).toMatchObject({
      kind: "source",
      source: { result },
    });
  });
});
