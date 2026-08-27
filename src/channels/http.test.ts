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
} from "./http.js";
import type { CoreDeps } from "../core/dispatcher.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";

// Feature: features/http-ingress.md — adapter #3 (HTTP). Auth is fail-closed +
// constant-time; a token maps to a namespaced identity that flows into the same
// dispatch() the Slack/CLI adapters use. A fake dispatch keeps these off real
// providers.

const deps = {} as CoreDeps;

/** A dispatch double that records the message and echoes a canned reply. */
function fakeDispatch(reply = "the answer") {
  const calls: { msg: IncomingMessage; io: ChannelIO }[] = [];
  const fn: DispatchFn = async (_deps, msg, io) => {
    calls.push({ msg, io });
    await io.reply(reply);
  };
  return { fn, calls };
}

const authConfig = (tokens: IngressConfig["tokens"]): IngressConfig => ({ tokens });
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
    const res = { writeHead: (c: number) => { statusCode = c; }, end: () => {} };
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
  const opts = (tokens: IngressConfig["tokens"] = { tok: { subject: "alice" } }) => ({ auth: authConfig(tokens) });
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
    expect(authorizeRequest("POST", bearer("tok"), opts())).toEqual({ identity: { subject: "alice", channel: undefined } });
  });
});

describe("parseIngressTokens (env → config, fail-closed)", () => {
  it("parses a valid JSON token map", () => {
    const cfg = parseIngressTokens({
      SWITCHBOARD_INGRESS_TOKENS: JSON.stringify({ s3cr3t: { subject: "alice", channel: "ops" }, t2: { subject: "bob" } }),
    });
    expect(cfg.tokens).toEqual({ s3cr3t: { subject: "alice", channel: "ops" }, t2: { subject: "bob", channel: undefined } });
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
    expect(cfg.tokens).toEqual({ good: { subject: "alice", channel: undefined } });
  });
});
