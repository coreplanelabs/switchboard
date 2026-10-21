import { describe, expect, it } from "vitest";
import { wrapUntrusted } from "@core/core/untrusted.js";
import { createPrChecks } from "./prChecks";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";

const snapshot = {
  repo: "acme/api",
  number: 7,
  headSha: "a".repeat(40),
  checkedSha: "a".repeat(40),
  state: "OPEN",
  checkedAt: 1000,
  warnings: [],
  checks: [{ id: "test", name: "ci / test", status: "in_progress", required: true }],
};
describe("PR checks stream", () => {
  it("opens on demand, receives replacement snapshots, retains stale data on failure and closes on disposal", () => {
    const streams = fakeEventSourceFactory();
    const control = createPrChecks("run-1", { repo: "acme/api", number: 7 }, streams.factory);
    expect(streams.created).toEqual([]);
    control.start();
    const source = streams.created[0];
    expect(source.url).toBe("/api/review.checks?id=run-1");
    source.emitMessage({
      ...snapshot,
      checks: [
        {
          ...snapshot.checks[0],
          name: wrapUntrusted("ci / test"),
          description: wrapUntrusted("Tests are running"),
          provider: wrapUntrusted("CI provider"),
        },
      ],
    });
    expect(control.snapshot?.rows).toEqual([
      {
        id: "test",
        name: "ci / test",
        description: "Tests are running",
        provider: "CI provider",
        status: "in_progress",
        required: true,
      },
    ]);
    source.emitError();
    expect(control.error).toBe("The checks stream was interrupted. Reconnecting…");
    expect(control.snapshot?.headSha).toBe("a".repeat(40));
    source.emitNamed("unavailable", JSON.stringify({ message: "GitHub is unavailable", retry: true }));
    expect(control.error).toBe("GitHub is unavailable");
    source.emitMessage({ ...snapshot, checks: [{ ...snapshot.checks[0], status: "success" }] });
    expect(control.error).toBe("");
    expect(control.snapshot?.rows[0].status).toBe("success");
    control.start();
    expect(streams.created).toHaveLength(1);
    control.dispose();
    expect(source.closed).toBe(true);
    source.emitMessage(snapshot);
    expect(control.snapshot?.rows[0].status).toBe("success");
  });
  it("refuses a different PR and stops retrying after access is refused", () => {
    const streams = fakeEventSourceFactory();
    const control = createPrChecks("run-1", { repo: "acme/api", number: 8 }, streams.factory);
    control.start();
    const source = streams.created[0];
    source.emitMessage(snapshot);
    expect(control.error).toBe("GitHub returned an incomplete checks response.");
    expect(control.snapshot).toBeUndefined();
    source.emitNamed("unavailable", JSON.stringify({ message: "This run is unavailable", retry: false }));
    expect(control.error).toBe("This run is unavailable");
    expect(source.closed).toBe(true);
    control.dispose();
  });
});
