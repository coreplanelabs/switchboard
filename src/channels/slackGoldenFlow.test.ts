import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contractFor } from "../core/coordinator/briefs.js";
import { privateWorkerThreadKey } from "./privateWorker.js";
import {
  goldenWorld,
  goldenProcess,
  answer,
  call,
  briefFromSource,
  sourceResult,
  SOURCE,
  REQUESTER,
} from "./testing/goldenFlow.js";
import type { CompletionRequest } from "../core/provider.js";
import { installOutboundGuard } from "./testing/outboundGuard.js";

// Admission-only fault cases have no source claim. Source-flow cases below
// construct their answer and proposal from the actual tool result instead.
const BRIEF = briefFromSource(SOURCE);
function sourcedAnswer(request: CompletionRequest, id = "mcp__metrics__signups") {
  const evidence = sourceResult(request, id);
  return answer(
    evidence
      ? `${evidence.result}. Query: ${evidence.query}. Window: ${evidence.timeWindow}. Source: ${evidence.sourceUrl}. Cause: unknown.`
      : "Source evidence is incomplete; I cannot answer that yet.",
  );
}
function sourcedStart(request: CompletionRequest, id = "mcp__metrics__signups", callId = "work_start") {
  const evidence = sourceResult(request, id);
  return evidence
    ? call("work_start", { repo: "acme/api", sourceMessage: "Fix it", ...briefFromSource(evidence) }, callId)
    : answer("Source evidence is incomplete; no worker started.");
}

