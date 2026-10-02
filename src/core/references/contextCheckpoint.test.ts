import { describe, expect, it } from "vitest";
import { contextDependenciesHash, mergeContextDependencies, type ContextDependencies } from "./contextDependencies.js";
import { testSlackReceipt } from "../testing/slackSources.js";
import { sourceHash } from "./receipts.js";
import {
  checkpointMembersOf,
  checkpointMemberHashesOf,
  checkpointOutsideOrdinaryWindow,
  normalizeCheckpointContexts,
  planContextCheckpoint,
  validateContextCheckpoint,
  type CanonicalCheckpointSource,
  type ContextCheckpointInputs,
} from "./contextCheckpoint.js";

const clean: ContextDependencies = { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] };
const origin = (runId: string) => ({ runId, requester: "cli:user", channelId: "cli:main", threadKey: "cli:thread" });
const meta = (from: number) => ({
  userId: "cli:user",
  channelId: "cli:main",
  threadKey: "cli:thread",
  channelVisibility: "public" as const,
  repo: "org/repo",
  session: { key: "cli:thread:general", seedFrom: from, request: from, range: { from, to: from } },
});
async function seal(
  run: CanonicalCheckpointSource,
  sources: CanonicalCheckpointSource[] = [],
  change?: Partial<ContextCheckpointInputs>,
) {
  const inputs = {
    transcriptHash: await sourceHash({ seed: run.runId }),
    systemHash: await sourceHash({ system: run.runId }),
    notepadHash: await sourceHash({ note: run.runId }),
  };
  return planContextCheckpoint({
    run,
    ownerGen: "gen",
    through: run.meta.session!.seedFrom,
    inputs,
    expected: {
      beforeHash: await contextDependenciesHash(run.context),
      revision: run.context.revision,
      inputs: { ...inputs, ...change },
    },
    sources,
  });
}

