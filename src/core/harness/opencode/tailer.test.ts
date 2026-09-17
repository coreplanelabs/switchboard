import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotHostHarnessContainer } from "../botHostContainer.js";
import { PiRpcTransport } from "../pi/transport.js";
import { openCodeAuthHeader, parseFeedRecord, type OpenCodeFeedRecord } from "./client.js";
import { openCodeRunPathsAt } from "./process.js";
import { OPENCODE_SERVE_PID_ENV, OPENCODE_TAILER_SOURCE } from "./tailerSource.js";

// Feature: docs/reference/specs/harness.md, the OpenCode process item — the
// tailer: a process beside `opencode serve` whose stdout is the run's feed,
// one JSON record per event as the stream carries it, and at every step's end
// two more from the store — the pending asks, and the messages changed since
// its previous refill of that session — reconnecting with backoff when the
// stream drops and refilling the gap. Run as the container runs it: the source
// written to a file and started under node, against a fake `serve` in this
// process; the feed read back through pi's log transport by offset, the road
// the harness reads it on.

const PASSWORD = "pw-of-the-run";

interface Fake {
  server: Server;
  port: number;
  /** Every request the tailer made, `METHOD path`, with the authorization header it carried. */
  requests: Array<{ line: string; authorization: string | undefined }>;
  /** The open event streams. */
  streams: ServerResponse[];
  permissions: Record<string, unknown[]>;
  messages: Record<string, Array<{ id: string; [k: string]: unknown }>>;
  /** Sessions whose next message refill answers 500, once: a refill that fails. */
  failMessagesOnce: Set<string>;
  /** Sessions whose next permissions refill answers 500, once. */
  failPermissionsOnce: Set<string>;
  /** Sessions whose next permissions read answers `null` — JSON, but no object. */
  nullPermissionsOnce: Set<string>;
  emit(event: Record<string, unknown>): void;
  heartbeat(): void;
  drop(): void;
  close(): Promise<void>;
}

/** A fake `serve`: the event stream, the two store routes, Basic auth checked on every request. */
async function fakeServe(opts: { password?: string } = {}): Promise<Fake> {
  const expected = openCodeAuthHeader(opts.password ?? PASSWORD);
  const fake: Fake = {
    server: undefined as unknown as Server,
    port: 0,
    requests: [],
    streams: [],
    permissions: {},
    messages: {},
    failMessagesOnce: new Set(),
    failPermissionsOnce: new Set(),
    nullPermissionsOnce: new Set(),
    emit(event) {
      for (const res of fake.streams) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    heartbeat() {
      for (const res of fake.streams) res.write(": heartbeat\n\n");
    },
    drop() {
      for (const res of fake.streams) res.end();
      fake.streams = [];
    },
    close: () =>
      new Promise<void>((resolve) => {
        fake.drop();
        fake.server.closeAllConnections();
        fake.server.close(() => resolve());
      }),
  };
  fake.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    fake.requests.push({
      line: `${req.method} ${url.pathname}${url.search}`,
      authorization: req.headers.authorization,
    });
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Secure Area"' });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`);
      fake.streams.push(res);
      return;
    }
    const perm = /^\/api\/session\/([^/]+)\/permission$/.exec(url.pathname);
    if (req.method === "GET" && perm) {
      if (fake.failPermissionsOnce.delete(perm[1])) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "asks unavailable" }));
        return;
      }
      if (fake.nullPermissionsOnce.delete(perm[1])) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("null");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: fake.permissions[perm[1]] ?? [] }));
      return;
    }
    const msgs = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (req.method === "GET" && msgs) {
      if (fake.failMessagesOnce.delete(msgs[1])) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "store unavailable" }));
        return;
      }
      const all = fake.messages[msgs[1]] ?? [];
      // Two pages when there is more than one message: the tailer must follow the cursor.
      const cursor = url.searchParams.get("cursor");
      const page = cursor === null ? all.slice(0, 1) : all.slice(Number(cursor));
      const next = cursor === null && all.length > 1 ? "1" : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: page, cursor: next === undefined ? {} : { next } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such route" }));
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", () => resolve()));
  const address = fake.server.address();
  fake.port = typeof address === "object" && address ? address.port : 0;
  return fake;
}

