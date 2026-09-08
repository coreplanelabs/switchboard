import { describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import {
  authenticate,
  authorizeRequest,
  createIngressHandler,
  handleIngressRequest,
  HttpIO,
  parseIngressTokens,
  readBody,
  type DispatchFn,
  type IngressConfig,
  type IngressIdentity,
} from "./http.js";
import type { CoreDeps } from "../core/dispatcher.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";

// Feature: features/http-ingress.md — adapter #3 (HTTP). Auth is fail-closed +
// constant-time; a token maps to a namespaced identity that flows into the same
// dispatch() the Slack/CLI adapters use. A fake dispatch keeps these off real
// providers.

// The config store as the adapter sees it: grants by actor id, and a `config` with no `tracing` (no span log).
const deps = { config: { grantsFor: (id: string) => GRANTS.get(id) ?? NO_GRANTS, config: {} } } as unknown as CoreDeps;

/** A dispatch double that records the message and echoes a canned reply. */
function fakeDispatch(reply = "the answer") {
  const calls: { msg: IncomingMessage; io: ChannelIO }[] = [];
  const fn: DispatchFn = async (_deps, msg, io) => {
    calls.push({ msg, io });
    await io.reply(reply);
  };
  return { fn, calls };
}

/** What each fixture token's `http:<subject>` actor holds — config's grants, as the
 *  bot's store answers them. `authConfig` registers `dispatch` for every subject
 *  unless a test says otherwise (`actions`); `deps.config.grantsFor` reads it. */
const GRANTS = new Map<string, Grants>();
const authConfig = (tokens: Record<string, IngressIdentity & { actions?: string[] }>): IngressConfig => ({
  tokens: Object.fromEntries(
    Object.entries(tokens).map(([t, { actions, ...id }]) => {
      GRANTS.set(`http:${id.subject}`, {
        actions: new Set(actions ?? ["dispatch"]),
        channels: new Set(),
        repos: new Set(),
      });
      return [t, id];
    }),
  ),
});
const bearer = (token: string): IncomingHttpHeaders => ({ authorization: `Bearer ${token}` });

describe("authenticate (bearer auth, constant-time)", () => {
  const config = authConfig({
    alpha: { subject: "alice" },
    beta: { subject: "bob", channel: "ops" },
    gamma: { subject: "carol" },
  });

  it("maps a valid token to its identity", () => {
    expect(authenticate(bearer("beta"), config)).toEqual({ subject: "bob", channel: "ops" });
  });

  it("returns the right identity regardless of token position (checks all, no early exit)", () => {
    expect(authenticate(bearer("alpha"), config)?.subject).toBe("alice"); // first
    expect(authenticate(bearer("gamma"), config)?.subject).toBe("carol"); // last
  });

  it("rejects an unknown token", () => {
    expect(authenticate(bearer("nope"), config)).toBeNull();
  });

  it("rejects an equal-length but wrong token (length-guard path is not a match)", () => {
    // "delta" has the same length as "alpha"/"gamma" but is not configured.
    expect(authenticate(bearer("delta"), config)).toBeNull();
  });

  it("rejects a missing Authorization header", () => {
    expect(authenticate({}, config)).toBeNull();
  });

  it("rejects a non-bearer / malformed Authorization header", () => {
    expect(authenticate({ authorization: "Basic abc" }, config)).toBeNull();
    expect(authenticate({ authorization: "alpha" }, config)).toBeNull();
    expect(authenticate({ authorization: "Bearer " }, config)).toBeNull();
  });

  it("handles a duplicated (array) header by using the first value", () => {
    // node lowercases and may repeat headers; authenticate() tolerates arrays
    // even though the typed shape is string — hence the cast.
    const headers = { authorization: ["Bearer alpha", "Bearer beta"] } as unknown as IncomingHttpHeaders;
    expect(authenticate(headers, config)?.subject).toBe("alice");
  });
});

describe("handleIngressRequest (transport gating + dispatch)", () => {
  const good = authConfig({ tok: { subject: "alice" } });

  it("valid token → dispatch called with the namespaced IncomingMessage; reply returned", async () => {
    const d = fakeDispatch("hello from agent");
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "hi", channel: "ops", thread: "t1" }) },
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: "hello from agent" });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].msg).toEqual({
      userId: "http:alice",
      channelId: "http:ops",
      threadKey: "http:ops:t1",
      text: "hi",
      receivedAt: expect.any(Number), // stamped at receipt (features/tracing.md)
    });
  });

  it("defaults channel/thread when the body omits them", async () => {
    const d = fakeDispatch();
    await handleIngressRequest({ method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "hi" }) }, deps, {
      auth: good,
      dispatch: d.fn,
    });
    expect(d.calls[0].msg.channelId).toBe("http:default");
    expect(d.calls[0].msg.threadKey).toBe("http:default:default");
  });

  it("a token-pinned channel overrides the body's channel", async () => {
    const d = fakeDispatch();
    const pinned = authConfig({ tok: { subject: "alice", channel: "locked" } });
    await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "hi", channel: "attacker" }) },
      deps,
      { auth: pinned, dispatch: d.fn },
    );
    expect(d.calls[0].msg.channelId).toBe("http:locked");
    expect(d.calls[0].msg.threadKey).toBe("http:locked:default");
  });

  it("no tokens configured → 503 disabled, dispatch never called (fail-closed)", async () => {
    const d = fakeDispatch();
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("anything"), body: JSON.stringify({ text: "hi" }) },
      deps,
      { auth: authConfig({}), dispatch: d.fn },
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "disabled" });
    expect(d.calls).toHaveLength(0);
  });

  it("missing/invalid token → 401, dispatch never called", async () => {
    const d = fakeDispatch();
    const missing = await handleIngressRequest(
      { method: "POST", headers: {}, body: JSON.stringify({ text: "hi" }) },
      deps,
      { auth: good, dispatch: d.fn },
    );
    const wrong = await handleIngressRequest(
      { method: "POST", headers: bearer("bad"), body: JSON.stringify({ text: "hi" }) },
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(d.calls).toHaveLength(0);
  });

  it("invalid JSON → 400, dispatch never called", async () => {
    const d = fakeDispatch();
    const res = await handleIngressRequest({ method: "POST", headers: bearer("tok"), body: "{not json" }, deps, {
      auth: good,
      dispatch: d.fn,
    });
    expect(res.status).toBe(400);
    expect(d.calls).toHaveLength(0);
  });

  it("missing/blank text → 400", async () => {
    const d = fakeDispatch();
    for (const body of [JSON.stringify({}), JSON.stringify({ text: "   " }), JSON.stringify({ text: 5 }), "[]"]) {
      const res = await handleIngressRequest({ method: "POST", headers: bearer("tok"), body }, deps, {
        auth: good,
        dispatch: d.fn,
      });
      expect(res.status).toBe(400);
    }
    expect(d.calls).toHaveLength(0);
  });

  it("malformed history → 400; well-formed history reaches io.history()", async () => {
    const d = fakeDispatch();
    const bad = await handleIngressRequest(
      {
        method: "POST",
        headers: bearer("tok"),
        body: JSON.stringify({ text: "hi", history: [{ role: "system", text: "x" }] }),
      },
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(bad.status).toBe(400);

    const captured = fakeDispatch();
    await handleIngressRequest(
      {
        method: "POST",
        headers: bearer("tok"),
        body: JSON.stringify({ text: "now", history: [{ role: "user", text: "earlier" }] }),
      },
      deps,
      { auth: good, dispatch: captured.fn },
    );
    expect(await captured.calls[0].io.history()).toEqual([{ role: "user", text: "earlier" }]);
  });

  it("non-POST → 405", async () => {
    const d = fakeDispatch();
    const res = await handleIngressRequest({ method: "GET", headers: bearer("tok"), body: "" }, deps, {
      auth: good,
      dispatch: d.fn,
    });
    expect(res.status).toBe(405);
    expect(d.calls).toHaveLength(0);
  });
});

