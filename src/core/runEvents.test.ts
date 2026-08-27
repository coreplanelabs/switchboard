import { describe, expect, it } from "vitest";
import { redactSecrets, summarizeToolResult } from "./runEvents.js";

// Feature: features/run-visibility.md — the run-event stream and its redaction.

describe("redactSecrets", () => {
  it("redacts known credential shapes", () => {
    const cases = [
      "xoxb-123456789012-abcdefghijkl",
      "ghp_" + "A".repeat(36),
      "github_pat_" + "A".repeat(30),
      "https://x-access-token:ghs_secretvalue123456@github.com",
      "sk-ant-" + "a".repeat(40),
      "sk-" + "a".repeat(40),
      "AKIA" + "A".repeat(16),
      "Authorization: Bearer abcdef.ghijkl.mnopqr123456",
    ];
    for (const c of cases) {
      expect(redactSecrets(c), c).toContain("«redacted");
    }
  });

  it("redacts key=value secrets but keeps the key name", () => {
    const out = redactSecrets("API_KEY=supersecretvalue123");
    expect(out).toContain("API_KEY");
    expect(out).not.toContain("supersecretvalue123");
    expect(redactSecrets('password: "hunter2hunter2"')).not.toContain("hunter2hunter2");
  });

  it("leaves normal text (incl. the word 'token' in prose) untouched", () => {
    const t = "Ran 42 tests, all passed in 3.2s. The token bucket refilled. See src/foo.ts:12.";
    expect(redactSecrets(t)).toBe(t);
  });
});

describe("summarizeToolResult", () => {
  it("takes the first non-empty line and notes size for multi-line output", () => {
    const out = summarizeToolResult("\n\nfirst line\nsecond\nthird");
    expect(out).toContain("first line");
    expect(out).toMatch(/lines/);
  });

  it("caps a very long first line", () => {
    const s = summarizeToolResult("x".repeat(500));
    expect(s.length).toBeLessThan(260);
    expect(s).toContain("…");
  });

  it("handles empty output", () => {
    expect(summarizeToolResult("   ")).toBe("(no output)");
  });

  it("redacts secrets in the summary", () => {
    const s = summarizeToolResult("deploy token=ghp_" + "A".repeat(36));
    expect(s).not.toContain("ghp_AAAA");
    expect(s).toContain("«redacted");
  });
});
