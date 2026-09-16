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