describe("handleIngressRequest — the dispatch grant (fail-closed)", () => {
  it("a token whose actor holds no dispatch grant (runs:read only) → 403, dispatch never called", async () => {
    const d = fakeDispatch();
    const auth = authConfig({ tok: { subject: "reader", actions: ["runs:read"] } });
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "start a run" }) },
      deps,
      { auth, dispatch: d.fn },
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", code: "unauthorized" });
    expect(d.calls).toHaveLength(0);
  });

  it("a token whose http:<subject> actor is granted dispatch dispatches; the token map itself grants nothing", async () => {
    const d = fakeDispatch("ok");
    const auth = parseIngressTokens({ SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({ tok: { subject: "alice" } }) });
    GRANTS.set("http:alice", { actions: new Set(["dispatch"]), channels: new Set(), repos: new Set() });
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "hi" }) },
      deps,
      { auth, dispatch: d.fn },
    );
    expect(res.status).toBe(200);
    expect(d.calls).toHaveLength(1);
  });

  it("the node wrapper refuses a dispatch-less actor from the headers, without reading the body", async () => {
    const d = fakeDispatch();
    const auth = authConfig({ tok: { subject: "reader", actions: ["runs:read"] } });
    const handler = createIngressHandler(deps, { auth, dispatch: d.fn });
    let bodyRead = false;
    const req = {
      method: "POST",
      headers: bearer("tok"),
      destroy: () => {},
      async *[Symbol.asyncIterator]() {
        bodyRead = true;
        yield Buffer.from(JSON.stringify({ text: "hi" }));
      },
    };
    let status = 0;
    let out = "";
    const res = { writeHead: (s: number) => void (status = s), end: (c?: string) => void (out = c ?? "") };
    handler(req as never, res as never);
    await vi.waitFor(() => expect(status).toBe(403));
    expect(JSON.parse(out)).toEqual({ error: "forbidden", code: "unauthorized" });
    expect(bodyRead).toBe(false);
    expect(d.calls).toHaveLength(0);
  });
});

