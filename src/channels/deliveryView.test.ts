import { describe, expect, it } from "vitest";
import type { Actor } from "../core/authz/types.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import {
  buildDeliveryReport,
  DELIVERY_OFF_MESSAGE,
  NullDeliveryService,
  type DeliveryRange,
  type DeliveryReport,
  type DeliveryService,
  type RunFact,
} from "../core/delivery.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService } from "../core/runsService.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import { createDeliveryViewHandler, DELIVERY_NO_REPOS_MESSAGE, parseDeliveryRoute } from "./deliveryView.js";
import { makeShellRenderer } from "./webShell.js";
import { SEED_ELEMENT_ID, type DeliverySeed } from "./webSeed.js";

// The delivery page handler: routing, live-per-request reads, the viewer's
// runs predicate, error statuses, the JSON twin, and the seed the shell
// carries. Rendering is tested in web/src/pages/delivery.test.ts.

// ---- fixtures ---------------------------------------------------------------

const NOW = Date.parse("2026-09-11T20:00:00Z");
const RANGE: DeliveryRange = {
  since: "2026-09-07T00:00:00Z".slice(0, 10),
  until: "2026-09-11T00:00:00Z".slice(0, 10),
  weeks: 1,
};

const report = (repo = "acme/api", runs: RunFact[] = []): DeliveryReport =>
  buildDeliveryReport({
    repo,
    range: RANGE,
    identities: { reviewers: ["acme-review[bot]"] },
    runs,
    prs: [
      {
        number: 42,
        title: "fix the build <b>",
        author: "alice",
        createdAt: "2026-09-10T23:59:09Z",
        mergedAt: "2026-09-11T00:18:40Z",
        firstHeadSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
        ci: [],
        reviews: [
          { author: "acme-review[bot]", state: "commented", submittedAt: "2026-09-11T00:05:15Z", body: "LGTM: fine." },
        ],
        pushes: [],
      },
    ],
  });

const shell = makeShellRenderer({ js: "/assets/main-test.js", css: [] }, ALL_CAPABILITIES);

function seedOf(html: string): DeliverySeed {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the page");
  return JSON.parse(m[1]) as DeliverySeed;
}