describe("ordinary context checkpoint", () => {
  it("rolls ordinary identity evidence after 128 runs without growing a restored checkpoint", async () => {
    let previous: CanonicalCheckpointSource | undefined;
    let original: CanonicalCheckpointSource | undefined;
    for (let turn = 0; turn < 384; turn++) {
      const runId = `bounded-${turn}`;
      const run: CanonicalCheckpointSource = {
        runId,
        meta: meta(turn),
        context: mergeContextDependencies(previous?.context ?? clean, { ...clean, origins: [origin(runId)] }),
      };
      const sources = previous ? [previous] : [];
      const receipt = await seal(run, sources);
      expect(receipt, `continuation ${turn}`).toBeDefined();
      const members = checkpointMembersOf(runId, receipt!.coveredOrigins, sources);
      expect(members).toEqual(
        Array.from({ length: Math.min(turn + 1, 128) }, (_, offset) => `bounded-${turn - offset}`),
      );
      previous = JSON.parse(
        JSON.stringify({
          ...run,
          context: receipt!.normalized,
          receipt,
          members,
          memberCheckpoints: checkpointMemberHashesOf(runId, receipt!.coveredOrigins, sources),
          transcriptHash: receipt!.inputs.transcriptHash,
        }),
      );
      expect(await validateContextCheckpoint(receipt, previous!)).toBe(true);
      if (turn === 0) original = structuredClone(previous);
    }
    expect(previous!.members).not.toContain("bounded-0");
    expect(checkpointOutsideOrdinaryWindow(original!, previous!)).toBe(true);
    expect(checkpointOutsideOrdinaryWindow(previous!, original!)).toBe(false);
    expect(
      checkpointOutsideOrdinaryWindow(
        {
          ...original!,
          receipt: { ...original!.receipt!, authority: { ...original!.receipt!.authority, repo: "foreign/repo" } },
        },
        previous!,
      ),
    ).toBe(false);
    const altered = { ...previous!, members: [...previous!.members!].reverse() };
    expect(await validateContextCheckpoint(previous!.receipt, altered)).toBe(false);
  });

  it("keeps more than 64 sealed continuations bounded across serialized checkpoint restoration", async () => {
    let previous: CanonicalCheckpointSource | undefined;
    const frozenRows: ContextDependencies[] = [];
    for (let turn = 0; turn < 72; turn++) {
      const runId = `run-${turn}`;
      const context = mergeContextDependencies(previous?.context ?? clean, { ...clean, origins: [origin(runId)] });
      const run: CanonicalCheckpointSource = { runId, meta: meta(turn), context };
      const receipt = await seal(run, previous ? [previous] : []);
      expect(receipt, `turn ${turn}`).toBeDefined();
      frozenRows.push(receipt!.normalized);
      expect(receipt!.normalized.origins).toHaveLength(1);
      expect(JSON.stringify(receipt!.normalized).length).toBeLessThan(700);
      previous = JSON.parse(
        JSON.stringify({
          ...run,
          context: receipt!.normalized,
          receipt,
          transcriptHash: receipt!.inputs.transcriptHash,
          members: checkpointMembersOf(runId, receipt!.coveredOrigins, previous ? [previous] : []),
          memberCheckpoints: checkpointMemberHashesOf(runId, receipt!.coveredOrigins, previous ? [previous] : []),
        }),
      );
      expect(await validateContextCheckpoint(receipt, previous!)).toBe(true);
    }
    const normalizedRows = await normalizeCheckpointContexts(frozenRows, [previous!]);
    const aggregate = mergeContextDependencies(...normalizedRows);
    expect(aggregate.status).toBe("known");
    expect(aggregate.origins).toHaveLength(1);
    expect(frozenRows[0].origins[0].runId).toBe("run-0");
    previous!.context = { ...previous!.context, status: "unknown", reason: "legacy" };
    expect(await validateContextCheckpoint(previous!.receipt, previous!)).toBe(true);
    expect(
      (await normalizeCheckpointContexts([{ ...clean, status: "unknown", reason: "legacy" }], [previous!]))[0].status,
    ).toBe("unknown");
  });

  it.each([
    ["repository", { repo: "other/repo" }],
    ["visibility", { channelVisibility: "private" }],
    ["credential", { authenticatedAs: "mcp:other" }],
    ["posting app", { postedBy: "slack:app:other" }],
    ["worker", { threadKey: "worker:instance:unit" }],
    ["coordinator child", { parentInstanceId: "instance" }],
    ["ordinary child", { parentRunId: "parent" }],
    ["hosted run", { hosted: true }],
  ] as const)("preserves the original run when its %s authority differs", async (_name, changed) => {
    const source: CanonicalCheckpointSource = { runId: "original", meta: { ...meta(0), ...changed }, context: clean };
    source.context = {
      ...clean,
      origins: [
        {
          runId: source.runId,
          requester: source.meta.userId,
          channelId: source.meta.channelId,
          threadKey: source.meta.threadKey,
        },
      ],
    };
    source.receipt = await seal(source);
    if (source.receipt) {
      source.context = source.receipt.normalized;
      source.transcriptHash = source.receipt.inputs.transcriptHash;
      source.members = [source.runId];
    }
    const current: CanonicalCheckpointSource = {
      runId: "current",
      meta: meta(1),
      context: mergeContextDependencies(source.context, { ...clean, origins: [origin("current")] }),
    };
    const receipt = (await seal(current, [source]))!;
    expect(receipt).toBeDefined();
    expect(receipt.normalized.origins.map((o) => o.runId).sort()).toEqual(["current", "original"]);
    expect(receipt.coveredOrigins).toEqual([]);
  });

  it("does not mint a different checkpoint after the run has committed its seed", async () => {
    const run: CanonicalCheckpointSource = {
      runId: "once",
      meta: meta(0),
      context: { ...clean, origins: [origin("once")] },
    };
    const receipt = (await seal(run))!;
    run.context = receipt.normalized;
    run.receipt = receipt;
    run.transcriptHash = receipt.inputs.transcriptHash;
    run.members = [run.runId];
    expect(await seal(run)).toBeUndefined();
  });

  it("preserves distinct source leaves and foreign authority while refusing changed seed bytes or unknown closure", async () => {
    const first: CanonicalCheckpointSource = {
      runId: "first",
      meta: meta(0),
      context: {
        ...clean,
        origins: [origin("first")],
        githubRepos: ["org/repo"],
        memoryScopes: ["user:cli:user"],
        slack: [testSlackReceipt({ userId: "slack:UA", channelId: "slack:DA", threadKey: "slack:DA:1" })],
        mcp: [
          {
            runId: "original-reader",
            actionId: "original-action",
            callIds: ["original-call"],
            responseHash: "a".repeat(64),
          },
        ],
        unitStatuses: [
          {
            instanceId: "original-instance",
            unit: "unit",
            attempt: 0,
            requester: "cli:user",
            channelId: "cli:main",
            threadKey: "cli:thread",
            deliveryId: "original-delivery",
            destinationThreadKey: "cli:thread",
            repo: "org/repo",
            snapshotHash: "b".repeat(64),
          },
        ],
      },
    };
    first.receipt = (await seal(first))!;
    first.context = first.receipt.normalized;
    first.transcriptHash = first.receipt.inputs.transcriptHash;
    first.members = [first.runId];
    const foreign: CanonicalCheckpointSource = {
      runId: "foreign",
      meta: { ...meta(1), repo: "other/repo" },
      context: { ...clean, origins: [origin("foreign")] },
    };
    foreign.receipt = (await seal(foreign))!;
    foreign.context = foreign.receipt.normalized;
    foreign.transcriptHash = foreign.receipt.inputs.transcriptHash;
    foreign.members = [foreign.runId];
    const run: CanonicalCheckpointSource = {
      runId: "current",
      meta: meta(2),
      context: mergeContextDependencies(first.context, foreign.context, { ...clean, origins: [origin("current")] }),
    };
    const receipt = (await seal(run, [first, foreign]))!;
    expect(receipt.normalized.origins.map((o) => o.runId).sort()).toEqual(["current", "foreign"]);
    expect(receipt.normalized.githubRepos).toEqual(first.context.githubRepos);
    expect(receipt.normalized.memoryScopes).toEqual(first.context.memoryScopes);
    expect(receipt.normalized.slack).toEqual(first.context.slack);
    expect(receipt.normalized.mcp).toEqual(first.context.mcp);
    expect(receipt.normalized.unitStatuses).toEqual(first.context.unitStatuses);
    const changedMarker = {
      ...run,
      context: {
        ...run.context,
        origins: run.context.origins.map((o) => (o.runId === "first" ? { ...o, checkpoint: "f".repeat(64) } : o)),
      },
    };
    expect(await seal(changedMarker, [first, foreign])).toBeUndefined();
    const source = {
      ...run,
      context: receipt.normalized,
      receipt,
      transcriptHash: receipt.inputs.transcriptHash,
      members: checkpointMembersOf(run.runId, receipt.coveredOrigins, [first, foreign]),
      memberCheckpoints: checkpointMemberHashesOf(run.runId, receipt.coveredOrigins, [first, foreign]),
    };
    expect(await validateContextCheckpoint(receipt, source)).toBe(true);
    expect(await validateContextCheckpoint(receipt, { ...source, members: [...source.members, "extra"] })).toBe(false);
    expect(await validateContextCheckpoint(receipt, { ...source, transcriptHash: "d".repeat(64) })).toBe(false);
    const oldRow = { ...clean, origins: first.context.origins };
    const [normalizedOld] = await normalizeCheckpointContexts([oldRow], [source]);
    expect(normalizedOld.origins.map((o) => o.runId)).toEqual(["current"]);
    expect(normalizedOld.mcp).toEqual([]);
    expect(normalizedOld).not.toHaveProperty("memoryScopes");
    expect(await seal(run, [first, foreign], { notepadHash: "f".repeat(64) })).toBeUndefined();
    expect(
      await seal({ ...run, context: { ...run.context, status: "unknown", reason: "legacy" } }, [first, foreign]),
    ).toBeUndefined();
    expect(
      await validateContextCheckpoint(
        { ...receipt, ownerGen: "forged" },
        { ...run, context: receipt.normalized, transcriptHash: receipt.inputs.transcriptHash },
      ),
    ).toBe(false);
  });
});
