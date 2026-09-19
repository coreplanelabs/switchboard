import { describe, expect, it } from "vitest";
import { reasonOf, timed } from "./reasons.js";

describe("reasonOf — the machine token inside a client's error", () => {
  it("finds the resident's named refusals wherever they sit in the message", () => {
    expect(
      reasonOf(new Error("resident attach failed for repo:x: user-pool-exhausted: all 16 thread users are allocated")),
    ).toBe("user-pool-exhausted");
    expect(reasonOf(new Error("resident attach failed for repo:x: mirror-busy: refresh holds the lock"))).toBe(
      "mirror-busy",
    );
    expect(reasonOf(new Error("resident attach failed for repo:x: disk-pressure: need 555 MB"))).toBe("disk-pressure");
  });

  it("finds the seed's tokens — the handle gone, a step failed, a Worker without presigned transfer", () => {
    expect(reasonOf(new Error("seed-missing: restore: Backup not found: 3f2a…"))).toBe("seed-missing");
    expect(reasonOf(new Error("seed-failed: fixup: fix-up exited 128"))).toBe("seed-failed");
    expect(reasonOf(new Error("seed-unconfigured: presigned R2 transfer needs R2_ACCESS_KEY_ID"))).toBe(
      "seed-unconfigured",
    );
  });

  it("maps the sandbox capacity error and the not-onboarded answer to their tokens", () => {
    expect(reasonOf(new Error("sandbox fleet busy — no free per-thread sandbox after waiting 300s"))).toBe(
      "fleet-busy",
    );
    expect(reasonOf(new Error("resident attach: repo:x is not onboarded (404)"))).toBe("not-onboarded");
  });

  it("recognizes rate limiting as `rate-limited`, before the timeout rule", () => {
    expect(reasonOf(new Error("HTTP 429 Too Many Requests"))).toBe("rate-limited");
    expect(reasonOf(new Error("Rate Limit exceeded, retry later"))).toBe("rate-limited");
    expect(reasonOf(new Error("rate limit hit: request timed out"))).toBe("rate-limited");
    expect(reasonOf(new Error("request timed out"))).toBe("timeout");
    expect(reasonOf(new Error("resident attach failed for repo:x: rate-limited: upstream throttled"))).toBe(
      "rate-limited",
    );
    expect(reasonOf(new Error("request took 14290 ms"))).not.toBe("rate-limited");
  });

  it("a fetch timeout is `timeout`; anything else is `unknown`, never a message fragment", () => {
    const t = new Error("The operation was aborted due to timeout");
    t.name = "TimeoutError";
    expect(reasonOf(t)).toBe("timeout");
    expect(reasonOf(new Error("something odd"))).toBe("unknown");
    expect(reasonOf("string error")).toBe("unknown");
  });

  it("a non-Error value that coerces to a string naming a known token is recognised", () => {
    // String(value) path: the token is found even when no Error object is thrown
    expect(reasonOf("runtime-replaced: a newer runtime took over")).toBe("runtime-replaced");
    expect(reasonOf({ toString: () => "needs-ref: branch was not supplied" })).toBe("needs-ref");
    expect(reasonOf("disk-pressure: volume full")).toBe("disk-pressure");
    expect(reasonOf("completely unrecognized")).toBe("unknown");
  });

  it("a known token beats the timeout rule when both appear in the same message", () => {
    // KNOWN_REASONS scan runs before the /TimeoutError|timed out|timeout/i branch;
    // `not-attached` wins even though the message also reads as a timeout
    expect(reasonOf(new Error("not-attached: sandbox timed out waiting for attach"))).toBe("not-attached");
  });

  it("the error's .name is included in the scan so a known token there is recognized", () => {
    const e = new Error("attach step failed");
    e.name = "mirror-busy";
    expect(reasonOf(e)).toBe("mirror-busy");
  });

  it("an AggregateError with an empty message whose first inner error names a known token is unknown", () => {
    // reasonOf builds the scan string from err.name + err.message only; it does
    // not walk AggregateError#errors, so the inner token is not reached and the
    // result is `unknown`.
    const inner = new Error("disk-pressure: volume full");
    const agg = new AggregateError([inner], "");
    expect(reasonOf(agg)).toBe("unknown");
  });

  it("a plain object with a message property that names a known token is unknown", () => {
    // The value is not instanceof Error so reasonOf calls String(value), which
    // yields '[object Object]' — the token in .message is not reached.
    const obj = { message: "seed-missing: backup gone" };
    expect(reasonOf(obj)).toBe("unknown");
  });
});

describe("timed", () => {
  it("measures a resolved call and carries its value; a rejected call is ok:false with the error, never a throw", async () => {
    let t = 0;
    const now = () => t;
    const ok = await timed(async () => {
      t = 250;
      return 42;
    }, now);
    expect(ok).toEqual({ ms: 250, startedAt: 0, ok: true, value: 42 });
    const bad = await timed(async () => {
      throw new Error("boom");
    }, now);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error.message).toBe("boom");
  });
});
