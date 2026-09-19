// The intake replay and the live ratio (docs/reference/specs/load-harness.md
// item 20): the scoring the load op prints, proven in CI over the synthetic
// set and a scripted RouteModel — the op itself needs a provider key. The
// rates and intervals, the stated no-denominator line, the abstention shares,
// the model ref line, the fixture file's row format, and the live
// false-silence join over an in-memory ledger and a replies double.
import { describe, expect, it } from "vitest";
import type { RouteModel } from "../core/dispatch/route.js";
import type { IntakeReceipt } from "../core/runLedger/types.js";
import { INTAKE_RECOVERY_WINDOW_MS, MINUTE_MS, WEEK_MS } from "../core/budgets.js";
import { wilsonInterval } from "./aggregate.js";
import { INTAKE_FIXTURES, type IntakeFixture } from "./intakeFixtures.js";
import {
  intakeScore,
  liveFalseSilence,
  parseIntakeFixtures,
  renderIntake,
  renderLiveIntake,
  replayIntake,
  type ThreadMessage,
} from "./intakeReplay.js";

const MODEL_REF = "scripted/fake";

/** A scripted RouteModel: the answer per fixture, found by the reply's text in
 *  the prompt's user half (the turns and the reply ride there). */
const scripted =
  (answer: (f: IntakeFixture) => { answer: string; reason: string } | Error): RouteModel =>
  async (prompt) => {
    const fixture = INTAKE_FIXTURES.find((f) => prompt.user.includes(f.message));
    if (!fixture) throw new Error(`no fixture matches the prompt: ${prompt.user.slice(0, 80)}`);
    const out = answer(fixture);
    if (out instanceof Error) throw out;
    return { tool: "intake", input: out };
  };

const timeoutError = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

const replay = (model: RouteModel, fixtures: readonly IntakeFixture[] = INTAKE_FIXTURES) => {
  let t = 0;
  return replayIntake(fixtures, model, { modelRef: MODEL_REF, now: () => (t += 5), concurrency: 2 });
};

