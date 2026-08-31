import { describe, expect, it } from "vitest";
import NotFoundPage from "./NotFoundPage.vue";
import RunRoutePage from "./RunRoutePage.vue";
import { mountApp } from "../testing/mount";

describe("NotFoundPage (run 404, item 19)", () => {
  it("shows the non-revealing message, the retention sentence, and the way back — static text only", () => {
    const w = mountApp(NotFoundPage, { seed: { page: "runNotFound", retentionDays: 7 } });
    expect(w.find(".code").text()).toBe("404");
    expect(w.text()).toContain("That run isn't here.");
    expect(w.text()).toContain("this page says the same thing in every case");
    expect(w.text()).toContain("Finished runs are kept for 7 days, then deleted");
    expect(w.find("a.back").attributes("href")).toBe("/runs");
  });

  it("states the registry TTL when run history is off", () => {
    const w = mountApp(NotFoundPage, { seed: { page: "runNotFound", retentionDays: null } });
    expect(w.text()).toContain("Run history is off; finished runs are kept about a minute.");
  });
});

describe("RunRoutePage (the /runs/:id dispatch)", () => {
  it("renders the 404 for a runNotFound seed — never an empty live scaffold", () => {
    const w = mountApp(RunRoutePage, { seed: { page: "runNotFound", retentionDays: 7 } });
    expect(w.text()).toContain("That run isn't here.");
    expect(w.find("#actions").exists()).toBe(false);
    expect(w.find("#tail").exists()).toBe(false);
  });

  it("renders the 404 with no seed at all (a shell served without an island must not pretend a run exists)", () => {
    const w = mountApp(RunRoutePage, { seed: null });
    expect(w.text()).toContain("That run isn't here.");
  });

  it("renders the run page for a run seed", () => {
    const w = mountApp(RunRoutePage, {
      seed: { page: "run", mode: "history", id: "r1", events: [], eventCount: 0 },
    });
    expect(w.find("h1").text()).toBe("Run");
    expect(w.text()).not.toContain("That run isn't here.");
  });
});
