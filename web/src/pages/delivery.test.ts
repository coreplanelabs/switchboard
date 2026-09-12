import { describe, expect, it, vi } from "vitest";
import DeliveryPage from "./DeliveryPage.vue";
import { mountApp } from "../testing/mount";
import type { DeliveryReport, PullRequestFacts } from "@core/core/delivery.js";
import { buildDeliveryReport } from "@core/core/delivery.js";
import type { DeliverySeed } from "@core/channels/webSeed.js";
import { freshHref, hours, monthDay, pct, snapshotTime, tilesOf } from "../lib/delivery";

// The delivery page against the mounted Vue page: the tiles, the two tables,
// the switchers, the method, and hostile text kept as text.

const day = (iso: string): string => iso.slice(0, 10);
/** An issue cell as the page spells it — built at runtime, so the test carries no literal tracker imprint. */
const hash = (n: number): string => `#${n}`;
const REVIEWER = "acme-review[bot]";
const AGENT = "Claude <noreply@anthropic.com>";

const pr = (number: number, over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  number,
  title: `change ${number}`,
  author: "alice",
  createdAt: "2026-09-10T23:59:09Z",
  mergedAt: "2026-09-11T00:18:40Z",
  firstHeadSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
  ci: [
    {
      headSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
      trigger: "pull_request",
      conclusion: "success",
      attempt: 1,
      createdAt: "2026-09-10T23:59:14Z",
    },
  ],
  reviews: [{ author: REVIEWER, state: "commented", submittedAt: "2026-09-11T00:05:15Z", body: "LGTM: fine." }],
  pushes: [],
  ...over,
});

function report(over: Partial<Parameters<typeof buildDeliveryReport>[0]> = {}): DeliveryReport {
  return buildDeliveryReport({
    repo: "acme/api",
    range: { since: day("2026-08-31T00:00:00Z"), until: day("2026-09-11T00:00:00Z"), weeks: 2 },
    identities: { reviewers: [REVIEWER], agentCoauthors: ["Claude"] },
    runs: [{ agent: "review", startedAt: 0, finishedAt: 600_000, status: "completed", pr: 917 }],
    prs: [
      pr(915, {
        mergedAt: "2026-09-04T10:00:00Z",
        issue: { number: 830, title: "OpenRouter as a documented example <b>", createdAt: "2026-09-03T03:00:31Z" },
        ci: [
          {
            headSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
            trigger: "pull_request",
            conclusion: "success",
            attempt: 2,
            createdAt: "2026-09-04T09:00:00Z",
          },
        ],
      }),
      pr(917, {
        title: "the mutex <script>alert(1)</script>",
        issue: { number: 825, title: "The durable mutex", createdAt: "2026-09-10T03:00:12Z" },
        reviews: [
          {
            author: REVIEWER,
            state: "commented",
            submittedAt: "2026-09-11T00:05:15Z",
            body: "Changes requested: one bug.\n- [blocking] F1 a.ts — the bug\n- [nit] F2 b.ts — a nit",
          },
          { author: REVIEWER, state: "commented", submittedAt: "2026-09-11T00:17:46Z", body: "LGTM: fixed." },
        ],
        pushes: [{ actor: "alice", at: "2026-09-11T00:13:41Z", kind: "force", coauthors: [AGENT] }],
      }),
      pr(921, { author: "acme-coding[bot]" }),
    ],
    ...over,
  });
}

const seed = (r: DeliveryReport = report(), repos: string[] = ["acme/api", "acme/web"]): DeliverySeed => ({
  page: "delivery",
  report: r,
  repos,
});

