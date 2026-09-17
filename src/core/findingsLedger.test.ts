import { describe, expect, it } from "vitest";
import { ledgerOf, parsePullRequestRef, PULL_REQUEST_REF_PATTERN, type LedgerRun } from "./findingsLedger.js";
import type { Finding, FindingDisposition } from "./reviewVerdict.js";

// Feature: docs/reference/specs/agent-ship.md item 18 — the findings ledger per
// pull request. The pure half: given the runs that name a pull request, one row
// per finding id whose status is a function of the recorded sequence alone —
// what each review listed, what each coding run recorded against it, in
// finishing order.

const T0 = 1_700_000_000_000;

const f = (id: string, over: Partial<Finding> = {}): Finding => ({
  id,
  severity: "major",
  file: "src/a.ts",
  line: 12,
  title: `finding ${id}`,
  ...over,
});
const d = (findingId: string, disposition: FindingDisposition["disposition"], note = `about ${findingId}`) => ({
  findingId,
  disposition,
  note,
});

/** A review run: its verdict lists `findings` at `head`; `round` when a unit row supplies it. */
function review(id: string, finishedAt: number, findings: Finding[] | undefined, head = "a".repeat(40)): LedgerRun {
  return {
    id,
    startedAt: finishedAt - 5_000,
    finishedAt,
    verdict: {
      verdict: findings && findings.length > 0 ? "request_changes" : "approve",
      summary: "…",
      head,
      ...(findings !== undefined ? { findings } : {}),
    },
    reviewHead: head,
  };
}
/** A coding run that recorded dispositions. */
function coding(id: string, finishedAt: number, dispositions: FindingDisposition[]): LedgerRun {
  return { id, startedAt: finishedAt - 5_000, finishedAt, dispositions };
}

