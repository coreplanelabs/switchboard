import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PiAiProviders } from "../core/harness/piAi.js";
import type { Provider } from "../core/provider.js";
import { PRESET_FLOORS, minutesToMs } from "../core/budgets.js";
import { systemClock } from "../core/trace/clock.js";
import { contextTasks } from "./contextTasks.js";
import { runContextTrial } from "./contextTrials.js";
import {
  compareContextScores,
  contextScorePassed,
  parseContextTrials,
  renderContextScores,
  scoreContextTrial,
  type ContextScore,
} from "./contextEvaluation.js";

const scoreSchema = z
  .object({
    id: z.string(),
    fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    environment: z.string(),
    effort: z.string(),
    runId: z.string(),
    model: z.string(),
    boundary: z.enum(["compaction", "restart", "child-handoff"]),
    qualification: z.enum(["synthetic", "recorded"]),
    boundaryRecorded: z.boolean(),
    completed: z.boolean(),
    completeTrace: z.boolean(),
    missingFacts: z.array(z.string()),
    wrongFacts: z.array(z.string()),
    unsupportedClaims: z.array(z.string()),
    missingEvidence: z.array(z.string()),
    missingNotes: z.array(z.string()),
    repeatedFailedCommands: z.number().int().nonnegative(),
    wallMs: z.number().finite().nonnegative(),
    tokens: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(),
      })
      .nullable(),
    usd: z.number().finite().nonnegative().nullable(),
    passed: z.boolean(),
  })
  .strict()
  .refine((score) => score.passed === contextScorePassed(score), "baseline score contradicts its outcome fields");

function readBounded(path: string): string {
  const limit = 32 * 1024 * 1024;
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("context input must be a regular file");
    if (stat.size > limit) throw new Error("context input exceeds 32 MiB");
    const buffer = Buffer.alloc(64 * 1024);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - total), null);
      if (count === 0) break;
      total += count;
      if (total > limit) throw new Error("context input exceeds 32 MiB");
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The load entry supplies this command. Tests inject a provider, never a production credential. */
export async function contextEvaluationCommand(
  flags: Record<string, string | boolean | undefined>,
  results: string,
  deps: { provider?: Provider; sourceRevision?: string; now?: () => number; output?: (text: string) => void } = {},
): Promise<boolean> {
  for (const name of Object.keys(flags))
    if (!["fixtures", "baseline", "provider", "model", "key-env", "base-url", "task", "context-arm"].includes(name))
      throw new Error(`context: unknown flag --${name}`);
  const sourceRevision = deps.sourceRevision ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const arm = flags["context-arm"] ?? "managed";
  if (arm !== "raw" && arm !== "managed") throw new Error("context: --context-arm must be raw or managed");
  if (
    flags.fixtures &&
    ["provider", "model", "key-env", "base-url", "context-arm"].some((name) => flags[name] !== undefined)
  )
    throw new Error("context: recorded fixtures cannot be combined with provider execution flags");
  let trials;
  if (typeof flags.fixtures === "string") trials = parseContextTrials(readBounded(flags.fixtures));
  else {
    if (typeof flags.provider !== "string" || typeof flags.model !== "string")
      throw new Error("context: supply --fixtures PATH or explicit --provider NAME --model ID");
    if (!deps.provider && typeof flags["key-env"] !== "string")
      throw new Error("context: --key-env is required for provider trials");
    const provider =
      deps.provider ??
      new PiAiProviders({
        [flags.provider]: {
          type: flags.provider === "anthropic" ? "anthropic" : "openai-compatible",
          ...(flags.provider === "openai" ? { wire: "openai-responses" as const } : {}),
          apiKeyEnv: String(flags["key-env"]),
          ...(typeof flags["base-url"] === "string" ? { baseUrl: flags["base-url"] } : {}),
        },
      }).get(flags.provider);
    if (provider.name !== flags.provider) throw new Error("context: provider identity differs from requested provider");
    const tasks = contextTasks().filter((task) => !flags.task || flags.task === "all" || flags.task === task.id);
    if (!tasks.length) throw new Error("context: unknown task");
    trials = [];
    for (const task of tasks)
      trials.push(
        await runContextTrial({
          task,
          provider,
          model: flags.model,
          sourceRevision,
          // Synthetic source is fixed independently of Switchboard implementation.
          targetRevision: "0".repeat(40),
          arm,
          signal: AbortSignal.timeout(minutesToMs(PRESET_FLOORS.research)),
        }),
      );
  }
  const scores = await Promise.all(trials.map(scoreContextTrial));
  let comparison;
  if (typeof flags.baseline === "string") {
    const baseline = z
      .object({
        schemaVersion: z.literal("context-evaluation/1"),
        evaluatorRevision: z.string().regex(/^[a-f0-9]{40}$/),
        sourceHashes: z
          .record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/))
          .refine((hashes) => Object.keys(hashes).length > 0, "baseline source hashes are required"),
        arm: z.enum(["recorded-input", "raw", "managed"]),
        scores: z.array(scoreSchema).min(1),
      })
      .passthrough()
      .parse(JSON.parse(readBounded(flags.baseline)));
    comparison = compareContextScores(baseline.scores as ContextScore[], scores);
  }
  const sourceFiles = [
    "scripts/load.ts",
    "src/load/contextEvaluation.ts",
    "src/load/contextEvaluationCommand.ts",
    "src/load/contextTasks.ts",
    "src/load/contextTrials.ts",
    "src/core/dispatch/handoffBrief.ts",
    "src/core/dispatch/seed.ts",
    "src/tools/session.ts",
  ];
  const sourceHashes = Object.fromEntries(
    sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  );
  const receipt = {
    schemaVersion: "context-evaluation/1",
    evaluatorRevision: sourceRevision,
    sourceHashes,
    arm: flags.fixtures ? "recorded-input" : arm,
    scores,
    ...(comparison ? { comparison } : {}),
  };
  mkdirSync(results, { recursive: true });
  const id = `${new Date((deps.now ?? systemClock)()).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const base = join(results, `context-${id}`);
  writeFileSync(`${base}.json`, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  const comparisonText = comparison ? `\nComparison: ${JSON.stringify(comparison)}\n` : "";
  writeFileSync(`${base}.md`, renderContextScores(scores) + comparisonText, { flag: "wx" });
  (deps.output ?? ((text) => process.stdout.write(text)))(
    `${scores.filter((row) => row.passed).length}/${scores.length} context tasks passed; receipts ${base}.json and .md\n${comparisonText}`,
  );
  return scores.every((score) => score.passed) && (!comparison || comparison.comparable);
}
