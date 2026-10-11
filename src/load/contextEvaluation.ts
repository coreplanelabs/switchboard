import { z } from "zod";
import { sourceHash } from "../core/references/receipts.js";
import { isChildHandoff, type ChildHandoff } from "../core/dispatch/handoff.js";

const text = z.string().min(1).max(4096);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const fact = z.object({ value: text, source: text }).strict();
const event = z
  .object({
    type: z.string(),
    kind: z.string().optional(),
    text: z.string().optional(),
    raw: z.string().optional(),
    command: z.string().optional(),
    tool: z.string().optional(),
  })
  .passthrough();
const usage = z.object({
  turns: z.number().int().nonnegative(),
  byModel: z.record(
    z.string(),
    z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cacheReadTokens: z.number().int().nonnegative(),
        cacheWriteTokens: z.number().int().nonnegative(),
        usd: z.number().nonnegative().nullable().optional(),
      })
      .passthrough(),
  ),
});

/** Labels are independent of the run being scored. Keep real recordings out of the tree. */
export const contextTrialSchema = z
  .object({
    id: text,
    task: text,
    boundary: z.enum(["compaction", "restart", "child-handoff"]),
    qualification: z.enum(["synthetic", "recorded"]),
    sourceRevision: sha,
    targetRevision: sha,
    environment: text,
    effort: text,
    contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
    limits: z.object({ maxTurns: z.number().int().min(1).max(8), maxTokens: z.number().int().positive() }).strict(),
    expectedNotes: z.array(text).max(30),
    expected: z.record(z.string(), fact).refine((v) => Object.keys(v).length > 0, "expected facts are required"),
    avoidCommands: z.array(text).max(30),
    run: z
      .object({
        id: text,
        model: text,
        status: z.string(),
        startedAt: z.number().finite().nonnegative(),
        finishedAt: z.number().finite().nonnegative(),
        truncated: z.boolean(),
        seed: z.string().optional(),
        childHandoff: z.custom<ChildHandoff>(isChildHandoff, "complete child source descriptor is required").optional(),
        answerOutcome: z
          .object({ ending: z.string(), output: z.enum(["present", "absent", "unknown"]) })
          .passthrough()
          .optional(),
        events: z.array(event),
        usage: usage.optional(),
      })
      .passthrough(),
  })
  .strict()
  .refine((v) => v.run.finishedAt >= v.run.startedAt, "run finishes before it starts");

export type ContextTrial = z.infer<typeof contextTrialSchema>;
export interface ContextScore {
  id: string;
  fixtureHash: string;
  sourceRevision: string;
  environment: string;
  effort: string;
  runId: string;
  model: string;
  boundary: ContextTrial["boundary"];
  qualification: ContextTrial["qualification"];
  boundaryRecorded: boolean;
  completed: boolean;
  completeTrace: boolean;
  missingFacts: string[];
  wrongFacts: string[];
  unsupportedClaims: string[];
  missingEvidence: string[];
  missingNotes: string[];
  repeatedFailedCommands: number;
  wallMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  usd: number | null;
  passed: boolean;
}

export function parseContextTrials(jsonl: string): ContextTrial[] {
  const trials = jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      try {
        return contextTrialSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`context fixture line ${i + 1}: ${String(error)}`, { cause: error });
      }
    });
  if (!trials.length) throw new Error("context fixtures are empty");
  if (new Set(trials.map((f) => f.id)).size !== trials.length) throw new Error("context fixture ids must be unique");
  return trials;
}

/** A saved score cannot supply a PASS label independent of its observed fields. */
export function contextScorePassed(score: ContextScore): boolean {
  return (
    score.completed &&
    score.boundaryRecorded &&
    score.completeTrace &&
    [score.missingFacts, score.wrongFacts, score.unsupportedClaims, score.missingEvidence, score.missingNotes].every(
      (items) => items.length === 0,
    ) &&
    score.repeatedFailedCommands === 0
  );
}

