import { describe, expect, it } from "vitest";
import { redactAndCap, redactSecrets, summarizeToolResult } from "./runEvents.js";

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

  it("redacts secrets in the summary", () => {
    const s = summarizeToolResult("deploy token=ghp_" + "A".repeat(36));
    expect(s).not.toContain("ghp_AAAA");
    expect(s).toContain("«redacted");
  });
});
