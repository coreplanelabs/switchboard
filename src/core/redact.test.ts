import { describe, expect, it } from "vitest";
import { oneLine, redactAndCap } from "./redact.js";

describe("oneLine", () => {
  it("keeps the first non-empty line and collapses its whitespace", () => {
    expect(oneLine("\n\n  resident   down \t (install failed)\nsecond line\n")).toBe("resident down (install failed)");
    expect(oneLine("")).toBe("");
    expect(oneLine("\n \n")).toBe("");
  });

  it("composes with redactAndCap for a title: one line, redacted, capped", () => {
    const title = oneLine(redactAndCap("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nmore", 120));
    expect(title).not.toContain("ghp_");
    expect(title).not.toContain("more");
  });
});
