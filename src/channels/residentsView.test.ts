import { describe, expect, it } from "vitest";
import type { ResidentAdminClient, ResidentAdminResponse } from "../core/repoCommands.js";
import {
  createResidentsViewHandler,
  parseResidentsRoute,
  renderResidentPage,
  renderResidentsIndex,
  residentStateTone,
  type ResidentListing,
} from "./residentsView.js";

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
    updatedAt: "2026-08-28T20:00:00.000Z",
    defaultRef: "master",
    sha: "0123456789abcdef0123456789abcdef01234567",
    lockfileHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    provisionedAt: "2026-08-26T01:05:00.000Z",
    lastRefreshAt: "2026-08-28T19:30:00.000Z",
    lastRefreshError: null,
    lastRestore: null,
    snapshot: {
      ref: "master",
      sha: "0123456789abcdef0123456789abcdef01234567",
      lockfileHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      createdAt: "2026-08-28T19:31:00.000Z",
      mirrorBackupId: "bk_mirror_1",
      checkoutBackupId: "bk_checkout_1",
    },
    schedules: { refresh: 1, provisionRun: 0, provisionDeadline: 0 },
    threads: [
      {
        threadKey: "slack:C0BQS7KPJHK:1787954209.398379",
        ref: "feat/residents-dash",
        sha: "abcdef1234567890abcdef1234567890abcdef12",
        user: "worker3",
        deps: "hardlink",
        boundAt: "2026-08-28T21:40:00.000Z",
        lastAttachAt: "2026-08-28T21:45:00.000Z",
        evicted: false,
      },
      {
        threadKey: "slack:C0BQS7KPJHK:1787900000.000001",
        ref: "master",
        user: "",
        deps: "install",
        boundAt: "2026-08-20T10:00:00.000Z",
        lastAttachAt: "2026-08-20T10:05:00.000Z",
        evicted: true,
        evictedAt: "2026-08-27T10:00:00.000Z",
        evictedWhy: "merged #12 <b>",
      },
    ],
  },
};

const DOWN = {
  resource: "repo:coreplanelabs/switchboard",
  commands: { test: "npm test", build: "npm run build --if-present" },
  defaultRef: "main",
  provisioningTimeoutMs: 900000,
  onboardedAt: "2026-08-28T21:00:00.000Z",
  updatedAt: "2026-08-28T21:00:00.000Z",
  live: {
    state: "down",
    reason: "provision-failed at clone: fatal: could not read Username",
    sha: null,
    lastRefreshError: "clone failed",
    snapshot: null,
    schedules: { refresh: 0, provisionRun: 0, provisionDeadline: 0 },
  },
};

const LISTING: ResidentListing = { cap: 5, count: 2, residents: [WARM, DOWN] };

function ok(data: Record<string, unknown>): ResidentAdminResponse {
  return { status: 200, data };
}

function fakeClient(residents: () => Promise<ResidentAdminResponse>): ResidentAdminClient {
  const never = () => Promise.reject(new Error("not used by the residents view"));
  return { residents, onboard: never, offboard: never, reconfigure: never, rebuild: never };
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

// ---- index page -------------------------------------------------------------

describe("renderResidentsIndex", () => {
  it("renders one full-row link per resident to its detail page, with state, reason, ref and short sha", () => {
    const html = renderResidentsIndex(LISTING);
    expect(html).toContain('href="/residents/jshttp/vary"');
    expect(html).toContain('href="/residents/coreplanelabs/switchboard"');
    expect(html).toContain("2/5");
    expect(html).toContain("warm");
    expect(html).toContain("01234567"); // short sha
    expect(html).toContain("master");
    expect(html).toContain("provision-failed at clone");
    expect(html).toContain('class="dot green"');
    expect(html).toContain('class="dot red"');
  });

  it("shows an empty state naming the onboard command when nothing is onboarded", () => {
    const html = renderResidentsIndex({ cap: 5, count: 0, residents: [] });
    expect(html).toContain("No repos onboarded");
    expect(html).toContain("repo onboard");
    expect(html).not.toContain("<a class=\"row\"");
  });

  it("HTML-escapes every dynamic string (slug, reason) so a hostile record cannot inject markup", () => {
    const hostile = {
      ...DOWN,
      resource: 'repo:evil/<img src=x onerror=alert(1)>',
      live: { ...DOWN.live, reason: '"><script>alert(1)</script>' },
    };
    const html = renderResidentsIndex({ cap: 5, count: 1, residents: [hostile] });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;img src=x");
    // a non-slug resource never becomes a detail link (it would 404 anyway)
    expect(html).not.toContain('href="/residents/evil/');
  });

  it("links across to the runs dash and carries the same strict CSP-safe self-contained shape", () => {
    const html = renderResidentsIndex(LISTING);
    expect(html).toContain('href="/runs"');
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/);
  });
});

