import { describe, expect, it } from "vitest";
import { formatElapsed, splitRunLabel } from "./indexFormat.js";

// Feature: features/live-view.md item 16 — the runs index shows how long each
// run has been going (live) or took (finished), and renders the run label as
// agent · scope · request so the eye lands on what matters.

describe("formatElapsed", () => {
  it("reads like a stopwatch: seconds, then m s, then h m — always two-part above a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(38_400)).toBe("38s");
    expect(formatElapsed(252_000)).toBe("4m 12s");
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(3_780_000)).toBe("1h 03m");
    expect(formatElapsed(26 * 3_600_000)).toBe("26h 00m");
  });

  it("clamps garbage (negative, NaN) to 0s instead of printing nonsense", () => {
    expect(formatElapsed(-5000)).toBe("0s");
    expect(formatElapsed(NaN)).toBe("0s");
  });
});

describe("splitRunLabel", () => {
  it("splits the dispatcher's `agent · scope · \"snippet\"` label into its parts", () => {
    expect(splitRunLabel('review · coreplanelabs/switchboard · "github.com/coreplanelabs/switchboard/pull/268 — re-review:…"')).toEqual({
      agent: "review",
      scope: "coreplanelabs/switchboard",
      snippet: "github.com/coreplanelabs/switchboard/pull/268 — re-review:…",
    });
    expect(splitRunLabel('general · #switchboard-prompting · justin · "hello there"')).toEqual({
      agent: "general",
      scope: "#switchboard-prompting · justin",
      snippet: "hello there",
    });
  });

  it("degrades gracefully: no snippet, no agent, or an arbitrary label", () => {
    expect(splitRunLabel("coding · acme/web")).toEqual({ agent: "coding", scope: "acme/web" });
    expect(splitRunLabel("Some Label · with · dots")).toEqual({ scope: "Some Label · with · dots" });
    expect(splitRunLabel("8f3a1c2e…")).toEqual({ scope: "8f3a1c2e…" });
    expect(splitRunLabel("")).toEqual({ scope: "" });
  });

  it("is inlinable into the index page (no imports, works under `String(fn)`)", () => {
    for (const fn of [formatElapsed, splitRunLabel]) {
      const src = String(fn);
      expect(src).not.toMatch(/\brequire\(|\bimport\b/);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      expect(typeof new Function(`var __name = function (f) { return f; }; return (${src});`)()).toBe("function");
    }
  });
});
