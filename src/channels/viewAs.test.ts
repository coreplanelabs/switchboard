import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Actor } from "../core/authz/types.js";
import { ALL_GRANTS, grantsFor } from "../core/authz/grants.js";
import { accessActor } from "./commandHttp.js";
import type { RunView } from "../core/runsService.js";
import {
  VIEW_AS_COOKIE,
  createViewAsHandler,
  isViewAsPath,
  refuseWhileViewing,
  requestersOf,
  viewAsFromCookie,
} from "./viewAs.js";

// Feature: docs/decisions/0053 — the cookie that carries an admin's choice, the two routes
// that set and clear it, and the refusal every write route outside the registry door answers.

const ADMIN: Actor = accessActor({ sub: "admin" }, (id) =>
  grantsFor(id, { grants: new Map([["access:admin", ALL_GRANTS]]) }),
);
const READER: Actor = accessActor({ sub: "alice" }, (id) => grantsFor(id, { commandGroups: ["runs"] }));

function request(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, "utf8")]) as Readable & {
    url: string;
    method: string;
    headers: Record<string, string>;
    destroyed: boolean;
  };
  req.url = url;
  req.method = method;
  req.headers = { host: "bot.example.test", ...headers };
  let status = 0;
  let out: Record<string, string> = {};
  let text = "";
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      out = h ?? {};
    },
    end: (b?: string) => {
      text = b ?? "";
    },
  };
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    status: () => status,
    headers: () => out,
    text: () => text,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("viewAsFromCookie", () => {
  it("reads the one cookie by name among others, decoded; none, empty, or malformed → undefined", () => {
    expect(viewAsFromCookie(`theme=dark; ${VIEW_AS_COOKIE}=slack%3AUIVY; other=1`)).toBe("slack:UIVY");
    expect(viewAsFromCookie(`${VIEW_AS_COOKIE}=slack:UIVY`)).toBe("slack:UIVY");
    expect(viewAsFromCookie([`a=b`, `${VIEW_AS_COOKIE}=slack:UIVY`])).toBe("slack:UIVY");
    expect(viewAsFromCookie(undefined)).toBeUndefined();
    expect(viewAsFromCookie("theme=dark")).toBeUndefined();
    expect(viewAsFromCookie(`${VIEW_AS_COOKIE}=`)).toBeUndefined();
    expect(viewAsFromCookie(`${VIEW_AS_COOKIE}=%E0%A4%A`)).toBeUndefined(); // a bad escape is no value
    expect(viewAsFromCookie(`${VIEW_AS_COOKIE}=%E0%A4%A; ${VIEW_AS_COOKIE}=slack:UIVY`)).toBe("slack:UIVY"); // a later part still counts
    expect(viewAsFromCookie(`x${VIEW_AS_COOKIE}=slack:UIVY`)).toBeUndefined(); // the name, not a suffix
  });
});

describe("requestersOf", () => {
  it("the page's Slack requesters once each with their names, sorted by name; sessions, credentials and rows without a requester are not people to view as", () => {
    const row = (id: string, over: Partial<RunView>): RunView => ({
      id,
      startedAt: 0,
      finished: true,
      eventCount: 0,
      ...over,
    });
    const rows = [
      row("1", { userId: "slack:UBOB", userName: "bob" }),
      row("2", { userId: "slack:UIVY", userName: "ivy" }),
      row("3", { userId: "slack:UBOB", userName: "bob", finished: false }),
      row("4", { userId: "access:a1" }),
      row("5", { userId: "http:ops" }),
      row("6", {}),
      row("7", { userId: "slack:UANON" }),
    ];
    expect(requestersOf(rows)).toEqual([
      { id: "slack:UBOB", name: "bob" },
      { id: "slack:UIVY", name: "ivy" },
      { id: "slack:UANON" },
    ]);
    expect(requestersOf([])).toEqual([]);
  });
});

