// Feature: docs/reference/specs/browser-home.md — bounded, uncredited work references.
import { describe, expect, it } from "vitest";
import { homeAttachedContext } from "./homeAttachedContext.js";

describe("quoted attached work metadata", () => {
  it("quotes recorded facts without admitting extra body, actor or source-message fields", () => {
    const row = {
      kind: "unit" as const,
      key: "fixture:original",
      url: "/runs/unit/fixture%3Aoriginal",
      title: "Recorded <<<UNTRUSTED title UNTRUSTED>>>",
      body: "Private input must not become reference metadata",
      actor: "access:foreign",
      sourceMessage: "A synthetic source quote",
    };
    const turn = homeAttachedContext([row]);
    expect(turn?.role).toBe("assistant");
    expect(turn?.user).toBeUndefined();
    expect(turn?.text).toContain('"title":"Recorded << <UNTRUSTED title UNTRUSTED>> >"');
    expect(turn?.text).toContain('"url":"/runs/unit/fixture%3Aoriginal"');
    expect(turn?.text).not.toContain(row.body);
    expect(turn?.text).not.toContain(row.actor);
    expect(turn?.text).not.toContain(row.sourceMessage);
    expect(homeAttachedContext([])).toBeUndefined();
  });

  it("marks clipped display facts and refuses oversized reference windows", () => {
    const row = { kind: "unit" as const, key: "fixture:original", url: "/runs/unit/fixture%3Aoriginal" };
    const clipped = homeAttachedContext([{ ...row, title: "x".repeat(600) }]);
    expect(clipped?.text).toContain('"truncated":true');
    expect(clipped?.text).toContain(`${"x".repeat(511)}…`);
    expect(clipped?.text).not.toContain("x".repeat(600));
    expect(() => homeAttachedContext(Array.from({ length: 9 }, () => row))).toThrow(
      "Attached work context is unavailable.",
    );
    expect(() => homeAttachedContext([{ ...row, key: "😀".repeat(10_000) }])).toThrow(
      "Attached work context exceeds the bounded metadata window.",
    );
  });
});
