import { describe, expect, it } from "vitest";
import {
  NullResidentAdminClient,
  type ResidentAdminClient,
  type ResidentAdminResponse,
} from "../core/residentAdmin.js";
import {
  createResidentsViewHandler,
  parseResidentsRoute,
  residentsFleetTone,
  residentStateTone,
  type ResidentListing,
} from "./residentsView.js";
import { makeShellRenderer } from "./webShell.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { SEED_ELEMENT_ID, type ResidentDetailSeed, type ResidentsIndexSeed } from "./webSeed.js";

// The residents dash handler: routing, the live-per-request registry read, the
// error statuses, and the seeds the shell carries. Rendering is tested in
// web/src/pages/residents.test.ts.

// ---- fixtures ---------------------------------------------------------------

const WARM = {
  resource: "repo:jshttp/vary",
  commands: { install: "npm install --no-audit --no-fund", build: "npm run build --if-present", test: "npm test" },
  effects: { test: "readonly" },
  defaultRef: "master",
  provisioningTimeoutMs: 900000,
  worktreeTtlDays: 7,
  onboardedAt: "2026-08-26T01:02:03.000Z",
  updatedAt: "2026-08-26T01:02:03.000Z",
  live: {
    resource: "repo:jshttp/vary",
    state: "warm",
    reason: "",
    sha: "0123456789abcdef0123456789abcdef01234567",
    snapshot: { ref: "master", mirrorBackupId: "bk_mirror_1" },
  },
};

const DOWN = {
  resource: "repo:coreplanelabs/switchboard",
  commands: { test: "npm test" },
  defaultRef: "main",
  live: { state: "down", reason: "provision-failed at clone: fatal: could not read Username" },
};

const LISTING: ResidentListing = { cap: 5, count: 2, residents: [WARM, DOWN] };

const shell = makeShellRenderer({ js: "/assets/main-test.js", css: [] }, ALL_CAPABILITIES);

function seedOf(html: string): ResidentsIndexSeed | ResidentDetailSeed {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the page");
  return JSON.parse(m[1]) as ResidentsIndexSeed | ResidentDetailSeed;
}

function ok(data: Record<string, unknown>): ResidentAdminResponse {
  return { status: 200, data };
}

function fakeClient(residents: () => Promise<ResidentAdminResponse>): ResidentAdminClient {
  const never = () => Promise.reject(new Error("not used by the residents view"));
  return { residents, onboard: never, offboard: never, reconfigure: never, rebuild: never, status: never };
}

function fakeReqRes(method: string, url: string) {
  let status = 0;
  let outHeaders: Record<string, string> = {};
  const chunks: string[] = [];
  const req = { method, url, headers: {}, on: () => undefined };
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      outHeaders = h ?? {};
    },
    write: (c: string) => void chunks.push(c),
    end: (c?: string) => {
      if (c) chunks.push(c);
    },
  };
  return {
    req: req as unknown as Parameters<ReturnType<typeof createResidentsViewHandler>>[0],
    res: res as unknown as Parameters<ReturnType<typeof createResidentsViewHandler>>[1],
    get status() {
      return status;
    },
    get headers() {
      return outHeaders;
    },
    body: () => chunks.join(""),
  };
}

// ---- routing ----------------------------------------------------------------

describe("parseResidentsRoute", () => {
  it("matches the bare index with or without a trailing slash", () => {
    expect(parseResidentsRoute("/residents")).toEqual({ kind: "index" });
    expect(parseResidentsRoute("/residents/")).toEqual({ kind: "index" });
  });

  it("matches a per-repo detail page by owner/name slug (lowercased)", () => {
    expect(parseResidentsRoute("/residents/jshttp/vary")).toEqual({ kind: "detail", slug: "jshttp/vary" });
    expect(parseResidentsRoute("/residents/CorePlaneLabs/Switchboard/")).toEqual({
      kind: "detail",
      slug: "coreplanelabs/switchboard",
    });
  });

  it("returns null for anything that is not a valid repo slug under /residents", () => {
    expect(parseResidentsRoute("/residents/onlyowner")).toBeNull();
    expect(parseResidentsRoute("/residents/a/b/c")).toBeNull();
    expect(parseResidentsRoute("/residents/../etc")).toBeNull();
    expect(parseResidentsRoute("/residents/%2e%2e/x")).toBeNull();
    expect(parseResidentsRoute("/residentsx")).toBeNull();
    expect(parseResidentsRoute("/runs")).toBeNull();
  });
});