describe("the view-as routes", () => {
  const handler = createViewAsHandler({ publicBaseUrl: "https://bot.example.test", secure: true });
  const post = (url: string, body?: string, actor: Actor = ADMIN, headers: Record<string, string> = {}) => {
    const t = request("POST", url, body, {
      "content-type": "application/json",
      origin: "https://bot.example.test",
      ...headers,
    });
    const handled = handler(t.req, t.res, { actor });
    return { ...t, handled };
  };

  it("claims exactly its two paths", () => {
    expect(isViewAsPath("/runs/view-as")).toBe(true);
    expect(isViewAsPath("/runs/view-as/exit")).toBe(true);
    for (const p of ["/runs", "/runs/view-as/", "/runs/view-as/x", "/view-as", "/runs/scheduled"])
      expect(isViewAsPath(p), p).toBe(false);
    const other = request("POST", "/runs/abc/stop");
    expect(handler(other.req, other.res, { actor: ADMIN })).toBe(false);
  });

  it("POST /runs/view-as { person } for a session holding `all` → 204 with the HttpOnly, SameSite=Strict, Secure, path-wide cookie naming the person", async () => {
    const t = post("/runs/view-as", JSON.stringify({ person: "slack:UIVY" }));
    expect(t.handled).toBe(true);
    await settle();
    expect(t.status()).toBe(204);
    expect(t.headers()["set-cookie"]).toBe(`${VIEW_AS_COOKIE}=slack%3AUIVY; Path=/; HttpOnly; SameSite=Strict; Secure`);
    expect(t.headers()["cache-control"]).toBe("no-store");
    expect(t.text()).toBe("");
    // The value round-trips through the parser the gate uses.
    expect(viewAsFromCookie(t.headers()["set-cookie"].split(";")[0])).toBe("slack:UIVY");
  });

  it("POST /runs/view-as/exit → 204 with the cookie cleared (Max-Age=0), no body read", async () => {
    const t = post("/runs/view-as/exit");
    await settle();
    expect(t.status()).toBe(204);
    expect(t.headers()["set-cookie"]).toBe(`${VIEW_AS_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`);
  });

  it("an http deployment sets no Secure attribute (the browser would drop it)", async () => {
    const local = createViewAsHandler({ secure: false });
    const t = request("POST", "/runs/view-as", JSON.stringify({ person: "slack:UIVY" }), {
      "content-type": "application/json",
    });
    local(t.req, t.res, { actor: ADMIN });
    await settle();
    expect(t.status()).toBe(204);
    expect(t.headers()["set-cookie"]).toBe(`${VIEW_AS_COOKIE}=slack%3AUIVY; Path=/; HttpOnly; SameSite=Strict`);
  });

  it("a session without `all` is refused both routes with 403 unauthorized before any body is read; a viewing admin still holds its own `all` and may switch or exit", async () => {
    for (const url of ["/runs/view-as", "/runs/view-as/exit"]) {
      const t = post(url, JSON.stringify({ person: "slack:UIVY" }), READER);
      await settle();
      expect(t.status(), url).toBe(403);
      expect(JSON.parse(t.text())).toMatchObject({ error: "unauthorized" });
      expect(t.headers()).not.toHaveProperty("set-cookie");
    }
    const viewing: Actor = { ...ADMIN, onBehalfOf: READER, viewingAs: { id: "slack:UALICE" } };
    const t = post("/runs/view-as", JSON.stringify({ person: "slack:UBOB" }), viewing);
    await settle();
    expect(t.status()).toBe(204);
  });

  it("a body that names no Slack person → 400 invalid_input, no cookie: a session id, a channel, a credential, a non-string, no body, junk, a huge body", async () => {
    for (const body of [
      JSON.stringify({ person: "access:a1" }),
      JSON.stringify({ person: "slack:C123" }),
      JSON.stringify({ person: "http:ops" }),
      JSON.stringify({ person: 7 }),
      JSON.stringify({}),
      "",
      "not json",
    ]) {
      const t = post("/runs/view-as", body);
      await settle();
      expect(t.status(), body).toBe(400);
      expect(JSON.parse(t.text())).toMatchObject({ error: "invalid_input" });
      expect(t.headers()).not.toHaveProperty("set-cookie");
    }
    const huge = post("/runs/view-as", JSON.stringify({ person: "slack:U" + "A".repeat(2000) }));
    await settle();
    expect(huge.status()).toBe(413);
    expect(huge.headers()).not.toHaveProperty("set-cookie");
  });

  it("a foreign origin → 403 and no cookie; GET → 405 allow: POST", async () => {
    const foreign = post("/runs/view-as", JSON.stringify({ person: "slack:UIVY" }), ADMIN, {
      origin: "https://evil.example",
    });
    await settle();
    expect(foreign.status()).toBe(403);
    expect(JSON.parse(foreign.text())).toEqual({ error: "forbidden_origin" });
    expect(foreign.headers()).not.toHaveProperty("set-cookie");
    const get = request("GET", "/runs/view-as");
    expect(handler(get.req, get.res, { actor: ADMIN })).toBe(true);
    expect(get.status()).toBe(405);
    expect(get.headers().allow).toBe("POST");
  });
});

describe("refuseWhileViewing", () => {
  it("answers the 403 the /api door gives, in the one sentence, naming the person by name or id", () => {
    const named = request("POST", "/x");
    expect(refuseWhileViewing(named.res, { id: "slack:UIVY", name: "ivy" })).toBe(true);
    expect(named.status()).toBe(403);
    expect(named.headers()["content-type"]).toContain("application/json");
    expect(JSON.parse(named.text())).toEqual({
      error: "unauthorized",
      message: "You are viewing as ivy; writes are your own to make — exit view-as to write.",
    });
    const unnamed = request("POST", "/x");
    refuseWhileViewing(unnamed.res, { id: "slack:UIVY" });
    expect(JSON.parse(unnamed.text()).message).toContain("viewing as slack:UIVY;");
  });
});
