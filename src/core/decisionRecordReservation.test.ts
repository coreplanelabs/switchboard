import { describe, expect, it } from "vitest";
import {
  DecisionRecordAllocator,
  DecisionRecordReservationUnavailableError,
  asksForDecisionRecord,
  decisionRecordNumberProblems,
} from "./decisionRecordReservation.js";

// Issue 2196 fixture: these are the two record-writing asks that were live
// together and each told its child to scan docs/decisions/ for the next number.
const EFFECT_RECORD_ASK =
  "Write the technical decision record (next free number in docs/decisions/, the repo's record shape) for one typed side-effect seam.";
const PROVIDER_RECORD_ASK =
  "Write the technical decision record (next free number in docs/decisions/, the repo's record shape) for one provider-failure cause.";

describe("DecisionRecordAllocator", () => {
  it("after a process restart, the durable reservation ledger advances past the first task's number", async () => {
    const reservations = new Map<string, string>();
    const durable = async (repo: string, taskKey: string, claimed: ReadonlySet<string>) => {
      const key = `${repo}\n${taskKey}`;
      const prior = reservations.get(key);
      if (prior !== undefined) return prior;
      const used = new Set([...claimed, ...reservations.values()]);
      const highest = [...used].reduce((max, value) => Math.max(max, Number(value)), 0);
      const number = String(highest + 1).padStart(4, "0");
      reservations.set(key, number);
      return number;
    };
    const githubClaims = async () => new Set(["0074"]);

    const beforeRestart = new DecisionRecordAllocator(githubClaims, durable);
    expect(await beforeRestart.reserve("acme/api", "effect-record")).toBe("0075");

    const afterRestart = new DecisionRecordAllocator(githubClaims, durable);
    expect(await afterRestart.reserve("acme/api", "provider-record")).toBe("0076");
  });

  it("two concurrent admissions reserve consecutive numbers above main and every open pull request claim", async () => {
    let reads = 0;
    const allocator = new DecisionRecordAllocator(async () => {
      reads += 1;
      await Promise.resolve();
      return new Set(["0073", "0074"]);
    });

    const [first, second] = await Promise.all([
      allocator.reserve("acme/api", "effect-record"),
      allocator.reserve("acme/api", "provider-record"),
    ]);

    expect([first, second]).toEqual(["0075", "0076"]);
    expect(reads).toBe(2);
  });

  it("a re-issue of the same task key keeps its reservation", async () => {
    const allocator = new DecisionRecordAllocator(async () => new Set(["0074"]));
    expect(await allocator.reserve("acme/api", "same-task")).toBe("0075");
    expect(await allocator.reserve("acme/api", "same-task")).toBe("0075");
    expect(await allocator.reserve("acme/api", "other-task")).toBe("0076");
  });

  it("an unavailable durable reservation store refuses without issuing a process-local number", async () => {
    let storeAvailable = false;
    const allocator = new DecisionRecordAllocator(
      async () => new Set(["0074"]),
      async () => (storeAvailable ? "0075" : undefined),
    );

    await expect(allocator.reserve("acme/api", "record-task")).rejects.toBeInstanceOf(
      DecisionRecordReservationUnavailableError,
    );
    storeAvailable = true;
    expect(await allocator.reserve("acme/api", "record-task")).toBe("0075");
  });

  it("recognizes positive record-writing instructions, excludes negations, and gives an explicit marker priority", () => {
    expect(asksForDecisionRecord(EFFECT_RECORD_ASK)).toBe(true);
    expect(asksForDecisionRecord(PROVIDER_RECORD_ASK)).toBe(true);
    expect(asksForDecisionRecord("Document this choice in a decision record.")).toBe(true);
    expect(asksForDecisionRecord("Do not write a decision record; just fix the provider seam.")).toBe(false);
    expect(asksForDecisionRecord("decision-record: write\nDo not infer the record from this sentence.")).toBe(true);
    expect(asksForDecisionRecord("decision-record: none\nWrite a decision record about the provider seam.")).toBe(
      false,
    );
    expect(
      asksForDecisionRecord(
        "Fix the reservation race: two children picked the same decision-record number; reserve it before either child runs.",
      ),
    ).toBe(false);
  });
});

describe("decisionRecordNumberProblems", () => {
  it("a child with a reservation that adds no decision record cannot pass", () => {
    expect(
      decisionRecordNumberProblems([], ["docs/decisions/0074-existing.md"], {
        child: true,
        reservation: "0075",
      }),
    ).toEqual([
      {
        path: "docs/decisions",
        what: "this child has runner reservation 0075 but adds no decision record — it must add exactly one",
      },
    ]);
  });

  it("a child adding a decision record without the reservation in its brief cannot pass", () => {
    expect(
      decisionRecordNumberProblems(["docs/decisions/0075-new.md"], ["docs/decisions/0074-existing.md"], {
        child: true,
      }),
    ).toEqual([
      {
        path: "docs/decisions/0075-new.md",
        what: "adds decision record 0075 but this child has no runner reservation (`record: NNNN`)",
      },
    ]);
  });

  it("fails a pull request that adds a number already present on main, and two added files sharing one number", () => {
    expect(
      decisionRecordNumberProblems(
        ["docs/decisions/0074-rival.md", "docs/decisions/0075-a.md", "docs/decisions/0075-b.md"],
        ["docs/decisions/0074-existing.md"],
        { child: false },
      ),
    ).toEqual([
      {
        path: "docs/decisions/0074-rival.md",
        what: "adds decision record 0074 but that number already exists on main (docs/decisions/0074-existing.md)",
      },
      {
        path: "docs/decisions/0075-a.md",
        what: "adds 2 decision records with number 0075 — a pull request may add at most one record per number",
      },
      {
        path: "docs/decisions/0075-b.md",
        what: "adds 2 decision records with number 0075 — a pull request may add at most one record per number",
      },
    ]);
  });

  it("a child's added record must equal the reservation in its brief", () => {
    expect(
      decisionRecordNumberProblems(["docs/decisions/0076-wrong.md"], ["docs/decisions/0074-existing.md"], {
        child: true,
        reservation: "0075",
      }),
    ).toEqual([
      {
        path: "docs/decisions/0076-wrong.md",
        what: "adds decision record 0076 but this child's runner reservation is 0075",
      },
    ]);
    expect(
      decisionRecordNumberProblems(["docs/decisions/0075-right.md"], ["docs/decisions/0074-existing.md"], {
        child: true,
        reservation: "0075",
      }),
    ).toEqual([]);
  });
});
