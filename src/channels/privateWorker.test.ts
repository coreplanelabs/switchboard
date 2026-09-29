import { describe, expect, it } from "vitest";
import {
  InMemoryPrivateWorkerLog,
  UnavailablePrivateWorkerLog,
  isPrivateWorkerEvent,
} from "../core/privateWorkerLog.js";
import {
  appendPrivateWorkerInput,
  appendPrivateWorkerReply,
  parsePrivateWorkerThreadKey,
  privateWorkerIO,
  privateWorkerThreadKey,
} from "./privateWorker.js";

const task = { instanceId: "plan_A-1", unit: "U12" };
const threadKey = "worker:plan_A-1:U12";
const now = () => 1000;

describe("private worker IO — a task thread with no Slack delivery", () => {
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