describe("HttpIO (single-shot ChannelIO)", () => {
  it("collects replies and joins them; status is a no-op; history replays the body's turns", async () => {
    const io = new HttpIO([{ role: "user", text: "prior" }]);
    await io.reply("one");
    await io.reply("two");
    expect(io.collected()).toBe("one\n\ntwo");
    expect(await io.history()).toEqual([{ role: "user", text: "prior" }]);
    const handle = await io.status({ title: "working" });
    expect(() => handle.update({ title: "still working" })).not.toThrow();
    await expect(handle.done({ title: "done" })).resolves.toBeUndefined();
  });

  it("defaults to empty history", async () => {
    expect(await new HttpIO().history()).toEqual([]);
  });
});

describe("readBody (size cap)", () => {
  async function* stream(...parts: string[]) {
    for (const p of parts) yield Buffer.from(p, "utf8");
  }

  it("concatenates chunks under the cap", async () => {
    const res = await readBody(stream("hello ", "world"), 100);
    expect(res).toEqual({ ok: true, body: "hello world" });
  });

  it("rejects a body over the cap", async () => {
    const res = await readBody(stream("a".repeat(10), "b".repeat(10)), 15);
    expect(res).toEqual({ ok: false, tooLarge: true });
  });
});

describe("createIngressHandler (node:http wrapper)", () => {
  function fakeReqRes(method: string, headers: IncomingHttpHeaders, body: string) {
    async function* iter() {
      yield Buffer.from(body, "utf8");
    }
    const req = Object.assign(iter(), { method, headers, destroy: vi.fn() });
    let statusCode = 0;
    let payload = "";
    const res = {
      writeHead: (code: number) => {
        statusCode = code;
      },
      end: (chunk?: string) => {
        payload = chunk ?? "";
      },
    };
    return {
      req: req as unknown as Parameters<ReturnType<typeof createIngressHandler>>[0],
      res: res as unknown as Parameters<ReturnType<typeof createIngressHandler>>[1],
      status: () => statusCode,
      json: () => JSON.parse(payload),
      reqRaw: req,
    };
  }

  it("reads the body, dispatches, and writes a 200 JSON reply", async () => {
    const d = fakeDispatch("wrapped");
    const handler = createIngressHandler(deps, { auth: authConfig({ tok: { subject: "alice" } }), dispatch: d.fn });
    const t = fakeReqRes("POST", bearer("tok"), JSON.stringify({ text: "hi" }));
    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.status()).toBe(200));
    expect(t.json()).toEqual({ reply: "wrapped" });
    expect(d.calls[0].msg.userId).toBe("http:alice");
  });

  it("answers 413 and destroys the request when the body exceeds the cap", async () => {
    const d = fakeDispatch();
    const handler = createIngressHandler(deps, {
      auth: authConfig({ tok: { subject: "alice" } }),
      dispatch: d.fn,
      maxBodyBytes: 5,
    });
    const t = fakeReqRes("POST", bearer("tok"), JSON.stringify({ text: "way too long" }));
    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.status()).toBe(413));
    expect(d.calls).toHaveLength(0);
    expect((t.reqRaw as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled();
  });

  // Hardening (review follow-up): an unauthorized caller must be rejected from
  // headers alone, WITHOUT the body ever being read/buffered.
  it("rejects an unauthorized request without reading the body (pre-auth)", async () => {
    const d = fakeDispatch();
    let bodyRead = false;
    async function* iter() {
      bodyRead = true;
      yield Buffer.from(JSON.stringify({ text: "hi" }), "utf8");
    }
    const destroy = vi.fn();
    const req = Object.assign(iter(), { method: "POST", headers: bearer("wrong-token"), destroy });
    let statusCode = 0;
    const res = {
      writeHead: (c: number) => {
        statusCode = c;
      },
      end: () => {},
    };
    const handler = createIngressHandler(deps, { auth: authConfig({ tok: { subject: "alice" } }), dispatch: d.fn });
    handler(
      req as unknown as Parameters<ReturnType<typeof createIngressHandler>>[0],
      res as unknown as Parameters<ReturnType<typeof createIngressHandler>>[1],
    );
    await vi.waitFor(() => expect(statusCode).toBe(401));
    expect(bodyRead).toBe(false); // body iterator never consumed
    expect(d.calls).toHaveLength(0);
    expect(destroy).toHaveBeenCalled();
  });
});

