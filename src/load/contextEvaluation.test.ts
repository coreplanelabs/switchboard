import { describe, expect, it } from "vitest";
import {
  compareContextScores,
  parseContextTrials,
  renderContextScores,
  scoreContextTrial,
  type ContextTrial,
} from "./contextEvaluation.js";

const trial = (over: Partial<ContextTrial["run"]> = {}): ContextTrial => ({
  id: "preserve-correction",
  task: "Keep the corrected target and recover the original failure after compaction.",
  boundary: "compaction",
  qualification: "synthetic",
  sourceRevision: "a".repeat(40),
  targetRevision: "c".repeat(40),
  environment: "local-in-memory/node-test",
  effort: "unset",
  contextDigest: "d".repeat(64),
  limits: { maxTurns: 8, maxTokens: 2048 },
  expectedNotes: [],
  expected: {
    target: { value: "release branch", source: "turn:3" },
    failure: { value: "missing owner", source: "turn:1" },
  },
  avoidCommands: ["repeat destructive repair"],
  run: {
    id: "eval-run",
    model: "test/context",
    status: "completed",
    startedAt: 1000,
    finishedAt: 1500,
    truncated: false,
    answerOutcome: { ending: "answered", output: "present" },
    events: [
      { type: "run_note", kind: "compacted" },
      {
        type: "answer",
        text: JSON.stringify({
          facts: {
            target: { value: "release branch", source: "turn:3" },
            failure: { value: "missing owner", source: "turn:1" },
          },
        }),
      },
    ],
    usage: {
      turns: 1,
      byModel: {
        "test/context": {
          inputTokens: 1200,
          outputTokens: 50,
          cacheReadTokens: 1000,
          cacheWriteTokens: 0,
          usd: 0.025,
        },
      },
    },
    ...over,
  },
});

