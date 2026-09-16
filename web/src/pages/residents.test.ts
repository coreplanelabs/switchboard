import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ResidentsIndexPage from "./ResidentsIndexPage.vue";
import ResidentDetailPage from "./ResidentDetailPage.vue";
import { mountApp } from "../testing/mount";
import { browser } from "../lib/browser";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";
import type { ResidentDetailSeed, ResidentsIndexSeed, RunIndexRowSeed } from "@core/channels/webSeed.js";
import { FAVICON_BY_TONE } from "@core/channels/favicon.js";

// Ported from the string-renderer suite (residentsView.test.ts): the same
// behaviors, asserted against the mounted Vue pages. Escaping assertions
// become "hostile text never becomes elements" (Vue renders text as data).

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
        threadKey: "slack:CACME0001:1787954209.398379",
        ref: "feat/residents-dash",
        sha: "abcdef1234567890abcdef1234567890abcdef12",
        user: "worker3",
        deps: "hardlink",
        boundAt: "2026-08-28T21:40:00.000Z",
        lastAttachAt: "2026-08-28T21:45:00.000Z",
        evicted: false,
      },
      {
        threadKey: "slack:CACME0001:1787900000.000001",
        ref: "master",
        user: "",
        deps: "reconcile",
        boundAt: "2026-08-20T10:00:00.000Z",
        lastAttachAt: "2026-08-20T10:05:00.000Z",
        evicted: true,
        evictedAt: "2026-08-27T10:00:00.000Z",
        evictedWhy: "branch merged <b>",
      },
    ],
  },
};

