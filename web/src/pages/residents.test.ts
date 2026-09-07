import { describe, expect, it } from "vitest";
import ResidentsIndexPage from "./ResidentsIndexPage.vue";
import ResidentDetailPage from "./ResidentDetailPage.vue";
import { mountApp } from "../testing/mount";
import type { ResidentDetailSeed, ResidentsIndexSeed } from "@core/channels/webSeed.js";

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

// Item 55: a resident's last disk sample (the nominal shape measured 2026-09-07:
// 14.4 GiB disk, 4.07 GiB used, deps 2.14 GiB, checkout 0.44 GiB, one 0.52 GiB
// hardlinked thread tree, the build user's home empty).
const DISK = {
  at: "2026-09-07T15:30:00.000Z",
  totalKiB: 15_086_920,
  usedKiB: 4_262_360,
  freeKiB: 10_808_176,
  parts: {
    mirror: 371_264,
    deps: 2_244_052,
    checkout: 462_888,
    threads: { "slack:C0BQS7KPJHK:1787954209.398379": 541_860 },
    homes: { worker1: 4, worker3: 2_100_000 },
    other: 640_000,
  },
};
const MEASURED = { ...WARM, live: { ...WARM.live, disk: DISK } };

const indexSeed = (residents: unknown[], cap: unknown = 5, count: unknown = residents.length): ResidentsIndexSeed => ({
  page: "residents",
  cap,
  count,
  residents,
});

const detailSeed = (record: unknown, slug = "jshttp/vary"): ResidentDetailSeed => ({ page: "resident", slug, record });

describe("ResidentsIndexPage", () => {
  it("renders one full-row link per resident to its detail page, with state, reason, ref and short sha", () => {
    const w = mountApp(ResidentsIndexPage, { seed: indexSeed([WARM, DOWN], 5, 2) });
    const hrefs = w.findAll("a.row").map((a) => a.attributes("href"));
    expect(hrefs).toEqual(["/residents/jshttp/vary", "/residents/coreplanelabs/switchboard"]);
    expect(w.text()).toContain("2/5 resident slots in use");
    expect(w.text()).toContain("live registry read, not cached");
    expect(w.text()).toContain("warm");
    expect(w.text()).toContain("01234567");
    expect(w.text()).toContain("ref master");
    expect(w.text()).toContain("provision-failed at clone");
    expect(w.find('[data-tone="green"]').exists()).toBe(true);
    expect(w.find('[data-tone="red"]').exists()).toBe(true);
  });

  it("shows an empty state naming the onboard command when nothing is onboarded", () => {
    const w = mountApp(ResidentsIndexPage, { seed: indexSeed([], 5, 0) });
    expect(w.text()).toContain("No repos onboarded");
    expect(w.text()).toContain("repo onboard");
    expect(w.find("a.row").exists()).toBe(false);
  });

  it("renders hostile records as text — markup never becomes elements, non-slugs never link", () => {
    const hostile = {
      ...DOWN,
      resource: "repo:evil/<img src=x onerror=alert(1)>",
      live: { ...DOWN.live, reason: '"><script>alert(1)</script>' },
    };
    const w = mountApp(ResidentsIndexPage, { seed: indexSeed([hostile], 5, 1) });
    expect(w.find("img").exists()).toBe(false);
    expect(w.text()).toContain("<img src=x");
    expect(w.text()).toContain("<script>alert(1)</script>");
    expect(w.find("a.row").exists()).toBe(false);
  });

  it("marks Residents current in the shared nav", () => {
    const w = mountApp(ResidentsIndexPage, { seed: indexSeed([WARM]) });
    expect(w.find('nav.site a[aria-current="page"]').attributes("href")).toBe("/residents");
  });

  it("item 55: a measured resident's row carries the disk gauge (used/total, pct) with the sample time on hover; an unmeasured one shows no disk", () => {
    const w = mountApp(ResidentsIndexPage, { seed: indexSeed([MEASURED, DOWN], 5, 2) });
    expect(w.text()).toContain("disk 4.06 GiB/14.4 GiB (28%)");
    expect(w.find('[title="measured 2026-09-07T15:30:00.000Z"]').exists()).toBe(true);
    const rows = w.findAll("a.row");
    expect(rows[1].text()).not.toContain("disk");
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
    const w = mountApp(ResidentDetailPage, { seed: detailSeed(DOWN, "coreplanelabs/switchboard") });
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
    const b = t.indexOf("slack:C0BQS7KPJHK:1787900000.000001");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(w.findAll("a").map((x) => x.attributes("href"))).toContain(
      "https://github.com/jshttp/vary/commit/abcdef1234567890abcdef1234567890abcdef12",
    );
    expect(t).toContain("hardlink");
    expect(t).toContain("worker3");
    expect(t).toContain("2026-08-28T21:45:00.000Z");
    expect(t).toContain("evicted 2026-08-27T10:00:00.000Z · merged #12 <b>");
    expect(t).toContain("1 live · 1 evicted");
  });

  it("says so when a resident has no thread worktrees, and never links a non-hex sha", () => {
    expect(mountApp(ResidentDetailPage, { seed: detailSeed(DOWN, "coreplanelabs/switchboard") }).text()).toContain(
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
      seed: detailSeed({ ...DOWN, live: { error: "DO unreachable" } }, "coreplanelabs/switchboard"),
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
    expect(t).toMatch(/reserve\s*2\.76 GiB \(snapshot staging 1\.76 GiB \+ floor 1\.00 GiB\)/);
    // headroom = 10.3 − 2.76 = 7.5 GiB → 17 hardlinked (0.44 GiB each) or 2 deps-installing (2.58 GiB each)
    expect(t).toMatch(
      /headroom\s*7\.5\d GiB — room for 17 more \(0\.44 GiB each\) hardlinked trees, 2 more \(2\.58 GiB each\) deps-installing/,
    );
    expect(t).toContain("2026-09-07T15:30:00.000Z");
    expect(t).toMatch(/mirror\s*0\.35 GiB/);
    expect(t).toMatch(/checkout deps \(node_modules\)\s*2\.14 GiB/);
    expect(t).toMatch(/checkout \(history \+ tree \+ build\)\s*0\.44 GiB/);
    expect(t).toMatch(/thread slack:C0BQS7KPJHK:1787954209\.398379\s*0\.52 GiB/);
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
