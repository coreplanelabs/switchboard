import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AGENTS } from "../../agents/registry.js";
import { ConfigStore } from "../../config.js";
import type { ChatMessage } from "../chatMessage.js";
import { parentContextOf } from "./handoff.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { turnRows } from "../runLedger/transcript.js";
import { sessionCapabilityFor } from "../../tools/session.js";
import { RunRegistry } from "../runRegistry.js";
import { createRunsService, type RunsService } from "../runsService.js";
import type { ChannelIO, IncomingMessage, OpenedThread } from "../types.js";
import type { CoreDeps, DispatchOptions, DispatchOutcome } from "../dispatcher.js";
import { steerRun } from "./admission.js";
import {
  childRequestText,
  childThreadLead,
  DEFAULT_MAX_CHILDREN,
  MAX_SPAWN_DEPTH,
  maxChildrenOf,
  nullSpawnCapability,
  runToolCapabilities,
  spawnCapabilityFor,
  spawnChild,
  spawnTierRefusal,
  tierOfModel,
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
  const childFiles: string[] = [];
  const childIo: ChannelIO = {
    reply: async (t) => void childReplies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
    attachFile: async (file) => void childFiles.push(`${file.name}:${file.bytes.byteLength}:${file.lead}`),
    uploadTicket: async (file) => {
      childFiles.push(`ticket:${file.name}:${file.size}`);
      return {
        url: "https://files.example/one-shot",
        complete: async (lead) => void childFiles.push(`complete:${lead}`),
      };
    },
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
  return { io, childIo, replies, childReplies, childFiles, leads };
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
  it.each(["research", "ship"])(
    "dispatches %s with a focused durable brief and retains original evidence",
    async (preset) => {
      const ledger = new InMemoryRunLedger();
      const session = { key: "slack:CX:1.0:@thread", seedFrom: 0, request: 0, range: { from: 0, to: 3 } };
      const evidence: ChatMessage[] = [
        { role: "user", content: [{ type: "text", text: "Inspect the selected work without broadening its scope." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "read", name: "read", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "read", content: "exact original failure output" }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Correction: staging only." },
            { type: "document", name: "scope.pdf", mediaType: "application/pdf", data: "cGRm" },
          ],
        },
      ];
      for (let i = 0; i < evidence.length; i++) {
        const { rows } = turnRows(i, evidence[i], {}, i === 0 || i === 3 ? PARENT_MSG.userId : undefined);
        await ledger.appendSession(session.key, `row-${i}`, rows);
      }
      await ledger.claimSession(session.key, "run-p", "g");
      await ledger.writeNotepad(
        session.key,
        "g",
        "Original failure output is at turn 2; retain the scope correction.",
        "run-p",
      );
      const capability = sessionCapabilityFor(
        { runId: "run-p", session },
        {
          readSession: ledger.readSession.bind(ledger),
          readSessionTail: ledger.readSessionTail.bind(ledger),
          searchSession: ledger.searchSession.bind(ledger),
          readNotepad: ledger.readNotepad.bind(ledger),
          writeNotepad: (key, text, owner) => ledger.writeNotepad(key, "g", text, owner),
        },
      )!;
      const ch = channel();
      const { dispatch, calls } = fakeDispatch(registers("run-child"));
      const prompt = preset === "ship" ? "https://github.com/acme/api/pull/7" : "Inspect the scoped failure.";
      const selection =
        preset === "ship"
          ? { prBatch: { kind: "ship" as const, targets: [{ repo: "acme/api", number: 7, url: prompt }] } }
          : {};
      const outcome = await spawnChild(
        deps(dispatch),
        parent(ch.io, {
          ...selection,
          context: () =>
            capability.captureHandoff!({
              runId: "run-p",
              requester: PARENT_MSG.userId,
              channelId: PARENT_MSG.channelId,
              threadKey: PARENT_MSG.threadKey,
            }),
        }),
        { preset, prompt, repo: "acme/api" },
      );
      expect(outcome.kind).toBe("spawned");
      const context = calls[0].opts!.parentContext!;
      expect(context.messages.slice(1)).toEqual([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Frozen parent working notes (source evidence):\nOriginal failure output is at turn 2; retain the scope correction.",
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Inspect the selected work without broadening its scope." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "Correction: staging only." },
            { type: "document", name: "scope.pdf", mediaType: "application/pdf", data: "cGRm" },
          ],
        },
      ]);
      expect(context.actors).toEqual([undefined, undefined, "slack:UALICE", "slack:UALICE"]);
      expect(context.handoff?.brief?.request).toBe(0);
      expect((await ledger.readSession(context.handoff!.session.key, 2, 2)).messages).toEqual([
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "read", content: "exact original failure output" }],
        },
      ]);
    },
  );

  it("a typed flattened Ship batch starts only selected exact PRs across repositories", async () => {
    const text = "ship these: • https://github.com/acme/api/pull/7 • https://github.com/acme/web/pull/9";
    const ch = channel();
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const p = parent(ch.io, {
      msg: { ...PARENT_MSG, text },
      prBatch: {
        kind: "ship",
        targets: [
          { repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" },
          { repo: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9" },
        ],
      },
    });
    const exact = await spawnChild(deps(dispatch), p, {
      preset: "ship",
      prompt: "https://github.com/acme/web/pull/9",
    });
    expect(exact).toMatchObject({ kind: "spawned" });
    expect(calls[0]?.opts).toMatchObject({ operationTarget: { repo: "acme/web" } });
    expect(calls[0]?.opts?.parent).toEqual({ runId: "run-p", depth: 1 });
    expect(
      await spawnChild(deps(dispatch), p, { preset: "ship", prompt: "https://github.com/acme/web/pull/10" }),
    ).toMatchObject({
      kind: "refused",
      reason: "spawn_batch_target",
    });
    expect(
      await spawnChild(deps(dispatch), p, { preset: "review", prompt: "https://github.com/acme/api/pull/7" }),
    ).toMatchObject({
      kind: "refused",
      reason: "spawn_batch_target",
    });
    expect(calls).toHaveLength(1);
  });

  it("a typed Review batch binds each child to its selected repository", async () => {
    const ch = channel();
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const p = parent(ch.io, {
      msg: {
        ...PARENT_MSG,
        text: "review these: • https://github.com/acme/api/pull/7 • https://github.com/acme/web/pull/9",
      },
      prBatch: {
        kind: "review",
        targets: [
          { repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" },
          { repo: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9" },
        ],
      },
    });
    expect(
      await spawnChild(deps(dispatch), p, { preset: "review", prompt: "https://github.com/acme/web/pull/9" }),
    ).toMatchObject({ kind: "spawned" });
    expect(calls[0]?.opts).toMatchObject({ operationTarget: { repo: "acme/web" } });
    expect(
      await spawnChild(deps(dispatch), p, { preset: "review", prompt: "https://github.com/acme/api/pull/8" }),
    ).toMatchObject({
      kind: "refused",
      reason: "spawn_batch_target",
    });
  });

  it("an unbound cross-repository list cannot start Review or Ship children", async () => {
    const text =
      "<@U123|switchboard> ship these\n" +
      "- <https://github.com/acme/api/pull/7|#7 — API>\n" +
      "- <https://github.com/acme/web/pull/9|#9 — Web>";
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const d = deps(dispatch);
    const ch = channel();
    const p = parent(ch.io, {
      msg: { ...PARENT_MSG, text },
      conversation: [{ role: "user", content: [{ type: "text", text }] }],
    });
    const ship = await spawnChild(d, p, {
      preset: "ship",
      prompt: "https://github.com/acme/web/pull/9",
      repo: "acme/web",
    });
    expect(ship).toMatchObject({ kind: "refused", reason: "spawn_batch_binding" });
    const review = await spawnChild(d, p, { preset: "review", prompt: "https://github.com/acme/api/pull/7" });
    expect(review).toMatchObject({ kind: "refused", reason: "spawn_batch_binding" });
    expect(ch.leads).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("a Ship batch with thirteen linked PRs still starts an exact target", async () => {
    const text = `ship these:\n${Array.from({ length: 13 }, (_, i) => `- https://github.com/acme/api/pull/${i + 1}`).join("\n")}`;
    const ch = channel();
    const { dispatch } = fakeDispatch(registers("run-child"));
    const out = await spawnChild(
      deps(dispatch),
      parent(ch.io, {
        msg: { ...PARENT_MSG, text },
        prBatch: {
          kind: "ship",
          targets: Array.from({ length: 13 }, (_, i) => ({
            repo: "acme/api",
            number: i + 1,
            url: `https://github.com/acme/api/pull/${i + 1}`,
          })),
        },
      }),
      {
        preset: "ship",
        prompt: "https://github.com/acme/api/pull/1",
      },
    );
    expect(out).toMatchObject({ kind: "spawned" });
    expect(ch.leads).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("carries the parent's repository and ref beside the prompt, not only in it", async () => {
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const prompt = "Inspect the defect illustrated by https://github.com/acme/web/pull/7";
    await spawnChild(deps(dispatch), parent(channel().io), {
      preset: "explore",
      repo: "acme/api",
      ref: "unit/repair",
      prompt,
    });
    expect(calls[0].opts).toMatchObject({ operationTarget: { repo: "acme/api", ref: "unit/repair" } });
    expect(calls[0].msg.text).toContain(prompt);
  });

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

  // docs/reference/specs/agent-coding.md item 10: the child's file upload is
  // the opened thread's too — forwarded by method when the thread has one,
  // absent when it does not, so `attach_file` in a child says the truth.
  it("the child's channel forwards attachFile to the opened thread when it has one, and offers none when it does not", async () => {
    const seen: Array<boolean> = [];
    const { dispatch } = fakeDispatch(async (_msg, io) => {
      seen.push(io.attachFile !== undefined);
      await io.attachFile?.({ name: "shot.png", bytes: new Uint8Array([1, 2, 3]), lead: "the page" });
      return { status: "completed" };
    });
    const ch = channel();
    await spawnChild(deps(dispatch), parent(ch.io), { preset: "research", prompt: "q" });
    expect(ch.childFiles).toEqual(["shot.png:3:the page"]);
    delete ch.childIo.attachFile;
    await spawnChild(deps(dispatch), parent(ch.io), { preset: "research", prompt: "q" });
    expect(seen).toEqual([true, false]);
  });

  // record 0033: the child's one-shot upload ticket is the opened thread's too —
  // forwarded by method, absent when the thread has none, so a store-backed
  // `attach_file` in a child shares into the child's own thread.
  it("the child's channel forwards uploadTicket to the opened thread when it has one, and offers none when it does not", async () => {
    const seen: Array<boolean> = [];
    const { dispatch } = fakeDispatch(async (_msg, io) => {
      seen.push(io.uploadTicket !== undefined);
      const ticket = await io.uploadTicket?.({ name: "clip.mp4", size: 5 });
      await ticket?.complete("the clip");
      return { status: "completed" };
    });
    const ch = channel();
    await spawnChild(deps(dispatch), parent(ch.io), { preset: "research", prompt: "q" });
    expect(ch.childFiles).toEqual(["ticket:clip.mp4:5", "complete:the clip"]);
    delete ch.childIo.uploadTicket;
    await spawnChild(deps(dispatch), parent(ch.io), { preset: "research", prompt: "q" });
    expect(seen).toEqual([true, false]);
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

  // decision 0046: the floor covers each child's loop, write-up and post-step.
  it("a child with less than its preset's floor is refused before a thread opens", async () => {
    const { dispatch } = fakeDispatch(registers("run-child"));
    const ch = channel();
    const out = await spawnChild(deps(dispatch), parent(ch.io, { remainingMs: 2 * 60_000 + 30_000 }), {
      preset: "research",
      prompt: "q",
    });
    expect(out).toMatchObject({ kind: "refused", reason: "spawn_budget" });
    expect(
      (out as { message?: string; reason: string } & Record<string, unknown>).message ?? JSON.stringify(out),
    ).toContain("4-minute floor");
    expect(dispatch).not.toHaveBeenCalled();
    const general = await spawnChild(deps(dispatch), parent(ch.io, { remainingMs: 119_000 }), {
      preset: "general",
      prompt: "q",
    });
    expect(general).toMatchObject({ kind: "refused", reason: "spawn_budget" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      await spawnChild(deps(dispatch), parent(ch.io), { preset: "research", prompt: "q", budget: 3 }),
    ).toMatchObject({ kind: "refused", reason: "spawn_budget" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("the fourth live child under a configured cap of 3 is refused `spawn_fanout`; a finished child frees a slot", async () => {
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
    const d = deps(dispatch, { registry, yaml: `${YAML}spawn:\n  maxChildren: 3\n` });
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
      await io.reply("🚫 You're not on the allowlist for the `explore` agent.");
      return { status: "refused", refusal: "agent_allowlist" };
    });
    const ch = channel();
    const out = await spawnChild(deps(dispatch), parent(ch.io), {
      preset: "explore",
      prompt: "time the suite",
      repo: "acme/api",
    });
    expect(out).toEqual({
      kind: "refused",
      reason: "agent_allowlist",
      message: "🚫 You're not on the allowlist for the `explore` agent.",
    });
    expect(ch.childReplies).toEqual(["🚫 You're not on the allowlist for the `explore` agent."]);
    expect(ch.replies).toEqual([]);
  });

  // docs/reference/specs/agent-conductor.md items 3 and 12: outside the exact
  // Ship batch exception, a writer is refused before a thread opens.
  it("an untyped conductor cannot start PR children or writers, while other readers pass", async () => {
    const { dispatch } = fakeDispatch(registers("run-child"));
    const ch = channel();
    const writers = Object.values(AGENTS).filter((a) => a.identity === "write");
    expect(writers.map((a) => a.name)).toEqual(["coding", "ship"]);
    for (const { name } of writers) {
      const out = await spawnChild(deps(dispatch), parent(ch.io), { preset: name, prompt: "fix it", repo: "acme/api" });
      expect(out, name).toEqual(
        name === "ship"
          ? {
              kind: "refused",
              reason: "spawn_batch_binding",
              message: "select the exact Review or Ship targets at the operator door first",
            }
          : {
              kind: "refused",
              reason: "spawn_identity",
              message: `\`${name}\` runs as a \`write\` identity, so this run was not started: only an exact PR in a typed Ship batch may spawn a write child`,
            },
      );
    }
    expect(ch.leads).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    for (const { name } of Object.values(AGENTS).filter((a) => a.identity !== "write" && a.name !== "review")) {
      expect(await spawnChild(deps(dispatch), parent(ch.io), { preset: name, prompt: "q" }), name).toMatchObject({
        kind: "spawned",
      });
    }
  });

  it("the child receives structured parent context preserving tool results and attachments, with provider reasoning removed", async () => {
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const ch = channel();
    const conversation: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "look into durable objects" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "two parts", signature: "sig" },
          { type: "text", text: "Splitting this into two children." },
          { type: "tool_use", id: "t1", name: "update_status", input: { checklist: "○ storage" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "First," },
          { type: "text", text: "the storage question." },
          { type: "tool_use", id: "t2", name: "spawn_run", input: { preset: "research", prompt: "q" } },
        ],
      },
    ];
    await spawnChild(deps(dispatch), parent(ch.io, { conversation }), { preset: "research", prompt: "q" });
    expect(calls[0].opts).toEqual({
      parent: { runId: "run-p", depth: 1, remainingMs: 30 * 60_000 },
      parentContext: parentContextOf(conversation),
    });
    await spawnChild(deps(dispatch), parent(ch.io), { preset: "research", prompt: "q" });
    expect(calls[1].opts).toEqual({ parent: { runId: "run-p", depth: 1, remainingMs: 30 * 60_000 } });
  });

  it.each(["research", "ship"])(
    "uses the durable context callback for %s and never falls back to prose when its read fails",
    async (preset) => {
      const { dispatch, calls } = fakeDispatch(registers("run-child"));
      const ch = channel();
      const context = parentContextOf([
        { role: "user", content: [{ type: "document", mediaType: "application/pdf", data: "cGRm" }] },
      ]);
      const capture = vi.fn(async () => context);
      const prompt = preset === "ship" ? "https://github.com/acme/api/pull/7" : "q";
      const selection =
        preset === "ship"
          ? { prBatch: { kind: "ship" as const, targets: [{ repo: "acme/api", number: 7, url: prompt }] } }
          : {};
      await spawnChild(deps(dispatch), parent(ch.io, { context: capture, ...selection }), {
        preset,
        prompt,
        repo: "acme/api",
      });
      expect(capture).toHaveBeenCalledOnce();
      expect(calls[0].opts).toMatchObject({ parentContext: context });
      capture.mockClear();
      const refused = await spawnChild(deps(dispatch), parent(ch.io, { context: capture }), {
        preset: "coding",
        prompt: "q",
      });
      expect(refused).toMatchObject({ kind: "refused", reason: "spawn_identity" });
      expect(capture).not.toHaveBeenCalled();
      const failed = await spawnChild(
        deps(dispatch),
        parent(ch.io, {
          ...selection,
          context: async () => {
            throw new Error("source log unavailable");
          },
          conversation: [{ role: "user", content: [{ type: "text", text: "lossy fallback" }] }],
        }),
        { preset, prompt, repo: "acme/api" },
      );
      expect(failed).toMatchObject({ kind: "refused", reason: "spawn_context" });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(ch.leads).toHaveLength(1);
    },
  );

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
  it("refuses a Ship target already launched by this parent before a restarted capability opens a thread", async () => {
    const target = "https://github.com/acme/api/pull/7";
    const text = `ship these:\n- ${target}\n- https://github.com/acme/web/pull/9`;
    const history = {
      listRuns: vi.fn(async () => ({ runs: [{ id: "old-ship", agent: "ship" }] })),
      getRun: vi.fn(async () => ({
        ok: true,
        value: { events: [{ type: "input", text: `in acme/api: ${target}` }] },
      })),
    } as unknown as Pick<RunsService, "listRuns" | "getRun">;
    const { dispatch } = fakeDispatch(registers("new-ship"));
    const ch = channel();
    const cap = spawnCapabilityFor(
      deps(dispatch),
      {
        runId: "run-p",
        depth: 0,
        agentName: "conductor",
        msg: { ...PARENT_MSG, text },
        io: ch.io,
        prBatch: {
          kind: "ship",
          targets: [
            { repo: "acme/api", number: 7, url: target },
            { repo: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9" },
          ],
        },
      },
      history,
    );
    expect(
      await cap.spawn({ preset: "ship", prompt: target, repo: "acme/api" }, { remainingMs: 30 * 60_000 }),
    ).toMatchObject({
      kind: "refused",
      reason: "spawn_ship_duplicate",
    });
    expect(ch.leads).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a Ship target closed when prior child history is unavailable", async () => {
    const target = "https://github.com/acme/api/pull/7";
    const text = `ship these:\n- ${target}\n- https://github.com/acme/web/pull/9`;
    const history = {
      listRuns: vi.fn(async () => ({ runs: [], storeUnavailable: true })),
    } as unknown as Pick<RunsService, "listRuns" | "getRun">;
    const { dispatch } = fakeDispatch(registers("new-ship"));
    const ch = channel();
    const cap = spawnCapabilityFor(
      deps(dispatch),
      {
        runId: "run-p",
        depth: 0,
        agentName: "conductor",
        msg: { ...PARENT_MSG, text },
        io: ch.io,
        prBatch: {
          kind: "ship",
          targets: [
            { repo: "acme/api", number: 7, url: target },
            { repo: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9" },
          ],
        },
      },
      history,
    );
    expect(await cap.spawn({ preset: "ship", prompt: target }, { remainingMs: 30 * 60_000 })).toMatchObject({
      kind: "refused",
      reason: "spawn_ship_history_unavailable",
    });
    expect(ch.leads).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("starts Ship once per PR in the original batch", async () => {
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const text = "ship these:\n- https://github.com/acme/api/pull/7\n- https://github.com/acme/web/pull/9";
    const cap = spawnCapabilityFor(deps(dispatch), {
      runId: "run-p",
      depth: 0,
      agentName: "conductor",
      msg: { ...PARENT_MSG, text },
      prBatch: {
        kind: "ship",
        targets: [
          { repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" },
          { repo: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9" },
        ],
      },
      io: channel().io,
    });
    const request = { preset: "ship", prompt: "https://github.com/acme/api/pull/7", repo: "acme/api" };
    const at = { remainingMs: 30 * 60_000 };
    expect(await cap.spawn(request, at)).toMatchObject({ kind: "spawned" });
    expect(await cap.spawn(request, at)).toMatchObject({ kind: "refused", reason: "spawn_ship_duplicate" });
    expect(
      await cap.spawn({ preset: "ship", prompt: "https://github.com/acme/web/pull/9", budget: 112 }, at),
    ).toMatchObject({ kind: "refused", reason: "spawn_budget" });
    expect(calls).toHaveLength(1);
  });

  it("starts all six independent Ship units even when the read-child cap is one", async () => {
    const registry = new RunRegistry({ genId: () => "run-x", genToken: () => "tok" });
    const targets = [
      { repo: "acme/api", number: 7 },
      { repo: "acme/api", number: 8 },
      { repo: "acme/api", number: 9 },
      { repo: "acme/web", number: 10 },
      { repo: "acme/web", number: 11 },
      { repo: "acme/web", number: 12 },
    ];
    const text = `ship these:\n${targets.map((t) => `- https://github.com/${t.repo}/pull/${t.number}`).join("\n")}`;
    let nextId = 0;
    const { dispatch, calls } = fakeDispatch(async (msg, io) => {
      const id = `run-child-${++nextId}`;
      registry.create(
        "c",
        {
          agent: msg.text.startsWith("agent:ship") ? "ship" : "research",
          channelId: msg.channelId,
          userId: msg.userId,
          threadKey: msg.threadKey,
          parentRunId: "run-p",
        },
        { id },
      );
      io.runStarted?.({ id });
      return { status: "completed" };
    });
    const cap = spawnCapabilityFor(deps(dispatch, { registry, yaml: `${YAML}spawn:\n  maxChildren: 1\n` }), {
      runId: "run-p",
      depth: 0,
      agentName: "conductor",
      msg: { ...PARENT_MSG, text },
      prBatch: {
        kind: "ship",
        targets: targets.map((target) => ({
          ...target,
          url: `https://github.com/${target.repo}/pull/${target.number}`,
        })),
      },
      io: channel().io,
    });
    const outcomes = await Promise.all(
      targets.map((target) =>
        cap.spawn(
          {
            preset: "ship",
            prompt: `https://github.com/${target.repo}/pull/${target.number}`,
            repo: target.repo,
          },
          { remainingMs: 5 * 60_000 },
        ),
      ),
    );
    expect(outcomes).toHaveLength(6);
    expect(outcomes.every((outcome) => outcome.kind === "spawned")).toBe(true);
    expect(calls).toHaveLength(6);
    for (const call of calls) expect(call.opts?.parent).toEqual({ runId: "run-p", depth: 1 });
    expect(
      await cap.spawn({ preset: "research", prompt: "read the batch status" }, { remainingMs: 5 * 60_000 }),
    ).toMatchObject({
      kind: "spawned",
    });
  });

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
    const out = await cap.spawn({ preset: "research", prompt: "q" }, { remainingMs: 7 * 60_000 });
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

  it("hands the conversation the call offers on as the child's seed, and seeds nothing for a call that offers none", async () => {
    const { dispatch } = fakeDispatch(registers("run-child"));
    const ch = channel();
    const cap = spawnCapabilityFor(deps(dispatch), {
      runId: "run-p",
      depth: 0,
      agentName: "conductor",
      msg: PARENT_MSG,
      io: ch.io,
    });
    const conversation: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "look into durable objects" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "spawn_run", input: {} }] },
    ];
    await cap.spawn({ preset: "research", prompt: "q" }, { remainingMs: 7 * 60_000, conversation });
    expect(dispatch.mock.calls[0][3]).toEqual({
      parent: { runId: "run-p", depth: 1, remainingMs: 7 * 60_000 },
      parentContext: parentContextOf(conversation),
    });
    await cap.spawn({ preset: "research", prompt: "q" }, { remainingMs: 7 * 60_000 });
    expect(dispatch.mock.calls[1][3]).toEqual({ parent: { runId: "run-p", depth: 1, remainingMs: 7 * 60_000 } });
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
      cap.spawn({ preset: "research", prompt: "a" }, { remainingMs: 30 * 60_000 }),
      cap.spawn({ preset: "research", prompt: "b" }, { remainingMs: 30 * 60_000 }),
    ]);
    expect(first).toMatchObject({ kind: "spawned", runId: "run-child-1" });
    expect(second).toMatchObject({ kind: "refused", reason: "spawn_fanout" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("the null capability refuses honestly: no run is spawning here", async () => {
    expect(await nullSpawnCapability.spawn({ preset: "research", prompt: "q" }, { remainingMs: 60_000 })).toMatchObject(
      {
        kind: "refused",
        reason: "spawn_unavailable",
      },
    );
    expect(nullSpawnCapability.childOutcome("run-x")).toBeUndefined();
  });
});

// The readers’ classifier and its configured fast ref are gone; every model a
// run can receive is strong, while the request slot still outranks scopes.
describe("tiers at spawn — the parent's model and effort in the child's request slot (the one-door plan's tiers rule)", () => {
  it("tierOfModel: every configured run model is strong after the classifier tier retires", () => {
    expect(tierOfModel("anthropic/fast-model", {})).toBe("strong");
    expect(tierOfModel("anthropic/general-model", {})).toBe("strong");
  });

  it("spawnTierRefusal: a configured run model is admitted on the strong tier wherever the preset permits it", () => {
    for (const preset of ["coding", "ship", "review", "explore", "research", "general", "conductor"])
      expect(spawnTierRefusal({ preset, model: "anthropic/fast-model" }, {}), preset).toBeUndefined();
    expect(spawnTierRefusal({ preset: "coding" }, {})).toBeUndefined();
    expect(spawnTierRefusal({ preset: "no-such-preset", model: "anthropic/fast-model" }, {})).toBeUndefined();
  });

  it("a child request carries the parent's model and effort as its own directives — the request slot, resolved ahead of every scope", async () => {
    const ch = channel();
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const out = await spawnChild(deps(dispatch), parent(ch.io), {
      preset: "explore",
      prompt: "time the suite",
      model: "anthropic/fast-model",
      effort: "low",
    });
    expect(out.kind).toBe("spawned");
    expect(calls[0].msg.text).toBe("agent:explore model:anthropic/fast-model effort:low time the suite");
  });
});

describe("child launch after asynchronous waits", () => {
  it("keeps an internal decision message ID and parent provenance in durable steering input", async () => {
    const sent: unknown[] = [];
    const result = await steerRun(
      {
        config: configStore(),
        clock: () => 123,
        admission: { get: () => undefined },
        runLedger: {
          pushInbox: async (runId, message) => {
            sent.push({ runId, message });
            return 1;
          },
        },
      },
      {
        userId: "slack:UALICE",
        channelId: "slack:CX",
        threadKey: "slack:CX:parent",
        from: { runId: "parent" },
        messageId: 'run:["parent","steer-one"]',
      },
      { runId: "child", agent: "research", threadKey: "slack:CX:child", parentRunId: "parent" },
      "Focus on retries.",
    );
    expect(result).toEqual({ kind: "steered", where: "elsewhere", at: 123, ledgerSeq: 1 });
    expect(sent).toMatchObject([
      {
        runId: "child",
        message: {
          messageId: 'run:["parent","steer-one"]',
          userId: "slack:UALICE",
          fromRunId: "parent",
          text: "Focus on retries.",
        },
      },
    ]);
  });
  it("passes the action binder's PR target without replacing it with child prompt citations", async () => {
    const ch = channel();
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const { remainingMs: _, ...run } = parent(ch.io, { agentName: "orchestrator" });
    const cap = spawnCapabilityFor(deps(dispatch), run);
    const out = await cap.spawn(
      { preset: "review", repo: "acme/api", prompt: "Read https://github.com/acme/api/pull/8 for context." },
      {
        remainingMs: 600_000,
        operationTarget: {
          repo: "acme/api",
          prTarget: { number: 7, source: "request", quote: "https://github.com/acme/api/pull/7" },
        },
      },
    );
    expect(out).toMatchObject({ kind: "spawned", runId: "run-child" });
    expect(calls[0].opts?.operationTarget).toEqual({
      repo: "acme/api",
      prTarget: { number: 7, source: "request", quote: "https://github.com/acme/api/pull/7" },
    });
  });
  it.each(["context", "thread"])("holds a revoked requester source after the %s wait", async (stage) => {
    let current = true;
    const ch = channel();
    const open = ch.io.openThread!;
    ch.io.openThread = async (lead) => {
      if (stage === "thread") current = false;
      return open(lead);
    };
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const { remainingMs: _, ...run } = parent(ch.io);
    const cap = spawnCapabilityFor(deps(dispatch), run);
    const out = await cap.spawn(
      { preset: "research", prompt: "q" },
      {
        remainingMs: 600_000,
        sourceCurrent: () => current,
        context: async () => {
          if (stage === "context") current = false;
          return parentContextOf([]);
        },
      },
    );
    expect(out).toMatchObject({ kind: "refused", reason: "spawn_source_changed" });
    expect(calls).toHaveLength(0);
    expect(ch.leads).toHaveLength(stage === "thread" ? 1 : 0);
    expect(
      await cap.spawn(
        { preset: "research", prompt: "new request" },
        { remainingMs: 600_000, sourceCurrent: () => true },
      ),
    ).toMatchObject({ kind: "spawned", runId: "run-child" });
  });
  it("subtracts context and thread waits from the read child's inherited budget", async () => {
    let now = NOW;
    const ch = channel();
    const open = ch.io.openThread!;
    ch.io.openThread = async (lead) => {
      now += 60_000;
      return open(lead);
    };
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const d = { ...deps(dispatch), clock: () => now };
    const out = await spawnChild(
      d,
      parent(ch.io, {
        remainingMs: 10 * 60_000,
        context: async () => {
          now += 2 * 60_000;
          return parentContextOf([]);
        },
      }),
      { preset: "research", prompt: "q" },
    );
    expect(out).toMatchObject({ kind: "spawned", runId: "run-child" });
    expect(calls[0].opts?.parent).toEqual({ runId: "run-p", depth: 1, remainingMs: 7 * 60_000 });
  });

  it.each(["context", "thread"])("refuses an exhausted budget after the %s wait", async (stage) => {
    let now = NOW;
    const ch = channel();
    const open = ch.io.openThread!;
    ch.io.openThread = async (lead) => {
      if (stage === "thread") now += 3 * 60_000;
      return open(lead);
    };
    const { dispatch } = fakeDispatch(registers("run-child"));
    const out = await spawnChild(
      { ...deps(dispatch), clock: () => now },
      parent(ch.io, {
        remainingMs: 5 * 60_000,
        context: async () => {
          if (stage === "context") now += 3 * 60_000;
          return parentContextOf([]);
        },
      }),
      { preset: "research", prompt: "q" },
    );
    expect(out).toMatchObject({ kind: "refused", reason: "spawn_budget" });
    expect(ch.leads).toHaveLength(stage === "thread" ? 1 : 0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("counts time in the serial launch queue against each call's original budget", async () => {
    let now = NOW;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const ch = channel();
    const { dispatch, calls } = fakeDispatch(registers("run-child"));
    const { remainingMs: _, ...run } = parent(ch.io);
    const cap = spawnCapabilityFor({ ...deps(dispatch), clock: () => now }, run);
    const first = cap.spawn(
      { preset: "research", prompt: "first" },
      {
        remainingMs: 10 * 60_000,
        context: async () => {
          await held;
          return parentContextOf([]);
        },
      },
    );
    const second = cap.spawn({ preset: "research", prompt: "second" }, { remainingMs: 5 * 60_000 });
    now += 2 * 60_000;
    release();
    expect(await first).toMatchObject({ kind: "spawned", runId: "run-child" });
    expect(await second).toMatchObject({ kind: "refused", reason: "spawn_budget" });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.parent?.remainingMs).toBe(8 * 60_000);
  });

  it.each([
    ["context", "stop"],
    ["thread", "stop"],
    ["context", "finish"],
    ["thread", "discard"],
    ["context", "replace"],
  ] as const)("refuses when the parent changes to %s/%s before child dispatch", async (stage, end) => {
    const ch = channel();
    const { dispatch } = fakeDispatch(registers("run-child"));
    const d = deps(dispatch);
    const handle = d.registry.create("parent", undefined, { id: "run-p" });
    d.core.runs = createRunsService({ registry: d.registry, store: null });
    const endParent = () => {
      if (end === "stop") d.registry.requestStop(handle.id, handle.token, "soft");
      else if (end === "finish") d.registry.finish(handle.id, "completed");
      else if (end === "discard") d.registry.discard(handle.id);
      else {
        d.registry.finish(handle.id, "interrupted");
        d.registry.discard(handle.id);
        d.registry.create("resumed parent", undefined, { id: handle.id, token: handle.token });
      }
    };
    const open = ch.io.openThread!;
    ch.io.openThread = async (lead) => {
      if (stage === "thread") endParent();
      return open(lead);
    };
    const { remainingMs: _, ...run } = parent(ch.io);
    const cap = runToolCapabilities(d, { ...run, control: handle.control, inbox: { arrived: 0 } }).spawn;
    const out = await cap.spawn(
      { preset: "research", prompt: "q" },
      {
        remainingMs: 10 * 60_000,
        context: async () => {
          if (stage === "context") endParent();
          return parentContextOf([]);
        },
      },
    );
    expect(out).toEqual({
      kind: "refused",
      reason: "spawn_parent_ended",
      message: "this run has stopped or ended; no new child can start",
    });
    expect(ch.leads).toHaveLength(stage === "thread" ? 1 : 0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not launch a queued child after its parent stops, while retaining the child already started", async () => {
    const ch = channel();
    const registry = new RunRegistry();
    const handle = registry.create("parent", undefined, { id: "run-p" });
    const { dispatch, calls } = fakeDispatch(async (_msg, io) => {
      io.runStarted?.({ id: "first-child" });
      registry.requestStop(handle.id, handle.token, "hard");
      return { status: "completed" };
    });
    const d = deps(dispatch, { registry });
    d.core.runs = createRunsService({ registry, store: null });
    const { remainingMs: _, ...run } = parent(ch.io);
    const cap = runToolCapabilities(d, { ...run, control: handle.control, inbox: { arrived: 0 } }).spawn;
    const first = cap.spawn({ preset: "research", prompt: "first" }, { remainingMs: 10 * 60_000 });
    const second = cap.spawn({ preset: "research", prompt: "second" }, { remainingMs: 10 * 60_000 });
    expect(await first).toMatchObject({ kind: "spawned", runId: "first-child" });
    expect(await second).toMatchObject({ kind: "refused", reason: "spawn_parent_ended" });
    expect(calls).toHaveLength(1);
    expect(ch.leads).toHaveLength(1);
  });

  it("counts Ship history reads against the launch budget without clipping an admitted unit's lease", async () => {
    let now = NOW;
    const ch = channel();
    const { dispatch, calls } = fakeDispatch(registers("ship-child"));
    const target = "https://github.com/acme/api/pull/7";
    const { remainingMs: _, ...run } = parent(ch.io, {
      prBatch: { kind: "ship", targets: [{ repo: "acme/api", number: 7, url: target }] },
    });
    const d = { ...deps(dispatch), clock: () => now };
    const history = {
      listRuns: async () => {
        now += 2 * 60_000;
        return { runs: [] };
      },
      getRun: async () => ({ ok: false as const, error: "not_found" as const }),
    };
    const request = { preset: "ship", prompt: target };
    const started = await spawnCapabilityFor(d, run, history).spawn(request, { remainingMs: 8 * 60_000 });
    expect(started).toMatchObject({ kind: "spawned", runId: "ship-child" });
    expect(calls[0].opts?.parent).toEqual({ runId: "run-p", depth: 1 });
    const ended = await spawnCapabilityFor(d, run, history).spawn(request, { remainingMs: 5 * 60_000 });
    expect(ended).toMatchObject({ kind: "refused", reason: "spawn_budget" });
    expect(calls).toHaveLength(1);
    expect(ch.leads).toHaveLength(1);
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
    // The parent's tier rides as the child's own directives, ahead of the budget.
    expect(
      childRequestText({
        preset: "explore",
        prompt: "time the suite",
        repo: "acme/api",
        budget: 30,
        model: "anthropic/fast-model",
        effort: "low",
      }),
    ).toBe("agent:explore model:anthropic/fast-model effort:low budget:30 in acme/api: time the suite");
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

  it("maxChildrenOf: the bounded default, the configured value otherwise", () => {
    expect(DEFAULT_MAX_CHILDREN).toBe(8);
    expect(maxChildrenOf(undefined)).toBe(8);
    expect(maxChildrenOf({})).toBe(8);
    expect(maxChildrenOf({ maxChildren: 5 })).toBe(5);
  });
});