// ---- state tone -------------------------------------------------------------

describe("residentStateTone", () => {
  it("maps every lifecycle state to a dot color, unknown states to grey", () => {
    expect(residentStateTone("warm")).toBe("green");
    expect(residentStateTone("onboarding")).toBe("amber");
    expect(residentStateTone("refreshing")).toBe("amber");
    expect(residentStateTone("restoring")).toBe("amber");
    expect(residentStateTone("degraded")).toBe("red");
    expect(residentStateTone("down")).toBe("red");
    expect(residentStateTone("whatever")).toBe("grey");
  });
});

describe("residentsFleetTone", () => {
  const at = (state: string) => ({ resource: `repo:o/${state}`, live: { state } });
  it("is the worst resident's tone: red beats amber beats everything else", () => {
    expect(residentsFleetTone([at("warm"), at("refreshing"), at("down")])).toBe("red");
    expect(residentsFleetTone([at("degraded"), at("whatever")])).toBe("red");
    expect(residentsFleetTone([at("warm"), at("onboarding"), at("warm")])).toBe("amber");
    expect(residentsFleetTone([at("restoring"), at("whatever")])).toBe("amber");
  });
  it("is green only when every resident is warm", () => {
    expect(residentsFleetTone([at("warm"), at("warm"), at("warm")])).toBe("green");
    expect(residentsFleetTone([at("warm")])).toBe("green");
  });
  it("is grey with no residents, and when a resident is unknown or unreachable with nothing worse to show", () => {
    expect(residentsFleetTone([])).toBe("grey");
    expect(residentsFleetTone([at("warm"), at("whatever")])).toBe("grey");
    expect(residentsFleetTone([at("warm"), { resource: "repo:o/x", live: { error: "DO unreachable" } }])).toBe("grey");
    expect(residentsFleetTone([at("warm"), "not a record" as never])).toBe("grey");
  });
});

// ---- handler ----------------------------------------------------------------