interface Tailer {
  child: ChildProcess;
  feed: string;
  dir: string;
  exited: Promise<number | null>;
  /** What the tailer has said on stderr so far. */
  stderr: () => string;
}

/** The tailer as the seam starts it: the source in the run's directory, node on
 *  it, its stdout appended to the feed — or, for the tests of a feed that refuses
 *  its writes, the feed's file opened read-only under it (`refusing`: every write
 *  fails EBADF) or a pipe the test can stop reading (`pipe`: EPIPE once it does). */
function startTailer(
  port: number,
  env: Record<string, string> = {},
  stdout: "feed" | "refusing" | "pipe" = "feed",
): Tailer {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-oc-tailer-"));
  const paths = openCodeRunPathsAt(dir);
  writeFileSync(paths.tailerScript, OPENCODE_TAILER_SOURCE);
  if (stdout === "refusing") writeFileSync(paths.feed, "");
  const fd = stdout === "pipe" ? undefined : openSync(paths.feed, stdout === "feed" ? "a" : "r");
  const child = spawn(process.execPath, [paths.tailerScript], {
    env: { PATH: process.env.PATH ?? "", SWITCHBOARD_HARNESS_PORT: String(port), OPENCODE_PASSWORD: PASSWORD, ...env },
    stdio: ["ignore", fd ?? "pipe", "pipe"],
  });
  if (fd !== undefined) closeSync(fd);
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  child.once("exit", () => {
    if (stderr && stdout === "feed") console.error("tailer stderr:", stderr);
  });
  return { child, feed: paths.feed, dir, exited, stderr: () => stderr };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** The feed read back exactly as the harness reads it: pi's transport over the
 *  bot host's container, from offset 0, whole lines, until the log is drained
 *  (the transport ends once its alive check finds no process at the pid). */
async function replay(feed: string): Promise<OpenCodeFeedRecord[]> {
  const container = new BotHostHarnessContainer();
  const paths = { ...openCodeRunPathsAt(join(feed, "..")).tailer, log: feed };
  const transport = new PiRpcTransport({ container, paths, pid: 999_999, pollMs: 1, alivePolls: 1, sleep });
  const records: OpenCodeFeedRecord[] = [];
  for await (const line of transport.lines) {
    const record = parseFeedRecord(line);
    if (!record) throw new Error(`a feed line is not a feed record: ${line}`);
    records.push(record);
  }
  expect(transport.consumedOffset).toBe(readFileSync(feed).length);
  return records;
}

const events = (records: OpenCodeFeedRecord[]) => records.filter((r) => r.feed === "event").map((r) => r.event);
const notes = (records: OpenCodeFeedRecord[]) => records.filter((r) => r.feed === "tailer").map((r) => r.note);

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function stop(t: Tailer): Promise<void> {
  if (t.child.exitCode === null) t.child.kill("SIGTERM");
  await t.exited;
}

function scenario(fake: Fake, tailer: Tailer): void {
  cleanup.push(async () => {
    await stop(tailer);
    rmSync(tailer.dir, { recursive: true, force: true });
  });
  cleanup.push(() => fake.close());
}

const STEP_END = (sessionID: string, id: string) => ({
  id,
  type: "session.step.ended",
  created: 1789578564000,
  data: {
    sessionID,
    assistantMessageID: "msg_a1",
    finish: "stop",
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  durable: { aggregateID: sessionID, seq: 7, version: 1 },
});

describe("the tailer", () => {
  it("writes every event as one record in the order fed, with the pin's Basic auth on every request, and at a step's end appends the session's pending asks as they answer and every message of the store, following the store's pages", async () => {
    const fake = await fakeServe();
    fake.permissions.ses_1 = [
      {
        id: "per_1",
        sessionID: "ses_1",
        action: "shell",
        resources: ["echo hi"],
        source: { type: "tool", messageID: "msg_a1", id: "call_0" },
      },
    ];
    fake.messages.ses_1 = [
      { id: "msg_u1", type: "user", time: { created: 1 } },
      {
        id: "msg_a1",
        type: "assistant",
        agent: "switchboard",
        time: { created: 2 },
        content: [{ type: "tool", tool: "shell" }],
      },
    ];
    const tailer = startTailer(fake.port);
    scenario(fake, tailer);
    await until(() => fake.streams.length === 1, "the tailer to subscribe");
    const e1 = {
      id: "evt_1",
      type: "session.step.started",
      created: 1,
      data: { sessionID: "ses_1", assistantMessageID: "msg_a1", agent: "switchboard" },
    };
    const e2 = { id: "evt_2", type: "session.text.delta", created: 2, data: { sessionID: "ses_1", text: "hel" } };
    fake.heartbeat();
    fake.emit(e1);
    fake.emit(e2);
    const e3 = STEP_END("ses_1", "evt_3");
    fake.emit(e3);
    await until(
      () => fake.requests.some((r) => r.line.includes("/message?cursor=")),
      "the refill to follow the cursor",
    );
    await sleep(50);
    await stop(tailer);
    const records = await replay(tailer.feed);
    expect(notes(records).slice(0, 2)).toEqual(["started", "connected"]);
    expect(events(records)).toEqual([{ id: "evt_0", type: "server.connected", data: {} }, e1, e2, e3]);
    const refills = records.filter((r) => r.feed === "permissions" || r.feed === "messages");
    // The pending asks first — emitted the moment their read answers, since an
    // unanswered ask holds the server's turn — then the store's messages after
    // its pages; the bridge holds an ask whose call the store has not named yet.
    expect(refills.map((r) => r.feed)).toEqual(["permissions", "messages"]);
    expect(refills[0]).toMatchObject({
      feed: "permissions",
      sessionID: "ses_1",
      reason: "session.step.ended",
      data: fake.permissions.ses_1,
    });
    expect(refills[1]).toMatchObject({
      feed: "messages",
      sessionID: "ses_1",
      reason: "session.step.ended",
      data: fake.messages.ses_1,
    });
    // The refill records come after the step end that caused them.
    expect(records.indexOf(refills[0])).toBeGreaterThan(
      records.findIndex((r) => r.feed === "event" && r.event.id === "evt_3"),
    );
    for (const r of fake.requests) expect(r.authorization).toBe(openCodeAuthHeader(PASSWORD));
    // Both reads go out at once, the asks' first.
    expect(fake.requests.map((r) => r.line)).toEqual([
      "GET /api/event",
      "GET /api/session/ses_1/permission",
      "GET /api/session/ses_1/message?order=asc&limit=200",
      "GET /api/session/ses_1/message?cursor=1&limit=200",
    ]);
    // Nothing between events is a record: the heartbeat comment left no line.
    expect(records.every((r) => r.feed !== "event" || typeof r.event.type === "string")).toBe(true);
  }, 15_000);

  it("two step ends around one unchanged message append that message once; a message that changed, and a new one, are appended again", async () => {
    const fake = await fakeServe();
    fake.messages.ses_1 = [
      { id: "msg_u1", type: "user", time: { created: 1 } },
      { id: "msg_a1", type: "assistant", time: { created: 2 }, content: [{ type: "tool", tool: "shell" }] },
    ];
    const tailer = startTailer(fake.port);
    scenario(fake, tailer);
    await until(() => fake.streams.length === 1, "the tailer to subscribe");
    fake.emit(STEP_END("ses_1", "evt_1"));
    await until(() => fake.requests.filter((r) => r.line.includes("/message?")).length >= 2, "the first refill");
    await sleep(50);
    // The store moved: a1 completed, a2 arrived; u1 is as it was.
    fake.messages.ses_1 = [
      fake.messages.ses_1[0],
      { ...fake.messages.ses_1[1], time: { created: 2, completed: 3 } },
      { id: "msg_a2", type: "assistant", time: { created: 4 }, content: [{ type: "text", text: "done" }] },
    ];
    fake.emit(STEP_END("ses_1", "evt_2"));
    await until(() => fake.requests.filter((r) => r.line.includes("/message?")).length >= 4, "the second refill");
    await sleep(50);
    await stop(tailer);
    const records = await replay(tailer.feed);
    const messages = records.filter((r) => r.feed === "messages");
    expect(messages).toHaveLength(2);
    expect(messages[0].data.map((m) => m.id)).toEqual(["msg_u1", "msg_a1"]);
    expect(messages[1].data.map((m) => m.id)).toEqual(["msg_a1", "msg_a2"]);
    expect(messages[1].data[0]).toMatchObject({ time: { created: 2, completed: 3 } });
    const seenU1 = messages.flatMap((r) => r.data).filter((m) => m.id === "msg_u1");
    expect(seenU1).toHaveLength(1);
  }, 15_000);

  it("a dropped stream is noted, reconnected with backoff, and the reconnect refills every session it knows, so a turn that ended while the stream was down still lands", async () => {
    const fake = await fakeServe();
    fake.messages.ses_1 = [{ id: "msg_u1", type: "user", time: { created: 1 } }];
    const tailer = startTailer(fake.port);
    scenario(fake, tailer);
    await until(() => fake.streams.length === 1, "the tailer to subscribe");
    fake.emit(STEP_END("ses_1", "evt_1"));
    await until(() => fake.requests.filter((r) => r.line.includes("/message?")).length >= 1, "the first refill");
    await sleep(50);
    const before = fake.requests.length;
    fake.drop();
    // While the stream is down the turn ends in the store and no step end reaches the tailer.
    fake.messages.ses_1 = [
      ...fake.messages.ses_1,
      {
        id: "msg_a1",
        type: "assistant",
        time: { created: 2, completed: 3 },
        content: [{ type: "text", text: "late" }],
      },
    ];
    await until(() => fake.streams.length === 1, "the tailer to reconnect");
    await until(() => fake.requests.filter((r) => r.line.includes("/message?")).length >= 2, "the reconnect's refill");
    const e4 = { id: "evt_4", type: "session.execution.succeeded", created: 9, data: { sessionID: "ses_1" } };
    fake.emit(e4);
    await until(
      () => fake.requests.filter((r) => r.line.includes("/message?")).length >= 3,
      "the execution end's refill",
    );
    await sleep(50);
    await stop(tailer);
    const records = await replay(tailer.feed);
    const noteList = notes(records);
    expect(noteList).toContain("stream closed");
    expect(noteList.indexOf("reconnected")).toBeGreaterThan(noteList.indexOf("stream closed"));
    const reconnected = records.find((r) => r.feed === "tailer" && r.note === "reconnected");
    expect(reconnected).toMatchObject({ connections: 2 });
    const messages = records.filter((r) => r.feed === "messages");
    expect(messages.map((r) => r.reason)).toEqual(["session.step.ended", "reconnect", "session.execution.succeeded"]);
    expect(messages[1].data.map((m) => m.id)).toEqual(["msg_a1"]);
    expect(messages[2].data).toEqual([]);
    expect(events(records).map((e) => e.id)).toEqual(["evt_0", "evt_1", "evt_0", "evt_4"]);
    expect(fake.requests.slice(before).map((r) => r.line)[0]).toBe("GET /api/event");
  }, 15_000);

  it("a refill that fails outright — both reads refused — is two tailer notes and never the end of refilling: the next step end's refill runs whole (the queue's chain never rejects; a record `emit` cannot throw either)", async () => {
    const fake = await fakeServe();
    fake.failMessagesOnce.add("ses_1");
    fake.failPermissionsOnce.add("ses_1");
    fake.permissions.ses_1 = [{ id: "per_1", sessionID: "ses_1", action: "shell", resources: ["echo hi"] }];
    fake.messages.ses_1 = [{ id: "msg_u1", type: "user", time: { created: 1 } }];
    const tailer = startTailer(fake.port);
    scenario(fake, tailer);
    await until(() => fake.streams.length === 1, "the tailer to subscribe");
    fake.emit(STEP_END("ses_1", "evt_1"));
    await until(
      () => fake.requests.filter((r) => r.line.includes("/session/ses_1/")).length >= 2,
      "the refill whose reads both fail",
    );
    await sleep(50);
    fake.emit(STEP_END("ses_1", "evt_2"));
    await until(
      () => fake.requests.filter((r) => r.line.includes("/session/ses_1/message?")).length >= 2,
      "the next refill to run",
    );
    await sleep(50);
    await stop(tailer);
    const records = await replay(tailer.feed);
    expect(notes(records)).toContain("permission refill failed");
    expect(notes(records)).toContain("message refill failed");
    const refills = records.filter((r) => r.feed === "permissions" || r.feed === "messages");
    expect(refills.map((r) => r.feed)).toEqual(["permissions", "messages"]);
    expect((refills[0] as { data: unknown[] }).data).toEqual(fake.permissions.ses_1);
    expect((refills[1] as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(["msg_u1"]);
  }, 15_000);

  it("a permissions read that answers no object — `null` — is the permission refill's own note, the messages record of that refill still written, never the chain's `refill failed`: the next refill runs whole", async () => {
    const fake = await fakeServe();
    fake.nullPermissionsOnce.add("ses_1");
    fake.messages.ses_1 = [{ id: "msg_u1", type: "user", time: { created: 1 } }];
    const tailer = startTailer(fake.port);
    scenario(fake, tailer);
    await until(() => fake.streams.length === 1, "the tailer to subscribe");
    fake.emit(STEP_END("ses_1", "evt_1"));
    await until(
      () => fake.requests.filter((r) => r.line.includes("/session/ses_1/message?")).length >= 1,
      "the refill whose asks answer null",
    );
    await sleep(50);
    fake.emit(STEP_END("ses_1", "evt_2"));
    await until(
      () => fake.requests.filter((r) => r.line.includes("/session/ses_1/permission")).length >= 2,
      "the next refill to run",
    );
    await sleep(50);
    await stop(tailer);
    const records = await replay(tailer.feed);
    expect(notes(records)).toContain("permission refill failed");
    expect(notes(records)).not.toContain("refill failed");
    const refills = records.filter((r) => r.feed === "permissions" || r.feed === "messages");
    expect(refills.map((r) => r.feed)).toEqual(["messages", "permissions", "messages"]);
  }, 15_000);

  // A write the feed refuses is not thrown from the write: node reports it on
  // the stream's `error` event — for the file the seam appends the feed to as
  // for a pipe — and an `error` nobody listens for is an uncaught exception.
  // A descriptor gone bad or a reader gone stays that way for every later
  // write, so the tailer says it and exits non-zero rather than live on mute.
  it("a feed that refuses every write — its file opened read-only under the tailer — is said on stderr, and the tailer exits non-zero rather than live on mute: its pid gone, a re-attach restarts it", async () => {
    const fake = await fakeServe();
    const tailer = startTailer(fake.port, {}, "refusing");
    scenario(fake, tailer);
    await until(
      () => /a record could not be written; the feed is gone, exiting: EBADF/.test(tailer.stderr()),
      "the refused write's note",
    );
    expect(await tailer.exited).toBe(1);
    expect(readFileSync(tailer.feed, "utf8")).toBe("");
    expect(tailer.stderr()).not.toMatch(/Unhandled|tailer failed/);
  }, 15_000);

  it("a feed whose reader is gone — the tailer's stdout a pipe nobody reads any more — is the same failure on the same event: EPIPE said on stderr, the tailer exiting non-zero", async () => {
    const fake = await fakeServe();
    const tailer = startTailer(fake.port, {}, "pipe");
    scenario(fake, tailer);
    await until(() => fake.streams.length === 1, "the tailer to subscribe");
    tailer.child.stdout!.destroy();
    fake.emit(STEP_END("ses_1", "evt_1"));
    await until(
      () => /a record could not be written; the feed is gone, exiting: write EPIPE/.test(tailer.stderr()),
      "the refused write's note",
    );
    expect(await tailer.exited).toBe(1);
    expect(tailer.stderr()).not.toMatch(/Unhandled|tailer failed/);
  }, 15_000);

  it("a session whose only refill failed is still swept on reconnect: the failure is noted, the session is known from then on, and the reconnect's refill carries its messages", async () => {
    const fake = await fakeServe();
    fake.failMessagesOnce.add("ses_2");
    fake.messages.ses_2 = [{ id: "msg_u2", type: "user", time: { created: 1 } }];
    const tailer = startTailer(fake.port);
    scenario(fake, tailer);
    await until(() => fake.streams.length === 1, "the tailer to subscribe");
    fake.emit(STEP_END("ses_2", "evt_1"));
    await until(
      () => fake.requests.filter((r) => r.line.includes("/session/ses_2/message?")).length >= 1,
      "the refill that fails",
    );
    await sleep(50);
    fake.drop();
    await until(() => fake.streams.length === 1, "the tailer to reconnect");
    await until(
      () => fake.requests.filter((r) => r.line.includes("/session/ses_2/message?")).length >= 2,
      "the reconnect's refill of the session whose refill failed",
    );
    await sleep(50);
    await stop(tailer);
    const records = await replay(tailer.feed);
    expect(notes(records)).toContain("message refill failed");
    const messages = records.filter(
      (r): r is Extract<OpenCodeFeedRecord, { feed: "messages" }> => r.feed === "messages" && r.sessionID === "ses_2",
    );
    expect(messages.map((r) => r.reason)).toEqual(["reconnect"]);
    expect(messages[0].data.map((m) => m.id)).toEqual(["msg_u2"]);
  }, 15_000);

  it("exits on its own once the server process it watches is gone and the stream has closed; a server that refuses the password is noted and retried, never a crash", async () => {
    const gone = spawn(process.execPath, ["-e", "0"]);
    const gonePid = await new Promise<number>((resolve) => gone.once("exit", () => resolve(gone.pid ?? 0)));
    const fake = await fakeServe();
    const tailer = startTailer(fake.port, { [OPENCODE_SERVE_PID_ENV]: String(gonePid) });
    scenario(fake, tailer);
    await until(() => fake.streams.length === 1, "the tailer to subscribe");
    fake.drop();
    const code = await Promise.race([tailer.exited, sleep(6000).then(() => "still running" as const)]);
    expect(code).toBe(0);
    const records = await replay(tailer.feed);
    expect(notes(records)).toEqual(["started", "connected", "stream closed", "the server process is gone; exiting"]);

    const strict = await fakeServe({ password: "another" });
    const refused = startTailer(strict.port);
    scenario(strict, refused);
    await until(() => strict.requests.length >= 2, "two refused subscriptions");
    await stop(refused);
    const refusedRecords = await replay(refused.feed);
    expect(notes(refusedRecords).filter((n) => n === "stream closed").length).toBeGreaterThanOrEqual(1);
    const closed = refusedRecords.find((r) => r.feed === "tailer" && r.note === "stream closed");
    expect(closed).toMatchObject({ detail: "the event stream answered 401" });
    expect(refusedRecords.some((r) => r.feed === "tailer" && r.note === "connected")).toBe(false);
  }, 20_000);
});
