// Feature: docs/reference/specs/browser-home.md — complete virtualized unresolved lists.
import { describe, expect, it } from "vitest";
import { rowOffsets, visibleWindow } from "./virtualRows";
describe("Unresolved work viewport", () => {
  it("keeps a thousand variable-height rows reachable without mounting the whole list", () => {
    const keys = Array.from({ length: 1000 }, (_, index) => `u${index}`);
    const offsets = rowOffsets(keys, { u0: 300, u999: 420 }, 150);
    expect(visibleWindow(offsets, 0, 600)).toEqual({ start: 0, end: 7 });
    expect(visibleWindow(offsets, 150270, 600)).toEqual({ start: 995, end: 1000 });
    expect(offsets[1000]).toBe(150420);
  });
});
