import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import type { CommandDef } from "../core/commandRegistry.js";
import type { CoreDeps } from "../core/dispatcher.js";
import { NO_GRANTS, type Actor, type Grants } from "../core/authz/types.js";
import type { RunEvent } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService, type RunRecordView } from "../core/runsService.js";
import { NullRunHistoryWriter } from "../core/runHistoryWriter.js";
import { createRunEnding } from "../core/runEnding.js";
import { channelOf, startRequestRoot } from "../core/requestTrace.js";
import { recordRoutedDecision, type RouteEventFields } from "../core/dispatch/commandRun.js";
import type { FastPathDeps } from "../core/dispatch/fastPath.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";
import type { CoordinatorInstance } from "../core/coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { AccessIdentity } from "./accessAuth.js";
import type { DispatchFn } from "./http.js";
import {
  conversationIdOf,
  createWebChatHandler,
  historyOf,
  orchestratorChatSeed,
  resumeWebIO,
  webThreadIO,
  EXCERPT_MAX,
  ownLane,
  paletteCommands,
  parseThreadsRoute,
  requesterOf,
  suggestionsFor,
  threadKeyFor,
  threadsOf,
  threadTitle,
  turnOf,
  WebIO,
} from "./web.js";
import {
  SEED_ELEMENT_ID,
  type HomeParentTurnSeed,
  type HomeReceiptTurnSeed,
  type HomeSeed,
  type HomeTurnSeed,
  type RunNotFoundSeed,
} from "./webSeed.js";
import type { IntakeReceipt } from "../core/runLedger/types.js";
import { makePageSender } from "./webShell.js";

// Feature: docs/reference/specs/web-chat.md item 11 (record 0043) — the web
// channel adapter: `POST /threads/<id>/send` dispatches the body as the
// session's own message into the same `dispatch()` every channel calls and
// answers `202` with the run's view path or `200` with the pipeline's reply;
// `GET /threads` and `GET /threads/<id>` seed the page from the runs service
// under the viewer's predicate. A fake dispatch keeps these off real providers.

const NOW = 1_700_000_000_000;
const set = (...names: string[]) => new Set(names);
const grants = (g: Partial<Grants>): Grants => ({ actions: set(), channels: set(), repos: set(), ...g });

/** The viewer: an unlisted browser session holding the reads it needs here. */
const BROWSER_GRANTS = grants({ actions: set("runs:read", "help:read", "config:read", "mcp:write") });
const alice: Actor = { kind: "user", id: "access:a1", grants: BROWSER_GRANTS };
/** The same session linked to its person (record 0042). */
const linked: Actor = {
  ...alice,
  self: ["access:a1", "slack:UALICE"],
  asUser: { id: "slack:UALICE", name: "alice" },
};
const IDENTITY: AccessIdentity = { sub: "a1", email: "alice@example.test" };

const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary });

function record(id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = over.events ?? [
    { type: "input", messageId: "m1", text: `request of ${id}`, seq: 1 },
    { type: "route", preset: "review", reason: "a pull request link", model: "anthropic/m", seq: 2 },
    { ...call("$ ls"), seq: 3 },
    { type: "answer", text: `answer of ${id}`, seq: 4 },
  ];
  return {
    id,
    label: `review · #a1 · alice · request of ${id}`,
    agent: "review",
    model: "anthropic/m",
    channelId: "web:a1",
    userId: "access:a1",
    threadKey: "web:a1:conv-1",
    channelVisibility: "dm",
    startedAt: finishedAt - 10_000,
    finishedAt,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
    ...over,
  };
}

/** A stored record as the service views it (`getRun` with messages): the record's fields, `finished`. */
const view = (r: RunRecord): RunRecordView => ({ ...r, finished: true });

const COMMANDS = [
  { id: "help.show", action: "help:read", describe: "What Switchboard can do", effect: "read" },
  { id: "config.show", action: "config:read", describe: "The agent and model a run here gets", effect: "read" },
  { id: "mcp.add", action: "mcp:write", describe: "Add an MCP server", effect: "write" },
  // Not exposed to chat: absent from the palette however the viewer is granted.
  { id: "runs.list", action: "runs:read", describe: "The runs", effect: "read", surfaces: { chat: false } },
  // A write the viewer holds no grant for: absent.
  { id: "deploy.all", action: "deploy:write", describe: "Deploy", effect: "write" },
] as unknown as CommandDef<unknown>[];