installOutboundGuard();
beforeEach(() => {
  vi.stubEnv("PUBLIC_BASE_URL", "");
  vi.stubGlobal("fetch", () => {
    throw new Error("The golden flow must not reach the network");
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Slack golden flow", () => {
  it("carries a sourced answer and ordinary fix into one private durable worker", async () => {
    const world = goldenWorld(Date.now);
    const initial = {
      ...SOURCE,
      query: "SELECT failures FROM signup_window",
      result: "4 failures among 80 attempts",
      sourceUrl: "https://metrics.example.test/initial",
      timeWindow: "2026-02-01T00:00:00Z/2026-02-02T00:00:00Z",
    };
    world.state.sourceResponse = initial;
    const process = goldenProcess(world, "generation-one", [
      () => call("mcp__metrics__signups", { query: SOURCE.query }),
      (req) => sourcedAnswer(req),
      (req) => {
        expect(JSON.stringify(req.messages)).toContain("How many signups failed?");
        // A new turn must re-read the source, not replay an earlier private result.
        expect(sourceResult(req, "mcp__metrics__signups")).toBeUndefined();
        return call("mcp__metrics__signups", { query: SOURCE.query }, "fresh-query");
      },
      (req) => sourcedStart(req, "fresh-query", "start-one"),
      (req) => sourcedStart(req, "fresh-query", "retry-one"),
      () => answer("I started one private worker with the query and acceptance check."),
    ]);
    const read = await process.deliver(world.event("How many signups failed?"));
    expect(read, JSON.stringify({ read, posts: world.posts })).toMatchObject({ status: "completed" });
    expect(world.sourceReads).toHaveLength(1);
    for (const value of Object.values(initial)) expect(world.posts.at(-1)?.text).toContain(value);
    expect(world.sourceReads[0]?.caller.userId).toBe(`slack:${REQUESTER}`);
    expect(world.created).toEqual([]);
    const refreshed = {
      ...SOURCE,
      result: "9 failures among 200 attempts",
      sourceUrl: "https://metrics.example.test/refreshed",
      timeWindow: "2026-01-03T00:00:00Z/2026-01-04T00:00:00Z",
    };
    world.state.sourceResponse = refreshed;
    const fix = world.event("Fix it");
    const fixed = await process.deliver(fix);
    expect(fixed, JSON.stringify({ fixed, posts: world.posts })).toMatchObject({ status: "completed" });
    expect(await process.deliver(fix)).toEqual({ status: "duplicate" });
    expect(process.remaining()).toBe(0);
    expect(world.created).toHaveLength(1);
    const instance = await process.instances.get(world.created[0]!);
    const units = await process.instances.listUnits(world.created[0]!);
    expect(instance).toMatchObject({ repo: "acme/api", userId: `slack:${REQUESTER}`, merge: "person" });
    expect(units).toHaveLength(1);
    expect(units[0]?.workBrief?.findings[0]).toMatchObject(refreshed);
    const contract = await contractFor(instance!, units[0]!, {
      readRepoFile: async () => undefined,
    } as unknown as Parameters<typeof contractFor>[2]);
    for (const value of Object.values(refreshed)) expect(contract.unit.section).toContain(value);
    expect(contract.unit.section).toContain("Cause: unknown");
    const identity = { instanceId: instance!.id, unit: units[0]!.unit };
    const postsBeforeWorker = world.posts.length;
    const worker = await process.spawnWorker(instance!.id, units[0]!.unit, "Worker-only findings");
    expect(worker, JSON.stringify(worker)).toMatchObject({
      started: { status: 200 },
      spawned: { status: 200 },
    });
    expect(process.workerCalls).toHaveLength(1);
    expect(process.workerCalls[0]).toMatchObject({
      hasOpenThread: false,
      message: { userId: `slack:${REQUESTER}`, threadKey: privateWorkerThreadKey(identity) },
    });
    for (const value of Object.values(refreshed)) expect(process.workerCalls[0]?.message.text).toContain(value);
    expect(world.posts).toHaveLength(postsBeforeWorker);
    expect((await process.privateWorkerLog.list(privateWorkerThreadKey(identity))).map((event) => event.kind)).toEqual([
      "input",
      "reply",
    ]);
    expect(world.sourceReads).toHaveLength(2);
    expect(world.posts.every((post) => post.channel === world.channel && post.thread_ts === world.root)).toBe(true);
    expect((await process.privateWorkerLog.list(privateWorkerThreadKey(identity))).at(-1)).toMatchObject({
      kind: "reply",
      text: "Worker-only findings",
    });
  });

  it.each(
    (["query", "result", "timeWindow", "sourceUrl"] as const).flatMap((field) =>
      (["initial read", "fix reread"] as const).map((turn) => ({ field, turn })),
    ),
  )("withholds missing $field evidence on the $turn", async ({ field, turn }) => {
    const world = goldenWorld(Date.now);
    const process = goldenProcess(world, "incomplete-source", [
      () => call("mcp__metrics__signups", { query: SOURCE.query }),
      (req) => sourcedAnswer(req),
      ...(turn === "fix reread"
        ? [() => call("mcp__metrics__signups", { query: SOURCE.query }), (req: CompletionRequest) => sourcedStart(req)]
        : []),
    ]);
    if (turn === "initial read") delete world.state.sourceResponse[field];
    expect(await process.deliver(world.event("How many signups failed?"))).toMatchObject({ status: "completed" });
    if (turn === "initial read") {
      expect(world.posts.at(-1)?.text).toBe("Source evidence is incomplete; I cannot answer that yet.");
    } else {
      expect(world.posts.at(-1)?.text).toContain(SOURCE.result);
      delete world.state.sourceResponse[field];
      expect(await process.deliver(world.event("Fix it"))).toMatchObject({ status: "completed" });
      expect(world.posts.at(-1)?.text).toBe("Source evidence is incomplete; no worker started.");
    }
    expect(world.sourceReads).toHaveLength(turn === "initial read" ? 1 : 2);
    expect(process.remaining()).toBe(0);
    expect(world.created).toEqual([]);
  });

  it("reopens persisted conversation and task state before replaying the same fix", async () => {
    const world = goldenWorld(Date.now);
    const first = goldenProcess(world, "before-restart", [
      () => call("mcp__metrics__signups", { query: SOURCE.query }),
      (req) => sourcedAnswer(req),
      () => call("mcp__metrics__signups", { query: SOURCE.query }),
      (req) => sourcedStart(req),
      () => answer("The worker has the findings."),
    ]);
    await first.deliver(world.event("How many signups failed?"));
    const fix = world.event("Fix it");
    expect(await first.deliver(fix)).toMatchObject({ status: "completed" });
    expect(world.created).toHaveLength(1);
    const instanceId = world.created[0]!;
    const originalInstance = await first.instances.get(instanceId);
    const originalUnits = await first.instances.listUnits(instanceId);
    expect(first.ledger.live.size).toBe(0);

    // Clear module-local Slack dedupe and create fresh admission, harness,
    // registry and store objects. Only the external Slack history and files survive.
    vi.resetModules();
    const { goldenProcess: reopen } = await import("./testing/goldenFlow.js");
    const second = reopen(world, "after-restart", [
      (req) => {
        expect(JSON.stringify(req.messages)).toContain("How many signups failed?");
        expect(JSON.stringify(req.messages)).not.toContain(SOURCE.result);
        return call("mcp__metrics__signups", { query: SOURCE.query });
      },
      (req) => sourcedStart(req),
      () => answer("The same worker still owns this request."),
    ]);
    expect(second.ledger).not.toBe(first.ledger);
    expect(second.instances).not.toBe(first.instances);
    // Force the already-scanned catch-up entry through admission as well as
    // the adapter's ordinary duplicate guard tested above.
    expect(await second.deliver(fix, true)).toMatchObject({ status: "completed" });
    expect(world.created).toEqual([instanceId]);
    expect(await second.instances.get(instanceId)).toEqual(originalInstance);
    expect(await second.instances.listUnits(instanceId)).toEqual(originalUnits);
    expect(second.remaining()).toBe(0);
  });

  it.each(["foreign requester", "shared destination"])(
    "refuses a %s before source reads or worker admission",
    async (negative) => {
      const world = goldenWorld(Date.now);
      world.state.shared = negative === "shared destination";
      const process = goldenProcess(world, "authorization", [() => answer("Private findings must not be sent")]);
      if (negative === "foreign requester")
        expect(process.deps.config.grantsFor("slack:UMALLORY")).toEqual(
          process.deps.config.grantsFor(`slack:${REQUESTER}`),
        );
      const result = await process.deliver(
        world.event("How many signups failed?", negative === "foreign requester" ? "UMALLORY" : REQUESTER),
      );
      expect(result.status).toBe("refused");
      expect(process.requests).toEqual([]);
      expect(world.sourceReads).toEqual([]);
      expect(world.created).toEqual([]);
      expect(JSON.stringify(world.posts)).not.toContain("Private findings must not be sent");
    },
  );

  it("reconciles a lost workflow reply after restart without a second creation", async () => {
    const world = goldenWorld(Date.now);
    world.state.loseCreateReply = true;
    const first = goldenProcess(world, "uncertain-start", [
      () => call("work_start", { repo: "acme/api", sourceMessage: "Fix it", ...BRIEF }),
      () => answer("The admission reply was lost; the saved task must be checked."),
    ]);
    const fix = world.event("Fix it");
    await first.deliver(fix);
    expect(world.created).toHaveLength(1);
    const original = await first.instances.listUnits(world.created[0]!);
    expect(original).toHaveLength(1);
    vi.resetModules();
    const { goldenProcess: reopen } = await import("./testing/goldenFlow.js");
    const second = reopen(world, "reconcile-start", [
      () => call("work_start", { repo: "acme/api", sourceMessage: "Fix it", ...BRIEF }),
      () => answer("The saved task is running."),
    ]);
    expect(await second.deliver(fix, true)).toMatchObject({ status: "completed" });
    expect(second.remaining()).toBe(0);
    expect(world.created).toHaveLength(1);
    expect(await second.instances.listUnits(world.created[0]!)).toEqual(original);
  });

  it("withholds the answer when source authorization changes before publication", async () => {
    const world = goldenWorld(Date.now);
    world.state.revokeOnRead = true;
    const process = goldenProcess(world, "source-revoked", [
      () => call("mcp__metrics__signups", { query: SOURCE.query }),
      () => answer(`Private count: ${SOURCE.result}`),
    ]);
    await process.deliver(world.event("How many signups failed?"));
    expect(world.sourceReads).toHaveLength(1);
    expect(process.remaining()).toBe(0);
    expect(JSON.stringify(world.posts)).not.toContain(SOURCE.result);
    expect(world.created).toEqual([]);
  });

  it.each([
    { name: "a foreign repository in model input", repo: "acme/foreign", sourceMessage: "Fix it" },
    {
      name: "an instruction absent from the requester turn",
      repo: "acme/api",
      sourceMessage: "fix the foreign project",
    },
  ])("refuses $name at the work proposal boundary", async ({ repo, sourceMessage }) => {
    const world = goldenWorld(Date.now);
    const process = goldenProcess(world, "bad-proposal", [
      () => call("work_start", { repo, sourceMessage, ...BRIEF }),
      (req) => {
        expect(JSON.stringify(req.messages)).toContain("error:");
        return answer("No worker started.");
      },
    ]);
    expect(await process.deliver(world.event("Fix it"))).toMatchObject({ status: "completed" });
    expect(process.remaining()).toBe(0);
    expect(world.created).toEqual([]);
  });
});
