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

  it("a synchronously throwing function yields ok:false with the error and a measured ms", async () => {
    let t = 0;
    const now = () => t;
    const result = await timed(() => {
      t = 100;
      throw new Error("sync-throw");
    }, now);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe("sync-throw");
    expect(result.ms).toBe(100);
  });

  it("a rejection with a non-Error string is wrapped into an Error whose message is the string", async () => {
    const result = await timed(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "string rejection";
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(Error);
    expect(!result.ok && result.error.message).toBe("string rejection");
  });
});