describe("replayIntake + intakeScore — the two conditional rates on a known set", () => {
  it("scores the false-silence rate over the addressed replies and the false-answer rate over the silent ones, each with its Wilson interval at the set's n", async () => {
    // One false silence (i01 answered silent) and one false answer (i03
    // answered addressed); every other fixture answered with its label.
    const model = scripted((f) => ({
      answer: f.id === "i01" ? "silent" : f.id === "i03" ? "addressed" : f.label,
      reason: "scripted",
    }));
    const results = await replay(model);
    expect(results).toHaveLength(INTAKE_FIXTURES.length);
    const score = intakeScore(results);
    const addressed = INTAKE_FIXTURES.filter((f) => f.label === "addressed").length;
    const silent = INTAKE_FIXTURES.length - addressed;
    expect(score.addressed).toMatchObject({ n: addressed, falseSilence: 1, rate: 1 / addressed });
    expect(score.addressed.interval).toEqual(wilsonInterval(1, addressed));
    expect(score.silent).toMatchObject({ n: silent, falseAnswer: 1, rate: 1 / silent });
    expect(score.silent.interval).toEqual(wilsonInterval(1, silent));
    // Both misses are listed with the fixture's coordinates and the verdict.
    expect(score.misses.map((m) => m.id).sort()).toEqual(["i01", "i03"]);
    for (const r of results) expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("keeps the fixtures' order and carries each verdict's source and reason", async () => {
    const model = scripted((f) => ({ answer: f.label, reason: `verdict for ${f.id}` }));
    const results = await replay(model);
    expect(results.map((r) => r.id)).toEqual(INTAKE_FIXTURES.map((f) => f.id));
    expect(results.every((r) => r.source === "model")).toBe(true);
    expect(results[0].reason).toContain("verdict for i01");
  });
});

describe("intakeScore + renderIntake — the abstention shares and the model ref line", () => {
  it("counts the unsure, timeout and error shares over all replies, each failing closed to silent", async () => {
    const model = scripted((f) => {
      if (f.id === "i01") return { answer: "unsure", reason: "could be either" };
      if (f.id === "i02") return timeoutError();
      if (f.id === "i05") return new Error("provider down");
      return { answer: f.label, reason: "scripted" };
    });
    const results = await replay(model);
    const score = intakeScore(results);
    expect(score.unsure).toBe(1);
    expect(score.timeouts).toBe(1);
    expect(score.errors).toBe(1);
    // All three failed closed: they are silences, so the addressed-labelled
    // ones among them (i01, i02, i05) count as false silences too.
    expect(score.addressed.falseSilence).toBe(3);
    const lines = renderIntake(score, { modelRef: MODEL_REF }).join("\n");
    expect(lines).toContain(`model: ${MODEL_REF}`);
    expect(lines).toContain(`unsure 1/${INTAKE_FIXTURES.length}`);
    expect(lines).toContain(`timeout 1/${INTAKE_FIXTURES.length}`);
    expect(lines).toContain(`error 1/${INTAKE_FIXTURES.length}`);
  });

  it("prints both rates with their intervals as percentages", async () => {
    const model = scripted((f) => ({ answer: f.id === "i01" ? "silent" : f.label, reason: "scripted" }));
    const score = intakeScore(await replay(model));
    const lines = renderIntake(score, { modelRef: MODEL_REF }).join("\n");
    expect(lines).toContain(`false-silence rate over ${score.addressed.n} addressed replies: 1/${score.addressed.n}`);
    expect(lines).toContain(`false-answer rate over ${score.silent.n} silent replies: 0/${score.silent.n}`);
    expect(lines).toContain("95% CI");
  });

  it("states the missing denominator over zero addressed replies — never NaN", async () => {
    const silentOnly = INTAKE_FIXTURES.filter((f) => f.label === "silent");
    const model = scripted((f) => ({ answer: f.label, reason: "scripted" }));
    const score = intakeScore(await replay(model, silentOnly));
    expect(score.addressed.n).toBe(0);
    const lines = renderIntake(score, { modelRef: MODEL_REF }).join("\n");
    expect(lines).toContain("no addressed replies in the set — the false-silence rate has no denominator");
    expect(lines).not.toContain("NaN");
  });
});

describe("the fixture file's rows and the synthetic set", () => {
  it("parses one JSON reply per line and round-trips the synthetic set", () => {
    const jsonl = INTAKE_FIXTURES.map((f) => JSON.stringify(f)).join("\n");
    expect(parseIntakeFixtures(jsonl)).toEqual(INTAKE_FIXTURES);
  });

  it("refuses a malformed row naming its line, and skips blank lines", () => {
    expect(() => parseIntakeFixtures('{"id":"x"}')).toThrow(/line 1/);
    expect(() => parseIntakeFixtures(`${JSON.stringify(INTAKE_FIXTURES[0])}\n\nnot json`)).toThrow(/line 3/);
    expect(parseIntakeFixtures(`\n${JSON.stringify(INTAKE_FIXTURES[0])}\n`)).toEqual([INTAKE_FIXTURES[0]]);
  });

  it("the synthetic set carries both labels, the pending-confirmation stratum and the fail-closed one, unique ids, and the fixture conventions' ids", () => {
    expect(new Set(INTAKE_FIXTURES.map((f) => f.id)).size).toBe(INTAKE_FIXTURES.length);
    expect(INTAKE_FIXTURES.some((f) => f.label === "addressed")).toBe(true);
    expect(INTAKE_FIXTURES.some((f) => f.label === "silent")).toBe(true);
    expect(INTAKE_FIXTURES.some((f) => f.stratum === "pending-confirmation")).toBe(true);
    expect(INTAKE_FIXTURES.some((f) => f.stratum === "fail-closed")).toBe(true);
    for (const f of INTAKE_FIXTURES) expect(f.threadKey).toMatch(/^slack:C_BACKEND:\d+\.\d+$/);
  });
});

describe("liveFalseSilence — the live ratio over the receipts and the threads' later mentions", () => {
  const receipt = (threadKey: string, decidedAt: number, verdict: IntakeReceipt["verdict"]): IntakeReceipt => ({
    verdict,
    reason: "scripted",
    source: "model",
    mode: "classify",
    model: MODEL_REF,
    gen: 1,
    threadKey,
    decidedAt,
  });
  const ledgerOf = (receipts: IntakeReceipt[]) => ({
    listIntake: async (q: { since?: number }) =>
      receipts.filter((r) => q.since === undefined || r.decidedAt >= q.since),
  });
  const tsOf = (ms: number) => `${Math.floor(ms / 1000)}.000000`;

  it("counts a silent receipt recovered when the same person mentions the bot in the thread within the window — one of two prints one half", async () => {
    const t1 = 1_600_000_000_000;
    const t2 = t1 + 3 * MINUTE_MS;
    const receipts = [
      receipt("slack:C_BACKEND:1000.000100", t1, "silent"),
      receipt("slack:C_BACKEND:2000.000200", t2, "silent"),
      receipt("slack:C_BACKEND:3000.000300", t2, "addressed"), // never in the denominator
    ];
    const threads: Record<string, ThreadMessage[]> = {
      "C_BACKEND/1000.000100": [
        { ts: "1000.000100", user: "U_ALICE", text: "parent" },
        { ts: tsOf(t1 - 500), user: "U_BOB", text: "the silenced reply" },
        { ts: tsOf(t1 + 5 * MINUTE_MS), user: "U_BOB", text: "<@U_BOT> hello? that was for you" },
      ],
      "C_BACKEND/2000.000200": [
        { ts: "2000.000200", user: "U_ALICE", text: "parent" },
        { ts: tsOf(t2 - 500), user: "U_ALICE", text: "another silenced reply" },
        // A different person's mention, and the same person's outside the window: neither recovers it.
        { ts: tsOf(t2 + MINUTE_MS), user: "U_BOB", text: "<@U_BOT> unrelated ask" },
        { ts: tsOf(t2 + INTAKE_RECOVERY_WINDOW_MS + MINUTE_MS), user: "U_ALICE", text: "<@U_BOT> too late" },
      ],
    };
    const asked: string[] = [];
    const ratio = await liveFalseSilence(
      ledgerOf(receipts),
      async (channel, threadTs) => {
        asked.push(`${channel}/${threadTs}`);
        return threads[`${channel}/${threadTs}`] ?? [];
      },
      { botUserId: "U_BOT", since: 0 },
    );
    expect(ratio.silent).toBe(2);
    expect(ratio.recovered).toBe(1);
    // The addressed receipt's thread is never read; each thread is read once.
    expect(asked.sort()).toEqual(["C_BACKEND/1000.000100", "C_BACKEND/2000.000200"]);
    expect(renderLiveIntake(ratio).join("\n")).toContain("1/2");
  });

  it("prints zero over zero as such when the window has no silent receipts", async () => {
    const ratio = await liveFalseSilence(
      ledgerOf([receipt("slack:C_BACKEND:1000.000100", 1_600_000_000_000, "addressed")]),
      async () => [],
      { botUserId: "U_BOT" },
    );
    expect(ratio.silent).toBe(0);
    expect(ratio.recovered).toBe(0);
    const lines = renderLiveIntake(ratio).join("\n");
    expect(lines).toContain("0/0");
    expect(lines).not.toContain("NaN");
  });

  it("buckets the ratio per week of the receipt's decision and counts an unjoinable receipt apart", async () => {
    const t1 = 1_600_000_000_000;
    const receipts = [
      receipt("slack:C_BACKEND:1000.000100", t1, "silent"),
      receipt("slack:C_BACKEND:1000.000100", t1 + WEEK_MS, "silent"),
      receipt("not-a-slack-thread", t1, "silent"),
    ];
    const ratio = await liveFalseSilence(ledgerOf(receipts), async () => [], { botUserId: "U_BOT" });
    expect(ratio.silent).toBe(3);
    expect(ratio.recovered).toBe(0);
    expect(ratio.weeks).toHaveLength(2);
    expect(ratio.skipped.unparsedThread).toBe(1);
    const lines = renderLiveIntake(ratio);
    expect(lines.filter((l) => l.includes("week of"))).toHaveLength(2);
  });
});