/** Score authored facts against fixed labels, never ask another model to judge itself. */
export async function scoreContextTrial(input: ContextTrial): Promise<ContextScore> {
  const trial = contextTrialSchema.parse(input);
  const { run } = trial;
  const note = trial.boundary === "compaction" ? "compacted" : "resumed";
  let firstBoundaryIndex = -1;
  let boundaryIndex = -1;
  let answerIndex = -1;
  let notesIndex = -1;
  for (let i = 0; i < run.events.length; i++) {
    const event = run.events[i];
    if (trial.boundary !== "child-handoff" && event.type === "run_note" && event.kind === note) {
      if (firstBoundaryIndex < 0) firstBoundaryIndex = i;
      boundaryIndex = i;
    }
    if (event.type === "answer") answerIndex = i;
    if (event.type === "notes") notesIndex = i;
  }
  const boundaryRecorded =
    trial.boundary === "child-handoff" ? run.seed === "parent" && run.childHandoff !== undefined : boundaryIndex >= 0;
  const answer = run.events[answerIndex];
  let actual: Record<string, z.infer<typeof fact>> = {};
  let authored = false;
  try {
    const parsed = z
      .object({ facts: z.record(z.string(), fact) })
      .strict()
      .parse(JSON.parse(answer?.raw ?? answer?.text ?? ""));
    actual = parsed.facts;
    authored = true;
  } catch {
    /* Malformed or missing output is an observed failure, not a fixture error. */
  }
  const missingFacts = Object.keys(trial.expected).filter((key) => !Object.hasOwn(actual, key));
  const wrongFacts = Object.keys(trial.expected).filter(
    (key) => actual[key] && actual[key].value !== trial.expected[key].value,
  );
  const unsupportedClaims = Object.keys(actual).filter((key) => !Object.hasOwn(trial.expected, key));
  const missingEvidence = Object.keys(actual).filter(
    (key) => trial.expected[key] && actual[key].source !== trial.expected[key].source,
  );
  const retainedNotes = run.events[notesIndex]?.text ?? "";
  const missingNotes = trial.expectedNotes.flatMap((item, i) =>
    retainedNotes.includes(item) ? [] : [`note:${i + 1}`],
  );
  const repeatedFailedCommands = run.events
    .slice(firstBoundaryIndex + 1)
    .filter((e) => e.type === "tool_call" && e.command !== undefined && trial.avoidCommands.includes(e.command)).length;
  const completed =
    run.status === "completed" &&
    run.answerOutcome?.ending === "answered" &&
    run.answerOutcome.output === "present" &&
    authored &&
    answerIndex > boundaryIndex;
  const models = run.usage ? Object.values(run.usage.byModel) : undefined;
  const tokens = models?.length
    ? models.reduce(
        (sum, m) => ({
          input: sum.input + m.inputTokens,
          output: sum.output + m.outputTokens,
          cacheRead: sum.cacheRead + m.cacheReadTokens,
          cacheWrite: sum.cacheWrite + m.cacheWriteTokens,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      )
    : null;
  const usd =
    models?.length && models.every((m) => typeof m.usd === "number")
      ? models.reduce((sum, m) => sum + m.usd!, 0)
      : null;
  const score: ContextScore = {
    id: trial.id,
    fixtureHash: await sourceHash({
      id: trial.id,
      task: trial.task,
      boundary: trial.boundary,
      targetRevision: trial.targetRevision,
      contextDigest: trial.contextDigest,
      limits: trial.limits,
      expected: trial.expected,
      expectedNotes: trial.expectedNotes,
      avoidCommands: trial.avoidCommands,
    }),
    sourceRevision: trial.sourceRevision,
    environment: trial.environment,
    effort: trial.effort,
    runId: run.id,
    model: run.model,
    boundary: trial.boundary,
    qualification: trial.qualification,
    boundaryRecorded,
    completed,
    completeTrace: !run.truncated,
    missingFacts,
    wrongFacts,
    unsupportedClaims,
    missingEvidence,
    missingNotes,
    repeatedFailedCommands,
    wallMs: run.finishedAt - run.startedAt,
    tokens,
    usd,
    passed: false,
  };
  score.passed = contextScorePassed(score);
  return score;
}

export function compareContextScores(before: readonly ContextScore[], after: readonly ContextScore[]) {
  const reasons: string[] = [];
  const old = new Map(before.map((s) => [s.id, s]));
  if (
    before.length !== after.length ||
    old.size !== before.length ||
    new Set(after.map((s) => s.id)).size !== after.length
  )
    reasons.push("case set differs");
  for (const row of after) {
    const prior = old.get(row.id);
    if (!prior) {
      reasons.push(`${row.id}: baseline case missing`);
      continue;
    }
    if (prior.fixtureHash !== row.fixtureHash) reasons.push(`${row.id}: fixture differs`);
    if (prior.model !== row.model) reasons.push(`${row.id}: model differs`);
    if (prior.qualification !== row.qualification) reasons.push(`${row.id}: qualification differs`);
    if (prior.environment !== row.environment) reasons.push(`${row.id}: environment differs`);
    if (prior.effort !== row.effort) reasons.push(`${row.id}: effort differs`);
  }
  if (reasons.length) return { comparable: false as const, reasons };
  const total = (rows: readonly ContextScore[], key: "wallMs" | "repeatedFailedCommands") =>
    rows.reduce((n, r) => n + r[key], 0);
  return {
    comparable: true as const,
    passedDelta: after.filter((r) => r.passed).length - before.filter((r) => r.passed).length,
    repeatedFailedCommandsDelta: total(after, "repeatedFailedCommands") - total(before, "repeatedFailedCommands"),
    wallMsDelta: total(after, "wallMs") - total(before, "wallMs"),
    usdDelta: [...before, ...after].every((r) => r.usd !== null)
      ? after.reduce((n, r) => n + r.usd!, 0) - before.reduce((n, r) => n + r.usd!, 0)
      : null,
  };
}

export function renderContextScores(scores: readonly ContextScore[]): string {
  const lines = [
    "# Context outcome evaluation",
    "",
    "Scored recorded answers against independent labels. This report does not prove general model quality.",
    "",
    "| Task | Qualification | Boundary | Result | Missing / wrong / unsupported / uncited | Repeated failed commands | Wall ms | USD |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const row of scores)
    lines.push(
      `| ${row.id.replaceAll("|", "\\|").replace(/[\r\n]/g, " ")} | ${row.qualification} | ${row.boundaryRecorded ? row.boundary : "unconfirmed"} | ${row.passed ? "PASS" : "FAIL"} | ${row.missingFacts.length} / ${row.wrongFacts.length} / ${row.unsupportedClaims.length} / ${row.missingEvidence.length} | ${row.repeatedFailedCommands} | ${row.wallMs} | ${row.usd ?? "unknown"} |`,
    );
  return lines.join("\n") + "\n";
}
