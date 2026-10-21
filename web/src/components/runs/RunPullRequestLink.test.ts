import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import RunRow from "./RunRow.vue";
import { mountApp, ALL_ON } from "../../testing/mount";
import type { IndexRow } from "../../lib/indexRow";
import { reactive } from "vue";
import { fakeEventSourceFactory } from "../../testing/fakeEventSource";

enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());
const run: IndexRow = {
  id: "code-1",
  repo: "acme/api",
  pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
  finished: true,
  startedAt: 1,
  eventCount: 3,
};
const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const seed = (events: unknown[]) => ({
  page: "run",
  title: "Run",
  capabilities: ALL_ON,
  mode: "history",
  id: "code-1",
  events,
  startedAt: 1,
  eventCount: events.length,
});
const events = [
  { type: "run_meta", repo: "acme/api", pr: 42, headSha: "abc1234" },
  { type: "review_artifact", artifact: "reading_diff", poweredBy: "git", baseRef: "main", diff },
];
const mountRow = (row = run) => mountApp(RunRow, { props: { run: row, now: 1000 } });

describe("Run row pull request", () => {
  it("starts checks only on a click, keeps updates across tabs, and closes and recreates the stream with the modal", async () => {
    const requests: string[] = [];
    let withDiff = true;
    const streams = fakeEventSourceFactory();
    vi.stubGlobal("fetch", async (address: string) => {
      requests.push(address);
      if (address.startsWith("/api/review.status")) return Response.json({ state: "absent" });
      return Response.json(seed(withDiff ? events : [events[0]]));
    });
    const w = mountApp(RunRow, {
      props: { run, now: 1000 },
      seed: { page: "runs", all: false, mine: false, retentionDays: null, now: 1000, rows: [] },
      eventSource: streams.factory,
    });
    await flushPromises();
    expect(requests).toEqual([]);
    await w.get("a.run-pr").trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] [role="tab"]')).not.toBeNull());
    expect(streams.created).toEqual([]);
    const pick = (label: string) =>
      (
        Array.from(document.querySelectorAll('[role="dialog"] [role="tab"]')).find((tab) =>
          tab.textContent?.includes(label),
        ) as HTMLElement
      ).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    pick("Checks");
    await flushPromises();
    const source = streams.created[0];
    expect(source.url).toBe("/api/review.checks?id=code-1");
    const snapshot = {
      repo: "acme/api",
      number: 42,
      headSha: "a".repeat(40),
      checkedSha: "a".repeat(40),
      state: "OPEN",
      checkedAt: 1000,
      checks: [{ id: "ci", name: "ci / test", status: "in_progress", required: true }],
      warnings: [],
    };
    source.emitMessage(snapshot);
    await flushPromises();
    expect(document.querySelector('[data-testid="pr-checks"]')?.textContent).toContain("ci / test");
    pick("Files changed");
    await flushPromises();
    expect(source.closed).toBe(false);
    source.emitMessage({ ...snapshot, checks: [{ ...snapshot.checks[0], status: "success" }] });
    pick("Checks");
    await flushPromises();
    expect(document.querySelector('[data-testid="checks-summary"]')?.textContent).toBe("All checks have passed");
    expect(streams.created).toHaveLength(1);
    expect(document.querySelector('[data-testid="pr-checks"]')?.textContent).not.toContain("Refresh");
    (document.querySelector('[data-testid="panel-close"]') as HTMLElement).click();
    await flushPromises();
    expect(source.closed).toBe(true);
    withDiff = false;
    await w.get("a.run-pr").trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] [role="tab"]')).not.toBeNull());
    expect(streams.created).toHaveLength(1);
    pick("Checks");
    await flushPromises();
    expect(streams.created).toHaveLength(2);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("No diff was recorded");
    w.unmount();
    expect(streams.created[1].closed).toBe(true);
  });
  it("links coding and published review PRs, and omits unknown or invalid PRs", () => {
    expect(mountRow().get("a.run-pr").attributes("href")).toBe("https://github.com/acme/api/pull/42");
    const review = mountRow({
      ...run,
      pr: undefined,
      reviewPost: { posted: true, target: { repo: "acme/api", number: 7 }, head: "abc1234" },
    });
    expect(review.get("a.run-pr").attributes("href")).toBe("https://github.com/acme/api/pull/7");
    expect(
      mountRow({ ...run, pr: undefined })
        .find("a.run-pr")
        .exists(),
    ).toBe(false);
    expect(
      mountRow({ ...run, repo: "acme/other/private" })
        .find("a.run-pr")
        .exists(),
    ).toBe(false);
  });

  it("opens the recorded diff in a dialog on an ordinary click and closes it", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (address: string) => {
      requests.push(address);
      if (address.startsWith("/api/review.status")) return Response.json({ state: "absent" });
      return Response.json(seed(events));
    });
    const w = mountRow();
    await flushPromises();
    await w.get("a.run-pr").trigger("click");
    await flushPromises();
    expect(requests).toEqual(["/runs/code-1", "/api/review.status?id=code-1"]);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("acme/api#42");
    expect(dialog.querySelector('[data-testid="pr-review-panel"]')).not.toBeNull();
    await vi.waitFor(() =>
      expect(dialog.querySelector('[data-testid="files-changed"]')?.textContent).toContain("a.ts"),
    );
    (dialog.querySelector('[data-testid="panel-close"]') as HTMLElement).click();
    await flushPromises();
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
    "keeps native GitHub navigation for %j without loading a diff",
    async (options) => {
      const requests: string[] = [];
      vi.stubGlobal("fetch", async (address: string) => {
        requests.push(address);
        return Response.json(seed(events));
      });
      const w = mountRow();
      await flushPromises();
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
      let nativeNavigationAllowed = false;
      w.element.addEventListener("click", (event: Event) => {
        nativeNavigationAllowed = !event.defaultPrevented;
        event.preventDefault();
      });
      w.get("a.run-pr").element.dispatchEvent(event);
      await flushPromises();
      expect(nativeNavigationAllowed).toBe(true);
      expect(w.get("a.run-pr").attributes("target")).toBe("_blank");
      expect(requests).toEqual([]);
    },
  );

  it.each([null, seed([]), seed([{ ...events[0], pr: 99 }, events[1]])])(
    "shows a GitHub fallback when the authorized run has no matching diff",
    async (response) => {
      vi.stubGlobal("fetch", async () => Response.json(response));
      const w = mountRow();
      await flushPromises();
      await w.get("a.run-pr").trigger("click");
      await flushPromises();
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain(response === null ? "Could not load" : "No diff was recorded");
      expect(dialog.querySelector('a[href="https://github.com/acme/api/pull/42"]')?.textContent).toContain("GitHub");
      expect(dialog.querySelector('[data-testid="pr-review-panel"]')).toBeNull();
    },
  );

  it("discards a late response when the row changes", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const current = reactive({ ...run });
    const w = mountRow(current);
    await flushPromises();
    await w.get("a.run-pr").trigger("click");
    current.id = "code-2";
    current.pr = { number: 43, url: "https://github.com/acme/api/pull/43" };
    await flushPromises();
    finish(Response.json(seed(events)));
    await flushPromises();
    expect(w.get("a.run-pr").attributes("href")).toBe("https://github.com/acme/api/pull/43");
    expect(document.querySelector('[data-testid="pr-review-panel"]')).toBeNull();
  });

  it("reads a live run's authorized stream and releases it on close", async () => {
    const sources = fakeEventSourceFactory();
    vi.stubGlobal("fetch", async () =>
      Response.json({
        ...seed([]),
        mode: "live",
        eventsUrl: "/runs/code-1/events?t=token",
        serverNow: 1000,
      }),
    );
    const w = mountApp(RunRow, {
      props: { run: { ...run, finished: false, token: "token" }, now: 1000 },
      seed: { page: "runs", all: false, mine: false, retentionDays: null, now: 1000, rows: [] },
      eventSource: sources.factory,
    });
    await flushPromises();
    await w.get("a.run-pr").trigger("click");
    await flushPromises();
    expect(sources.created[0].url).toBe("/runs/code-1/events?t=token&follow=1");
    sources.created[0].emitMessage(events[0], "1");
    sources.created[0].emitMessage(events[1], "2");
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="pr-review-panel"]')?.textContent).toContain("acme/api#42"),
    );
    const pick = () =>
      (
        Array.from(document.querySelectorAll('[role="dialog"] [role="tab"]')).find(
          (tab) => tab.textContent === "Checks",
        ) as HTMLElement
      ).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    pick();
    await flushPromises();
    sources.created[1].emitMessage({
      repo: "acme/api",
      number: 42,
      headSha: "a".repeat(40),
      checkedSha: "a".repeat(40),
      state: "OPEN",
      checkedAt: 1000,
      warnings: [],
      checks: [{ id: "ci", name: "ci / test", status: "in_progress", required: true }],
    });
    await flushPromises();
    expect(document.querySelector('[data-testid="pr-checks"]')?.textContent).toContain("ci / test");
    sources.created[0].emitMessage(
      {
        type: "review_artifact",
        artifact: "pr_description",
        repo: "acme/api",
        pr: 42,
        origin: "parsed",
        title: "New description",
        body: "Description",
        complete: false,
        truncated: false,
      },
      "3",
    );
    await flushPromises();
    expect(document.querySelector('[data-testid="pr-title"]')?.textContent).toBe("New description");
    sources.created[1].emitMessage({
      repo: "acme/api",
      number: 42,
      headSha: "a".repeat(40),
      checkedSha: "a".repeat(40),
      state: "OPEN",
      checkedAt: 2000,
      warnings: [],
      checks: [{ id: "ci", name: "ci / test", status: "success", required: true }],
    });
    await flushPromises();
    expect(document.querySelector('[data-testid="checks-summary"]')?.textContent).toBe("All checks have passed");
    expect(sources.created[1].closed).toBe(false);
    (document.querySelector('[data-testid="panel-close"]') as HTMLElement).click();
    await flushPromises();
    expect(sources.created.map((source) => source.closed)).toEqual([true, true]);
  });
});
