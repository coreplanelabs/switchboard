import { describe, expect, it } from "vitest";
import { parseIngressTokenMap, RETIRED_TOKEN_FIELD, tokenForSubject } from "./ingressTokens.js";

// Feature: docs/reference/specs/http-ingress.md — the ONE parser of SWITCHBOARD_INGRESS_TOKENS,
// shared by the bot's ingress adapters and the Worker shim. Node-free. A
// token is a credential: subject (+ the channel its dispatches are recorded
// under); what its bearer may do is config's `grants` (authorization.md item 9).

describe("parseIngressTokenMap", () => {
  it("parses a valid map, keeping `channel` only when present", () => {
    const parsed = parseIngressTokenMap(
      JSON.stringify({ s3cr3t: { subject: "alice", channel: "ops" }, t2: { subject: "bob" } }),
    );
    expect(parsed).toEqual({
      ok: true,
      tokens: { s3cr3t: { subject: "alice", channel: "ops" }, t2: { subject: "bob" } },
      warnings: [],
    });
    expect("channel" in parsed.tokens.t2).toBe(false);
  });

  it("absent / blank → ok with an empty map (the caller treats empty as disabled)", () => {
    expect(parseIngressTokenMap(undefined)).toEqual({ ok: true, tokens: {}, warnings: [] });
    expect(parseIngressTokenMap("   ")).toEqual({ ok: true, tokens: {}, warnings: [] });
  });

  it("not JSON / not an object → ok:false with a reason and an empty map (never open)", () => {
    expect(parseIngressTokenMap("{oops")).toEqual({ ok: false, reason: "not valid JSON", tokens: {}, warnings: [] });
    expect(parseIngressTokenMap("[1,2]")).toEqual({
      ok: false,
      reason: "must be a JSON object",
      tokens: {},
      warnings: [],
    });
    expect(parseIngressTokenMap("null")).toEqual({
      ok: false,
      reason: "must be a JSON object",
      tokens: {},
      warnings: [],
    });
  });

  it("skips malformed entries (empty token, non-object, missing/blank subject, non-string channel) and keeps the rest", () => {
    const parsed = parseIngressTokenMap(
      JSON.stringify({
        good: { subject: "alice" },
        noSubject: { channel: "ops" },
        blankSubject: { subject: "" },
        badChannel: { subject: "x", channel: 5 },
        notObject: "nope",
        "": { subject: "empty-token" },
      }),
    );
    expect(parsed).toEqual({ ok: true, tokens: { good: { subject: "alice" } }, warnings: [] });
  });

  it("the retired `scopes` field grants nothing: the entry is kept as a credential (never dropped, never widened) and a warning names the subject — not the token — and the replacement", () => {
    const parsed = parseIngressTokenMap(
      JSON.stringify({
        plain: { subject: "a" },
        legacy: { subject: "b", channel: "ops", scopes: ["dispatch", "runs:read"] },
        weird: { subject: "c", scopes: "runs:write" },
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.tokens).toEqual({
      plain: { subject: "a" },
      legacy: { subject: "b", channel: "ops" },
      weird: { subject: "c" },
    });
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[0]).toContain(`entry for subject "b" carries \`${RETIRED_TOKEN_FIELD}\``);
    expect(parsed.warnings[0]).toContain("grants entry for http:b / mcp:b");
    expect(parsed.warnings.join("\n")).not.toContain("legacy"); // the token material never appears
    expect(parsed.warnings.join("\n")).not.toContain("weird");
  });
});

describe("tokenForSubject", () => {
  const tokens = {
    a: { subject: "cron", channel: "cron" },
    b: { subject: "ops-ingress" },
  };

  it("returns the one token mapped to the subject", () => {
    expect(tokenForSubject(tokens, "cron")).toBe("a");
    expect(tokenForSubject(tokens, "ops-ingress")).toBe("b");
  });

  it("unknown subject → undefined; two tokens for one subject → undefined (ambiguity is refused, not guessed)", () => {
    expect(tokenForSubject(tokens, "nobody")).toBeUndefined();
    expect(tokenForSubject({ ...tokens, c: { subject: "cron" } }, "cron")).toBeUndefined();
  });
});
