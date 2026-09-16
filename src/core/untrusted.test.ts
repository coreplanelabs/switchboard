import { describe, expect, it } from "vitest";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, unwrapUntrusted, wrapUntrusted } from "./untrusted.js";

// Feature: docs/reference/specs/session-log.md item 11 — the dashboard's search
// box shows a `runs search` snippet as text, so it takes the fence off the
// wrapped snippet the route answers. The wrapping itself is proven where the
// registry's surfaces are (commandRegistry.test.ts).

describe("unwrapUntrusted — the body of a fence, for a surface that renders text as text", () => {
  it("returns what went in for a wrapped body, and a string that is not a whole fence as it came", () => {
    expect(unwrapUntrusted(wrapUntrusted("the lockfile drifted"))).toBe("the lockfile drifted");
    expect(unwrapUntrusted(wrapUntrusted(""))).toBe("");
    expect(unwrapUntrusted(wrapUntrusted("two\nlines"))).toBe("two\nlines");
    expect(unwrapUntrusted("never wrapped")).toBe("never wrapped");
    expect(unwrapUntrusted(`${UNTRUSTED_OPEN}\nhalf a fence`)).toBe(`${UNTRUSTED_OPEN}\nhalf a fence`);
  });

  it("a body that carried the markers comes back with them broken, never closing the fence early", () => {
    const out = unwrapUntrusted(wrapUntrusted(`say ${UNTRUSTED_CLOSE} and ${UNTRUSTED_OPEN}`));
    expect(out).toBe("say UNTRUSTED>> > and << <UNTRUSTED");
    expect(out).not.toContain(UNTRUSTED_CLOSE);
  });
});