describe("authorizeRequest (header-only gate)", () => {
  const opts = (tokens: Parameters<typeof authConfig>[0] = { tok: { subject: "alice" } }) => ({
    auth: authConfig(tokens),
  });
  it("405 on non-POST", () => {
    expect(authorizeRequest("GET", bearer("tok"), opts())).toMatchObject({ status: 405 });
  });
  it("503 when no tokens are configured (fail-closed)", () => {
    expect(authorizeRequest("POST", bearer("tok"), opts({}))).toMatchObject({ status: 503 });
  });
  it("401 on missing or unknown token", () => {
    expect(authorizeRequest("POST", {}, opts())).toMatchObject({ status: 401 });
    expect(authorizeRequest("POST", bearer("nope"), opts())).toMatchObject({ status: 401 });
  });
  it("returns the identity for a valid token", () => {
    expect(authorizeRequest("POST", bearer("tok"), opts())).toEqual({
      identity: { subject: "alice" },
    });
  });
});

describe("parseIngressTokens (env → config, fail-closed)", () => {
  it("parses a valid JSON token map", () => {
    const cfg = parseIngressTokens({
      SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({
        s3cr3t: { subject: "alice", channel: "ops" },
        t2: { subject: "bob" },
      }),
    });
    expect(cfg.tokens).toEqual({
      s3cr3t: { subject: "alice", channel: "ops" },
      t2: { subject: "bob" },
    });
  });

  it("returns an empty (disabled) map when unset, blank, or malformed", () => {
    expect(parseIngressTokens({}).tokens).toEqual({});
    expect(parseIngressTokens({ SWITCHBOARD_INGRESS_TOKENS: "   " }).tokens).toEqual({});
    expect(parseIngressTokens({ SWITCHBOARD_INGRESS_TOKENS: "{not json" }).tokens).toEqual({});
    expect(parseIngressTokens({ SWITCHBOARD_INGRESS_TOKENS: "[]" }).tokens).toEqual({});
  });

  it("skips malformed entries (missing/blank subject, bad channel, empty token) without opening", () => {
    const cfg = parseIngressTokens({
      SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({
        good: { subject: "alice" },
        noSubject: { channel: "ops" },
        blankSubject: { subject: "" },
        badChannel: { subject: "x", channel: 5 },
        notObject: "nope",
        "": { subject: "empty-token" },
      }),
    });
    expect(cfg.tokens).toEqual({ good: { subject: "alice" } });
  });
});

