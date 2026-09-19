import { describe, expect, it } from "vitest";
import { ACTORS } from "../core/authz/testing.js";
import type { Predicate } from "../core/authz/types.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import type { PlaneService } from "../core/planeService.js";
import type { PlaneTable } from "../core/plane/table.js";
import type { RunView } from "../core/runsService.js";
import { createPlaneViewHandler, parsePlaneRoute } from "./planeView.js";
import { SEED_ELEMENT_ID, type PlaneSeed } from "./webSeed.js";
import { makePageSender } from "./webShell.js";

// The plane panel handler (docs/reference/specs/orchestration-plane.md item 5): routing, the
// read under the viewer's predicate, the JSON twin, the seed the shell carries
// and the live rows' tokens. Rendering is tested in web/src/pages/plane.test.ts.

const NOW = Date.parse("2026-09-19T03:00:00Z");

function view(over: Partial<RunView> & { id: string }): RunView {
  return { startedAt: NOW - 600_000, finished: false, eventCount: 3, agent: "coding", ...over };
}

const TABLE: PlaneTable = {
  at: NOW,
  runs: [
    {
      run: view({ id: "live-here", eventsLast5m: 2, lastToolCallAt: NOW - 60_000 }),
      owner: { id: "slack:U_A" },
      health: [],
    },
    { run: view({ id: "live-there", ownerGen: "gen-b" }), owner: { generation: "gen-b" }, health: ["no-signal"] },
    { run: view({ id: "done", finished: true, status: "completed", finishedAt: NOW - 1000 }), owner: {}, health: [] },
  ],
  units: [],
  pullRequests: [],
  windows: [],
  findings: [],
};

const sendPage = makePageSender({ js: "/assets/main-test.js", css: [] }, ALL_CAPABILITIES);

function seedOf(html: string): PlaneSeed {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the page");
  return JSON.parse(m[1]) as PlaneSeed;
}

function fakeService(table: PlaneTable = TABLE) {
  const asked: Predicate[] = [];
  const service: PlaneService = {
    table: async (visibleTo) => {
      asked.push(visibleTo);
      return table;
    },
  };
  return { service, asked };
}

function fakeRes() {
  let status = 0;
  let headers: Record<string, string> = {};
  const chunks: string[] = [];
  let done: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    done = resolve;
  });
  const res = {
    writeHead(code: number, h?: Record<string, string>) {
      status = code;
      headers = h ?? {};
      return res;
    },
    end(body?: string) {
      if (body !== undefined) chunks.push(body);
      done();
    },
    setHeader() {},
    getHeader: () => undefined,
  };
  return {
    res: res as unknown as import("node:http").ServerResponse,
    ended,
    status: () => status,
    headers: () => headers,
    body: () => chunks.join(""),
  };
}

const req = (url: string, method = "GET") =>
  ({ url, method, headers: {} }) as unknown as import("node:http").IncomingMessage;

describe("parsePlaneRoute", () => {
  it("knows the page and its twin and nothing else", () => {
    expect(parsePlaneRoute("/plane")).toEqual({ kind: "page" });
    expect(parsePlaneRoute("/plane.json")).toEqual({ kind: "json" });
    expect(parsePlaneRoute("/plane/queue")).toBeNull();
    expect(parsePlaneRoute("/planes")).toBeNull();
  });
});

describe("createPlaneViewHandler", () => {
  it("falls through for other paths and refuses non-GET", async () => {
    const { service } = fakeService();
    const handler = createPlaneViewHandler(service, sendPage);
    expect(handler(req("/runs"), fakeRes().res)).toBe(false);
    const r = fakeRes();
    expect(handler(req("/plane", "POST"), r.res)).toBe(true);
    await r.ended;
    expect(r.status()).toBe(405);
  });

  it("serves the shell with the table as the seed, read under the viewer's predicate, with tokens for this process's live rows only", async () => {
    const { service, asked } = fakeService();
    const tokens = new Map([
      ["live-here", "tok-here"],
      ["done", "tok-done"],
    ]);
    const handler = createPlaneViewHandler(service, sendPage, { liveTokens: () => tokens });
    const r = fakeRes();
    expect(handler(req("/plane"), r.res, { actor: ACTORS.operator })).toBe(true);
    await r.ended;
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("text/html");
    const seed = seedOf(r.body());
    expect(seed.page).toBe("plane");
    expect(seed.table.runs.map((row) => row.run.id)).toEqual(["live-here", "live-there", "done"]);
    expect(seed.tokens).toEqual({ "live-here": "tok-here" });
    expect(asked).toEqual([{ kind: "all" }]);
  });

  it("answers the twin as the same table in JSON", async () => {
    const { service } = fakeService();
    const handler = createPlaneViewHandler(service, sendPage);
    const r = fakeRes();
    expect(handler(req("/plane.json"), r.res, { actor: ACTORS.operator })).toBe(true);
    await r.ended;
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/json");
    expect(JSON.parse(r.body())).toEqual(TABLE);
  });

  it("a viewer the gate resolved to nobody sees nothing", async () => {
    const { service, asked } = fakeService();
    const handler = createPlaneViewHandler(service, sendPage);
    const r = fakeRes();
    handler(req("/plane.json"), r.res, {});
    await r.ended;
    expect(asked).toEqual([{ kind: "none" }]);
  });

  it("a table that cannot be built is a 502 with the reason, never a 500", async () => {
    const service: PlaneService = { table: async () => Promise.reject(new Error("store unreachable")) };
    const handler = createPlaneViewHandler(service, sendPage);
    const r = fakeRes();
    handler(req("/plane"), r.res, { actor: ACTORS.operator });
    await r.ended;
    expect(r.status()).toBe(502);
    expect(r.body()).toBe("plane unavailable: store unreachable");
  });
});
