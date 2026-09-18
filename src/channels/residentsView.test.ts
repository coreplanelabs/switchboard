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
  type ResidentsViewContext,
  type ResidentsViewDeps,
} from "./residentsView.js";
import { makePageSender } from "./webShell.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { recordingSink } from "../core/testing/recordingSink.js";
import {
  SEED_ELEMENT_ID,
  type ResidentDetailSeed,
  type ResidentsFeedFrame,
  type ResidentsIndexSeed,
} from "./webSeed.js";
import { RunRegistry } from "../core/runRegistry.js";
import { accessActor } from "./commandHttp.js";
import { ALL_GRANTS, grantsFor, type GrantsSource } from "../core/authz/grants.js";
import { NO_GRANTS } from "../core/authz/index.js";
import { ATTACH_SPAN } from "./residentsFeed.js";

// The residents dash handler: routing, the live-per-request registry read, the
// error statuses, the seeds the shell carries, the runs the index seeds under
// the viewer's predicate, and the `?stream=1` feed route. Rendering is tested
// in web/src/pages/residents.test.ts; the feed's own rules in residentsFeed.test.ts.

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
  resource: "repo:acme/api",
  commands: { test: "npm test" },
  defaultRef: "main",
  live: { state: "down", reason: "provision-failed at clone: fatal: could not read Username" },
};

const LISTING: ResidentListing = { cap: 5, count: 2, residents: [WARM, DOWN] };

const page = makePageSender({ js: "/assets/main-test.js", css: [] }, ALL_CAPABILITIES);

/** The viewer every call below reads as unless a test says otherwise: a fleet
 *  admin resolved through the real Access resolver (the path index.ts takes). */
const ADMIN: ResidentsViewContext = {
  actor: accessActor({ sub: "admin" }, (id) => grantsFor(id, { grants: new Map([["access:admin", ALL_GRANTS]]) })),
};