// Feature: features/authorization.md item 9 — a token entry identifies; what the
// token may do is config's `grants["http:<subject>"]` / `["mcp:<subject>"]`.
describe("parseIngressTokens — a token is a credential, its rights are config's", () => {
  it("an entry is subject + optional channel; nothing about what it may do", () => {
    const cfg = parseIngressTokens({
      SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({ t: { subject: "ci", channel: "ops" }, u: { subject: "alice" } }),
    });
    expect(cfg.tokens).toEqual({ t: { subject: "ci", channel: "ops" }, u: { subject: "alice" } });
  });

  it("the retired `scopes` field is kept out of the identity and warned about by subject — the entry stays usable, never widened", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = parseIngressTokens({
      SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({ legacy: { subject: "ci", scopes: ["dispatch", "runs:read"] } }),
    });
    expect(cfg.tokens).toEqual({ legacy: { subject: "ci" } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('subject "ci"');
    expect(String(warn.mock.calls[0][0])).not.toContain("legacy");
    warn.mockRestore();
  });
});

describe("run receipt in the response (#244)", () => {
  const options = (dispatch: DispatchFn) => ({
    auth: authConfig({ tok: { subject: "cron", channel: "cron" } }),
    dispatch,
  });
  const request = { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "friction propose" }) };

  it("carries `run: {id, status}` when the core finished a run for the request — never the view token", async () => {
    const dispatch: DispatchFn = async (_deps, _msg, io) => {
      io.runFinished?.({ id: "run-1", status: "completed" });
      await io.reply("🔍 8 runs analyzed");
    };
    const res = await handleIngressRequest(request, deps, options(dispatch));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: "🔍 8 runs analyzed", run: { id: "run-1", status: "completed" } });
    expect(JSON.stringify(res.body)).not.toContain("token");
  });

  it("reports a failed / stopped run's status truthfully", async () => {
    const dispatch: DispatchFn = async (_deps, _msg, io) => {
      io.runFinished?.({ id: "run-2", status: "failed" });
      await io.reply("🚫 restricted");
    };
    expect((await handleIngressRequest(request, deps, options(dispatch))).body).toEqual({
      reply: "🚫 restricted",
      run: { id: "run-2", status: "failed" },
    });
  });

  it("omits `run` entirely when the request produced no run (a config reply)", async () => {
    const { fn } = fakeDispatch("Usage: …");
    const res = await handleIngressRequest(request, deps, options(fn));
    expect(res.body).toEqual({ reply: "Usage: …" });
    expect("run" in (res.body as object)).toBe(false);
  });

  it("HttpIO.run() is undefined until runFinished is called, then the receipt", () => {
    const io = new HttpIO();
    expect(io.run()).toBeUndefined();
    io.runFinished({ id: "r", status: "stopped_soft" });
    expect(io.run()).toEqual({ id: "r", status: "stopped_soft" });
  });
});