const DOWN = {
  resource: "repo:acme/api",
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

// Item 55: a resident's last disk sample (a typical shape: 14.4 GiB disk, 4.07 GiB
// used, deps 2.14 GiB, checkout 0.44 GiB, one 0.52 GiB hardlinked thread tree, the
// build user's home empty).
const DISK = {
  at: "2026-09-07T15:30:00.000Z",
  totalKiB: 15_086_920,
  usedKiB: 4_262_360,
  freeKiB: 10_808_176,
  parts: {
    mirror: 371_264,
    deps: 2_244_052,
    checkout: 462_888,
    threads: { "slack:CACME0001:1787954209.398379": 541_860 },
    homes: { worker1: 4, worker3: 2_100_000 },
    other: 640_000,
  },
};
const MEASURED = { ...WARM, live: { ...WARM.live, disk: DISK } };

// The seed's clock: 15 minutes after MEASURED's disk sample, ten days after
// WARM's live thread last attached.
const NOW = Date.parse("2026-09-07T15:45:00.000Z");

const run = (id: string, over: Partial<RunIndexRowSeed> = {}): RunIndexRowSeed => ({
  id,
  label: 'coding · jshttp/vary · "add the residents fold"',
  channelId: "slack:CACME0001",
  userId: "slack:UACME1",
  userName: "alice",
  threadKey: "slack:CACME0001:1787954209.398379",
  repo: "jshttp/vary",
  sourceUrl: "https://example.slack.com/archives/CACME0001/p1787954209398379",
  finished: false,
  startedAt: NOW - 4 * 60_000 - 12_000,
  eventCount: 17,
  token: `tok-${id}`,
  ...over,
});

const indexSeed = (
  residents: unknown[],
  cap: unknown = 5,
  count: unknown = residents.length,
  runs: RunIndexRowSeed[] = [],
): ResidentsIndexSeed => ({
  page: "residents",
  cap,
  count,
  residents,
  now: NOW,
  runs,
});

const detailSeed = (record: unknown, slug = "jshttp/vary"): ResidentDetailSeed => ({ page: "resident", slug, record });

function mountIndex(s: ResidentsIndexSeed) {
  const { created, factory } = fakeEventSourceFactory();
  const wrapper = mountApp(ResidentsIndexPage, { seed: s, eventSource: factory });
  return { wrapper, es: () => created[0] };
}

let setTitle: ReturnType<typeof vi.spyOn>;
let setFavicon: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  setTitle = vi.spyOn(browser, "setTitle").mockImplementation(() => {});
  setFavicon = vi.spyOn(browser, "setFavicon").mockImplementation(() => {});
  window.history.replaceState(null, "", "/residents");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResidentsIndexPage", () => {
  it("renders one fold per resident with state, reason, ref, short sha and a detail link, and opens the feed", () => {
    const { wrapper: w, es } = mountIndex(indexSeed([WARM, DOWN], 5, 2));
    expect(w.findAll("li.resident").map((li) => li.attributes("data-slug"))).toEqual(["jshttp/vary", "acme/api"]);
    expect(w.findAll("a.detail").map((a) => a.attributes("href"))).toEqual([
      "/residents/jshttp/vary",
      "/residents/acme/api",
    ]);
    expect(w.text()).toContain("2/5 resident slots in use");
    expect(w.find("#running").text()).toBe("0 running");
    expect(w.text()).toContain("warm");
    expect(w.text()).toContain("01234567");
    expect(w.text()).toContain("ref master");
    expect(w.text()).toContain("provision-failed at clone");
    expect(w.find('[data-tone="green"]').exists()).toBe(true);
    expect(w.find('[data-tone="red"]').exists()).toBe(true);
    expect(es().url).toBe("/residents?stream=1");
    // closed by default: the fold's body is not rendered as open
    expect(w.find("li.resident details").attributes("open")).toBeUndefined();
  });

  it("shows an empty state naming the onboard command when nothing is onboarded", () => {
    const { wrapper: w } = mountIndex(indexSeed([], 5, 0));
    expect(w.text()).toContain("No repos onboarded");
    expect(w.text()).toContain("repo onboard");
    expect(w.find("li.resident").exists()).toBe(false);
  });

  it("renders hostile records as text — markup never becomes elements, non-slugs never link", () => {
    const hostile = {
      ...DOWN,
      resource: "repo:evil/<img src=x onerror=alert(1)>",
      live: { ...DOWN.live, reason: '"><script>alert(1)</script>' },
    };
    const { wrapper: w } = mountIndex(indexSeed([hostile], 5, 1));
    expect(w.find("img").exists()).toBe(false);
    expect(w.text()).toContain("<img src=x");
    expect(w.text()).toContain("<script>alert(1)</script>");
    expect(w.find("a.detail").exists()).toBe(false);
  });

  it("marks Residents current in the shared nav", () => {
    const { wrapper: w } = mountIndex(indexSeed([WARM]));
    expect(w.find('nav.site a[aria-current="page"]').attributes("href")).toBe("/residents");
  });

  it("item 55: a measured resident's row carries the disk gauge (used/total, pct) with the sample time on hover; an unmeasured one shows no disk", () => {
    const { wrapper: w } = mountIndex(indexSeed([MEASURED, DOWN], 5, 2));
    expect(w.text()).toContain("disk 4.06 GiB/14.4 GiB (28%)");
    expect(w.find('li.resident[data-slug="jshttp/vary"] summary .facts').attributes("title")).toContain(
      "disk measured 2026-09-07T15:30:00.000Z",
    );
    const rows = w.findAll("li.resident summary");
    expect(rows[1].text()).not.toContain("disk");
  });
});

