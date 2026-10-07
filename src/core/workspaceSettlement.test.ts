import { describe, expect, it } from "vitest";
import { isAcknowledgedWorkspaceOwner, workspaceAcknowledgment } from "./workspaceSettlement.js";

describe("acknowledged workspace owner evidence", () => {
  const owner = { runId: "original-run", ownerGen: "original-gen", ownerFence: 7 };
  const acknowledgment = { kind: "acknowledged", owner, revision: 1 };

  it("recognizes only the exact retained owner and positive safe revision", () => {
    expect(isAcknowledgedWorkspaceOwner(acknowledgment, owner)).toBe(true);
    expect(isAcknowledgedWorkspaceOwner({ ...acknowledgment, revision: Number.MAX_SAFE_INTEGER }, owner)).toBe(true);
    for (const field of ["runId", "ownerGen", "ownerFence"] as const) {
      const foreign = { ...owner, [field]: field === "ownerFence" ? 8 : "foreign" };
      expect(isAcknowledgedWorkspaceOwner({ ...acknowledgment, owner: foreign }, owner)).toBe(false);
    }
    for (const revision of [undefined, null, 0, -1, 0.5, true, "1", Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(isAcknowledgedWorkspaceOwner({ ...acknowledgment, revision }, owner)).toBe(false);
    expect(isAcknowledgedWorkspaceOwner({ ...acknowledgment, owner: null }, owner)).toBe(false);
    expect(isAcknowledgedWorkspaceOwner({ ...acknowledgment, owner: [owner] }, owner)).toBe(false);
  });

  it("cannot turn a live, absent or unknown observation into an acknowledgment", () => {
    for (const kind of ["live", "terminal", "absent", "unknown"])
      expect(isAcknowledgedWorkspaceOwner({ ...acknowledgment, kind }, owner)).toBe(false);
    expect(isAcknowledgedWorkspaceOwner(null, owner)).toBe(false);
    expect(isAcknowledgedWorkspaceOwner([acknowledgment], owner)).toBe(false);
    expect(isAcknowledgedWorkspaceOwner(acknowledgment, { ...owner, ownerFence: 0 })).toBe(false);
  });
});

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
