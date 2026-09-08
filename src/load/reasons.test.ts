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

  it("maps the sandbox capacity error and the not-onboarded answer to their tokens", () => {
    expect(reasonOf(new Error("sandbox fleet busy — no free per-thread sandbox after waiting 300s"))).toBe(
      "fleet-busy",
    );
    expect(reasonOf(new Error("resident attach: repo:x is not onboarded (404)"))).toBe("not-onboarded");
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