describe("ResidentsIndexPage — the fold (item 42: what is on this resident)", () => {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  it("counts the runs on each resident in its row and in the toolbar, and lists them in the fold as one grid — agent, request, who and thread, worktree, user, deps, size, stopwatch, run link — joined to the worktree by thread key", () => {
    const { wrapper: w } = mountIndex(
      indexSeed([MEASURED, DOWN], 5, 2, [run("r1"), run("other", { repo: "acme/web", threadKey: "slack:C9:1" })]),
    );
    expect(w.find("#running").text()).toBe("1 running"); // the acme/web run is on no listed resident
    const vary = w.find('li.resident[data-slug="jshttp/vary"]');
    expect(vary.attributes("data-running")).toBe("1");
    expect(vary.find("summary .running").text()).toBe("1 running");
    expect(norm(vary.find("summary .facts").text())).toBe(
      "ref master · 01234567 · refreshed Aug 28 · disk 4.06 GiB/14.4 GiB (28%)",
    );
    const line = vary.find('li.run[data-run-id="r1"]');
    expect(line.exists()).toBe(true);
    expect(line.find(".agent").text()).toBe("coding");
    expect(line.find(".text").text()).toBe("add the residents fold");
    expect(norm(line.find(".who").text())).toBe("by alice · Slack thread ↗");
    expect(line.find(".who a[target='_blank']").attributes("href")).toBe(
      "https://example.slack.com/archives/CACME0001/p1787954209398379",
    );
    expect(norm(line.find(".tree").text())).toBe("feat/residents-dash @ abcdef12");
    expect(
      line
        .find(".tree a[href='https://github.com/jshttp/vary/commit/abcdef1234567890abcdef1234567890abcdef12']")
        .exists(),
    ).toBe(true);
    expect(line.find(".user").text()).toBe("worker3");
    expect(line.find(".deps").text()).toBe("hardlink");
    expect(line.find(".size").text()).toBe("0.52 GiB");
    expect(line.find(".elapsed").text()).toBe("4m 12s");
    expect(line.find(".elapsed").attributes("title")).toContain("started 4 minutes ago");
    expect(line.find("a.open").attributes("href")).toBe("/runs/r1?t=tok-r1");
    // the resident with nothing on it says so
    expect(w.find('li.resident[data-slug="acme/api"] .fold').text()).toContain("nothing on this resident");
    expect(w.find('li.resident[data-slug="acme/api"] summary .running').exists()).toBe(false);
  });

  it("a run whose attach has not completed has no worktree yet; a run without a thread link names its surface", () => {
    const { wrapper: w } = mountIndex(
      indexSeed([WARM], 5, 1, [
        run("r2", {
          threadKey: "slack:CACME0001:9.9",
          sourceUrl: undefined,
          channelId: "cli:local",
          userId: "cli:alice",
          userName: undefined,
        }),
      ]),
    );
    const line = w.find('li.run[data-run-id="r2"]');
    expect(line.find(".tree").text()).toContain("no worktree bound yet");
    expect(norm(line.find(".who").text())).toBe("by alice · via CLI");
    expect(line.find(".who a").exists()).toBe(false);
    expect(line.find(".size").exists()).toBe(false); // no tree, no size
  });

  it("lists the live worktrees no run is using as idle rows with their size and last use, never an evicted one; the disk line carries free space, the room in trees and the sample age", () => {
    const { wrapper: w } = mountIndex(indexSeed([MEASURED], 5, 1));
    const fold = w.find('li.resident[data-slug="jshttp/vary"] .fold');
    const idle = fold.findAll("li.idle");
    expect(idle).toHaveLength(1); // the evicted binding is not a tree
    expect(idle[0].attributes("data-thread")).toBe("slack:CACME0001:1787954209.398379");
    expect(idle[0].find(".text").text()).toBe("idle");
    expect(idle[0].find(".who").text()).toBe("last used Aug 28");
    expect(norm(idle[0].find(".tree").text())).toBe("feat/residents-dash @ abcdef12");
    expect(idle[0].find(".user").text()).toBe("worker3");
    expect(idle[0].find(".deps").text()).toBe("hardlink");
    expect(idle[0].find(".size").text()).toBe("0.52 GiB");
    expect(idle[0].find(".elapsed").exists()).toBe(false);
    expect(idle[0].find("a.open").exists()).toBe(false);
    expect(fold.find(".disk").attributes("data-idle")).toBe("1");
    expect(norm(fold.find(".disk").text())).toBe("10.3 GiB free · room for 20 more trees · measured 15 minutes ago");
  });

  it("an idle worktree becomes a run's the moment a run on its thread appears; an unmeasured resident says so in the size cell and the disk line", () => {
    const { wrapper: w } = mountIndex(indexSeed([WARM], 5, 1, [run("r1")]));
    const fold = w.find('li.resident[data-slug="jshttp/vary"] .fold');
    expect(fold.findAll("li.idle")).toHaveLength(0);
    expect(fold.find('li.run[data-run-id="r1"] .size').text()).toBe("—");
    expect(fold.find('li.run[data-run-id="r1"] .size').attributes("title")).toBe("size not measured yet");
    expect(fold.find(".disk").text()).toContain("disk not measured yet");
  });

  it("`?open=<slug>` opens that resident's fold on first paint", () => {
    window.history.replaceState(null, "", "/residents?open=acme/api");
    const { wrapper: w } = mountIndex(indexSeed([WARM, DOWN], 5, 2));
    expect(w.find('li.resident[data-slug="jshttp/vary"] details').attributes("open")).toBeUndefined();
    expect(w.find('li.resident[data-slug="acme/api"] details').attributes("open")).toBeDefined();
  });

  it("hostile thread fields in the fold render as text, and a non-hex sha never links", () => {
    const hostile = {
      ...WARM,
      live: {
        ...WARM.live,
        threads: [
          {
            threadKey: "slack:CACME0001:1787954209.398379",
            ref: "<b>r</b>",
            sha: "zz",
            user: "<i>u</i>",
            deps: "x",
            lastAttachAt: "t",
          },
        ],
      },
    };
    const { wrapper: w } = mountIndex(
      indexSeed([hostile], 5, 1, [run("r1", { label: 'coding · jshttp/vary · "<img src=x>"' })]),
    );
    const fold = w.find(".fold");
    expect(fold.find("b").exists()).toBe(false);
    expect(fold.find("img").exists()).toBe(false);
    expect(fold.text()).toContain("<b>r</b>");
    expect(fold.text()).toContain("<img src=x>");
    expect(
      fold
        .findAll("a")
        .map((a) => a.attributes("href"))
        .join(" "),
    ).not.toContain("/commit/zz");
  });
});