function fakeService(
  impl: (
    repo: string,
    opts: { since?: string; weeks?: number; fresh?: boolean; runs?: (range: DeliveryRange) => Promise<RunFact[]> },
  ) => Promise<DeliveryReport>,
  repos = ["acme/api"],
): DeliveryService {
  return { unavailable: () => undefined, repos: () => repos, report: impl };
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
    req: req as unknown as Parameters<ReturnType<typeof createDeliveryViewHandler>>[0],
    res: res as unknown as Parameters<ReturnType<typeof createDeliveryViewHandler>>[1],
    get status() {
      return status;
    },
    get headers() {
      return outHeaders;
    },
    body: () => chunks.join(""),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const viewer: Actor = {
  kind: "user",
  id: "access:viewer",
  grants: { actions: new Set(), channels: new Set(), repos: new Set() },
};
const admin: Actor = { kind: "user", id: "access:admin", grants: { actions: "all", channels: "all", repos: "all" } };
const ctx = (actor: Actor) => ({ actor });

// ---- routing ----------------------------------------------------------------

describe("parseDeliveryRoute", () => {
  it("matches the bare index, a repository page, and a repository's JSON twin", () => {
    expect(parseDeliveryRoute("/delivery")).toEqual({ kind: "page", repo: null });
    expect(parseDeliveryRoute("/delivery/")).toEqual({ kind: "page", repo: null });
    expect(parseDeliveryRoute("/delivery.json")).toEqual({ kind: "json", repo: null });
    expect(parseDeliveryRoute("/delivery/acme/api")).toEqual({ kind: "page", repo: "acme/api" });
    expect(parseDeliveryRoute("/delivery/acme/api.json")).toEqual({ kind: "json", repo: "acme/api" });
    expect(parseDeliveryRoute("/delivery/acme/my.repo-2/")).toEqual({ kind: "page", repo: "acme/my.repo-2" });
  });
  it("rejects anything else, including traversal-shaped, one-segment and over-long paths", () => {
    expect(parseDeliveryRoute("/deliveryX")).toBeNull();
    expect(parseDeliveryRoute("/delivery/acme")).toBeNull();
    expect(parseDeliveryRoute("/delivery/acme/api/extra")).toBeNull();
    expect(parseDeliveryRoute("/delivery/../x")).toBeNull();
    expect(parseDeliveryRoute("/delivery/acme/..")).toBeNull();
    expect(parseDeliveryRoute("/delivery/acme/" + "a".repeat(120))).toBeNull();
    expect(parseDeliveryRoute("/costs")).toBeNull();
  });
});

// ---- handler ----------------------------------------------------------------------

describe("createDeliveryViewHandler", () => {
  it("ignores paths it does not own", () => {
    const h = createDeliveryViewHandler({ service: fakeService(() => Promise.resolve(report())) }, shell);
    const io = fakeReqRes("GET", "/runs");
    expect(h(io.req, io.res, ctx(viewer))).toBe(false);
    expect(io.status).toBe(0);
  });

  it("503s with the reason when the process has no GitHub (the Null Object), and with the config to set when no repository is named", () => {
    const off = createDeliveryViewHandler({ service: new NullDeliveryService() }, shell);
    const a = fakeReqRes("GET", "/delivery");
    expect(off(a.req, a.res, ctx(viewer))).toBe(true);
    expect(a.status).toBe(503);
    expect(a.body()).toBe(DELIVERY_OFF_MESSAGE);
    const none = createDeliveryViewHandler({ service: fakeService(() => Promise.resolve(report()), []) }, shell);
    const b = fakeReqRes("GET", "/delivery/acme/api");
    expect(none(b.req, b.res, ctx(viewer))).toBe(true);
    expect(b.status).toBe(503);
    expect(b.body()).toBe(DELIVERY_NO_REPOS_MESSAGE);
    expect(b.body()).toContain("delivery.repos");
  });

  it("405s non-GET", () => {
    const h = createDeliveryViewHandler({ service: fakeService(() => Promise.resolve(report())) }, shell);
    const io = fakeReqRes("POST", "/delivery");
    expect(h(io.req, io.res, ctx(viewer))).toBe(true);
    expect(io.status).toBe(405);
    expect(io.headers.allow).toBe("GET");
  });

  it("serves the first repository on the bare index, asking the service on every request, with the hardened page headers and the report + repositories as the seed", async () => {
    let calls = 0;
    const h = createDeliveryViewHandler(
      {
        service: fakeService(
          (repo, opts) => {
            calls++;
            expect(repo).toBe("acme/api");
            expect(opts.weeks).toBeUndefined();
            expect(opts.since).toBeUndefined();
            return Promise.resolve(report());
          },
          ["acme/api", "acme/web"],
        ),
      },
      shell,
    );
    for (let i = 0; i < 2; i++) {
      const io = fakeReqRes("GET", "/delivery");
      expect(h(io.req, io.res, ctx(viewer))).toBe(true);
      await tick();
      expect(io.status).toBe(200);
      expect(io.headers["content-type"]).toContain("text/html");
      expect(io.headers["cache-control"]).toBe("no-store");
      expect(io.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(io.headers["x-frame-options"]).toBe("DENY");
      const seed = seedOf(io.body());
      expect(seed.page).toBe("delivery");
      expect(seed.report).toEqual(report());
      expect(seed.repos).toEqual(["acme/api", "acme/web"]);
      expect(io.body()).toContain("<title>acme/api delivery</title>");
      // The hostile title stays data inside the island — never markup on the page.
      expect(io.body()).not.toContain("<b>");
    }
    expect(calls).toBe(2);
  });

  it("passes ?weeks, ?since and ?fresh=1 through and 404s a repository that is not configured (the page serves the configured ones only)", async () => {
    const seen: unknown[] = [];
    const h = createDeliveryViewHandler(
      {
        service: fakeService(
          (repo, opts) => {
            seen.push([repo, opts.weeks, opts.since, opts.fresh]);
            return Promise.resolve(report(repo));
          },
          ["acme/api", "acme/web"],
        ),
      },
      shell,
    );
    const w = fakeReqRes("GET", "/delivery/acme/web?weeks=2");
    h(w.req, w.res, ctx(viewer));
    await tick();
    expect(w.status).toBe(200);
    const s = fakeReqRes("GET", `/delivery/acme/api?since=${"2026-09-01T00:00:00Z".slice(0, 10)}`);
    h(s.req, s.res, ctx(viewer));
    await tick();
    const f = fakeReqRes("GET", "/delivery/acme/api.json?weeks=1&fresh=1");
    h(f.req, f.res, ctx(viewer));
    await tick();
    const notFresh = fakeReqRes("GET", "/delivery/acme/api?fresh=0");
    h(notFresh.req, notFresh.res, ctx(viewer));
    await tick();
    expect(seen).toEqual([
      ["acme/web", 2, undefined, undefined],
      ["acme/api", undefined, "2026-09-01T00:00:00Z".slice(0, 10), undefined],
      ["acme/api", 1, undefined, true],
      ["acme/api", undefined, undefined, undefined],
    ]);
    const miss = fakeReqRes("GET", "/delivery/acme/nope");
    expect(h(miss.req, miss.res, ctx(viewer))).toBe(true);
    expect(miss.status).toBe(404);
  });

  it("hands the service the viewer's OWN runs: the runs predicate is the policy's for that actor, on the report's repository", async () => {
    const store = new InMemoryRunStore();
    const record = (id: string, repo: string, visibility: RunRecord["channelVisibility"]): RunRecord => ({
      id,
      label: `review · ${repo} · "review https://github.com/${repo}/pull/42"`,
      agent: "review",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:t1",
      channelVisibility: visibility,
      repo,
      startedAt: NOW - 600_000,
      finishedAt: NOW - 300_000,
      status: "completed",
      eventCount: 0,
      storedEventCount: 0,
      truncated: false,
      events: [],
      diagnosis: analyzeRunFriction([], { finished: true }),
    });
    await store.put(record("private-run", "acme/api", "private"));
    await store.put(record("public-run", "acme/api", "public"));
    await store.put(record("other-repo", "acme/web", "public"));
    const runs = createRunsService({ registry: new RunRegistry(), store, clock: () => NOW });
    const handed: RunFact[][] = [];
    const h = createDeliveryViewHandler(
      {
        service: fakeService(async (repo, opts) => {
          const facts = (await opts.runs?.(RANGE)) ?? [];
          handed.push(facts);
          return report(repo, facts);
        }),
        runs,
      },
      shell,
    );
    const asViewer = fakeReqRes("GET", "/delivery");
    h(asViewer.req, asViewer.res, ctx(viewer));
    await tick();
    const asAdmin = fakeReqRes("GET", "/delivery");
    h(asAdmin.req, asAdmin.res, ctx(admin));
    await tick();
    // A viewer with no channel sees the public run alone; the admin both — never the other repository's.
    expect(handed.map((f) => f.length)).toEqual([1, 2]);
    expect(handed[1].every((f) => f.pr === 42)).toBe(true);
    expect(seedOf(asAdmin.body()).report.totals.agentRuns).toEqual({ count: 2, minutes: 10 });
  });

  it("serves the JSON twin for agents with no-store, the snapshot's time and completeness in it", async () => {
    const h = createDeliveryViewHandler(
      {
        service: fakeService(() =>
          Promise.resolve({
            ...report(),
            snapshotAt: "2026-09-11T13:51:00Z",
            truncated: true,
            completeFrom: "2026-09-09T02:41:37Z",
          }),
        ),
      },
      shell,
    );
    const io = fakeReqRes("GET", "/delivery/acme/api.json");
    h(io.req, io.res, ctx(viewer));
    await tick();
    expect(io.status).toBe(200);
    expect(io.headers["content-type"]).toContain("application/json");
    expect(io.headers["cache-control"]).toBe("no-store");
    const parsed = JSON.parse(io.body()) as DeliveryReport;
    expect(parsed.repo).toBe("acme/api");
    expect(parsed.totals.prsMerged).toBe(1);
    expect(parsed.snapshotAt).toBe("2026-09-11T13:51:00Z");
    expect(parsed.truncated).toBe(true);
    expect(parsed.completeFrom).toBe("2026-09-09T02:41:37Z");
  });

  it("a renderer that throws once the report is in hand is one 502 with the reason — the headers are written once, never a 200 and then a 502", async () => {
    const exploding: typeof shell = () => {
      throw new Error("template exploded");
    };
    const h = createDeliveryViewHandler({ service: fakeService(() => Promise.resolve(report())) }, exploding);
    const io = fakeReqRes("GET", "/delivery");
    h(io.req, io.res, ctx(viewer));
    await tick();
    expect(io.status).toBe(502);
    expect(io.headers["content-type"]).toContain("text/plain");
    expect(io.body()).toBe("delivery sources unavailable: template exploded");
  });

  it("502s (never 500s, never leaks) when an upstream source fails", async () => {
    const h = createDeliveryViewHandler(
      {
        service: fakeService(() =>
          Promise.reject(new Error("GitHub GET pulls failed: HTTP 403 denied " + "x".repeat(2000))),
        ),
      },
      shell,
    );
    const io = fakeReqRes("GET", "/delivery");
    h(io.req, io.res, ctx(viewer));
    await tick();
    expect(io.status).toBe(502);
    expect(io.body()).toContain("HTTP 403");
    expect(io.body().length).toBeLessThan(600);
  });
});
