import { describe, expect, it } from "vitest";
import NotFoundPage from "../../green/pages/NotFound.vue";
import RunRoutePage from "../../green/pages/RunRoute.vue";
import { mountApp } from "../testing/mount";

describe("NotFoundPage (run 404, item 19)", () => {
  it("shows the non-revealing message, the retention sentence, and the way back — static text only", () => {
    const w = mountApp(NotFoundPage, { seed: { page: "runNotFound", retentionDays: 7 } });
    expect(w.find("h3").text()).toBe("This page is unavailable");
    expect(w.text()).toContain("This page is unavailable");
    expect(w.text()).toContain("The address is unknown or cannot be viewed with your current access.");
    expect(w.text()).toContain("Finished runs are kept for 7 days, then deleted");
    expect(w.find('a[href="/runs"]').attributes("href")).toBe("/runs");
  });

  it("states the registry TTL when run history is off", () => {
    const w = mountApp(NotFoundPage, { seed: { page: "runNotFound", retentionDays: null } });
    expect(w.text()).toContain("History is off; finished runs are kept about a minute.");
  });
});

describe("RunRoutePage (the /runs/:id dispatch)", () => {
  it("renders the 404 for a runNotFound seed — never an empty live scaffold", () => {
    const w = mountApp(RunRoutePage, { seed: { page: "runNotFound", retentionDays: 7 } });
    expect(w.text()).toContain("This page is unavailable");
    expect(w.find("#actions").exists()).toBe(false);
    expect(w.find("#tail").exists()).toBe(false);
  });

  it("renders the 404 with no seed at all (a shell served without an island must not pretend a run exists)", () => {
    const w = mountApp(RunRoutePage, { seed: null });
    expect(w.text()).toContain("This page is unavailable");
  });

  it("renders the run page for a run seed", () => {
    const w = mountApp(RunRoutePage, {
      seed: { page: "run", mode: "history", id: "r1", events: [], eventCount: 0, startedAt: 1 },
    });
    expect(w.find("h1").text()).toBe("Run details");
    expect(w.text()).not.toContain("This page is unavailable");
  });
});
