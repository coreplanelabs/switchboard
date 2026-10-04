import { describe, expect, it } from "vitest";
import { workspaceAcknowledgment } from "./workspaceSettlement.js";

describe("exact retained workspace acknowledgment", () => {
  it("refuses an owner that has never retained a terminal revision", () => {
    expect(workspaceAcknowledgment(undefined, 1, false)).toEqual({ ok: false, reason: "unverified" });
  });

  it("accepts a lost-ACK retry only beneath a known retained revision", () => {
    expect(workspaceAcknowledgment(undefined, 1, false, 2)).toEqual({ ok: true });
    expect(workspaceAcknowledgment(undefined, 3, false, 2)).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses corrupt retained revision metadata instead of inventing an acknowledgment", () => {
    expect(workspaceAcknowledgment(undefined, 1, false, Number.NaN)).toEqual({ ok: false, reason: "unverified" });
  });

  it("preserves live-owner precedence even for a previously acknowledged revision", () => {
    expect(workspaceAcknowledgment(undefined, 1, true, 2)).toEqual({ ok: false, reason: "owner-live" });
  });
});
