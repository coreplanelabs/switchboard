import { describe, expect, it } from "vitest";
import { parseIngressTokenMap, tokenForSubject } from "./ingressTokens.js";

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
    });
    expect("channel" in parsed.tokens.t2).toBe(false);
  });

  it("absent / blank → ok with an empty map (the caller treats empty as disabled)", () => {
    expect(parseIngressTokenMap(undefined)).toEqual({ ok: true, tokens: {} });
    expect(parseIngressTokenMap("   ")).toEqual({ ok: true, tokens: {} });
  });

  it("not JSON / not an object → ok:false with a reason and an empty map (never open)", () => {
    expect(parseIngressTokenMap("{oops")).toEqual({ ok: false, reason: "not valid JSON", tokens: {} });
    expect(parseIngressTokenMap("[1,2]")).toEqual({ ok: false, reason: "must be a JSON object", tokens: {} });
    expect(parseIngressTokenMap("null")).toEqual({ ok: false, reason: "must be a JSON object", tokens: {} });
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
    expect(parsed).toEqual({ ok: true, tokens: { good: { subject: "alice" } } });
  });

  it("an identity is exactly { subject, channel? }: any other field in an entry (`scopes`, a typo) is ignored — nothing in the token map can widen what the grants entry says", () => {
    const parsed = parseIngressTokenMap(
      JSON.stringify({
        plain: { subject: "a" },
        withScopes: { subject: "b", channel: "ops", scopes: ["dispatch", "runs:read"] },
        typo: { subject: "c", chanel: "ops", actions: "all" },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      tokens: {
        plain: { subject: "a" },
        withScopes: { subject: "b", channel: "ops" },
        typo: { subject: "c" },
      },
    });
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
