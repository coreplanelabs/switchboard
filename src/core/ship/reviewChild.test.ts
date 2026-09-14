import { describe, expect, it } from "vitest";
import type { Finding, FindingDisposition } from "../reviewVerdict.js";
import { buildShipReviewTurn } from "./reviewChild.js";

// Feature: docs/reference/specs/agent-ship.md item 5 — the one user turn a
// review round of the ship pipeline is given. The child is an ordinary
// `dispatch()` review run the plan runner spawns, pinned to the pull request's
// head like any review; this is the turn the spawn route composes for it
// (coordinator/briefs.ts), round 1 and every re-review.

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const F1: Finding = {
  id: "F1",
  severity: "blocking",
  file: "src/login.ts",
  line: 10,
  title: "drops the session cookie",
};
const F2: Finding = { id: "F2", severity: "nit", file: "src/login.ts", title: "rename shadowed variable" };
const D1: FindingDisposition = { findingId: "F1", disposition: "fixed", note: "cookie set on the redirect" };
const D2: FindingDisposition = { findingId: "F2", disposition: "declined", note: "" };

describe("buildShipReviewTurn — the review round's one user turn (item 5)", () => {
  it("round 1 asks for the review of the pull request at the pinned head and a verdict through submit_verdict; without a head it names the pull request alone", () => {
    expect(buildShipReviewTurn({ where: "acme/api#7", round: 1, headSha: HEAD })).toBe(
      `Review pull request acme/api#7 at head \`${HEAD}\`. Submit your verdict with findings via submit_verdict before your final message.`,
    );
    expect(buildShipReviewTurn({ where: "acme/api#7", round: 1 })).toBe(
      "Review pull request acme/api#7. Submit your verdict with findings via submit_verdict before your final message.",
    );
  });

  it("a later round without a prior record reads like round 1 — the turn never invents a previous round", () => {
    expect(buildShipReviewTurn({ where: "acme/api#7", round: 2, headSha: HEAD })).toBe(
      buildShipReviewTurn({ where: "acme/api#7", round: 1, headSha: HEAD }),
    );
  });

  it("a re-review carries the PREVIOUS round's findings and the fix round's dispositions as given, loads the re-review-delta skill for the reading, keeps the verdict over the full diff, and carries unresolved findings forward under their ids", () => {
    const turn = buildShipReviewTurn({
      where: "acme/api#7",
      round: 2,
      headSha: HEAD,
      prior: { findings: [F1, F2], dispositions: [D1, D2] },
    });
    expect(turn).toContain(
      `Re-review pull request acme/api#7 at head \`${HEAD}\` — review round 2 of this ship pipeline.`,
    );
    expect(turn).toContain("Load the `re-review-delta` skill");
    expect(turn).toContain("your verdict still covers the full diff against base");
    expect(turn).toContain("Carry every unresolved prior finding forward under its existing id.");
    expect(turn).toContain(
      "Previous round's findings:\n[blocking] F1 src/login.ts:10 — drops the session cookie\n[nit] F2 src/login.ts — rename shadowed variable",
    );
    expect(turn).toContain("Fix round's dispositions:\nF1: fixed — cookie set on the redirect\nF2: declined");
  });

  it("a re-review whose prior round recorded nothing says so for both lists", () => {
    const turn = buildShipReviewTurn({ where: "acme/api#7", round: 3, prior: { findings: [], dispositions: [] } });
    expect(turn).toContain("Previous round's findings:\n(none recorded)");
    expect(turn).toContain("Fix round's dispositions:\n(none recorded)");
    expect(turn).not.toContain("at head");
  });
});