/** `createResidentsViewHandler` over an empty registry unless one is given. */
function handler(
  client: ResidentAdminClient,
  trace?: ResidentsViewDeps["trace"],
  runs: ResidentsViewDeps["runs"] = new RunRegistry(),
  now?: () => number,
) {
  return createResidentsViewHandler({ client, page, runs, ...(trace ? { trace } : {}), ...(now ? { now } : {}) });
}

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
    expect(parseResidentsRoute("/residents/Acme/Api/")).toEqual({
      kind: "detail",
      slug: "acme/api",
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
    const h = handler(fakeClient(() => Promise.resolve(ok(LISTING as never))));
    const io = fakeReqRes("GET", "/runs");
    expect(h(io.req, io.res, ADMIN)).toBe(false);
    expect(io.status).toBe(0);
  });

  it("serves the index shell from a LIVE registry read on every request (never cached), the listing passed through as the seed", async () => {
    let calls = 0;
    const h = handler(
      fakeClient(() => {
        calls++;
        return Promise.resolve(ok(LISTING as never));
      }),
    );
    for (let i = 0; i < 2; i++) {
      const io = fakeReqRes("GET", "/residents");
      const claimed = h(io.req, io.res, ADMIN);
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
    const h = handler(fakeClient(() => Promise.resolve(ok({ cap: 5, count: 1, residents: [hostile] }))));
    const io = fakeReqRes("GET", "/residents");
    h(io.req, io.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(io.body()).not.toContain("<script>alert(1)</script>");
    expect(io.body().match(/<\/script>/g)).toHaveLength(2); // the shell's own two script elements only
    const seed = seedOf(io.body()) as ResidentsIndexSeed;
    expect((seed.residents[0] as typeof hostile).live.reason).toBe('"><script>alert(1)</script>');
  });

  it("serves a detail page for an onboarded slug (the record as the seed) and 404s an unknown one", async () => {
    const h = handler(fakeClient(() => Promise.resolve(ok(LISTING as never))));
    const hit = fakeReqRes("GET", "/residents/jshttp/vary");
    h(hit.req, hit.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(hit.status).toBe(200);
    const seed = seedOf(hit.body()) as ResidentDetailSeed;
    expect(seed.page).toBe("resident");
    expect(seed.slug).toBe("jshttp/vary");
    expect(seed.record).toEqual(WARM);

    const miss = fakeReqRes("GET", "/residents/nobody/here");
    h(miss.req, miss.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(miss.status).toBe(404);
    expect(miss.body()).toContain("not onboarded");
  });

  it("405s non-GET methods", () => {
    const h = handler(fakeClient(() => Promise.resolve(ok(LISTING as never))));
    const io = fakeReqRes("POST", "/residents");
    expect(h(io.req, io.res, ADMIN)).toBe(true);
    expect(io.status).toBe(405);
    expect(io.headers.allow).toBe("GET");
  });

  it("503s with a plain explanation when the process has no residents (the null admin client carries the reason)", async () => {
    const h = handler(new NullResidentAdminClient());
    const io = fakeReqRes("GET", "/residents");
    expect(h(io.req, io.res, ADMIN)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(io.status).toBe(503);
    expect(io.body()).toContain("execution.resident");
    expect(io.body()).not.toContain("resident Worker answered");
  });

  it("502s (never a 500 with a stack) when the resident Worker answers non-200 or the request throws", async () => {
    const bad = handler(fakeClient(() => Promise.resolve({ status: 401, data: { error: "unauthorized" } })));
    const a = fakeReqRes("GET", "/residents");
    bad(a.req, a.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(a.status).toBe(502);
    expect(a.body()).toContain("401");
    expect(a.body()).toContain("unauthorized");

    const huge = handler(fakeClient(() => Promise.resolve({ status: 500, data: { blob: "x".repeat(10_000) } })));
    const c = fakeReqRes("GET", "/residents");
    huge(c.req, c.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.status).toBe(502);
    expect(c.body().length).toBeLessThan(700);

    const hugeErr = handler(fakeClient(() => Promise.reject(new Error("x".repeat(10_000)))));
    const e = fakeReqRes("GET", "/residents");
    hugeErr(e.req, e.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(e.status).toBe(502);
    expect(e.body().length).toBeLessThan(700);

    const throwing = handler(
      fakeClient(() => Promise.reject(new Error("resident admin /residents request failed (ECONNREFUSED)"))),
    );
    const b = fakeReqRes("GET", "/residents/jshttp/vary");
    throwing(b.req, b.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.status).toBe(502);
    expect(b.body()).toContain("ECONNREFUSED");
  });
});

describe("createResidentsViewHandler — each page request is a root (docs/reference/specs/tracing.md item 20)", () => {
  const tracedClient = (residents: () => Promise<ResidentAdminResponse>, bound: string[]): ResidentAdminClient => {
    const base = fakeClient(residents);
    const client: ResidentAdminClient = {
      ...base,
      withSpan(span) {
        bound.push(span.name);
        return client;
      },
    };
    return client;
  };

  it("each page request runs under a dashboard.residents root handed to the client, with the route and the status; a 200 ends ok, a 404 ends error", async () => {
    const sink = recordingSink();
    const bound: string[] = [];
    const h = handler(
      tracedClient(() => Promise.resolve(ok(LISTING as never)), bound),
      { sinks: [sink] },
    );
    const index = fakeReqRes("GET", "/residents");
    expect(h(index.req, index.res, ADMIN)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(index.status).toBe(200);
    const detail = fakeReqRes("GET", "/residents/acme/unknown");
    expect(h(detail.req, detail.res, ADMIN)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(detail.status).toBe(404);

    expect(bound).toEqual(["dashboard.residents", "dashboard.residents"]);
    const roots = sink.ends.filter((e) => e.name === "dashboard.residents");
    expect(roots.map((r) => [r.parentSpanId, r.status, r.attrs.route, r.attrs.httpStatus])).toEqual([
      [undefined, "ok", "index", 200],
      [undefined, "error", "detail", 404],
    ]);
  });

  it("a throwing client ends the root error with the 502 it answered", async () => {
    const sink = recordingSink();
    const h = handler(
      tracedClient(() => Promise.reject(new Error("boom")), []),
      { sinks: [sink] },
    );
    const io = fakeReqRes("GET", "/residents");
    h(io.req, io.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(io.status).toBe(502);
    expect(sink.ended("dashboard.residents")).toMatchObject({
      status: "error",
      attrs: { route: "index", httpStatus: 502 },
    });
  });

  it("without trace deps a request is untraced and the client is used unbound", async () => {
    const bound: string[] = [];
    const h = handler(tracedClient(() => Promise.resolve(ok(LISTING as never)), bound));
    const io = fakeReqRes("GET", "/residents");
    h(io.req, io.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(io.status).toBe(200);
    expect(bound).toEqual([]);
  });
});

describe("createResidentsViewHandler — the runs on residents and the live feed (resident-repos item 42)", () => {
  const PUBLIC = { channelId: "slack:C_PUB", channelVisibility: "public" } as const;
  const PRIVATE = { channelId: "slack:G_PRIV", channelVisibility: "private" } as const;
  const meta = (channel: typeof PUBLIC | typeof PRIVATE, threadKey: string, repo?: string) => ({
    ...channel,
    userId: "slack:UA",
    threadKey,
    ...(repo ? { repo } : {}),
  });
  // alice is an unlisted browser session (every group's read, no channel
  // grants); nobody is a viewer config names nothing for.
  const SOURCE: GrantsSource = { grants: new Map([["access:admin", ALL_GRANTS]]), commandGroups: ["runs"] };
  const alice: ResidentsViewContext = { actor: accessActor({ sub: "alice" }, (id) => grantsFor(id, SOURCE)) };
  const nobody: ResidentsViewContext = { actor: accessActor({ sub: "nobody" }, () => NO_GRANTS) };

  function fleet() {
    const registry = new RunRegistry();
    const pub = registry.create("coding · jshttp/vary", meta(PUBLIC, "slack:C_PUB:1", "jshttp/vary"));
    const priv = registry.create("review · acme/api", meta(PRIVATE, "slack:G_PRIV:1", "acme/api"));
    const noRepo = registry.create("general · #dev", meta(PUBLIC, "slack:C_PUB:2"));
    const done = registry.create("coding · jshttp/vary", meta(PUBLIC, "slack:C_PUB:3", "jshttp/vary"));
    registry.finish(done.id, "completed");
    return { registry, pub, priv, noRepo, done };
  }

  it("seeds the live repo runs the viewer may read, each with its token, and the server clock; never a finished run or one without a repo", async () => {
    const f = fleet();
    const h = handler(
      fakeClient(() => Promise.resolve(ok(LISTING as never))),
      undefined,
      f.registry,
      () => 4242,
    );
    const admin = fakeReqRes("GET", "/residents");
    h(admin.req, admin.res, ADMIN);
    await new Promise((r) => setTimeout(r, 0));
    const seed = seedOf(admin.body()) as ResidentsIndexSeed;
    expect(seed.now).toBe(4242);
    expect(seed.runs.map((r) => [r.id, r.repo, r.token]).sort()).toEqual(
      [
        [f.pub.id, "jshttp/vary", f.pub.token],
        [f.priv.id, "acme/api", f.priv.token],
      ].sort(),
    );

    const viewer = fakeReqRes("GET", "/residents");
    h(viewer.req, viewer.res, alice);
    await new Promise((r) => setTimeout(r, 0));
    expect((seedOf(viewer.body()) as ResidentsIndexSeed).runs.map((r) => r.id)).toEqual([f.pub.id]);

    const none = fakeReqRes("GET", "/residents");
    h(none.req, none.res, nobody);
    await new Promise((r) => setTimeout(r, 0));
    expect(none.status).toBe(200); // the residents themselves are the Access gate's to show
    expect((seedOf(none.body()) as ResidentsIndexSeed).runs).toEqual([]);
  });

  it("`?stream=1` is the feed: an SSE head, the viewer's repo runs replayed, live upserts, and a fresh listing when a run's attach span ends", async () => {
    const f = fleet();
    let reads = 0;
    const h = handler(
      fakeClient(() => {
        reads++;
        return Promise.resolve(ok(LISTING as never));
      }),
      undefined,
      f.registry,
    );
    const io = fakeReqRes("GET", "/residents?stream=1");
    expect(h(io.req, io.res, alice)).toBe(true);
    expect(io.status).toBe(200);
    expect(io.headers["content-type"]).toContain("text/event-stream");
    expect(reads).toBe(0); // the feed opens on the registry alone; the page already has the seed's listing
    const frames = () =>
      io
        .body()
        .split("\n\n")
        .filter((c) => c.startsWith("data: "))
        .map((c) => JSON.parse(c.slice(6)) as ResidentsFeedFrame);
    const ids = (fs: ResidentsFeedFrame[]) =>
      fs.map((fr) => (fr.type === "upsert" ? `${fr.run.id}:${fr.run.finished}` : fr.type));
    // The replay is the registry's live set as the viewer sees it: alice's
    // public repo runs — the live one and the finished one still inside its
    // TTL (the page drops a finished row; the runs index feed carries it the
    // same way) — never the private run or the one without a repo.
    expect(ids(frames()).sort()).toEqual([`${f.done.id}:true`, `${f.pub.id}:false`].sort());

    const late = f.registry.create("coding · jshttp/vary", meta(PUBLIC, "slack:C_PUB:9", "jshttp/vary"));
    f.registry.create("review · acme/api", meta(PRIVATE, "slack:G_PRIV:9", "acme/api")); // not alice's to see
    f.registry.publish(late.id, {
      type: "span_end",
      spanId: "s1",
      name: ATTACH_SPAN,
      startedAt: 1,
      durationMs: 2,
      status: "ok",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toBe(1);
    const after = frames();
    // the create's upsert (a span record never repaints the index), then the listing the attach end caused
    expect(ids(after).slice(2)).toEqual([`${late.id}:false`, "residents"]);
    expect(after.at(-1)).toEqual({ type: "residents", cap: 5, count: 2, residents: [WARM, DOWN] });
  });

  it("the feed's listing reads run under their own `dashboard.residents` root (route `feed`), one per read", async () => {
    const f = fleet();
    const sink = recordingSink();
    const h = handler(
      fakeClient(() => Promise.resolve(ok(LISTING as never))),
      { sinks: [sink] },
      f.registry,
    );
    const io = fakeReqRes("GET", "/residents?stream=1");
    h(io.req, io.res, ADMIN);
    f.registry.publish(f.pub.id, {
      type: "span_end",
      spanId: "s1",
      name: ATTACH_SPAN,
      startedAt: 1,
      durationMs: 2,
      status: "ok",
    });
    await new Promise((r) => setTimeout(r, 0));
    const roots = sink.ends.filter((e) => e.name === "dashboard.residents");
    expect(roots.map((r) => [r.status, r.attrs.route, r.attrs.httpStatus])).toEqual([["ok", "feed", 200]]);
  });
});
