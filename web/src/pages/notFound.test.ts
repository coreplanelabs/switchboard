import { describe, expect, it } from "vitest";
import NotFoundPage from "./NotFoundPage.vue";
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
