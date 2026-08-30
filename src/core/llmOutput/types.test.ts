import { describe, expect, it } from "vitest";
import { acceptOutput, type OutputFailure, type OutputType } from "./types.js";

// Feature: features/llm-output.md item 2 — the control loop is deterministic
// and type-blind: parse → ok done; a retryable failure re-asks with `observed`
// up to `maxRetries`; non-retryable or no callback returns the failure without
// throwing (the caller decides fail-open vs fail-closed).

/** A type that fails until the raw text equals `accept`, classifying every
 *  other input as a `schema` failure that echoes what it saw. */
function pickyType(accept: string, retryable: boolean, maxRetries = 2): OutputType<string> {
  return {
    name: "picky",
    parse(raw) {
      if (raw === accept) return { ok: true, value: raw, canonical: raw, changed: false };
      return { ok: false, failure: { kind: "schema", observed: `saw ${raw}` } };
    },
    retryable: () => retryable,
    maxRetries,
  };
}

describe("acceptOutput", () => {
  it("passes a first-try success straight through", async () => {
    const out = await acceptOutput(pickyType("good", true), "good");
    expect(out).toEqual({ ok: true, value: "good", canonical: "good", raw: "good", changed: false, attempts: 1 });
  });

  it("re-asks with the failure's `observed` and succeeds on a corrected reply", async () => {
    const seen: OutputFailure[] = [];
    const replies = ["still bad", "good"];
    const out = await acceptOutput(pickyType("good", true), "bad", async (f) => {
      seen.push(f);
      return replies.shift()!;
    });
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(3);
    expect(seen.map((f) => f.observed)).toEqual(["saw bad", "saw still bad"]);
  });

  it("stops at maxRetries and returns the LAST failure and raw, never throwing", async () => {
    let asks = 0;
    const out = await acceptOutput(pickyType("good", true, 2), "bad", async () => {
      asks++;
      return `bad-${asks}`;
    });
    expect(asks).toBe(2);
    expect(out).toEqual({ ok: false, failure: { kind: "schema", observed: "saw bad-2" }, raw: "bad-2", attempts: 3 });
  });

  it("returns a non-retryable failure immediately even when a reask callback exists", async () => {
    let asked = false;
    const out = await acceptOutput(pickyType("good", false), "bad", async () => {
      asked = true;
      return "good";
    });
    expect(asked).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(1);
  });

  it("returns the failure without re-asking when no callback is supplied", async () => {
    const out = await acceptOutput(pickyType("good", true), "bad");
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(1);
  });
});
