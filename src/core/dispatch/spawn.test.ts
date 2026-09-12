import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { RunRegistry } from "../runRegistry.js";
import type { ChannelIO, IncomingMessage, OpenedThread } from "../types.js";
import type { CoreDeps, DispatchOptions, DispatchOutcome } from "../dispatcher.js";
import {
  childRequestText,
  childThreadLead,
  DEFAULT_MAX_CHILDREN,
  MAX_SPAWN_DEPTH,
  maxChildrenOf,
  nullSpawnCapability,
  spawnCapabilityFor,
  spawnChild,
  type SpawnDeps,
  type SpawnParent,
} from "./spawn.js";

// Feature: docs/reference/specs/routing-and-config.md item 20 (the child
// pipeline), docs/reference/specs/thread-admission.md item 6 (a child is its own
// thread), docs/reference/specs/agent-conductor.md — `spawnChild()` is the ONE
// path a child run is born through: it refuses depth, budget and fan-out before
// anything else, opens a thread through the parent's channel, and hands the
// child to `dispatch()` as the requesting user with `parent` set. What the
// pipeline does with the child (the gates, the clipped budget, the record) is
// proven through `dispatch()` in `src/core/dispatcher.test.ts` (`agent:conductor`).

const YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
`;

function configStore(yaml = YAML): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-spawn-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

const NOW = 50_000;
const PARENT_MSG: IncomingMessage = {
  channelId: "slack:CX",
  userId: "slack:UALICE",
  userName: "alice",
  channelName: "general",
  threadKey: "slack:CX:1.0",
  text: "agent:conductor research two things",
  sourceUrl: "https://acme.slack.com/archives/CX/p10",
};

/** A recording channel: replies kept, `openThread` answering a fixed child thread whose replies are kept too. */
function channel(opts: { openThread?: false } = {}) {
  const replies: string[] = [];
  const childReplies: string[] = [];
  const childIo: ChannelIO = {
    reply: async (t) => void childReplies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
  };
  const leads: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
    ...(opts.openThread === false
      ? {}
      : {
          openThread: async (lead: string): Promise<OpenedThread> => {
            leads.push(lead);
            return {
              thread: { threadKey: "slack:CX:9.0", sourceUrl: "https://acme.slack.com/archives/CX/p90" },
              io: childIo,
            };
          },
        }),
  };
  return { io, childIo, replies, childReplies, leads };
}

/** A `dispatch()` double: records its calls and plays the script the test hands it. */
function fakeDispatch(
  script: (msg: IncomingMessage, io: ChannelIO, opts: DispatchOptions | undefined) => Promise<DispatchOutcome>,
) {
  const calls: Array<{ msg: IncomingMessage; io: ChannelIO; opts: DispatchOptions | undefined }> = [];
  const dispatch = vi.fn(async (_deps: CoreDeps, msg: IncomingMessage, io: ChannelIO, opts?: DispatchOptions) => {
    calls.push({ msg, io, opts });
    return script(msg, io, opts);
  });
  return { dispatch, calls };
}

/** The child registers, then its dispatch completes: the common path. */
const registers =
  (id: string) =>
  async (_msg: IncomingMessage, io: ChannelIO): Promise<DispatchOutcome> => {
    io.runStarted?.({ id });
    return { status: "completed" };
  };

function deps(
  dispatch: SpawnDeps<CoreDeps>["dispatch"],
  over: { registry?: RunRegistry; yaml?: string } = {},
): SpawnDeps<CoreDeps> & { registry: RunRegistry } {
  const registry = over.registry ?? new RunRegistry({ genId: () => "run-child", genToken: () => "tok" });
  const core = { config: configStore(over.yaml), runRegistry: registry } as unknown as CoreDeps;
  return { core, dispatch, registry, clock: () => NOW };
}

const parent = (io: ChannelIO, over: Partial<SpawnParent> = {}): SpawnParent => ({
  runId: "run-p",
  depth: 0,
  remainingMs: 30 * 60_000,
  agentName: "conductor",
  msg: PARENT_MSG,
  io,
  ...over,
});

describe("spawnChild — the one path a child run is born through", () => {
  it("builds the child's message as the requesting user on the opened thread and calls dispatch() with `parent` set: the child registers and the parent gets its id, thread and link", async () => {
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const d = deps(dispatch);
    const ch = channel();
    const out = await spawnChild(d, parent(ch.io), { preset: "research", prompt: "what is a Durable Object?" });
    expect(out).toEqual({
      kind: "spawned",
      runId: "run-child",
      threadKey: "slack:CX:9.0",
      url: "https://acme.slack.com/archives/CX/p90",
    });
    expect(calls).toHaveLength(1);
    const [{ msg, opts }] = calls;
    expect(dispatch.mock.calls[0][0]).toBe(d.core);
    expect(msg).toEqual({
      channelId: "slack:CX",
      userId: "slack:UALICE",
      userName: "alice",
      channelName: "general",
      threadKey: "slack:CX:9.0",
      sourceUrl: "https://acme.slack.com/archives/CX/p90",
      text: "agent:research what is a Durable Object?",
      receivedAt: NOW,
    });
    expect(opts).toEqual({ parent: { runId: "run-p", depth: 1, remainingMs: 30 * 60_000 } });
    // The lead the parent's channel posted names the child, the requester and the parent.
    expect(ch.leads).toHaveLength(1);
    expect(ch.leads[0]).toContain("*research*");
    expect(ch.leads[0]).toContain("alice");
    expect(ch.leads[0]).toContain("*conductor*");
    expect(ch.leads[0]).toContain("what is a Durable Object?");
    expect(ch.leads[0]).toContain(PARENT_MSG.sourceUrl);
  });

  it("the child's channel is the opened thread's: a reply in the child's dispatch lands there, never in the parent's thread", async () => {
    const { dispatch } = fakeDispatch(async (_msg, io) => {
      await io.reply("hello from the child");
      io.runStarted?.({ id: "run-child" });
      return { status: "completed" };
    });
    const ch = channel();
    await spawnChild(deps(dispatch), parent(ch.io), { preset: "research", prompt: "q" });
    expect(ch.childReplies).toEqual(["hello from the child"]);
    expect(ch.replies).toEqual([]);
  });

  it("a spawn from a run at depth 1 is refused `spawn_depth` before anything else: no thread opened, no dispatch", async () => {
    const { dispatch } = fakeDispatch(registers("run-child"));
    const ch = channel();
    const out = await spawnChild(deps(dispatch), parent(ch.io, { depth: MAX_SPAWN_DEPTH }), {
      preset: "research",
      prompt: "q",
    });
    expect(out).toMatchObject({ kind: "refused", reason: "spawn_depth" });
    expect((out as { message: string }).message).toMatch(/itself a child/);
    expect(ch.leads).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a parent with under two minutes left is refused `spawn_budget`: a child could never run a command", async () => {
    const { dispatch } = fakeDispatch(registers("run-child"));
    const ch = channel();
    const out = await spawnChild(deps(dispatch), parent(ch.io, { remainingMs: 119_000 }), {
      preset: "research",
      prompt: "q",
    });
    expect(out).toMatchObject({ kind: "refused", reason: "spawn_budget" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("the fourth live child under the default cap of 3 is refused `spawn_fanout`; a finished child does not count, and a configured cap replaces the default", async () => {
    const registry = new RunRegistry({ genId: () => "run-new", genToken: () => "tok" });
    const child = (id: string, parentRunId = "run-p") =>
      registry.create(
        "c",
        { channelId: "slack:CX", userId: "slack:UALICE", threadKey: `slack:CX:${id}`, parentRunId },
        { id },
      );
    child("c1");
    child("c2");
    child("c3");
    child("other-parent", "run-q"); // another parent's child never counts
    const { dispatch } = fakeDispatch(registers("run-new"));
    const d = deps(dispatch, { registry });
    const ch = channel();
    const refused = await spawnChild(d, parent(ch.io), { preset: "research", prompt: "q" });
    expect(refused).toMatchObject({ kind: "refused", reason: "spawn_fanout" });
    expect((refused as { message: string }).message).toContain("3");
    expect(dispatch).not.toHaveBeenCalled();
    // One child finishes: a slot is free.
    registry.finish("c1", "completed");
    expect(await spawnChild(d, parent(ch.io), { preset: "research", prompt: "q" })).toMatchObject({ kind: "spawned" });
    // A deployment that caps at 1 refuses the second while the first is live.
    const capped = deps(dispatch, { registry, yaml: `${YAML}spawn:\n  maxChildren: 1\n` });
    expect(await spawnChild(capped, parent(ch.io), { preset: "research", prompt: "q" })).toMatchObject({
      kind: "refused",
      reason: "spawn_fanout",
    });
  });

  it("a channel whose IO cannot open a thread refuses `spawn_unsupported` naming the channel, and never dispatches", async () => {
    const { dispatch } = fakeDispatch(registers("run-child"));
    const ch = channel({ openThread: false });
    const out = await spawnChild(deps(dispatch), parent(ch.io, { msg: { ...PARENT_MSG, channelId: "http:ops" } }), {
      preset: "research",
      prompt: "q",
    });
    expect(out).toMatchObject({ kind: "refused", reason: "spawn_unsupported" });
    expect((out as { message: string }).message).toContain("http");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a refusal at a gate before the child registered is relayed by name with the child thread's own reply, and the parent's thread is untouched", async () => {
    const { dispatch } = fakeDispatch(async (_msg, io) => {
      await io.reply("🚫 You're not on the allowlist for the `coding` agent.");
      return { status: "refused", refusal: "agent_allowlist" };
    });
    const ch = channel();
    const out = await spawnChild(deps(dispatch), parent(ch.io), {
      preset: "coding",
      prompt: "fix it",
      repo: "acme/api",
    });
    expect(out).toEqual({
      kind: "refused",
      reason: "agent_allowlist",
      message: "🚫 You're not on the allowlist for the `coding` agent.",
    });
    expect(ch.childReplies).toEqual(["🚫 You're not on the allowlist for the `coding` agent."]);
    expect(ch.replies).toEqual([]);
  });

  it("a dispatch that fails before any run exists is `spawn_failed` with the error's message; one that threw is too", async () => {
    const failed = fakeDispatch(async (_msg, io) => {
      await io.reply("⚠️ Unknown provider");
      return { status: "failed" };
    });
    const ch = channel();
    expect(await spawnChild(deps(failed.dispatch), parent(ch.io), { preset: "research", prompt: "q" })).toEqual({
      kind: "refused",
      reason: "spawn_failed",
      message: "⚠️ Unknown provider",
    });
    const threw = fakeDispatch(async () => {
      throw new Error("registry exploded");
    });
    expect(await spawnChild(deps(threw.dispatch), parent(channel().io), { preset: "research", prompt: "q" })).toEqual({
      kind: "refused",
      reason: "spawn_failed",
      message: "registry exploded",
    });
  });

  it("a channel that cannot open the thread — a throw from `openThread` — is `spawn_failed` naming the cause, and nothing is dispatched", async () => {
    const { dispatch } = fakeDispatch(registers("run-child"));
    const ch = channel();
    ch.io.openThread = async () => {
      throw new Error("chat.postMessage answered without a ts");
    };
    const out = await spawnChild(deps(dispatch), parent(ch.io), { preset: "research", prompt: "q" });
    expect(out).toEqual({
      kind: "refused",
      reason: "spawn_failed",
      message: "the channel could not open the child's thread: chat.postMessage answered without a ts",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("spawnCapabilityFor — the capability a spawning run's tools hold", () => {
  it("spawns with the parent's remaining wall clock at the call, and remembers how a child that registered ended when its dispatch returns later", async () => {
    let finish!: (o: DispatchOutcome) => void;
    const { dispatch } = fakeDispatch(async (_msg, io) => {
      io.runStarted?.({ id: "run-child" });
      return new Promise<DispatchOutcome>((resolve) => {
        finish = resolve;
      });
    });
    const ch = channel();
    const cap = spawnCapabilityFor(deps(dispatch), {
      runId: "run-p",
      depth: 0,
      agentName: "conductor",
      msg: PARENT_MSG,
      io: ch.io,
    });
    const out = await cap.spawn({ preset: "research", prompt: "q" }, 7 * 60_000);
    expect(out).toMatchObject({ kind: "spawned", runId: "run-child" });
    expect(dispatch.mock.calls[0][3]).toEqual({ parent: { runId: "run-p", depth: 1, remainingMs: 7 * 60_000 } });
    expect(cap.childOutcome("run-child")).toBeUndefined(); // still running
    // The child was refused at a gate after it registered (a repository gate): the parent can read why.
    finish({ status: "refused", refusal: "repo_not_onboarded" });
    await vi.waitFor(() =>
      expect(cap.childOutcome("run-child")).toEqual({ status: "refused", refusal: "repo_not_onboarded" }),
    );
    expect(cap.childOutcome("someone-else")).toBeUndefined();
  });

  // The fan-out check counts the registry's live children, and a child is not in
  // the registry until its dispatch registers it: two spawns issued at once would
  // both count zero. The capability admits one spawn at a time — the next waits
  // for the previous to register or refuse — so the cap holds however the
  // caller batches its calls.
  it("spawns issued at once are admitted one at a time: under a cap of 1, the second waits for the first to register and is refused `spawn_fanout`", async () => {
    const registry = new RunRegistry({ genId: () => "run-x", genToken: () => "tok" });
    let n = 0;
    const { dispatch } = fakeDispatch(async (msg, io) => {
      // Registers a tick later, as a real dispatch does after its gates.
      await new Promise((r) => setTimeout(r, 5));
      const id = `run-child-${++n}`;
      registry.create(
        "c",
        { channelId: msg.channelId, userId: msg.userId, threadKey: msg.threadKey, parentRunId: "run-p" },
        { id },
      );
      io.runStarted?.({ id });
      return { status: "completed" };
    });
    const ch = channel();
    const cap = spawnCapabilityFor(deps(dispatch, { registry, yaml: `${YAML}spawn:\n  maxChildren: 1\n` }), {
      runId: "run-p",
      depth: 0,
      agentName: "conductor",
      msg: PARENT_MSG,
      io: ch.io,
    });
    const [first, second] = await Promise.all([
      cap.spawn({ preset: "research", prompt: "a" }, 30 * 60_000),
      cap.spawn({ preset: "research", prompt: "b" }, 30 * 60_000),
    ]);
    expect(first).toMatchObject({ kind: "spawned", runId: "run-child-1" });
    expect(second).toMatchObject({ kind: "refused", reason: "spawn_fanout" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("the null capability refuses honestly: no run is spawning here", async () => {
    expect(await nullSpawnCapability.spawn({ preset: "research", prompt: "q" }, 60_000)).toMatchObject({
      kind: "refused",
      reason: "spawn_unavailable",
    });
    expect(nullSpawnCapability.childOutcome("run-x")).toBeUndefined();
  });
});

describe("childRequestText / maxChildrenOf", () => {
  it("the child's text is the preset directive, then the budget, then the repository, then the prompt", () => {
    expect(childRequestText({ preset: "research", prompt: "what changed?" })).toBe("agent:research what changed?");
    expect(childRequestText({ preset: "coding", prompt: "fix the login test", repo: "acme/api" })).toBe(
      "agent:coding in acme/api: fix the login test",
    );
    expect(childRequestText({ preset: "explore", prompt: "time the suite", repo: "acme/api", budget: 30 })).toBe(
      "agent:explore budget:30 in acme/api: time the suite",
    );
    // A coordinator's coding child binds its thread to the unit's branch.
    expect(childRequestText({ preset: "coding", prompt: "do the unit", repo: "acme/api", ref: "plan/p/u10" })).toBe(
      "agent:coding in acme/api on branch plan/p/u10: do the unit",
    );
  });

  it("the lead names the child preset, the requester and the parent; a prompt is cut to one line", () => {
    const lead = childThreadLead(
      { agentName: "conductor", msg: PARENT_MSG },
      { preset: "research", prompt: "line one\nline two" },
    );
    expect(lead).toContain("*research*");
    expect(lead).toContain("line one");
    expect(lead).not.toContain("line two");
    const noNames = childThreadLead(
      { agentName: "conductor", msg: { ...PARENT_MSG, userName: undefined, sourceUrl: undefined } },
      { preset: "research", prompt: "q" },
    );
    expect(noNames).toContain("slack:UALICE");
  });

  it("maxChildrenOf: 3 by default, the configured value otherwise", () => {
    expect(DEFAULT_MAX_CHILDREN).toBe(3);
    expect(maxChildrenOf(undefined)).toBe(3);
    expect(maxChildrenOf({})).toBe(3);
    expect(maxChildrenOf({ maxChildren: 5 })).toBe(5);
  });
});
