import { describe, expect, it } from "vitest";
import { formatDateTime, formatRelative, splitRunLabel } from "./indexFormat.js";

// Feature: features/live-view.md item 16 — the runs index shows how long each
// run has been going (live) or took (finished), and renders the run label as
// agent · scope · request so the eye lands on what matters.

describe("formatDateTime (live-view item 21)", () => {
  it("reads Aug 30, 9:12 PM in the runtime's zone; noon and midnight are 12; the year only when it differs from now's", () => {
    const at = new Date(2026, 7, 30, 21, 12).getTime();
    expect(formatDateTime(at, at)).toBe("Aug 30, 9:12 PM");
    expect(formatDateTime(new Date(2026, 0, 5, 0, 3).getTime(), at)).toBe("Jan 5, 12:03 AM");
    expect(formatDateTime(new Date(2026, 0, 5, 12, 0).getTime(), at)).toBe("Jan 5, 12:00 PM");
    expect(formatDateTime(new Date(2025, 11, 31, 8, 30).getTime(), at)).toBe("Dec 31, 2025, 8:30 AM");
  });
});

describe("formatRelative", () => {
  const now = Date.UTC(2026, 7, 30, 18, 0, 0);
  it("reads like GitHub: just now → minutes → hours → yesterday/days → a date", () => {
    expect(formatRelative(now - 10_000, now)).toBe("just now");
    expect(formatRelative(now - 44_000, now)).toBe("just now");
    expect(formatRelative(now - 46_000, now)).toBe("1 minute ago");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelative(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(formatRelative(now - 24 * 3_600_000, now)).toBe("yesterday");
    expect(formatRelative(now - 3 * 86_400_000, now)).toBe("3 days ago");
    expect(formatRelative(now - 8 * 86_400_000, now)).toMatch(/^Aug 2[12]$/); // the runtime's zone decides the day
    expect(formatRelative(Date.UTC(2025, 11, 25, 12), now)).toMatch(/^Dec 2[45], 2025$/); // another year keeps its year
  });

  it("never says a negative or NaN age", () => {
    expect(formatRelative(now + 60_000, now)).toBe("just now");
    expect(formatRelative(NaN, now)).toBe("just now");
  });

  it("is inlinable (no imports)", () => {
    expect(String(formatRelative)).not.toMatch(/\brequire\(|\bimport\b/);
  });
});

describe("splitRunLabel", () => {
  it('splits the dispatcher\'s `agent · scope · "snippet"` label into its parts', () => {
    expect(splitRunLabel('review · acme/api · "github.com/acme/api/pull/268 — re-review:…"')).toEqual({
      agent: "review",
      scope: "acme/api",
      snippet: "github.com/acme/api/pull/268 — re-review:…",
    });
    expect(splitRunLabel('general · #eng-prompting · ada · "hello there"')).toEqual({
      agent: "general",
      scope: "#eng-prompting · ada",
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
    for (const fn of [splitRunLabel]) {
      const src = String(fn);
      expect(src).not.toMatch(/\brequire\(|\bimport\b/);

      expect(typeof new Function(`var __name = function (f) { return f; }; return (${src});`)()).toBe("function");
    }
  });
});