function setup(
  opts: {
    dispatch?: DispatchFn;
    now?: number;
    channelNames?: Record<string, string>;
    /** The thread view's receipt read; defaults to an empty ledger, `null` is a ledger that is off. */
    intake?: { listIntake: (query: { threadKey?: string; since?: number }) => Promise<IntakeReceipt[]> } | null;
    /** The coordinator's records, for a thread whose runs carry an instance tag (item 2). */
    units?: InMemoryCoordinatorInstanceStore;
  } = {},
) {
  let n = 0;
  const registry = new RunRegistry({ genId: () => `id-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const store = new InMemoryRunStore({ now: () => NOW });
  const service = createRunsService({ registry, store, ...(opts.units ? { units: opts.units } : {}) });
  const core = { config: { grantsFor: () => NO_GRANTS, config: {} } } as unknown as CoreDeps;
  const calls: { msg: IncomingMessage; io: ChannelIO }[] = [];
  const dispatch: DispatchFn =
    opts.dispatch ??
    (async (_deps, msg, io) => {
      calls.push({ msg, io });
      await io.reply("the answer");
    });
  const handler = createWebChatHandler({
    core,
    service,
    registry,
    commands: { list: () => COMMANDS },
    page: makePageSender({ js: "/assets/main-test.js", css: [] }, ALL_CAPABILITIES),
    capabilities: ALL_CAPABILITIES,
    retention: { retentionDays: 30 },
    intake: opts.intake !== undefined ? opts.intake : { listIntake: async () => [] },
    publicBaseUrl: "https://bot.example.test",
    ...(opts.channelNames
      ? {
          names: {
            person: async () => undefined,
            channel: async (id: string) => {
              const name = opts.channelNames![id];
              if (name === "!") throw new Error("slack down");
              return name;
            },
          },
        }
      : {}),
    dispatch: (deps, msg, io, o) => {
      calls.push({ msg, io });
      return dispatch(deps, msg, io, o);
    },
    now: () => opts.now ?? NOW,
    mintId: () => "fresh-1",
    warn: () => {},
  });
  return { registry, store, service, handler, calls };
}

interface Answer {
  handled: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Drive the handler with a node-shaped request and wait for its response. */
async function request(
  handler: ReturnType<typeof setup>["handler"],
  opts: { url: string; method?: string; body?: string; headers?: Record<string, string>; actor?: Actor },
): Promise<Answer> {
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(opts.body, "utf8")]) as Readable & {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  req.url = opts.url;
  req.method = opts.method ?? "GET";
  req.headers = {
    host: "bot.example.test",
    ...(opts.body !== undefined ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}),
    ...opts.headers,
  };
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  let resolveEnd!: () => void;
  const ended = new Promise<void>((r) => (resolveEnd = r));
  const res = {
    headersSent: false,
    writeHead: (s: number, h: Record<string, string>) => {
      status = s;
      headers = h;
      res.headersSent = true;
    },
    end: (b?: string) => {
      body = b ?? "";
      resolveEnd();
    },
  };
  const handled = handler(req as never, res as never, { actor: opts.actor ?? alice, identity: IDENTITY });
  if (!handled) return { handled, status, headers, body };
  await ended;
  return { handled, status, headers, body };
}

function seedOf<T>(html: string): T {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the page");
  return JSON.parse(m[1]) as T;
}

// ---- routes and keys -----------------------------------------------------------

describe("parseThreadsRoute — /threads, /threads/<id>, /threads/<id>/send", () => {
  it("a new conversation, one by id, one by a whole thread key (encoded or not), and the send route", () => {
    expect(parseThreadsRoute("/threads")).toEqual({ kind: "new" });
    expect(parseThreadsRoute("/threads/")).toEqual({ kind: "new" });
    expect(parseThreadsRoute("/threads/conv-1")).toEqual({ kind: "thread", id: "conv-1" });
    expect(parseThreadsRoute("/threads/slack:C1:1712.34")).toEqual({ kind: "thread", id: "slack:C1:1712.34" });
    expect(parseThreadsRoute("/threads/slack%3AC1%3A1712.34")).toEqual({ kind: "thread", id: "slack:C1:1712.34" });
    expect(parseThreadsRoute("/threads/conv-1/send")).toEqual({ kind: "send", id: "conv-1" });
  });

  it("anything else under the prefix is not a route: a deeper path, a malformed id, a bad escape", () => {
    for (const p of ["/threads/conv-1/x", "/threads/conv-1/send/x", "/threads/a b", "/threads/%E0%A4%A", "/thread"])
      expect(parseThreadsRoute(p), p).toBeNull();
  });

  it("a plain id names the session's own lane; a key with a colon is another channel's thread, read here and answered there", () => {
    expect(threadKeyFor("a1", "conv-1")).toBe("web:a1:conv-1");
    expect(threadKeyFor("a1", "slack:C1:1.2")).toBe("slack:C1:1.2");
    expect(ownLane("a1", "web:a1:conv-1")).toBe(true);
    expect(ownLane("a1", "web:b2:conv-1")).toBe(false);
    expect(conversationIdOf("a1", "web:a1:conv-1")).toBe("conv-1");
    expect(conversationIdOf("a1", "slack:C1:1.2")).toBe("slack:C1:1.2");
  });
});

// ---- the pure projections ------------------------------------------------------

describe("the projections — requester, turn, history, threads, title, palette, chips", () => {
  it("requesterOf: a linked session sends as its person with the session as authenticatedAs; an unlinked one as itself, named by its email", () => {
    expect(requesterOf(linked, IDENTITY)).toEqual({
      userId: "slack:UALICE",
      userName: "alice",
      authenticatedAs: "access:a1",
    });
    expect(requesterOf(alice, IDENTITY)).toEqual({ userId: "access:a1", userName: "alice@example.test" });
    expect(requesterOf(alice, {})).toEqual({ userId: "access:a1" });
  });

  it("turnOf: the first input is the request, the last answer the reply, the route event the receipt; a token rides only when given; the view's own route decision is dropped", () => {
    const r = view(record("r-1", NOW));
    const routed = { ...r, route: { preset: "review", reason: "x", model: "m" } as never };
    expect(turnOf(routed, "tok-1")).toMatchObject({
      id: "r-1",
      token: "tok-1",
      request: "request of r-1",
      answer: "answer of r-1",
      route: { preset: "review", reason: "a pull request link" },
    });
    expect(turnOf(routed)).not.toHaveProperty("token");
    expect(turnOf(routed)).not.toHaveProperty("events");
    const bare = turnOf({ ...r, events: [] });
    expect(bare.request).toBe("");
    expect(bare).not.toHaveProperty("answer");
    expect(bare).not.toHaveProperty("route");
  });

  it("historyOf: a receipt turn is no one's line — the history a run reads carries the runs alone", () => {
    const done = turnOf(view(record("r-1", NOW - 5_000)));
    const receipt: HomeReceiptTurnSeed = { kind: "receipt", reason: "a question to another person", decidedAt: NOW };
    expect(historyOf([done, receipt])).toEqual([
      { role: "user", text: "request of r-1", at: NOW - 15_000 },
      { role: "assistant", text: "answer of r-1", at: NOW - 5_000 },
    ]);
  });

  it("historyOf: a finished turn is the person's line then the agent's, stamped; a live turn is the person's alone", () => {
    const done = turnOf(view(record("r-1", NOW - 5_000)));
    const live = {
      ...turnOf(view({ ...record("r-2", NOW), events: [record("r-2", NOW).events![0]] })),
      finished: false,
    };
    delete (live as { finishedAt?: number }).finishedAt;
    expect(historyOf([done, live])).toEqual([
      { role: "user", text: "request of r-1", at: NOW - 15_000 },
      { role: "assistant", text: "answer of r-1", at: NOW - 5_000 },
      { role: "user", text: "request of r-2", at: NOW - 10_000 },
    ]);
  });

  it("threadsOf: groups the viewer's runs by thread, newest thread first, capped; a run without a thread key belongs to no thread", () => {
    const runs = [
      { ...record("a1", NOW - 3_000), threadKey: "web:a1:A" },
      { ...record("b1", NOW - 9_000), threadKey: "slack:C1:1.1", channelId: "slack:C1" },
      { ...record("a2", NOW - 1_000), threadKey: "web:a1:A", finished: false, finishedAt: undefined },
      { ...record("c1", NOW - 2_000), threadKey: "web:a1:C" },
      { ...record("n1", NOW), threadKey: undefined },
    ] as never[];
    const groups = threadsOf(runs, 2);
    expect(groups.map((g) => g.threadKey)).toEqual(["web:a1:C", "web:a1:A"]);
    const a = groups[1];
    expect(a.runs.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(a.live).toBe(true);
    expect(a.surface).toBe("web");
    expect(threadsOf(runs).map((g) => g.surface)).toEqual(["web", "web", "slack"]);
  });

  it("threadTitle: the first non-empty line, cut to 60 with an ellipsis; nothing → New conversation", () => {
    expect(threadTitle("\n\n  review PR 7  \nmore")).toBe("review PR 7");
    expect(threadTitle("x".repeat(80))).toBe(`${"x".repeat(59)}…`);
    expect(threadTitle("")).toBe("New conversation");
    // The row's excerpt — what its tooltip says in full — is the same line cut at 240.
    expect(threadTitle("x".repeat(300), EXCERPT_MAX)).toBe(`${"x".repeat(239)}…`);
    expect(EXCERPT_MAX).toBe(240);
  });

  it("paletteCommands: the chat-exposed commands the actor may run, in chat form, by name; a chat-hidden or ungranted command is absent", () => {
    expect(paletteCommands(COMMANDS, alice)).toEqual([
      { chat: "config show", describe: "The agent and model a run here gets" },
      { chat: "help show", describe: "What Switchboard can do" },
      { chat: "mcp add", describe: "Add an MCP server" },
    ]);
    const reader: Actor = { ...alice, grants: grants({ actions: set("help:read") }) };
    expect(paletteCommands(COMMANDS, reader).map((c) => c.chat)).toEqual(["help show"]);
  });

  it("suggestionsFor: grounded in the viewer's repositories, their failed run and what is on; the last chip asks what it can do; no chip starts a change", () => {
    const caps = { mcp: true, github: true };
    expect(suggestionsFor({ repos: ["acme/api"], failed: true, any: true, capabilities: caps })).toEqual([
      "review the open PR on acme/api",
      "why did my last run fail?",
      "what agent and model do I get here?",
      "connect an MCP server",
      "What can Switchboard do?",
    ]);
    expect(suggestionsFor({ repos: [], failed: false, any: true, capabilities: { mcp: false, github: true } })).toEqual(
      [
        "review a pull request — paste its link",
        "what did my last run do?",
        "what agent and model do I get here?",
        "What can Switchboard do?",
      ],
    );
    expect(
      suggestionsFor({ repos: [], failed: false, any: false, capabilities: { mcp: false, github: false } }),
    ).toEqual(["what agent and model do I get here?", "What can Switchboard do?"]);
  });

  it("WebIO: the ingress IO's shape with the thread's history read on demand, the asking run named so it is left out", async () => {
    const turns = vi.fn(async (_except: string | undefined) => [{ role: "user" as const, text: "hi" }]);
    const io = new WebIO(turns);
    expect(turns).not.toHaveBeenCalled();
    expect(await io.history()).toEqual([{ role: "user", text: "hi" }]);
    expect(turns).toHaveBeenLastCalledWith(undefined);
    io.runStarted({ id: "id-9" });
    await io.history();
    expect(turns).toHaveBeenLastCalledWith("id-9");
    expect(await io.started).toEqual({ id: "id-9" });
    await io.reply("a");
    await io.reply("b");
    expect(io.collected()).toBe("a\n\nb");
  });
});

// ---- the rebuilt handle (record 0060) --------------------------------------------------

describe("the web handle rebuilt from a bare thread key — threadIoFor's web: arm (record 0060; web-chat item 11)", () => {
  function resumeSetup() {
    const registry = new RunRegistry({ genId: () => "id-r", genToken: () => "tok-r", now: () => NOW });
    const store = new InMemoryRunStore({ now: () => NOW });
    const service = createRunsService({ registry, store });
    return { registry, store, service };
  }

  it("history() lists the thread's runs as the session's own actor; reply resolves and logs the length, never the text; undeliverable is set", async () => {
    const { registry, store, service } = resumeSetup();
    await store.put(record("r1", NOW - 1_000, { threadKey: "web:a1:c9" }));
    const log = vi.fn();
    const io = resumeWebIO(
      { service, registry, grantsFor: () => BROWSER_GRANTS, log },
      { threadKey: "web:a1:c9", userId: "access:a1" },
    );
    expect(io).toBeDefined();
    expect(io!.undeliverable).toBeTruthy();
    expect(await io!.history()).toEqual([
      { role: "user", text: "request of r1", at: NOW - 11_000 },
      { role: "assistant", text: "answer of r1", at: NOW - 1_000 },
    ]);
    await expect(io!.reply("twelve chars")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("web:a1:c9");
    expect(line).toContain("12 chars");
    expect(line).not.toContain("twelve");
  });

  it("a key that is not a web conversation rebuilds nothing", () => {
    const { registry, service } = resumeSetup();
    const deps = { service, registry, grantsFor: () => BROWSER_GRANTS };
    expect(resumeWebIO(deps, { threadKey: "slack:C1:1.0", userId: "access:a1" })).toBeUndefined();
    expect(resumeWebIO(deps, { threadKey: "web:a1", userId: "access:a1" })).toBeUndefined();
  });

  it("openThread(lead) mints a conversation in the same lane — the key `web:<sub>:<id>`, a handle bound to it, the lead's length logged — and two calls mint two ids (thread-admission item 6)", async () => {
    const { registry, store, service } = resumeSetup();
    await store.put(record("r2", NOW - 2_000, { threadKey: "web:a1:conv-9" }));
    let n = 8;
    const log = vi.fn();
    const io = resumeWebIO(
      { service, registry, grantsFor: () => BROWSER_GRANTS, mintId: () => `conv-${++n}`, log },
      { threadKey: "web:a1:c9", userId: "access:a1" },
    );
    expect(io?.openThread).toBeDefined();
    const first = await io!.openThread!("↳ the unit thread lead");
    expect(first.thread).toEqual({ threadKey: "web:a1:conv-9" });
    // The child's handle is bound to the new key: it reads that thread's runs.
    expect(await first.io.history()).toEqual([
      { role: "user", text: "request of r2", at: NOW - 12_000 },
      { role: "assistant", text: "answer of r2", at: NOW - 2_000 },
    ]);
    expect(first.io.undeliverable).toBeTruthy();
    const second = await io!.openThread!("↳ another");
    expect(second.thread.threadKey).toBe("web:a1:conv-10");
    const leadLine = (log.mock.calls as string[][]).map((c) => c[0]).find((l) => l.includes("conv-9"));
    expect(leadLine).toContain(`${"↳ the unit thread lead".length} chars`);
    expect(leadLine).not.toContain("the lead");
  });

  it("webThreadIO builds the same handle over a known actor — what the request path's openThread hands a child", async () => {
    const { registry, store, service } = resumeSetup();
    await store.put(record("r3", NOW - 3_000, { threadKey: "web:a1:c9" }));
    const io = webThreadIO({ service, registry }, { threadKey: "web:a1:c9", actor: alice });
    expect(await io.history()).toEqual([
      { role: "user", text: "request of r3", at: NOW - 13_000 },
      { role: "assistant", text: "answer of r3", at: NOW - 3_000 },
    ]);
    expect(io.undeliverable).toBeTruthy();
  });

  it("history() never asks the intake ledger: `historyOf` discards receipt turns, so the history path reads the runs alone", async () => {
    const { registry, store, service } = resumeSetup();
    await store.put(record("r4", NOW - 4_000, { threadKey: "web:a1:c9" }));
    const listIntake = vi.fn(async () => []);
    const io = webThreadIO({ service, registry, intake: { listIntake } }, { threadKey: "web:a1:c9", actor: alice });
    expect(await io.history()).toEqual([
      { role: "user", text: "request of r4", at: NOW - 14_000 },
      { role: "assistant", text: "answer of r4", at: NOW - 4_000 },
    ]);
    expect(listIntake).not.toHaveBeenCalled();
  });
});

// ---- POST /threads/<id>/send ---------------------------------------------------------

describe("POST /threads/<id>/send — the body into dispatch() as this session (item 11)", () => {
  it("a plain request dispatches { access:<sub>, web:<sub>, web:<sub>:<id>, text, receivedAt } and, once the run exists, answers 202 with the run's own view path", async () => {
    const { handler, registry, calls } = setup({
      dispatch: async (_deps, msg, io) => {
        const run = registry.create("review · request", {
          channelId: msg.channelId,
          userId: msg.userId,
          threadKey: msg.threadKey,
          channelVisibility: "dm",
        });
        io.runStarted?.({ id: run.id });
        // The run outlives the response: never finished here.
        await new Promise(() => {});
      },
    });
    const res = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "review https://github.com/acme/api/pull/1" }),
    });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({
      runId: "id-1",
      viewPath: "/runs/id-1?t=tok-1",
      threadKey: "web:a1:conv-1",
    });
    expect(calls[0].msg).toEqual({
      userId: "access:a1",
      userName: "alice@example.test",
      channelId: "web:a1",
      threadKey: "web:a1:conv-1",
      text: "review https://github.com/acme/api/pull/1",
      receivedAt: NOW,
    });
  });

  it("the dispatched handle can open a thread of its own (record 0060): openThread mints a conversation in the session's lane, so the ship preflight admits the web by capability", async () => {
    const { handler, calls } = setup();
    const res = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "help" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0].io.openThread).toBeDefined();
    const opened = await calls[0].io.openThread!("↳ a child");
    expect(opened.thread.threadKey).toBe("web:a1:fresh-1");
    expect(opened.io.undeliverable).toBeTruthy();
  });

  it("a linked session sends as its person with the session as authenticatedAs (authorization.md item 15)", async () => {
    const { handler, calls } = setup();
    const res = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "help" }),
      actor: linked,
    });
    expect(res.status).toBe(200);
    expect(calls[0].msg).toMatchObject({ userId: "slack:UALICE", userName: "alice", authenticatedAs: "access:a1" });
  });

  // Feature: docs/decisions/0053 — the chat is the person's to speak in.
  it("a session viewing as a person is refused a send with 403 and the one sentence; nothing is dispatched", async () => {
    const { handler, calls } = setup();
    const viewing: Actor = {
      ...alice,
      grants: { actions: "all", channels: "all", repos: "all" },
      onBehalfOf: linked,
      asUser: linked.asUser,
      viewingAs: { id: "slack:UALICE", name: "alice" },
    };
    const res = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "help" }),
      actor: viewing,
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "unauthorized",
      message: "You are viewing as alice; writes are your own to make — exit view-as to write.",
    });
    expect(calls).toHaveLength(0);
  });

  it("a request the pipeline answers without a run — a help answer, a steer acknowledgement — is 200 with the reply text and no view path", async () => {
    const { handler } = setup({
      dispatch: async (_deps, _msg, io) => {
        await io.reply("**Commands** — `help commands` lists every one.");
      },
    });
    const res = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "help" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: "**Commands** — `help commands` lists every one." });
  });

  it("a routed write offered through the real machinery (record 0069) is 200 with the click row — the offer's line and risk ride the response, no view path, no run receipt — while the registry holds the record", async () => {
    const offerText = "config set me --agent review";
    const route: RouteEventFields = {
      preset: "command",
      reason: "command config.set",
      model: "anthropic/m",
      command: "config.set",
      input: { args: ["me"], options: { agent: "review" } },
      receipt: "config set me --agent review",
      outcome: "offered",
    };
    const { handler, registry } = setup({
      // What the route stage does for an offered write: the decision recorded
      // through the real inline-run machinery, told to announce nothing, then
      // the offer shown. The adapter's answer is judged against the real seam.
      dispatch: async (_deps, msg, io) => {
        const fastPath = {
          runRegistry: registry,
          runHistoryWriter: new NullRunHistoryWriter(),
          clock: () => NOW,
        } as unknown as FastPathDeps;
        const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(msg.channelId), receivedAt: NOW });
        const ending = createRunEnding({ registry });
        await recordRoutedDecision(fastPath, msg, io, { id: "config.set" }, route, offerText, ending, trace);
        await ending.sealAfterReply(
          async () => {},
          () => io.offer!({ id: "c-1", line: offerText, risk: "changes your agent", expiresAt: NOW + 600_000 }),
        );
      },
    });
    const res = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "use the review agent for me" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: "", offer: { line: offerText, risk: "changes your agent" } });
    expect(registry.getById("id-1")).toMatchObject({ finished: true, status: "completed", agent: "command" });
  });

  it("a run gone from the registry before its token was read (discarded) is answered with its reply and receipt, never a dead view path", async () => {
    const { handler, registry } = setup({
      dispatch: async (_deps, msg, io) => {
        const run = registry.create("config · show", {
          channelId: msg.channelId,
          userId: msg.userId,
          threadKey: msg.threadKey,
        });
        registry.discard(run.id);
        io.runStarted?.({ id: run.id });
        io.runFinished?.({ id: run.id, status: "completed" });
        await io.reply("agent: review");
      },
    });
    const res = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "config show" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: "agent: review", run: { id: "id-1", status: "completed" } });
  });

  it("a run reads the thread's finished turns as its history, from the store, only when it asks — never its own request, though its run is already registered", async () => {
    let resolveSeen!: (h: unknown) => void;
    const seen = new Promise<unknown>((r) => (resolveSeen = r));
    const { handler, store, registry } = setup({
      dispatch: async (_deps, msg, io) => {
        // As the dispatcher does: the run exists and its `input` is published before history is read.
        const run = registry.create("general · and the tests?", {
          channelId: msg.channelId,
          userId: msg.userId,
          threadKey: msg.threadKey,
          channelVisibility: "dm",
        });
        registry.publish(run.id, { type: "input", messageId: run.id, text: msg.text });
        io.runStarted?.({ id: run.id });
        resolveSeen(await io.history());
        await new Promise(() => {});
      },
    });
    await store.put(record("r-1", NOW - 60_000));
    await store.put(record("r-2", NOW - 30_000));
    const res = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "and the tests?" }),
    });
    expect(res.status).toBe(202);
    expect(await seen).toEqual([
      { role: "user", text: "request of r-1", at: NOW - 70_000 },
      { role: "assistant", text: "answer of r-1", at: NOW - 60_000 },
      { role: "user", text: "request of r-2", at: NOW - 40_000 },
      { role: "assistant", text: "answer of r-2", at: NOW - 30_000 },
    ]);
  });

  it("a run's history read on a send never asks the intake ledger — the receipts it would fetch are discarded by historyOf anyway", async () => {
    let resolveSeen!: (h: unknown) => void;
    const seen = new Promise<unknown>((r) => (resolveSeen = r));
    const listIntake = vi.fn(async () => []);
    const { handler, store } = setup({
      intake: { listIntake },
      dispatch: async (_deps, _msg, io) => {
        resolveSeen(await io.history());
      },
    });
    await store.put(record("r-1", NOW - 60_000));
    const res = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "and the tests?" }),
    });
    expect(res.status).toBe(200);
    expect(await seen).toEqual([
      { role: "user", text: "request of r-1", at: NOW - 70_000 },
      { role: "assistant", text: "answer of r-1", at: NOW - 60_000 },
    ]);
    expect(listIntake).not.toHaveBeenCalled();
  });

  it("refusals before dispatch: GET 405, a foreign origin 403, a non-JSON body 415, an empty text 400, another channel's thread 403, an oversized body 413", async () => {
    const { handler, calls } = setup();
    const body = JSON.stringify({ text: "hi" });
    expect((await request(handler, { url: "/threads/conv-1/send", method: "GET" })).status).toBe(405);
    expect(
      (
        await request(handler, {
          url: "/threads/conv-1/send",
          method: "POST",
          body,
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(handler, {
          url: "/threads/conv-1/send",
          method: "POST",
          body,
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(handler, {
          url: "/threads/conv-1/send",
          method: "POST",
          body,
          headers: { "content-type": "text/plain" },
        })
      ).status,
    ).toBe(415);
    expect(
      (await request(handler, { url: "/threads/conv-1/send", method: "POST", body: JSON.stringify({ text: "  " }) }))
        .status,
    ).toBe(400);
    expect((await request(handler, { url: "/threads/conv-1/send", method: "POST", body: "not json" })).status).toBe(
      400,
    );
    const foreign = await request(handler, { url: "/threads/slack:C1:1.2/send", method: "POST", body });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).detail).toMatch(/lives on slack/);
    const big = await request(handler, {
      url: "/threads/conv-1/send",
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(1_100_000) }),
    });
    expect(big.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

// ---- GET /threads and /threads/<id> ------------------------------------------------

describe("orchestratorChatSeed — the plane's chat half (record 0070; orchestration-plane item 11)", () => {
  it("reads the viewer's own orchestrator thread — one per person, in their lane — with the composer's send URL and palette", async () => {
    const { service, registry, store } = setup();
    await store.put(record("r-orc", NOW - 60_000, { threadKey: "web:a1:orchestrator" }));
    // Another conversation of the viewer's: never part of the half.
    await store.put(record("r-else", NOW - 30_000));
    const half = await orchestratorChatSeed({ service, registry, commands: { list: () => COMMANDS } })(alice, IDENTITY);
    expect(half.conversation).toBe("orchestrator");
    expect(half.sendUrl).toBe("/threads/orchestrator/send");
    expect(half.turns.map((t) => ("id" in t ? t.id : ""))).toEqual(["r-orc"]);
    expect(half.viewer.name).toBe("alice@example.test");
    expect(half.commands.map((c) => c.chat)).toEqual(["config show", "help show", "mcp add"]);
  });

  it("a viewer with no orchestrator runs yet gets an empty thread — created on first open, continued ever after", async () => {
    const { service, registry } = setup();
    const half = await orchestratorChatSeed({ service, registry, commands: { list: () => [] } })(linked);
    expect(half.turns).toEqual([]);
    // The linked person's own name; without a link or an identity, the sub.
    expect(half.viewer.name).toBe("alice");
  });
});

describe("GET /threads and /threads/<id> — the seed from the runs service (items 2, 7, 8, 11)", () => {
  it("/threads mints a conversation of the viewer's own lane: no turns, a send URL under it, the palette the viewer may run, chips grounded in their runs", async () => {
    const { handler, store } = setup();
    await store.put(record("r-1", NOW - 60_000, { repo: "acme/api", status: "failed" }));
    const res = await request(handler, { url: "/threads" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    const seed = seedOf<HomeSeed>(res.body);
    expect(seed).toMatchObject({
      page: "home",
      conversation: "fresh-1",
      turns: [],
      sendUrl: "/threads/fresh-1/send",
      lane: "web:a1",
      viewer: { name: "alice@example.test" },
      now: NOW,
      retentionDays: 30,
    });
    expect(seed).not.toHaveProperty("elsewhere");
    expect(seed.commands.map((c) => c.chat)).toEqual(["config show", "help show", "mcp add"]);
    expect(seed.suggestions[0]).toBe("review the open PR on acme/api");
    expect(seed.suggestions).toContain("why did my last run fail?");
    expect(seed.suggestions.at(-1)).toBe("What can Switchboard do?");
    expect(res.body).not.toMatch(/tok-/);
  });

  it("/threads/<id> seeds exactly the thread's runs the viewer may read, oldest first, each with its request, reply and route; a live run carries its token; the rail lists the viewer's threads across channels, newest first, a foreign thread by its whole key, a thread whose oldest run recorded no request titled by the next one's", async () => {
    const { handler, store, registry } = setup();
    await store.put(record("r-1", NOW - 60_000));
    await store.put(record("r-2", NOW - 30_000));
    // Another conversation of alice's, and a Slack thread her linked person requested in.
    await store.put(record("o-1", NOW - 3_600_000, { threadKey: "web:a1:conv-2" }));
    // A thread whose oldest run died before its request was published (no `input`; its
    // label is the card's head): the title comes from the next run that recorded one.
    await store.put(
      record("d-0", NOW - 7_200_000, {
        threadKey: "web:a1:conv-3",
        label: "*ship* on `anthropic/m`",
        status: "failed",
        events: [{ type: "run_meta", agent: "ship", seq: 1 }],
      }),
    );
    await store.put(record("d-1", NOW - 7_000_000, { threadKey: "web:a1:conv-3" }));
    await store.put(
      record("s-1", NOW - 120_000, {
        threadKey: "slack:C1:1712.34",
        channelId: "slack:C1",
        userId: "slack:UALICE",
        channelVisibility: "unknown",
        sourceUrl: "https://slack.example/archives/C1/p171234",
      }),
    );
    // A stranger's conversation: invisible, so absent from the rail.
    await store.put(
      record("x-1", NOW - 1_000, { threadKey: "web:b2:conv-9", channelId: "web:b2", userId: "access:b2" }),
    );
    const live = registry.create("review · re-review", {
      channelId: "web:a1",
      userId: "access:a1",
      threadKey: "web:a1:conv-1",
      channelVisibility: "dm",
    });
    registry.publish(live.id, { type: "input", messageId: live.id, text: "re-review after the repush" });

    const res = await request(handler, { url: "/threads/conv-1", actor: linked });
    expect(res.status).toBe(200);
    const seed = seedOf<HomeSeed>(res.body);
    expect(seed.conversation).toBe("conv-1");
    expect(seed.viewer).toEqual({ name: "alice" });
    const runTurns = seed.turns.filter((t): t is HomeTurnSeed => !("kind" in t));
    expect(runTurns.map((t) => [t.id, t.request, t.answer, t.route?.preset, t.finished, t.token])).toEqual([
      ["r-1", "request of r-1", "answer of r-1", "review", true, undefined],
      ["r-2", "request of r-2", "answer of r-2", "review", true, undefined],
      [live.id, "re-review after the repush", undefined, undefined, false, live.token],
    ]);
    expect(seed.conversations).toEqual([
      {
        id: "conv-1",
        title: "request of r-1",
        excerpt: "request of r-1",
        lastAt: NOW,
        runs: 3,
        live: true,
        surface: "web",
      },
      {
        id: "slack:C1:1712.34",
        title: "request of s-1",
        excerpt: "request of s-1",
        lastAt: NOW - 120_000,
        runs: 1,
        live: false,
        surface: "slack",
        channelId: "slack:C1",
      },
      {
        id: "conv-2",
        title: "request of o-1",
        excerpt: "request of o-1",
        lastAt: NOW - 3_600_000,
        runs: 1,
        live: false,
        surface: "web",
      },
      {
        id: "conv-3",
        title: "request of d-1",
        excerpt: "request of d-1",
        lastAt: NOW - 7_000_000,
        runs: 2,
        live: false,
        surface: "web",
      },
    ]);
    // The tab title carries the live count, as the runs index does.
    expect(res.body).toMatch(/<title>\(1\) Threads<\/title>/);
  });

  it("the rail names a thread's channel when the name directory knows it (record 0042, the dashboard reads names): channelName beside channelId on the Slack row, nothing on the viewer's own lane, the id alone when unknown or failing", async () => {
    const { store, handler } = setup({ channelNames: { "slack:C1": "backend", "slack:C9": "!" } });
    await store.put(
      record("r-1", NOW - 5_000, { threadKey: "web:a1:conv-1", channelId: "web:a1", userId: "access:a1" }),
    );
    await store.put(
      record("s-1", NOW - 3_000, { threadKey: "slack:C1:1712.34", channelId: "slack:C1", userId: "slack:UALICE" }),
    );
    await store.put(
      record("s-2", NOW - 2_000, { threadKey: "slack:C9:1712.99", channelId: "slack:C9", userId: "slack:UALICE" }),
    );
    await store.put(
      record("s-3", NOW - 1_000, { threadKey: "slack:C2:1712.55", channelId: "slack:C2", userId: "slack:UALICE" }),
    );
    const res = await request(handler, { url: "/threads/conv-1", actor: linked });
    const seed = seedOf<HomeSeed>(res.body);
    const byId = Object.fromEntries(seed.conversations.map((c) => [c.id, c]));
    expect(byId["slack:C1:1712.34"]).toMatchObject({ channelId: "slack:C1", channelName: "backend" });
    expect(byId["slack:C9:1712.99"]).toMatchObject({ channelId: "slack:C9" });
    expect(byId["slack:C9:1712.99"]).not.toHaveProperty("channelName");
    expect(byId["slack:C2:1712.55"]).toMatchObject({ channelId: "slack:C2" });
    expect(byId["slack:C2:1712.55"]).not.toHaveProperty("channelName");
    expect(byId["conv-1"]).not.toHaveProperty("channelId");
    expect(byId["conv-1"]).not.toHaveProperty("channelName");
  });

  it("a stranger's thread — or one the viewer may see nothing of — is the same 404 an unknown run gives; the viewer's own empty conversation opens empty", async () => {
    const { handler, store } = setup();
    await store.put(record("x-1", NOW, { threadKey: "web:b2:conv-9", channelId: "web:b2", userId: "access:b2" }));
    const foreign = await request(handler, { url: "/threads/web:b2:conv-9" });
    expect(foreign.status).toBe(404);
    expect(seedOf<RunNotFoundSeed>(foreign.body)).toMatchObject({ page: "runNotFound", retentionDays: 30 });
    const unknown = await request(handler, { url: "/threads/slack:C9:1.1" });
    expect(unknown.status).toBe(404);
    const own = await request(handler, { url: "/threads/never-used" });
    expect(own.status).toBe(200);
    expect(seedOf<HomeSeed>(own.body)).toMatchObject({ conversation: "never-used", turns: [] });
  });

  it("a thread from another channel the viewer may read opens read-only: `elsewhere` names its surface and link, and the composer's route refuses a send there", async () => {
    const { handler, store } = setup();
    await store.put(
      record("s-1", NOW - 120_000, {
        threadKey: "slack:C1:1712.34",
        channelId: "slack:C1",
        userId: "slack:UALICE",
        channelVisibility: "unknown",
        sourceUrl: "https://slack.example/archives/C1/p171234",
      }),
    );
    const res = await request(handler, { url: "/threads/slack:C1:1712.34", actor: linked });
    expect(res.status).toBe(200);
    const seed = seedOf<HomeSeed>(res.body);
    expect(seed.elsewhere).toEqual({ surface: "slack", url: "https://slack.example/archives/C1/p171234" });
    expect(seed.turns.map((t) => ("kind" in t ? t.kind : t.id))).toEqual(["s-1"]);
    const sent = await request(handler, {
      url: "/threads/slack:C1:1712.34/send",
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
      actor: linked,
    });
    expect(sent.status).toBe(403);
  });

  it("not a route here: another path under the prefix returns false; a POST to a page is 405", async () => {
    const { handler } = setup();
    expect((await request(handler, { url: "/threads/conv-1/x" })).handled).toBe(false);
    expect((await request(handler, { url: "/threads", method: "POST", body: "{}" })).status).toBe(405);
  });
});

// ---- silent intake receipts on the thread view --------------------------------------

describe("GET /threads/<id> — silent intake receipts on the thread view (item 12)", () => {
  const THREAD = "slack:C1:1712.34";
  const receipt = (decidedAt: number, reason: string, verdict: IntakeReceipt["verdict"] = "silent"): IntakeReceipt => ({
    verdict,
    reason,
    source: "model",
    mode: "classify",
    model: "anthropic/fast",
    gen: 1,
    threadKey: THREAD,
    decidedAt,
  });
  const slackRun = (id: string, finishedAt: number) =>
    record(id, finishedAt, {
      threadKey: THREAD,
      channelId: "slack:C1",
      userId: "slack:UALICE",
      channelVisibility: "unknown",
    });
  const shapeOf = (t: HomeTurnSeed | HomeReceiptTurnSeed | HomeParentTurnSeed) =>
    "kind" in t ? (t.kind === "receipt" ? [t.kind, t.reason, t.decidedAt] : [t.kind]) : t.id;

  it("two silent receipts seed two read-not-answered turns with their reasons, interleaved among the runs by decidedAt; an addressed receipt seeds nothing", async () => {
    const rows = [
      // Deliberately unsorted: the seed orders by decidedAt, not by the read's order.
      receipt(NOW - 80_000, "smalltalk between people"),
      receipt(NOW - 40_000, "handled by its person", "addressed"),
      receipt(NOW - 150_000, "a question to another person"),
    ];
    const listIntake = vi.fn(async (q: { threadKey?: string }) => rows.filter((r) => r.threadKey === q.threadKey));
    const { handler, store } = setup({ intake: { listIntake } });
    await store.put(slackRun("s-a", NOW - 200_000));
    await store.put(slackRun("s-b", NOW - 60_000));
    const res = await request(handler, { url: `/threads/${THREAD}`, actor: linked });
    expect(res.status).toBe(200);
    const seed = seedOf<HomeSeed>(res.body);
    expect(seed.turns.map(shapeOf)).toEqual([
      "s-a",
      ["receipt", "a question to another person", NOW - 150_000],
      ["receipt", "smalltalk between people", NOW - 80_000],
      "s-b",
    ]);
    expect(listIntake).toHaveBeenCalledWith({ threadKey: THREAD });
  });

  it("zero receipts, a null ledger and a failing one all seed the runs alone", async () => {
    for (const intake of [
      { listIntake: async () => [] },
      null,
      {
        listIntake: async () => {
          throw new Error("the ledger is down");
        },
      },
    ]) {
      const { handler, store } = setup({ intake });
      await store.put(slackRun("s-a", NOW - 200_000));
      const res = await request(handler, { url: `/threads/${THREAD}`, actor: linked });
      expect(res.status).toBe(200);
      expect(seedOf<HomeSeed>(res.body).turns.map(shapeOf)).toEqual(["s-a"]);
    }
  });

  it("a thread the viewer may see nothing of seeds no receipt: the 404 stands and the ledger is never asked", async () => {
    const listIntake = vi.fn(async () => [receipt(NOW - 80_000, "smalltalk between people")]);
    const { handler, store } = setup({ intake: { listIntake } });
    await store.put(record("x-1", NOW, { threadKey: THREAD, channelId: "slack:C1", userId: "slack:UBOB" }));
    const res = await request(handler, { url: `/threads/${THREAD}` });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("smalltalk");
    expect(listIntake).not.toHaveBeenCalled();
  });
});

// ---- the parent's word on a unit's thread --------------------------------------

describe("GET /threads/<id> — the parent's word on a unit's thread (item 2)", () => {
  const THREAD = "web:a1:conv-1";
  const instance: CoordinatorInstance = {
    id: "plan-p-1",
    kind: "ship",
    userId: "access:a1",
    channelId: "web:a1",
    threadKey: "web:a1:conv-0",
    repo: "acme/api",
    branch: "plan/p/u9",
    createdAt: NOW - 400_000,
    runId: "parent-run",
  };
  const word = (state: string, at: number, over: Partial<Extract<RunEvent, { type: "ship_unit" }>> = {}) =>
    ({ type: "ship_unit", unit: "U16", state, threadKey: THREAD, at, ...over }) as RunEvent;
  const parentRecord = (events: RunEvent[]) =>
    record("parent-run", NOW - 10_000, {
      agent: "ship",
      channelId: instance.channelId,
      userId: instance.userId,
      threadKey: instance.threadKey,
      events,
      eventCount: events.length,
      storedEventCount: events.length,
    });
  const tagged = (id: string, finishedAt: number) =>
    record(id, finishedAt, {
      parentInstanceId: "plan-p-1",
      idempotencyKey: "plan-p-1:U16/0/coding",
    });
  const shapeOf = (t: HomeTurnSeed | HomeReceiptTurnSeed | HomeParentTurnSeed) =>
    "kind" in t ? (t.kind === "parent" ? [t.kind, t.runId, t.unit, t.state, t.at] : [t.kind]) : t.id;

  it("a conversation whose runs carry an instance tag lists the parent's ship_unit events naming this thread, in time order among its runs, and none naming another thread", async () => {
    const units = new InMemoryCoordinatorInstanceStore();
    await units.put(instance);
    const { handler, store } = setup({ units });
    // r-1 starts NOW-70_000, r-2 starts NOW-40_000 (record() starts 10 s before the finish).
    await store.put(tagged("r-1", NOW - 60_000));
    await store.put(tagged("r-2", NOW - 30_000));
    await store.put(
      parentRecord([
        word("approve", NOW - 35_000, { report: "round 1 approved", pr: 7 }),
        word("started", NOW - 65_000, { lead: "↳ unit U16" }),
        word("started", NOW - 50_000, { threadKey: "web:a1:conv-9" }),
      ]),
    );
    const res = await request(handler, { url: "/threads/conv-1" });
    expect(res.status).toBe(200);
    const seed = seedOf<HomeSeed>(res.body);
    expect(seed.turns.map(shapeOf)).toEqual([
      "r-1",
      ["parent", "parent-run", "U16", "started", NOW - 65_000],
      "r-2",
      ["parent", "parent-run", "U16", "approve", NOW - 35_000],
    ]);
    const approve = seed.turns.at(-1) as HomeParentTurnSeed;
    expect(approve).toEqual({
      kind: "parent",
      runId: "parent-run",
      unit: "U16",
      state: "approve",
      report: "round 1 approved",
      pr: 7,
      at: NOW - 35_000,
    });
  });

  it("a live parent's turn carries its capability token — the link reads during the pipeline's whole life — and a finished parent's carries none", async () => {
    const units = new InMemoryCoordinatorInstanceStore();
    const { handler, store, registry } = setup({ units });
    // The parent is live: only its registry row holds it, under its own token.
    const live = registry.create("ship · plan p", {
      channelId: instance.channelId,
      userId: instance.userId,
      threadKey: instance.threadKey,
      channelVisibility: "dm",
    });
    registry.publish(live.id, word("started", NOW - 65_000, { lead: "↳ unit U16" }));
    await units.put({ ...instance, runId: live.id });
    await store.put(tagged("r-1", NOW - 60_000));
    const seed = seedOf<HomeSeed>((await request(handler, { url: "/threads/conv-1" })).body);
    const parent = seed.turns.find((t) => "kind" in t && t.kind === "parent") as HomeParentTurnSeed;
    expect(parent.runId).toBe(live.id);
    expect(parent.token).toBe(live.token);
  });

  it("a ship_unit event without a stamp sits at the parent's own start, never at epoch 0", async () => {
    const units = new InMemoryCoordinatorInstanceStore();
    await units.put(instance);
    const { handler, store } = setup({ units });
    await store.put(tagged("r-1", NOW - 60_000));
    await store.put(
      parentRecord([{ type: "ship_unit", unit: "U16", state: "started", threadKey: THREAD } as RunEvent]),
    );
    const seed = seedOf<HomeSeed>((await request(handler, { url: "/threads/conv-1" })).body);
    // parentRecord finishes at NOW - 10_000; record() starts 10 s earlier.
    expect(seed.turns.map(shapeOf)).toEqual(["r-1", ["parent", "parent-run", "U16", "started", NOW - 20_000]]);
  });

  it("a conversation with no tagged run reads no parent, and so does a process without the coordinator's records", async () => {
    const units = new InMemoryCoordinatorInstanceStore();
    await units.put(instance);
    const withUnits = setup({ units });
    await withUnits.store.put(record("r-1", NOW - 60_000));
    await withUnits.store.put(parentRecord([word("started", NOW - 65_000)]));
    const plain = seedOf<HomeSeed>((await request(withUnits.handler, { url: "/threads/conv-1" })).body);
    expect(plain.turns.map(shapeOf)).toEqual(["r-1"]);

    const bare = setup();
    await bare.store.put(tagged("r-1", NOW - 60_000));
    await bare.store.put(parentRecord([word("started", NOW - 65_000)]));
    const seed = seedOf<HomeSeed>((await request(bare.handler, { url: "/threads/conv-1" })).body);
    expect(seed.turns.map(shapeOf)).toEqual(["r-1"]);
  });

  it("a viewer whose predicate excludes the parent sees no parent turns in a conversation whose runs carry the instance tag", async () => {
    const units = new InMemoryCoordinatorInstanceStore();
    // Another channel's instance: alice reads the thread's runs, never the parent.
    await units.put({ ...instance, userId: "slack:UBOB", channelId: "slack:C9", threadKey: "slack:C9:1.1" });
    const { handler, store } = setup({ units });
    await store.put(tagged("r-1", NOW - 60_000));
    await store.put(
      record("parent-run", NOW - 10_000, {
        agent: "ship",
        channelId: "slack:C9",
        userId: "slack:UBOB",
        threadKey: "slack:C9:1.1",
        events: [word("started", NOW - 65_000)],
      }),
    );
    const res = await request(handler, { url: "/threads/conv-1" });
    expect(res.status).toBe(200);
    expect(seedOf<HomeSeed>(res.body).turns.map(shapeOf)).toEqual(["r-1"]);
  });
});
