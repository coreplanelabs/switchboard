import { describe, expect, it } from "vitest";
import { oneLine, redactAndCap } from "./redact.js";

describe("oneLine", () => {
  it("redacts named credentials after an error prefix without hiding the error code", () => {
    expect(redactAndCap("HEAD read failed: token=private-value")).toBe("HEAD read failed: token=«redacted»");
    expect(redactAndCap("github-token-mint-failed: HTTP 422 password=private-value")).toBe(
      "github-token-mint-failed: HTTP 422 password=«redacted»",
    );
  });
  it("redacts run bearers from earlier generations before truncating the text", () => {
    const token = `sbr_run-7.${"A".repeat(43)}`;
    expect(redactAndCap(`bearer=${token}`, 100)).toBe("bearer=«redacted-run-bearer»");
    expect(redactAndCap(`old ${token} then failure`, 10)).toBe("old «redac…");
  });

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