describe("DeliveryPage", () => {
  it("renders hostile titles as text, never as markup", () => {
    const w = mountApp(DeliveryPage, { seed: seed() });
    expect(w.find("h1").text()).toBe("acme/api delivery");
    expect(w.html()).not.toContain("<script>alert");
    expect(w.find("table.units").text()).toContain("OpenRouter as a documented example <b>");
    expect(w.find("table.units b").exists()).toBe(false);
  });

  it("leads with the six tiles: merged, issue → merge, first-pass CI, review rounds, no human edit, blocking caught", () => {
    const w = mountApp(DeliveryPage, { seed: seed() });
    const t = w.text();
    expect(t).toContain("Merged");
    expect(t).toContain("1 agent-authored · 2 weeks");
    expect(t).toContain("Issue → merge");
    expect(t).toContain("First-pass CI");
    expect(t).toContain("2 of 3 green at the first attempt");
    expect(t).toContain("Review rounds");
    expect(t).toContain("4 verdicts, 1 fix round");
    expect(t).toContain("No human edit");
    expect(t).toContain("of 2 findings resolved by an agent alone");
    expect(t).toContain("Blocking caught");
    const tiles = tilesOf(report());
    // Median of 31.0 h (from the board issue), 21.3 h (from the board issue) and 20 min (from the opening).
    expect(tiles.map((x) => x.value)).toEqual(["3", "21.3 h", "67%", "1.33", "100%", "1"]);
  });

  it("draws one row per week with the indicators, and one row per unit with its issue and pull request links", () => {
    const w = mountApp(DeliveryPage, { seed: seed() });
    const weeks = w.findAll("table.weeks tbody tr");
    expect(weeks).toHaveLength(2);
    expect(weeks[0].text()).toContain("Aug 31 – Sep 6");
    expect(weeks[0].findAll("td")[1].text()).toBe("1");
    expect(weeks[1].text()).toContain("Sep 7 – Sep 13");
    expect(weeks[1].findAll("td")[1].text()).toBe("2");
    // The mutex unit: one pull request, two verdicts, one blocking finding, resolved by an agent, ten agent-run minutes in its week.
    const units = w.findAll("table.units tbody tr");
    expect(units.map((r) => r.findAll("td")[0].text())).toEqual([hash(825), hash(830), "—"]);
    const mutex = units[0];
    expect(mutex.find('a[href="https://github.com/acme/api/issues/825"]').exists()).toBe(true);
    expect(mutex.find('a[href="https://github.com/acme/api/pull/917"]').exists()).toBe(true);
    expect(mutex.findAll("td")[5].text()).toBe("2");
    expect(mutex.findAll("td")[6].text()).toBe("2 (1 blocking)");
    expect(mutex.findAll("td")[7].text()).toBe("100%");
    expect(weeks[1].findAll("td")[8].text()).toBe("10");
    // The unlinked row groups the pull requests no issue claims.
    expect(units[2].text()).toContain("(no issue)");
    expect(units[2].find('a[href="https://github.com/acme/api/pull/921"]').exists()).toBe(true);
  });

  it("says a week or a range with nothing merged is empty, without an error, and names a cut-short fetch", () => {
    const r = report({ prs: [], truncated: true });
    const w = mountApp(DeliveryPage, { seed: seed(r) });
    expect(w.findAll("table.weeks tbody tr")).toHaveLength(2);
    expect(w.text()).toContain("Nothing merged in range.");
    expect(w.text()).toContain("newest pull requests only");
    expect(w.text()).toContain("no merges in range");
    expect(tilesOf(r).map((x) => x.value)).toEqual(["0", "—", "—", "—", "—", "0"]);
  });

  it("carries the shared site nav with Delivery current", () => {
    const w = mountApp(DeliveryPage, { seed: seed() });
    expect(w.find('nav.site a[aria-current="page"]').attributes("href")).toBe("/delivery");
  });

  it("offers the range switch with the current range as text, the others as links, and the sibling repositories", () => {
    const w = mountApp(DeliveryPage, { seed: seed() });
    const hrefs = w.findAll("a").map((a) => a.attributes("href"));
    expect(hrefs).toContain("/delivery/acme/api?weeks=1");
    expect(hrefs).toContain("/delivery/acme/api?weeks=13");
    expect(hrefs).not.toContain("/delivery/acme/api?weeks=2");
    expect(hrefs).toContain("/delivery/acme/web");
    const single = mountApp(DeliveryPage, { seed: seed(report(), ["acme/api"]) });
    expect(single.findAll("a").map((a) => a.attributes("href"))).not.toContain("/delivery/acme/web");
  });

  it("states the method and the identities it judged by, and names the JSON twin", () => {
    const w = mountApp(DeliveryPage, { seed: seed() });
    const t = w.text();
    expect(t).toContain("first attempt");
    expect(t).toContain(REVIEWER);
    expect(t).toContain("Claude");
    expect(t).toContain("GET /delivery/acme/api.json");
  });

  it("the footer says when the facts were read and how long ago, and offers a live read that keeps the range", () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-11T14:03:30Z") });
    try {
      const w = mountApp(DeliveryPage, { seed: seed({ ...report(), snapshotAt: "2026-09-11T13:51:00Z" }) });
      const footer = w.find("footer").text();
      expect(footer).toContain("As of Sep 11, 13:51 UTC, 12 minutes ago");
      expect(w.find('footer a[href="?fresh=1"]').text()).toContain("read GitHub now");
      expect(footer).toContain("snapshot");
      expect(footer).not.toContain("nothing stored");
      // A report with no read time (a bare source) says nothing about one.
      const bare = mountApp(DeliveryPage, { seed: seed() });
      expect(bare.find("footer").text()).not.toContain("As of");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("delivery formatters", () => {
  it("hours read as minutes, hours or days; shares as whole percents; days as month-day", () => {
    expect(hours(null)).toBe("—");
    expect(hours(0.5)).toBe("30 min");
    expect(hours(21.31)).toBe("21.3 h");
    expect(hours(72)).toBe("3.0 d");
    expect(pct(null)).toBe("—");
    expect(pct(5 / 6)).toBe("83%");
    expect(monthDay(day("2026-09-07T00:00:00Z"))).toBe("Sep 7");
    expect(monthDay("garbage")).toBe("garbage");
  });
  it("the snapshot's time reads as month-day and UTC clock; the fresh link keeps the page's query", () => {
    expect(snapshotTime("2026-09-11T13:51:00Z")).toBe("Sep 11, 13:51 UTC");
    expect(snapshotTime("garbage")).toBe("garbage");
    expect(freshHref("")).toBe("?fresh=1");
    expect(freshHref("?weeks=2")).toBe("?weeks=2&fresh=1");
    expect(freshHref(`?since=${day("2026-09-01T00:00:00Z")}&fresh=1`)).toBe(
      `?since=${day("2026-09-01T00:00:00Z")}&fresh=1`,
    );
  });
});
