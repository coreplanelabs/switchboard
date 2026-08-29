import { describe, expect, it } from "vitest";
import { TOOL_OUTPUT_CAP, parseExitPrefix, prepareToolOutput, redactAndCap, redactSecrets, summarizeToolResult } from "./runEvents.js";

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

  // Review round 2: realistic shapes that previously leaked (curl/env/cloud/
  // connection strings), plus the `\b`-boundary bug on `*_KEY`/`*_SECRET` names.
  it("redacts realistic env / curl / cloud / connection-string secrets", () => {
    const cases: Array<[string, string]> = [
      ["curl -u admin:SuperSecretPass123 https://x", "SuperSecretPass123"],
      ["DATABASE_URL=postgres://appuser:hunter2hunter2@db.internal:5432/prod", "hunter2hunter2"],
      ["Set-Cookie: session=abcdef0123456789abcdef0123456789; Path=/", "abcdef0123456789"],
      ["Cookie: sessionid=zzzzzzzzzzzzzzzzzzzz", "zzzzzzzzzzzzzzzzzzzz"],
      ["Authorization: Basic dXNlcjpTdXBlclNlY3JldFBhc3N3b3Jk", "dXNlcjpTdXBlclNlY3JldFBhc3N3b3Jk"],
      ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEX", "wJalrXUtnFEMIK7MDENGbPxRfiCYEX"],
      ["aws_secret_access_key = wJalrXUtnFEMIbPxRfiCYEXKEY", "wJalrXUtnFEMIbPxRfiCYEXKEY"],
      ["STRIPE_WEBHOOK_SECRET=whsec_qqqqqqqqqqqqqqqqqqqqqqqq", "whsec_qqqqqqqqqqqqqqqqqqqqqqqq"],
      ["GOOGLE_API_KEY=AIzaSyD-abcdefghijklmnopqrstuvwxyz01234", "AIzaSyD-abcdefghijklmnopqrstuvwxyz01234"],
      ['"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----\\n"', "MIIEvQ"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaA"],
    ];
    for (const [input, leaked] of cases) {
      const out = redactSecrets(input);
      expect(out, input).toContain("«redacted");
      expect(out, input).not.toContain(leaked);
    }
  });

  it("does not over-redact ordinary config / output (no false positives)", () => {
    const safe = [
      "PORT=3000",
      "REACT_VERSION=18.2.0",
      "MONKEY_BARS=playground",
      "commit abc123def4567890abc123def4567890abcdef12",
      "digest sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    ];
    for (const s of safe) expect(redactSecrets(s), s).toBe(s);
  });
});

describe("redactAndCap", () => {
  it("strips terminal escapes", () => {
    expect(redactAndCap("\x1b[1mgit\x1b[0m status")).toBe("git status");
  });

  it("redacts BEFORE capping — a secret near the boundary never leaks as a fragment", () => {
    const token = "ghp_" + "A".repeat(40);
    const out = redactAndCap("x".repeat(190) + " " + token, 200);
    expect(out).not.toContain("ghp_AAAA");
    expect(out).toContain("«redacted");
  });
  it("caps length after redaction", () => {
    expect(redactAndCap("y".repeat(500), 200).length).toBeLessThanOrEqual(201);
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

  it("strips ANSI color/style escapes so vitest-style output reads as plain text", () => {
    const s = summarizeToolResult("\x1b[32m✓\x1b[39m src/tools/skills.test.ts \x1b[2m(\x1b[22m\x1b[2m9 tests\x1b[22m\x1b[2m)\x1b[22m \x1b[32m 11\x1b[2mms\x1b[22m\x1b[39m\nline2");
    expect(s).toContain("✓ src/tools/skills.test.ts (9 tests)  11ms");
    expect(s).not.toMatch(/\x1b|\[\d+m/);
  });

  it("strips OSC hyperlinks and cursor-control sequences", () => {
    const s = summarizeToolResult("\x1b]8;;https://x.test\x07link\x1b]8;;\x07 \x1b[2K\x1b[1Adone\r");
    expect(s).toBe("link done");
  });

  it("drops the payload of an OSC sequence cut off by truncation", () => {
    expect(summarizeToolResult("see \x1b]8;;https://x.test/very/long\nnext")).toBe("see (9 chars, 2 lines)");
  });

  it("strips escapes before redacting so a mid-token escape cannot split a secret", () => {
    const s = summarizeToolResult("token=ghp_\x1b[0m" + "A".repeat(36));
    expect(s).not.toContain("AAAA");
    expect(s).toContain("«redacted");
  });

  it("counts chars/lines on the stripped text", () => {
    const s = summarizeToolResult("\x1b[32mok\x1b[39m\nb");
    expect(s).toBe("ok (4 chars, 2 lines)");
  });

  it("redacts secrets in the summary", () => {
    const s = summarizeToolResult("deploy token=ghp_" + "A".repeat(36));
    expect(s).not.toContain("ghp_AAAA");
    expect(s).toContain("«redacted");
  });
});

// Feature: features/live-view.md item 13 — the run page shows each tool call
// as a card with its real exit status and its (bounded) output inside.
describe("parseExitPrefix", () => {
  it("reads the numeric exit code every executor prefixes nonzero output with", () => {
    expect(parseExitPrefix("exit 128: fatal: not a git repository\nmore")).toEqual({ failed: true, exitCode: 128 });
    expect(parseExitPrefix("exit 1:\n--- stderr ---\nno match")).toEqual({ failed: true, exitCode: 1 });
  });
  it("treats a non-numeric code (execFile errno / 'error') as failed without an exit code", () => {
    expect(parseExitPrefix("exit ETIMEDOUT: spawn timed out")).toEqual({ failed: true });
    expect(parseExitPrefix("exit error: something")).toEqual({ failed: true });
  });
  it("is a clean pass for ordinary output, even output that mentions 'exit' later", () => {
    expect(parseExitPrefix("ok")).toEqual({ failed: false, exitCode: 0 });
    expect(parseExitPrefix("(no output)")).toEqual({ failed: false, exitCode: 0 });
    expect(parseExitPrefix("the script calls exit 1: when done")).toEqual({ failed: false, exitCode: 0 });
    expect(parseExitPrefix("")).toEqual({ failed: false, exitCode: 0 });
  });
  it("ignores a leading ANSI escape or whitespace before the prefix", () => {
    expect(parseExitPrefix("\x1b[31mexit 2: boom")).toEqual({ failed: true, exitCode: 2 });
    expect(parseExitPrefix("\n exit 3: boom")).toEqual({ failed: true, exitCode: 3 });
  });
});

describe("prepareToolOutput", () => {
  it("strips escapes, redacts, and returns the text unchanged otherwise", () => {
    const out = prepareToolOutput("\x1b[32mPASS\x1b[0m token=ghp_" + "A".repeat(36) + "\nline 2");
    expect(out).toBe("PASS token=«redacted»\nline 2");
  });
  it("caps at TOOL_OUTPUT_CAP chars AFTER redacting, with a visible note of what was cut", () => {
    const secret = "ghp_" + "B".repeat(36);
    const text = "x".repeat(TOOL_OUTPUT_CAP - 10) + secret + "y".repeat(500);
    const out = prepareToolOutput(text);
    expect(out.length).toBeLessThan(TOOL_OUTPUT_CAP + 80);
    expect(out).not.toContain("ghp_BBBB");
    expect(out).toMatch(/…\[\d+ more chars\]$/);
  });
  it("returns an empty string for empty/whitespace output", () => {
    expect(prepareToolOutput("")).toBe("");
    expect(prepareToolOutput("  \n ")).toBe("");
  });
});