describe("ledgerOf — one row per finding id, its status a function of the recorded sequence", () => {
  it("a finding the newest review raised with no disposition after it is open — severity, file, line and title from that review, raised and last seen there", () => {
    const rows = ledgerOf([review("r1", T0, [f("F1"), f("F2", { severity: "nit", line: undefined })])]);
    expect(rows).toEqual([
      {
        id: "F1",
        severity: "major",
        file: "src/a.ts",
        line: 12,
        title: "finding F1",
        raised: { runId: "r1", head: "a".repeat(40) },
        lastSeen: { runId: "r1", head: "a".repeat(40) },
        status: "open",
      },
      {
        id: "F2",
        severity: "nit",
        file: "src/a.ts",
        title: "finding F2",
        raised: { runId: "r1", head: "a".repeat(40) },
        lastSeen: { runId: "r1", head: "a".repeat(40) },
        status: "open",
      },
    ]);
  });

  it("a disposition recorded with no review after it is awaiting re-review, the disposition on the row", () => {
    const rows = ledgerOf([review("r1", T0, [f("F1")]), coding("c1", T0 + 10_000, [d("F1", "fixed", "guarded")])]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: "F1",
        disposition: { kind: "fixed", note: "guarded", runId: "c1" },
        status: "awaiting re-review",
      }),
    ]);
  });

  it("fixed: disposition fixed and the newest later review did not re-raise the id; conceded: disposition declined and not re-raised — a review that lists no findings settles both", () => {
    const base = [
      review("r1", T0, [f("F1"), f("F2")]),
      coding("c1", T0 + 10_000, [d("F1", "fixed"), d("F2", "declined", "by design")]),
    ];
    const statuses = (runs: LedgerRun[]) => Object.fromEntries(ledgerOf(runs).map((r) => [r.id, r.status]));
    expect(statuses([...base, review("r2", T0 + 20_000, [], "b".repeat(40))])).toEqual({
      F1: "fixed",
      F2: "conceded",
    });
    // a verdict with no findings array at all is a review that listed none
    expect(statuses([...base, review("r2", T0 + 20_000, undefined, "b".repeat(40))])).toEqual({
      F1: "fixed",
      F2: "conceded",
    });
  });

  it("re-raised: a later review lists the id again after a disposition — the row says which kind the review answered, keeps the id, and takes the later review's words", () => {
    const rows = ledgerOf([
      review("r1", T0, [f("F1"), f("F2")]),
      coding("c1", T0 + 10_000, [d("F1", "fixed", "moved the guard"), d("F2", "declined", "not worth it")]),
      review(
        "r2",
        T0 + 20_000,
        [f("F1", { title: "the guard moved but the null path stays" }), f("F2")],
        "b".repeat(40),
      ),
    ]);
    expect(rows.map((r) => [r.id, r.status, r.reRaisedAfter, r.title, r.lastSeen?.runId, r.raised?.runId])).toEqual([
      ["F1", "re-raised", "fixed", "the guard moved but the null path stays", "r2", "r1"],
      ["F2", "re-raised", "declined", "finding F2", "r2", "r1"],
    ]);
    expect(rows[0].lastSeen).toEqual({ runId: "r2", head: "b".repeat(40) });
    expect(rows[0].disposition).toEqual({ kind: "fixed", note: "moved the guard", runId: "c1" });
  });

  it("the latest disposition decides: re-raised, answered again, then not re-raised is fixed; and a second disposition run replaces the first", () => {
    const rows = ledgerOf([
      review("r1", T0, [f("F1")]),
      coding("c1", T0 + 10_000, [d("F1", "declined", "no")]),
      review("r2", T0 + 20_000, [f("F1")], "b".repeat(40)),
      coding("c2", T0 + 30_000, [d("F1", "fixed", "fine, fixed")]),
      review("r3", T0 + 40_000, [], "c".repeat(40)),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: "F1",
        status: "fixed",
        disposition: { kind: "fixed", note: "fine, fixed", runId: "c2" },
        lastSeen: { runId: "r2", head: "b".repeat(40) },
      }),
    ]);
  });

  it("a finding raised at an older head that the newest review did not list, with no disposition recorded, is not re-raised — never open, never fixed", () => {
    const rows = ledgerOf([review("r1", T0, [f("F1")]), review("r2", T0 + 20_000, [], "b".repeat(40))]);
    expect(rows).toEqual([expect.objectContaining({ id: "F1", status: "not re-raised" })]);
    expect(rows[0].disposition).toBeUndefined();
  });

  it("an id a disposition names that no review issued is a row of its own — `unknown id`, the disposition kept, no severity, file or title", () => {
    const rows = ledgerOf([
      review("r1", T0, [f("F1")]),
      coding("c1", T0 + 10_000, [d("F1", "fixed"), d("F9", "fixed", "?")]),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["F1", "F9"]);
    expect(rows[1]).toEqual({
      id: "F9",
      disposition: { kind: "fixed", note: "?", runId: "c1" },
      status: "unknown id",
    });
  });

  it("a disposition that predates the review that first raised the id answers nothing: the finding is open and the row carries no disposition", () => {
    const rows = ledgerOf([coding("c0", T0, [d("F1", "fixed")]), review("r1", T0 + 10_000, [f("F1")])]);
    expect(rows).toEqual([expect.objectContaining({ id: "F1", status: "open" })]);
    expect(rows[0].disposition).toBeUndefined();
  });

  it("a review that lists no findings and no dispositions yields no rows; runs without a verdict or dispositions contribute nothing; a live run (no finishedAt) is left out", () => {
    expect(ledgerOf([review("r1", T0, [])])).toEqual([]);
    expect(ledgerOf([{ id: "x", startedAt: T0, finishedAt: T0 + 1 }])).toEqual([]);
    expect(
      ledgerOf([{ id: "live", startedAt: T0, verdict: { verdict: "approve", summary: "", findings: [f("F1")] } }]),
    ).toEqual([]);
  });

  it("orders the runs by finishedAt itself, then startedAt, then id — the caller's order does not matter — and carries a run's round onto raised, lastSeen and the disposition when a unit row supplied it", () => {
    const rows = ledgerOf([
      { ...review("r2", T0 + 20_000, [], "b".repeat(40)), round: 2 },
      { ...coding("c1", T0 + 10_000, [d("F1", "fixed")]), round: 1 },
      { ...review("r1", T0, [f("F1")]), round: 1 },
    ]);
    expect(rows).toEqual([
      {
        id: "F1",
        severity: "major",
        file: "src/a.ts",
        line: 12,
        title: "finding F1",
        raised: { runId: "r1", head: "a".repeat(40), round: 1 },
        lastSeen: { runId: "r1", head: "a".repeat(40), round: 1 },
        disposition: { kind: "fixed", note: "about F1", runId: "c1", round: 1 },
        status: "fixed",
      },
    ]);
  });

  it("rows keep the order ids were first raised in across rounds; a new id in a later round follows; unknown ids come last; within one run the last disposition for an id wins; a review's head is the reviewed head, else the verdict's", () => {
    const rows = ledgerOf([
      {
        id: "r1",
        startedAt: T0,
        finishedAt: T0 + 1,
        verdict: { verdict: "request_changes", summary: "", head: "abc1234", findings: [f("F2"), f("F1")] },
      },
      coding("c1", T0 + 10_000, [d("F1", "declined", "first"), d("F1", "fixed", "second"), d("F7", "fixed")]),
      review("r2", T0 + 20_000, [f("F3")], "b".repeat(40)),
    ]);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ["F2", "not re-raised"],
      ["F1", "fixed"],
      ["F3", "open"],
      ["F7", "unknown id"],
    ]);
    expect(rows[1].disposition).toEqual({ kind: "fixed", note: "second", runId: "c1" });
    expect(rows[0].raised).toEqual({ runId: "r1", head: "abc1234" });
  });
});

describe("parsePullRequestRef — `owner/repo#N` or the pull request's GitHub URL", () => {
  it("accepts both spellings and answers the repository and the number", () => {
    expect(parsePullRequestRef("acme/api#42")).toEqual({ repo: "acme/api", number: 42 });
    expect(parsePullRequestRef("https://github.com/acme/api/pull/42")).toEqual({ repo: "acme/api", number: 42 });
    expect(parsePullRequestRef("https://www.github.com/acme/api.js/pull/7/files")).toEqual({
      repo: "acme/api.js",
      number: 7,
    });
  });
  it("refuses anything else — a bare number, a repository alone, a zero, an issue URL — and the pattern agrees", () => {
    for (const text of ["42", "acme/api", "acme/api#0", "https://github.com/acme/api/issues/42", "acme/api#4x", ""]) {
      expect(parsePullRequestRef(text), text).toBeUndefined();
      expect(PULL_REQUEST_REF_PATTERN.test(text), text).toBe(false);
    }
    expect(PULL_REQUEST_REF_PATTERN.test("acme/api#42")).toBe(true);
    expect(PULL_REQUEST_REF_PATTERN.test("https://github.com/acme/api/pull/42")).toBe(true);
  });
});