// ---- detail page ------------------------------------------------------------

describe("renderResidentPage", () => {
  it("shows the interesting facts: state, ref, sha, lockfile hash, provisioned/refreshed, snapshot stamp, schedules, command table", () => {
    const html = renderResidentPage(WARM);
    expect(html).toContain("jshttp/vary");
    expect(html).toContain("warm");
    expect(html).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(html).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(html).toContain("2026-08-26T01:05:00.000Z");
    expect(html).toContain("2026-08-28T19:30:00.000Z");
    expect(html).toContain("bk_mirror_1");
    expect(html).toContain("bk_checkout_1");
    expect(html).toContain("npm install --no-audit --no-fund");
    expect(html).toContain("readonly");
    expect(html).toContain("7"); // worktreeTtlDays
  });

  it("shows idle mode when the resident parked its refresh, 'awake' otherwise", () => {
    expect(renderResidentPage(WARM)).toContain("awake");
    const idle = { ...WARM, live: { ...WARM.live, idleSince: "2026-08-29T03:00:00.000Z" } };
    expect(renderResidentPage(idle)).toContain("2026-08-29T03:00:00.000Z");
    expect(renderResidentPage(idle)).toContain("container may sleep");
  });

  it("links to the GitHub repo, the pinned commit, and back to the residents index", () => {
    const html = renderResidentPage(WARM);
    expect(html).toContain('href="https://github.com/jshttp/vary"');
    expect(html).toContain('href="https://github.com/jshttp/vary/commit/0123456789abcdef0123456789abcdef01234567"');
    expect(html).toContain('href="/residents"');
  });

  it("names the failure reason and last refresh error for a down resident and omits a commit link without a sha", () => {
    const html = renderResidentPage(DOWN);
    expect(html).toContain("provision-failed at clone: fatal: could not read Username");
    expect(html).toContain("clone failed");
    expect(html).toContain('class="dot red"');
    expect(html).not.toContain("/commit/");
    expect(html).toContain("no snapshot");
  });

  it("HTML-escapes hostile field values", () => {
    const hostile = { ...WARM, commands: { test: "</script><script>alert(1)</script>" } };
    const html = renderResidentPage(hostile);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("lists thread worktrees (ref, sha linked to its commit, deps mechanism, attach times), newest first, marking evicted ones", () => {
    const html = renderResidentPage(WARM);
    const a = html.indexOf("feat/residents-dash");
    const b = html.indexOf("slack:C0BQS7KPJHK:1787900000.000001");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a); // newest lastAttachAt first
    expect(html).toContain('href="https://github.com/jshttp/vary/commit/abcdef1234567890abcdef1234567890abcdef12"');
    expect(html).toContain("hardlink");
    expect(html).toContain("worker3");
    expect(html).toContain("2026-08-28T21:45:00.000Z");
    // The eviction reason (#50 reclamation audit trail) rides along, escaped.
    expect(html).toContain("evicted 2026-08-27T10:00:00.000Z · merged #12 &lt;b&gt;");
    expect(html).toContain("1 live · 1 evicted");
  });

  it("says so when a resident has no thread worktrees, and escapes hostile thread fields", () => {
    expect(renderResidentPage(DOWN)).toContain("no thread worktrees");
    const hostile = { ...WARM, live: { ...WARM.live, threads: [{ threadKey: "<b>x</b>", ref: "<i>r</i>", sha: "zz", lastAttachAt: "t" }] } };
    const html = renderResidentPage(hostile);
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("/commit/zz"); // non-hex sha never becomes a link
  });

  it("shows the resident's live-view error when the registry record has no reachable engine", () => {
    const html = renderResidentPage({ ...DOWN, live: { error: "DO unreachable" } });
    expect(html).toContain("DO unreachable");
    expect(html).toContain('class="dot grey"');
  });
});

// ---- handler ----------------------------------------------------------------

describe("createResidentsViewHandler", () => {
  it("ignores non-/residents paths (returns false, writes nothing)", () => {
    const h = createResidentsViewHandler(fakeClient(() => Promise.resolve(ok(LISTING as never))));
    const io = fakeReqRes("GET", "/runs");
    expect(h(io.req, io.res)).toBe(false);
    expect(io.status).toBe(0);
  });

  it("serves the index from a LIVE registry read on every request (never cached)", async () => {
    let calls = 0;
    const h = createResidentsViewHandler(
      fakeClient(() => {
        calls++;
        return Promise.resolve(ok(LISTING as never));
      }),
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
      expect(io.body()).toContain("/residents/jshttp/vary");
    }
    expect(calls).toBe(2);
  });

  it("serves a detail page for an onboarded slug and 404s an unknown one (registry still read live)", async () => {
    const h = createResidentsViewHandler(fakeClient(() => Promise.resolve(ok(LISTING as never))));
    const hit = fakeReqRes("GET", "/residents/jshttp/vary");
    h(hit.req, hit.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(hit.status).toBe(200);
    expect(hit.body()).toContain("bk_mirror_1");

    const miss = fakeReqRes("GET", "/residents/nobody/here");
    h(miss.req, miss.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(miss.status).toBe(404);
    expect(miss.body()).toContain("not onboarded");
  });

  it("405s non-GET methods", () => {
    const h = createResidentsViewHandler(fakeClient(() => Promise.resolve(ok(LISTING as never))));
    const io = fakeReqRes("POST", "/residents");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(405);
    expect(io.headers.allow).toBe("GET");
  });

  it("503s with a plain explanation when no resident admin client is configured", () => {
    const h = createResidentsViewHandler(undefined);
    const io = fakeReqRes("GET", "/residents");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(503);
    expect(io.body()).toContain("execution.resident");
  });

  it("502s (never a 500 with a stack) when the resident Worker answers non-200 or the request throws", async () => {
    const bad = createResidentsViewHandler(fakeClient(() => Promise.resolve({ status: 401, data: { error: "unauthorized" } })));
    const a = fakeReqRes("GET", "/residents");
    bad(a.req, a.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(a.status).toBe(502);
    expect(a.body()).toContain("401");
    expect(a.body()).toContain("unauthorized");

    const huge = createResidentsViewHandler(fakeClient(() => Promise.resolve({ status: 500, data: { blob: "x".repeat(10_000) } })));
    const c = fakeReqRes("GET", "/residents");
    huge(c.req, c.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.status).toBe(502);
    expect(c.body().length).toBeLessThan(700); // upstream body is capped, never echoed wholesale

    const hugeErr = createResidentsViewHandler(fakeClient(() => Promise.reject(new Error("x".repeat(10_000)))));
    const e = fakeReqRes("GET", "/residents");
    hugeErr(e.req, e.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(e.status).toBe(502);
    expect(e.body().length).toBeLessThan(700); // transport-failure message capped like the non-200 path

    const throwing = createResidentsViewHandler(fakeClient(() => Promise.reject(new Error("resident admin /residents request failed (ECONNREFUSED)"))));
    const b = fakeReqRes("GET", "/residents/jshttp/vary");
    throwing(b.req, b.res);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.status).toBe(502);
    expect(b.body()).toContain("ECONNREFUSED");
  });
});

describe("nav (shared by both pages)", () => {
  it("marks Residents as the current nav section on both the index and a detail page", () => {
    expect(renderResidentsIndex(LISTING)).toContain('<a href="/residents" class="current">Residents</a>');
    expect(renderResidentPage(WARM)).toContain('<a href="/residents" class="current">Residents</a>');
  });
});
