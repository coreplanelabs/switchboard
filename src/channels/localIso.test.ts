import { describe, expect, it } from "vitest";
import { formatLocalIso } from "./localIso.js";

describe("formatLocalIso", () => {
  const T = Date.UTC(2026, 7, 30, 0, 47, 44, 123); // 2026-08-30T00:47:44.123Z

  it("renders the instant as an ISO-8601 timestamp in the given zone offset (minutes west of UTC, as Date#getTimezoneOffset)", () => {
    expect(formatLocalIso(T, 420)).toBe("2026-08-29T17:47:44-07:00"); // PDT
    expect(formatLocalIso(T, -330)).toBe("2026-08-30T06:17:44+05:30"); // IST
    expect(formatLocalIso(T, 0)).toBe("2026-08-30T00:47:44+00:00");
  });

  it("zero-pads every field and drops milliseconds", () => {
    expect(formatLocalIso(Date.UTC(2026, 0, 5, 3, 4, 5, 999), 0)).toBe("2026-01-05T03:04:05+00:00");
  });

  it("defaults to the runtime's zone offset when none is given", () => {
    const d = new Date(T);
    expect(formatLocalIso(T)).toBe(formatLocalIso(T, d.getTimezoneOffset()));
  });

  it("is plain ES5 source so it can be inlined into the page with String(fn)", () => {
    const src = String(formatLocalIso);
    expect(src).not.toMatch(/\b(import|require|export)\b/);
    expect(src).not.toMatch(/=>|\bconst\b|\blet\b/);
  });
});