describe("ResidentsIndexPage — live over the feed", () => {
  it("shows the connection state: connecting, then live on open, disconnected on a closed error", async () => {
    const { wrapper: w, es } = mountIndex(indexSeed([WARM]));
    expect(w.find("#state").text()).toBe("connecting…");
    es().emitOpen();
    await nextTick();
    expect(w.find("#state").text()).toBe("live");
    es().emitError(true);
    await nextTick();
    expect(w.find("#state").text()).toBe("disconnected");
  });

  it("an upsert adds a run to its resident's fold and its stopwatch ticks; a finished upsert and a removed take it out", async () => {
    const { wrapper: w, es } = mountIndex(indexSeed([WARM], 5, 1));
    es().emitOpen();
    es().emitMessage({ type: "upsert", run: run("r1") });
    await nextTick();
    expect(w.find("#running").text()).toBe("1 running");
    expect(w.find('li.run[data-run-id="r1"] .elapsed').text()).toBe("4m 12s");
    es().emitMessage({ type: "upsert", run: run("r1", { finished: true, finishedAt: NOW }) });
    await nextTick();
    expect(w.find('li.run[data-run-id="r1"]').exists()).toBe(false);
    expect(w.find("#running").text()).toBe("0 running");
    es().emitMessage({ type: "upsert", run: run("r3") });
    es().emitMessage({ type: "removed", id: "r3" });
    await nextTick();
    expect(w.find('li.run[data-run-id="r3"]').exists()).toBe(false);
    es().emitMessage("not json");
    await nextTick();
    expect(w.find("#running").text()).toBe("0 running");
  });

  it("a residents frame replaces the listing — state, bindings, disk, count — and the tab's title and favicon follow the runs and the fleet tone", async () => {
    const { wrapper: w, es } = mountIndex(indexSeed([WARM], 5, 1, [run("r1")]));
    expect(setTitle).toHaveBeenLastCalledWith("(1) Resident repos");
    expect(setFavicon).toHaveBeenLastCalledWith(FAVICON_BY_TONE.green);
    es().emitOpen();
    es().emitMessage({
      type: "residents",
      cap: 6,
      count: 2,
      residents: [{ ...MEASURED, live: { ...MEASURED.live, state: "refreshing" } }, DOWN],
    });
    await nextTick();
    expect(w.text()).toContain("2/6 resident slots in use");
    expect(w.findAll("li.resident")).toHaveLength(2);
    expect(w.find('li.resident[data-slug="jshttp/vary"] summary').text()).toContain("refreshing");
    expect(w.find('li.run[data-run-id="r1"] .size').text()).toBe("0.52 GiB");
    expect(setFavicon).toHaveBeenLastCalledWith(FAVICON_BY_TONE.red);
    es().emitMessage({ type: "upsert", run: run("r1", { finished: true }) });
    await nextTick();
    expect(setTitle).toHaveBeenLastCalledWith("Resident repos");
  });

  it("a reconnect reloads the page for a fresh snapshot instead of drifting", () => {
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    const { es } = mountIndex(indexSeed([WARM]));
    es().emitOpen();
    expect(reload).not.toHaveBeenCalled();
    es().emitOpen();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("closes the stream on unmount", () => {
    const { wrapper: w, es } = mountIndex(indexSeed([WARM]));
    w.unmount();
    expect(es().closed).toBe(true);
  });
});

describe("ResidentDetailPage", () => {
  it("shows the interesting facts: state, ref, sha, lockfile hash, provisioned/refreshed, snapshot stamp, schedules, command table", () => {
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(WARM) });
    const t = w.text();
    expect(t).toContain("jshttp/vary");
    expect(t).toContain("warm");
    expect(t).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(t).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(t).toContain("2026-08-26T01:05:00.000Z");
    expect(t).toContain("2026-08-28T19:30:00.000Z");
    expect(t).toContain("bk_mirror_1");
    expect(t).toContain("bk_checkout_1");
    expect(t).toContain("npm install --no-audit --no-fund");
    expect(t).toContain("readonly");
    expect(t).toContain("7");
  });

  it("shows idle mode when the resident parked its refresh, 'awake' otherwise", () => {
    expect(mountApp(ResidentDetailPage, { seed: detailSeed(WARM) }).text()).toContain("awake");
    const idle = { ...WARM, live: { ...WARM.live, idleSince: "2026-08-29T03:00:00.000Z" } };
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(idle) });
    expect(w.text()).toContain("2026-08-29T03:00:00.000Z");
    expect(w.text()).toContain("container may sleep");
  });

  it("links to the GitHub repo, the pinned commit, and back to the residents index", () => {
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(WARM) });
    const hrefs = w.findAll("a").map((a) => a.attributes("href"));
    expect(hrefs).toContain("https://github.com/jshttp/vary");
    expect(hrefs).toContain("https://github.com/jshttp/vary/commit/0123456789abcdef0123456789abcdef01234567");
    expect(hrefs).toContain("/residents");
  });

  it("names the failure reason and last refresh error for a down resident and omits a commit link without a sha", () => {
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(DOWN, "acme/api") });
    expect(w.text()).toContain("provision-failed at clone: fatal: could not read Username");
    expect(w.text()).toContain("clone failed");
    expect(w.find('[data-tone="red"]').exists()).toBe(true);
    expect(
      w
        .findAll("a")
        .map((a) => a.attributes("href"))
        .join(" "),
    ).not.toContain("/commit/");
    expect(w.text()).toContain("no snapshot");
  });

  it("renders hostile field values as text, never elements", () => {
    const hostile = { ...WARM, commands: { test: "</script><script>alert(1)</script>" } };
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(hostile) });
    expect(w.text()).toContain("<script>alert(1)</script>");
  });

  it("lists thread worktrees (ref, sha linked to its commit, deps mechanism, attach times), newest first, marking evicted ones", () => {
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(WARM) });
    const t = w.text();
    const a = t.indexOf("feat/residents-dash");
    const b = t.indexOf("slack:CACME0001:1787900000.000001");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(w.findAll("a").map((x) => x.attributes("href"))).toContain(
      "https://github.com/jshttp/vary/commit/abcdef1234567890abcdef1234567890abcdef12",
    );
    expect(t).toContain("hardlink");
    expect(t).toContain("worker3");
    expect(t).toContain("2026-08-28T21:45:00.000Z");
    expect(t).toContain("evicted 2026-08-27T10:00:00.000Z · branch merged <b>");
    expect(t).toContain("1 live · 1 evicted");
  });

  it("says so when a resident has no thread worktrees, and never links a non-hex sha", () => {
    expect(mountApp(ResidentDetailPage, { seed: detailSeed(DOWN, "acme/api") }).text()).toContain(
      "no thread worktrees",
    );
    const hostile = {
      ...WARM,
      live: { ...WARM.live, threads: [{ threadKey: "<b>x</b>", ref: "<i>r</i>", sha: "zz", lastAttachAt: "t" }] },
    };
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(hostile) });
    expect(w.find("table b").exists()).toBe(false);
    expect(w.text()).toContain("<b>x</b>");
    expect(
      w
        .findAll("a")
        .map((x) => x.attributes("href"))
        .join(" "),
    ).not.toContain("/commit/zz");
  });

  it("shows the resident's live-view error when the registry record has no reachable engine", () => {
    const w = mountApp(ResidentDetailPage, {
      seed: detailSeed({ ...DOWN, live: { error: "DO unreachable" } }, "acme/api"),
    });
    expect(w.text()).toContain("DO unreachable");
    expect(w.find('[data-tone="grey"]').exists()).toBe(true);
    expect(w.text()).toContain("unreachable");
  });

  it("item 55: the Disk section shows the gauge, free, the reserve and its two terms, the headroom in trees, the sample time, and every component — hardlinked thread trees at their unique bytes, homes only above 1 MiB", () => {
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(MEASURED) });
    const t = w.text();
    expect(t).toContain("4.06 GiB/14.4 GiB (28%)");
    expect(t).toContain("10.3 GiB"); // free
    // reserve = 0.6 × (mirror + deps + checkout) + max(1 GiB, 5 %) = 0.6 × 2.94 GiB + 1 GiB
    expect(t).toMatch(/reserve\s*1\.48 GiB \(snapshot staging 0\.48 GiB \+ floor 1\.00 GiB\)/);
    // headroom = 10.3 − 2.76 = 7.5 GiB → 17 hardlinked (0.44 GiB each) or 7 lockfile-diverged
    // (0.44 + 0.25 × 2.14 = 0.98 GiB each: the seed plus the reconcile share of the deps)
    expect(t).toMatch(
      /headroom\s*8\.8\d GiB — room for 20 more \(0\.44 GiB each\) hardlinked trees, 9 more \(0\.98 GiB each\) lockfile-diverged \(reconciling\)/,
    );
    expect(t).toContain("2026-09-07T15:30:00.000Z");
    expect(t).toMatch(/mirror\s*0\.35 GiB/);
    expect(t).toMatch(/checkout deps \(node_modules\)\s*2\.14 GiB/);
    expect(t).toMatch(/checkout \(history \+ tree \+ build\)\s*0\.44 GiB/);
    expect(t).toMatch(/thread slack:CACME0001:1787954209\.398379\s*0\.52 GiB/);
    expect(t).toMatch(/home worker3\s*2\.00 GiB/);
    expect(t).not.toContain("home worker1"); // 4 KiB of dotfiles is noise
    expect(t).toMatch(/other \(image, \/tmp, …\)\s*0\.61 GiB/);
  });

  it("item 55: a diskBudgetMb below the disk caps the free space and says so; an unmeasured resident says it is not measured yet; a malformed sample is unmeasured, never NaN", () => {
    const capped = mountApp(ResidentDetailPage, { seed: detailSeed({ ...MEASURED, diskBudgetMb: 8 * 1024 }) }).text();
    // cap 8 GiB − used 4.06 GiB = 3.94 GiB free under the cap
    expect(capped).toContain("3.94 GiB under the 8.00 GiB diskBudgetMb cap");
    expect(mountApp(ResidentDetailPage, { seed: detailSeed(WARM) }).text()).toContain("not measured yet");
    const broken = {
      ...WARM,
      live: { ...WARM.live, disk: { totalKiB: "lots", usedKiB: -1, freeKiB: null, parts: "<b>x</b>" } },
    };
    const bw = mountApp(ResidentDetailPage, { seed: detailSeed(broken) });
    expect(bw.text()).toContain("not measured yet");
    expect(bw.text()).not.toContain("NaN");
    expect(bw.find("table b").exists()).toBe(false);
  });

  it("marks Residents current in the shared nav and offers the way back", () => {
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(WARM) });
    expect(w.find('nav.site a[aria-current="page"]').attributes("href")).toBe("/residents");
    expect(w.find("a.back").attributes("href")).toBe("/residents");
    expect(w.text()).toContain("repo rebuild jshttp/vary");
  });
});