describe("context outcome evaluation", () => {
  it("scores literal expected answers and original references with actual usage and wall time", async () => {
    const score = await scoreContextTrial(trial());
    expect(score).toMatchObject({
      completed: true,
      boundaryRecorded: true,
      completeTrace: true,
      missingFacts: [],
      wrongFacts: [],
      unsupportedClaims: [],
      missingEvidence: [],
      repeatedFailedCommands: 0,
      wallMs: 500,
      usd: 0.025,
      tokens: { input: 1200, output: 50, cacheRead: 1000, cacheWrite: 0 },
      passed: true,
      sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      runId: "eval-run",
      qualification: "synthetic",
    });
    expect(score.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(renderContextScores([score])).toContain(
      "| preserve-correction | synthetic | compaction | PASS | 0 / 0 / 0 / 0 | 0 | 500 | 0.025 |",
    );
  });

  it("fails missed corrections, missing facts, unsupported claims, wrong references and repeated failed commands independently", async () => {
    const score = await scoreContextTrial(
      trial({
        events: [
          { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
          { type: "run_note", kind: "compacted" },
          { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
          {
            type: "answer",
            text: JSON.stringify({
              facts: {
                target: { value: "default branch", source: "invented source" },
                deployment: { value: "completed", source: "none" },
              },
            }),
          },
        ],
      }),
    );
    expect(score).toMatchObject({
      missingFacts: ["failure"],
      wrongFacts: ["target"],
      unsupportedClaims: ["deployment"],
      missingEvidence: ["target"],
      repeatedFailedCommands: 1,
      passed: false,
    });
    expect((await scoreContextTrial(trial())).passed).toBe(true);
  });

  it.each(["compaction", "restart"] as const)(
    "counts forbidden retries after the first %s even when another boundary follows",
    async (boundary) => {
      const note = boundary === "compaction" ? "compacted" : "resumed";
      const current = trial({
        events: [
          { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
          { type: "run_note", kind: note },
          { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
          { type: "run_note", kind: note },
          trial().run.events.at(-1)!,
        ],
      });
      current.boundary = boundary;
      expect(await scoreContextTrial(current)).toMatchObject({
        completed: true,
        boundaryRecorded: true,
        missingFacts: [],
        wrongFacts: [],
        repeatedFailedCommands: 1,
        passed: false,
      });
    },
  );

  it("counts every forbidden command on both sides of later compaction", async () => {
    const current = trial({
      events: [
        { type: "run_note", kind: "compacted" },
        { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
        { type: "run_note", kind: "compacted" },
        { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
        trial().run.events.at(-1)!,
      ],
    });
    expect(await scoreContextTrial(current)).toMatchObject({
      completed: true,
      repeatedFailedCommands: 2,
      passed: false,
    });
  });

  it("excludes the original source command before the first required boundary", async () => {
    const current = trial({
      events: [
        { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
        { type: "run_note", kind: "resumed" },
        { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
        { type: "run_note", kind: "compacted" },
        { type: "run_note", kind: "compacted" },
        trial().run.events.at(-1)!,
      ],
    });
    expect(await scoreContextTrial(current)).toMatchObject({
      completed: true,
      boundaryRecorded: true,
      repeatedFailedCommands: 0,
      passed: true,
    });
  });

  it("counts the whole child trace without treating child compaction as its handoff boundary", async () => {
    const current = trial({
      seed: "parent",
      childHandoff: {
        version: 1,
        source: { runId: "original-parent", requester: "cli:owner", channelId: "cli:context", threadKey: "cli:parent" },
        session: { key: "cli:parent:general", from: 0, to: 2 },
        assets: [],
      },
      events: [
        { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
        { type: "run_note", kind: "compacted" },
        { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
        trial().run.events.at(-1)!,
      ],
    });
    current.boundary = "child-handoff";
    expect(await scoreContextTrial(current)).toMatchObject({
      completed: true,
      boundaryRecorded: true,
      repeatedFailedCommands: 2,
      passed: false,
    });
  });

  it("keeps a between-boundary retry when an answer precedes the latest boundary", async () => {
    const current = trial({
      events: [
        { type: "run_note", kind: "compacted" },
        { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
        trial().run.events.at(-1)!,
        { type: "run_note", kind: "compacted" },
      ],
    });
    expect(await scoreContextTrial(current)).toMatchObject({
      completed: false,
      boundaryRecorded: true,
      repeatedFailedCommands: 1,
      passed: false,
    });
  });

  it("cannot pass missing or partial boundaries after forbidden retries", async () => {
    const missing = trial({
      events: [{ type: "tool_call", tool: "bash", command: "repeat destructive repair" }, trial().run.events.at(-1)!],
    });
    expect(await scoreContextTrial(missing)).toMatchObject({
      boundaryRecorded: false,
      repeatedFailedCommands: 1,
      passed: false,
    });
    const partial = trial({
      truncated: true,
      events: [
        { type: "run_note", kind: "compacted" },
        { type: "tool_call", tool: "bash", command: "repeat destructive repair" },
        { type: "run_note", kind: "compacted" },
        trial().run.events.at(-1)!,
      ],
    });
    expect(await scoreContextTrial(partial)).toMatchObject({
      completed: true,
      boundaryRecorded: true,
      completeTrace: false,
      repeatedFailedCommands: 1,
      passed: false,
    });
  });

  it("requires recorded boundaries, an answer after the boundary and a complete trace", async () => {
    const correct = trial().run.events.at(-1)!;
    for (const run of [
      { events: [correct] },
      { events: [correct, { type: "run_note", kind: "compacted" }] },
      { truncated: true },
      { status: "interrupted" },
      { answerOutcome: { ending: "answered", output: "absent" as const } },
      { answerOutcome: { ending: "interrupted", output: "unknown" as const } },
      {
        events: [
          { type: "run_note", kind: "compacted" },
          { type: "answer", text: "I completed everything" },
        ],
      },
    ])
      expect((await scoreContextTrial(trial(run))).passed).toBe(false);
    const restart = trial({ events: [{ type: "run_note", kind: "resumed" }, correct] });
    restart.boundary = "restart";
    expect((await scoreContextTrial(restart)).passed).toBe(true);
    const child = trial({
      seed: "parent",
      childHandoff: {
        version: 1,
        source: { runId: "original-parent", requester: "cli:owner", channelId: "cli:context", threadKey: "cli:parent" },
        session: { key: "cli:parent:general", from: 0, to: 2 },
        assets: [],
      },
      events: [correct],
    });
    child.boundary = "child-handoff";
    expect((await scoreContextTrial(child)).passed).toBe(true);
    delete child.run.childHandoff;
    expect((await scoreContextTrial(child)).passed).toBe(false);
  });

  it("cannot pass a rejected-approach task after its durable notes are erased", async () => {
    const retained = trial();
    retained.expectedNotes = ["Rejected force-rebuild", "preserve-and-inspect"];
    retained.run.events.push({ type: "notes", text: "Rejected force-rebuild; next preserve-and-inspect." });
    expect((await scoreContextTrial(retained)).passed).toBe(true);
    retained.run.events.push({ type: "notes", text: "All earlier decisions erased." });
    expect(await scoreContextTrial(retained)).toMatchObject({ passed: false, missingNotes: ["note:1", "note:2"] });
  });

  it("keeps absent usage and partial pricing unknown rather than zero", async () => {
    expect(await scoreContextTrial(trial({ usage: undefined }))).toMatchObject({ tokens: null, usd: null });
    const unpriced = trial();
    delete unpriced.run.usage!.byModel["test/context"].usd;
    expect(await scoreContextTrial(unpriced)).toMatchObject({ usd: null, tokens: { input: 1200 } });
  });

  it("rejects empty, duplicate or invalid fixture input and binds changes to independent labels", async () => {
    expect(() => parseContextTrials("")).toThrow("empty");
    expect(() => parseContextTrials("{}\n")).toThrow("line 1");
    const json = JSON.stringify(trial());
    expect(() => parseContextTrials(`${json}\n${json}`)).toThrow("unique");
    expect(parseContextTrials(json)[0].run.id).toBe("eval-run");
    const before = await scoreContextTrial(trial());
    const changed = trial();
    changed.expected.target.value = "different label";
    expect((await scoreContextTrial(changed)).fixtureHash).not.toBe(before.fixtureHash);
  });
});

describe("context outcome comparison", () => {
  it("compares the same tasks across source revisions and reports actual outcome/time/cost deltas", async () => {
    const before = await scoreContextTrial(trial({ status: "failed", finishedAt: 2000 }));
    const current = trial();
    current.sourceRevision = "b".repeat(40);
    const after = await scoreContextTrial(current);
    expect(compareContextScores([before], [after])).toEqual({
      comparable: true,
      passedDelta: 1,
      repeatedFailedCommandsDelta: 0,
      wallMsDelta: -500,
      usdDelta: 0,
    });
  });

  it("refuses improvement deltas for different labels, models or qualification and keeps unpriced cost unknown", async () => {
    const before = await scoreContextTrial(trial());
    const changed = trial();
    changed.expected.target.value = "different target";
    changed.run.model = "test/other";
    changed.qualification = "recorded";
    changed.environment = "different runtime";
    changed.effort = "high";
    changed.contextDigest = "e".repeat(64);
    changed.limits.maxTurns = 4;
    expect(compareContextScores([before], [await scoreContextTrial(changed)])).toEqual({
      comparable: false,
      reasons: [
        "preserve-correction: fixture differs",
        "preserve-correction: model differs",
        "preserve-correction: qualification differs",
        "preserve-correction: environment differs",
        "preserve-correction: effort differs",
      ],
    });
    const unpriced = await scoreContextTrial(trial({ usage: undefined }));
    expect(compareContextScores([before], [unpriced])).toMatchObject({ comparable: true, usdDelta: null });
    expect(compareContextScores([before], [])).toEqual({ comparable: false, reasons: ["case set differs"] });
  });
});