describe("createResidentsViewHandler", () => {
  it("ignores non-/residents paths (returns false, writes nothing)", () => {
    const h = createResidentsViewHandler(
      fakeClient(() => Promise.resolve(ok(LISTING as never))),
      shell,
    );
    const io = fakeReqRes("GET", "/runs");
    expect(h(io.req, io.res)).toBe(false);
    expect(io.status).toBe(0);
  });

  it("serves the index shell from a LIVE registry read on every request (never cached), the listing passed through as the seed", async () => {
    let calls = 0;
    const h = createResidentsViewHandler(
      fakeClient(() => {
        calls++;
        return Promise.resolve(ok(LISTING as never));
      }),
      shell,
    );
    for (let i = 0; i < 2; i++) {
      const io = fakeReqRes("GET", "/residents");
      const claimed = h(io.req, io.res);
      expect(claimed).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(io.status).toBe(200);
      expect(io.headers["content-type"]).toContain("text/html");
      expect(io.headers["cache-control"]).toBe("no-store");
      expect(io.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(io.headers["x-frame-options"]).toBe("DENY");
      const seed = seedOf(io.body()) as ResidentsIndexSeed;
      expect(seed.page).toBe("residents");
      expect(seed.cap).toBe(5);
      expect(seed.count).toBe(2);
      expect(seed.residents).toEqual([WARM, DOWN]);
    }
    expect(calls).toBe(2);
  });

  it("a hostile record is inert in the page (the seed island escapes every angle bracket) and survives as data", async () => {
    const hostile = { ...DOWN, live: { ...DOWN.live, reason: '"><script>alert(1)</script>' } };
    const h = createResidentsViewHandler(
      fakeClient(() => Promise.resolve(ok({ cap: 5, count: 1, residents: [hostile] }))),
      shell,
    );
    const io = fakeReqRes("GET", "/residents");
    h(io.req, io.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(io.body()).not.toContain("<script>alert(1)</script>");
    expect(io.body().match(/<\/script>/g)).toHaveLength(2); // the shell's own two script elements only
    const seed = seedOf(io.body()) as ResidentsIndexSeed;
    expect((seed.residents[0] as typeof hostile).live.reason).toBe('"><script>alert(1)</script>');
  });

  it("serves a detail page for an onboarded slug (the record as the seed) and 404s an unknown one", async () => {
    const h = createResidentsViewHandler(
      fakeClient(() => Promise.resolve(ok(LISTING as never))),
      shell,
    );
    const hit = fakeReqRes("GET", "/residents/jshttp/vary");
    h(hit.req, hit.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(hit.status).toBe(200);
    const seed = seedOf(hit.body()) as ResidentDetailSeed;
    expect(seed.page).toBe("resident");
    expect(seed.slug).toBe("jshttp/vary");
    expect(seed.record).toEqual(WARM);

    const miss = fakeReqRes("GET", "/residents/nobody/here");
    h(miss.req, miss.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(miss.status).toBe(404);
    expect(miss.body()).toContain("not onboarded");
  });

  it("405s non-GET methods", () => {
    const h = createResidentsViewHandler(
      fakeClient(() => Promise.resolve(ok(LISTING as never))),
      shell,
    );
    const io = fakeReqRes("POST", "/residents");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(405);
    expect(io.headers.allow).toBe("GET");
  });

  it("503s with a plain explanation when the process has no residents (the null admin client carries the reason)", async () => {
    const h = createResidentsViewHandler(new NullResidentAdminClient(), shell);
    const io = fakeReqRes("GET", "/residents");
    expect(h(io.req, io.res)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(io.status).toBe(503);
    expect(io.body()).toContain("execution.resident");
    expect(io.body()).not.toContain("resident Worker answered");
  });

  it("502s (never a 500 with a stack) when the resident Worker answers non-200 or the request throws", async () => {
    const bad = createResidentsViewHandler(
      fakeClient(() => Promise.resolve({ status: 401, data: { error: "unauthorized" } })),
      shell,
    );
    const a = fakeReqRes("GET", "/residents");
    bad(a.req, a.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(a.status).toBe(502);
    expect(a.body()).toContain("401");
    expect(a.body()).toContain("unauthorized");

    const huge = createResidentsViewHandler(
      fakeClient(() => Promise.resolve({ status: 500, data: { blob: "x".repeat(10_000) } })),
      shell,
    );
    const c = fakeReqRes("GET", "/residents");
    huge(c.req, c.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.status).toBe(502);
    expect(c.body().length).toBeLessThan(700);

    const hugeErr = createResidentsViewHandler(
      fakeClient(() => Promise.reject(new Error("x".repeat(10_000)))),
      shell,
    );
    const e = fakeReqRes("GET", "/residents");
    hugeErr(e.req, e.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(e.status).toBe(502);
    expect(e.body().length).toBeLessThan(700);

    const throwing = createResidentsViewHandler(
      fakeClient(() => Promise.reject(new Error("resident admin /residents request failed (ECONNREFUSED)"))),
      shell,
    );
    const b = fakeReqRes("GET", "/residents/jshttp/vary");
    throwing(b.req, b.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.status).toBe(502);
    expect(b.body()).toContain("ECONNREFUSED");
  });
});