describe('async mode (`"async": true` → 202 Accepted, run continues in background)', () => {
  const good = authConfig({ tok: { subject: "alice" } });

  /** A dispatch double modelling the real one: "in flight" from its first line
   *  (the drain counter), runStarted fired once the run exists, resolution
   *  controlled by the test. */
  function slowRunDispatch(runId = "run-42") {
    let inFlight = 0;
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const fn: DispatchFn = async (_deps, _msg, io) => {
      inFlight++; // first line, like the real dispatch() (drain counts this)
      try {
        io.runStarted?.({ id: runId });
        await gate;
        await io.reply("background answer");
        io.runFinished?.({ id: runId, status: "completed" });
      } finally {
        inFlight--;
      }
    };
    return { fn, finish, inFlight: () => inFlight };
  }

  it("answers 202 with runId, runUrl (PUBLIC_BASE_URL) and threadKey before the run finishes", async () => {
    const d = slowRunDispatch("run-7");
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "go", channel: "ops", async: true }) },
      deps,
      { auth: good, dispatch: d.fn, publicBaseUrl: "https://sb.example.com/" },
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      runId: "run-7",
      runUrl: "https://sb.example.com/runs/run-7",
      threadKey: "http:ops:default",
    });
    expect(d.inFlight()).toBe(1); // still running when the 202 went out
    d.finish();
  });

  it("runUrl degrades to a path when no publicBaseUrl is configured", async () => {
    const d = slowRunDispatch("run-8");
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "go", async: true }) },
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect((res.body as { runUrl: string }).runUrl).toBe("/runs/run-8");
    d.finish();
  });

  it("the sync path is unchanged: same body without `async` → 200 with the reply", async () => {
    const d = slowRunDispatch("run-9");
    const pending = handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "go" }) },
      deps,
      { auth: good, dispatch: d.fn },
    );
    d.finish(); // sync mode awaits the whole run
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: "background answer", run: { id: "run-9", status: "completed" } });
  });

  it("`async: false` behaves exactly like omitting it", async () => {
    const d = fakeDispatch("sync answer");
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "go", async: false }) },
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: "sync answer" });
  });

  it("a non-boolean `async` → 400, dispatch never called", async () => {
    const d = fakeDispatch();
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "go", async: "yes" }) },
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(res.status).toBe(400);
    expect(d.calls).toHaveLength(0);
  });

  it("authorization applies unchanged on the async path: unknown token → 401, dispatch never called", async () => {
    const d = fakeDispatch();
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("wrong"), body: JSON.stringify({ text: "go", async: true }) },
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(res.status).toBe(401);
    expect(d.calls).toHaveLength(0);
  });

  it("a dispatch-less token is refused on the async path too (403, fail-closed)", async () => {
    const d = fakeDispatch();
    const auth = authConfig({ tok: { subject: "reader", actions: ["runs:read"] } });
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "go", async: true }) },
      deps,
      { auth, dispatch: d.fn },
    );
    expect(res.status).toBe(403);
    expect(d.calls).toHaveLength(0);
  });

  it("the token's channel pin applies on the async path (threadKey reflects the pinned channel)", async () => {
    const d = slowRunDispatch("run-10");
    const pinned = authConfig({ tok: { subject: "alice", channel: "locked" } });
    const res = await handleIngressRequest(
      {
        method: "POST",
        headers: bearer("tok"),
        body: JSON.stringify({ text: "go", channel: "attacker", async: true }),
      },
      deps,
      { auth: pinned, dispatch: d.fn },
    );
    expect((res.body as { threadKey: string }).threadKey).toBe("http:locked:default");
    d.finish();
  });

  it("drain semantics: the run counts in flight after the 202 and completes in the background with its receipt", async () => {
    const d = slowRunDispatch("run-11");
    const io: HttpIO[] = [];
    const capture: DispatchFn = async (dd, m, i) => {
      io.push(i as HttpIO);
      await d.fn(dd, m, i);
    };
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "go", async: true }) },
      deps,
      { auth: good, dispatch: capture },
    );
    expect(res.status).toBe(202);
    expect(d.inFlight()).toBe(1); // a drain polling the counter would wait
    d.finish();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(d.inFlight()).toBe(0); // ...and see it complete
    expect(io[0].run()).toEqual({ id: "run-11", status: "completed" }); // record receipt landed
  });

  it("an async request the core answers WITHOUT a run (no runStarted) falls back to the sync 200 shape", async () => {
    const d = fakeDispatch("config reply"); // never calls runStarted
    const res = await handleIngressRequest(
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ text: "config show", async: true }) },
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: "config reply" });
  });
});
