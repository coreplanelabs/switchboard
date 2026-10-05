import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  InMemoryPrivateWorkerLog,
  UnavailablePrivateWorkerLog,
  isPrivateWorkerEvent,
} from "../core/privateWorkerLog.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { CoordinatorInstance } from "../core/coordinator/contract.js";
import {
  appendPrivateWorkerInput,
  appendPrivateWorkerReply,
  parsePrivateWorkerThreadKey,
  privateWorkerIO,
  rehostPrivateWorkerIO,
  privateWorkerThreadKey,
} from "./privateWorker.js";

const task = { instanceId: "plan_A-1", unit: "U12" };
const threadKey = "worker:plan_A-1:U12";
const now = () => 1000;

describe("private worker IO — a task thread with no Slack delivery", () => {
  it("checks the original act and private requester before exposing worker history", async () => {
    const log = new InMemoryPrivateWorkerLog();
    await appendPrivateWorkerInput(log, task, { id: "spawn-1", sender: "slack:UA", text: "private finding", at: 10 });
    const requester = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:UA",
      threadKey: "slack:DMAIN:1.0",
    };
    let current = true;
    const io = privateWorkerIO(log, task, {
      clock: now,
      currentInputId: "spawn-2",
      audience: {
        actId: "m_original",
        requester,
        spawnKey: "spawn-2",
        verify: async () => (current ? { ok: true } : { ok: false, code: "direct-audience-denied" }),
      },
    });
    const msg = {
      channelId: requester.channelId,
      userId: requester.userId,
      threadKey,
      messageId: "spawn-2",
      text: "continue",
    };
    expect(await io.verifyPrivateWorkerAudience?.(msg)).toEqual({ ok: true });
    expect(await io.history()).toEqual([{ role: "user", text: "private finding", at: 10, user: "slack:UA" }]);
    expect(await io.verifyPrivateWorkerAudience?.({ ...msg, messageId: "other" })).toMatchObject({ ok: false });
    expect(await io.verifyPrivateWorkerAudience?.({ ...msg, userId: "slack:UB" })).toMatchObject({ ok: false });
    current = false;
    expect(await io.verifyPrivateWorkerAudience?.(msg)).toMatchObject({ ok: false });
    await expect(io.history()).rejects.toThrow("private worker audience unavailable");
    await expect(io.reply("private reply")).rejects.toThrow("private worker audience unavailable");
  });

  it("rebuilds the audience check from a current stored binding after rehost", async () => {
    const log = new InMemoryPrivateWorkerLog();
    const requester = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:UA",
      threadKey: "slack:DMAIN:1.0",
    };
    let available = false;
    const io = privateWorkerIO(log, task, {
      clock: now,
      currentInputId: "spawn-1",
      audience: async () =>
        available
          ? {
              actId: "m_original",
              requester,
              spawnKey: "spawn-1",
              verify: async () => ({ ok: true }),
            }
          : undefined,
    });
    const request = {
      channelId: requester.channelId,
      userId: requester.userId,
      threadKey,
      messageId: "spawn-1",
      text: "private work",
    };
    expect(await io.verifyPrivateWorkerAudience?.(request)).toMatchObject({ ok: false });
    available = true;
    expect(await io.verifyPrivateWorkerAudience?.(request)).toEqual({ ok: true });
    available = false;
    await expect(io.history()).rejects.toThrow("private worker audience unavailable");
  });

  it("rehosts a saved private child from its original unit and requester DM", async () => {
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const instance: CoordinatorInstance = {
      id: task.instanceId,
      kind: "ship",
      userId: "slack:UA",
      channelId: "slack:DMAIN",
      threadKey: "slack:DMAIN:1.0",
      repo: "acme/api",
      branch: "plan/private-task/u12",
      base: "main",
      merge: "person",
      plan: { id: "private-task" },
      createdAt: 1,
    };
    const unit = {
      instanceId: instance.id,
      unit: task.unit,
      slug: "u12",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: instance.threadKey,
        actId: "m_original",
        repo: instance.repo,
        base: instance.base!,
        question: "Why?",
        findings: [],
        requestedChange: "Fix it",
      },
    };
    expect(
      await instances.recordRequesterTurn({
        threadKey: instance.threadKey,
        requesterId: instance.userId,
        messageId: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await instances.claimMainTask({ mainThreadKey: instance.threadKey, actId: "m_original" }, instance, unit, {
        requesterId: instance.userId,
        sourceMessageId: "1",
        revision: 1,
        repo: instance.repo,
      }),
    ).toMatchObject({ ok: true, created: true });
    let live = true;
    const ioFor = () => ({
      reply: async () => {
        throw new Error("worker posted to Slack");
      },
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
      directAudience: () => ({
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey: instance.threadKey,
      }),
      verifyDirectAudience: async () =>
        live ? { ok: true as const } : { ok: false as const, code: "direct-audience-denied" as const },
    });
    const io = rehostPrivateWorkerIO(new InMemoryPrivateWorkerLog(), task, {
      clock: now,
      currentInputId: "spawn-1",
      instances,
      ioFor,
    });
    const request = {
      channelId: instance.channelId,
      userId: instance.userId,
      threadKey,
      messageId: "spawn-1",
      text: "continue",
    };
    expect(await io.verifyPrivateWorkerAudience?.(request)).toEqual({ ok: true });
    live = false;
    expect(await io.verifyPrivateWorkerAudience?.(request)).toMatchObject({ ok: false });
    live = true;
    const withoutOriginalClaim = rehostPrivateWorkerIO(new InMemoryPrivateWorkerLog(), task, {
      clock: now,
      currentInputId: "spawn-1",
      instances: {
        get: instances.get.bind(instances),
        listUnits: instances.listUnits.bind(instances),
        getMainTask: async () => null,
      },
      ioFor,
    });
    expect(await withoutOriginalClaim.verifyPrivateWorkerAudience?.(request)).toMatchObject({ ok: false });
  });

  it("derives the same internal thread key after rehost and rejects ambiguous identities", () => {
    expect(privateWorkerThreadKey(task)).toBe(threadKey);
    expect(privateWorkerThreadKey({ ...task })).toBe(threadKey);
    expect(parsePrivateWorkerThreadKey(threadKey)).toEqual(task);
    expect(parsePrivateWorkerThreadKey("worker:plan_A-1:U12:extra")).toBeUndefined();
    expect(parsePrivateWorkerThreadKey("slack:C1:1.0")).toBeUndefined();
    expect(() => privateWorkerThreadKey({ ...task, unit: "U12:other" })).toThrow("invalid private worker identity");
    expect(() => privateWorkerThreadKey({ ...task, instanceId: "" })).toThrow("invalid private worker identity");
  });

  it("persists attributed input and worker replies, then rebuilds history without status noise or the current request", async () => {
    const log = new InMemoryPrivateWorkerLog();
    await appendPrivateWorkerInput(log, task, { id: "human-1", sender: "slack:UA", text: "fix signup", at: 10 });
    await appendPrivateWorkerInput(log, task, { id: "human-1", sender: "slack:UA", text: "fix signup", at: 11 });
    const first = privateWorkerIO(log, task, { currentInputId: "human-1", clock: now });
    expect(await first.history()).toEqual([]);
    expect(first.openThread).toBeUndefined();
    first.runStarted?.({ id: "run-1" });
    await first.reply("I found the failing path");
    const card = await first.status({ title: "working" });
    card.update({ title: "testing" });
    await card.done({ title: "finished" });
    await appendPrivateWorkerInput(log, task, { id: "human-2", sender: "slack:UA", text: "include retries", at: 20 });
    const rehosted = privateWorkerIO(log, task, { currentInputId: "human-2", clock: now });
    expect(await rehosted.history()).toEqual([
      { role: "user", text: "fix signup", at: 10, user: "slack:UA" },
      { role: "assistant", text: "I found the failing path", at: 1000 },
    ]);
    expect((await log.list(threadKey)).filter((event) => event.kind === "input")).toHaveLength(2);
    expect((await log.list(threadKey)).find((event) => event.kind === "reply")).toMatchObject({ runId: "run-1" });
  });

  it("bounds escaped long input without splitting a code point or duplicating its retry", async () => {
    const log = new InMemoryPrivateWorkerLog();
    const text = `Fix this: ${'"\\\n🙂'.repeat(12_000)}`;
    await appendPrivateWorkerInput(log, task, { id: "long-1", sender: "slack:UA", text, at: 10 });
    await appendPrivateWorkerInput(log, task, { id: "long-1", sender: "slack:UA", text, at: 11 });
    await expect(
      appendPrivateWorkerInput(log, task, { id: "long-1", sender: "slack:UA", text: `${text}Changed`, at: 12 }),
    ).rejects.toThrow("private worker event id reused with different content");
    const longPrefix = "x".repeat(40_000);
    await appendPrivateWorkerInput(log, task, {
      id: "long-unicode",
      sender: "slack:UA",
      text: `${longPrefix}\ud800`,
      at: 13,
    });
    await expect(
      appendPrivateWorkerInput(log, task, {
        id: "long-unicode",
        sender: "slack:UA",
        text: `${longPrefix}\udc00`,
        at: 14,
      }),
    ).rejects.toThrow("private worker event id reused with different content");
    const events = await log.list(threadKey);
    expect(events).toHaveLength(2);
    expect(events.every(isPrivateWorkerEvent)).toBe(true);
    expect(events[0]?.kind === "input" ? events[0].text : "").toContain("[Private history copy shortened;");
    const stored = events[0]?.kind === "input" ? events[0].text : "";
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(stored)).toBe(false);
    const history = await privateWorkerIO(log, task, { currentInputId: "long-1", clock: now }).history();
    expect(history).toHaveLength(1);
    expect(history[0]?.text).toBe(events[1]?.kind === "input" ? events[1].text : "");
  });

  it("bounds an oversized private reply while preserving a full valid unit report", async () => {
    const log = new InMemoryPrivateWorkerLog();
    const report = "\u0000".repeat(20_000);
    await appendPrivateWorkerReply(log, task, { id: "unit-end", text: report, at: 10 });
    await appendPrivateWorkerReply(log, task, { id: "unit-end", text: report, at: 11 });
    await privateWorkerIO(log, task, { clock: now }).reply('"\\\n🙂'.repeat(30_000));
    const events = await log.list(threadKey);
    expect(events).toHaveLength(2);
    expect(events.every(isPrivateWorkerEvent)).toBe(true);
    expect(events[0]?.kind === "reply" ? events[0].text : "").toBe(report);
    expect(events[1]?.kind === "reply" ? events[1].text : "").toContain("[Private history copy shortened;");
  });

  it("writes ordered status frames and waits for updates before closing the status", async () => {
    const log = new InMemoryPrivateWorkerLog();
    const io = privateWorkerIO(log, task, { clock: now });
    const handle = await io.status({ title: "starting" });
    handle.update({ title: "installing" });
    handle.update({ title: "testing" });
    await handle.done({ title: "done" });
    const frames = (await log.list(threadKey)).filter((event) => event.kind === "status");
    expect(frames.map((event) => event.frame.title)).toEqual(["starting", "installing", "testing", "done"]);
    expect(frames.map((event) => event.phase)).toEqual(["start", "update", "update", "done"]);
    expect(new Set(frames.map((event) => event.statusSeq))).toEqual(new Set([frames[0]?.seq]));
  });

  it("fails closed when the private log is unavailable", async () => {
    const io = privateWorkerIO(new UnavailablePrivateWorkerLog(), task, { clock: now });
    await expect(io.reply("never delivered")).rejects.toThrow("private worker log unavailable");
    await expect(io.status({ title: "never delivered" })).rejects.toThrow("private worker log unavailable");
    await expect(io.history()).rejects.toThrow("private worker log unavailable");
  });
});
