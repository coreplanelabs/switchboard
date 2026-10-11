import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  fstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextEvaluationCommand } from "./contextEvaluationCommand.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync), fstatSync: vi.fn(actual.fstatSync) };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
afterEach(() => {
  vi.mocked(statSync).mockReset().mockImplementation(actualFs.statSync);
  vi.mocked(fstatSync).mockReset().mockImplementation(actualFs.fstatSync);
});

function fixture(model = "test/context") {
  return {
    id: "corrected-goal",
    task: "Report the corrected environment.",
    boundary: "compaction",
    qualification: "synthetic",
    sourceRevision: "a".repeat(40),
    targetRevision: "b".repeat(40),
    contextDigest: "c".repeat(64),
    environment: "local-fixture",
    effort: "unset",
    limits: { maxTurns: 8, maxTokens: 2048 },
    expectedNotes: [],
    avoidCommands: [],
    expected: { environment: { value: "staging", source: "turn:1" } },
    run: {
      id: "recorded-fixture",
      model,
      status: "completed",
      startedAt: 1,
      finishedAt: 21,
      truncated: false,
      answerOutcome: { ending: "answered", output: "present" },
      events: [
        { type: "run_note", kind: "compacted" },
        {
          type: "answer",
          text: JSON.stringify({
            facts: {
              environment: { value: "staging", source: "turn:1" },
            },
          }),
        },
      ],
    },
  };
}

describe("context evaluation command", () => {
  it("scores recordings and writes distinct metric receipts without exporting private answer text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-command-"));
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "results");
      writeFileSync(input, JSON.stringify(fixture()) + "\n");
      const lines: string[] = [];
      const deps = { sourceRevision: "d".repeat(40), now: () => 1, output: (text: string) => lines.push(text) };
      expect(await contextEvaluationCommand({ fixtures: input }, output, deps)).toBe(true);
      expect(await contextEvaluationCommand({ fixtures: input }, output, deps)).toBe(true);
      const files = readdirSync(output);
      expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(2);
      expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(2);
      const bytes = readFileSync(
        join(
          output,
          files.find((f) => f.endsWith(".json"))!,
        ),
        "utf8",
      );
      expect(JSON.parse(bytes)).toMatchObject({
        schemaVersion: "context-evaluation/1",
        evaluatorRevision: "d".repeat(40),
        scores: [{ passed: true, wallMs: 20, usd: null, tokens: null }],
      });
      expect(bytes).not.toContain("Report the corrected environment");
      expect(bytes).not.toContain('"value": "staging"');
      expect(lines[0]).toContain("1/1 context tasks passed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses incomparable baseline improvements and execution flags combined with recordings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-command-"));
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "results");
      const deps = { sourceRevision: "d".repeat(40), output: () => {} };
      writeFileSync(input, JSON.stringify(fixture()) + "\n");
      expect(await contextEvaluationCommand({ fixtures: input }, output, deps)).toBe(true);
      const baseline = join(
        output,
        readdirSync(output).find((f) => f.endsWith(".json"))!,
      );
      writeFileSync(input, JSON.stringify(fixture("test/different")) + "\n");
      expect(await contextEvaluationCommand({ fixtures: input, baseline }, output, deps)).toBe(false);
      const newest = readdirSync(output).filter((f) => f.endsWith(".json") && join(output, f) !== baseline)[0];
      expect(JSON.parse(readFileSync(join(output, newest), "utf8")).comparison).toEqual({
        comparable: false,
        reasons: ["corrected-goal: model differs"],
      });
      await expect(contextEvaluationCommand({ fixtures: input, provider: "test" }, output, deps)).rejects.toThrow(
        "cannot be combined",
      );
      await expect(contextEvaluationCommand({ provider: "test", model: "context" }, output, deps)).rejects.toThrow(
        "key-env is required",
      );
      await expect(
        contextEvaluationCommand({ fixtures: input, "context-arm": "invalid" }, output, deps),
      ).rejects.toThrow("--context-arm must be raw or managed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("context evaluation baseline integrity", () => {
  it("refuses baseline PASS and FAIL labels that contradict the scored fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-baseline-"));
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "results");
      const deps = { sourceRevision: "d".repeat(40), output: () => {} };
      writeFileSync(input, JSON.stringify(fixture()) + "\n");
      expect(await contextEvaluationCommand({ fixtures: input }, output, deps)).toBe(true);
      const validPath = join(
        output,
        readdirSync(output).find((f) => f.endsWith(".json"))!,
      );
      const receipt = JSON.parse(readFileSync(validPath, "utf8"));
      expect(await contextEvaluationCommand({ fixtures: input, baseline: validPath }, output, deps)).toBe(true);
      for (const patch of [{ completed: false }, { missingFacts: ["environment"] }, { passed: false }]) {
        const changed = structuredClone(receipt);
        Object.assign(changed.scores[0], patch);
        const invalidPath = join(dir, "invalid-baseline.json");
        writeFileSync(invalidPath, JSON.stringify(changed));
        await expect(
          contextEvaluationCommand({ fixtures: input, baseline: invalidPath }, output, deps),
        ).rejects.toThrow("baseline score contradicts its outcome fields");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("actual context load CLI", () => {
  it.each(["passing fixture", "failed fact", "incomparable baseline", "inconsistent baseline"] as const)(
    "records the real entry outcome for %s",
    async (scenario) => {
      const dir = mkdtempSync(join(tmpdir(), "context-cli-"));
      try {
        const input = join(dir, "input.jsonl");
        const output = join(dir, "results");
        const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        writeFileSync(input, JSON.stringify(fixture()) + "\n");
        const extraFlags: string[] = [];
        if (scenario !== "failed fact") {
          // Build the prerequisite through the existing API. Each test drives
          // one real CLI invocation instead of repeatedly starting its imports.
          const baselineDir = join(dir, "baseline");
          expect(
            await contextEvaluationCommand({ fixtures: input }, baselineDir, { sourceRevision, output: () => {} }),
          ).toBe(true);
          const baseline = join(
            baselineDir,
            readdirSync(baselineDir).find((file) => file.endsWith(".json"))!,
          );
          if (scenario === "inconsistent baseline") {
            const contradictory = JSON.parse(readFileSync(baseline, "utf8"));
            contradictory.scores[0].completed = false;
            writeFileSync(baseline, JSON.stringify(contradictory));
          }
          extraFlags.push("--baseline", baseline);
        }
        if (scenario === "failed fact") {
          const failed = fixture();
          failed.run.events.at(-1)!.text = JSON.stringify({
            facts: { environment: { value: "production", source: "turn:1" } },
          });
          writeFileSync(input, JSON.stringify(failed) + "\n");
        } else if (scenario === "incomparable baseline")
          writeFileSync(input, JSON.stringify(fixture("test/other")) + "\n");
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", "scripts/load.ts", "context", "--fixtures", input, ...extraFlags],
          {
            encoding: "utf8",
            env: { ...process.env, SWITCHBOARD_LOAD_RESULTS: output },
          },
        );
        if (scenario === "inconsistent baseline") {
          expect(result.status).toBe(2);
          expect(result.stderr).toContain("baseline score contradicts its outcome fields");
          expect(readdirSync(dir)).not.toContain("results");
          return;
        }
        expect({ status: result.status, stderr: result.stderr }).toEqual({
          status: scenario === "passing fixture" ? 0 : 1,
          stderr: "",
        });
        const receipt = JSON.parse(
          readFileSync(
            join(
              output,
              readdirSync(output).find((file) => file.endsWith(".json"))!,
            ),
            "utf8",
          ),
        );
        expect(receipt.evaluatorRevision).toBe(sourceRevision);
        expect(receipt.sourceHashes["scripts/load.ts"]).toMatch(/^[a-f0-9]{64}$/);
        if (scenario === "failed fact") {
          expect(result.stdout).toContain("0/1 context tasks passed");
          expect(receipt.scores).toMatchObject([
            { passed: false, wrongFacts: ["environment"], usd: null, tokens: null },
          ]);
        } else {
          expect(result.stdout).toContain("1/1 context tasks passed");
          expect(receipt.scores).toMatchObject([{ passed: true, qualification: "synthetic", usd: null, tokens: null }]);
          expect(receipt.comparison).toEqual(
            scenario === "passing fixture"
              ? { comparable: true, passedDelta: 0, repeatedFailedCommandsDelta: 0, wallMsDelta: 0, usdDelta: null }
              : { comparable: false, reasons: ["corrected-goal: model differs"] },
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("context evaluation bounded input", () => {
  const deps = { sourceRevision: "d".repeat(40), output: () => {} };
  const afterMetadata = (change: () => void) => {
    // Both implementations observe the same boundary. The callback runs after
    // metadata was read and before any input bytes can be consumed.
    vi.mocked(statSync).mockImplementationOnce((path) => {
      const stat = actualFs.statSync(path);
      change();
      return stat;
    });
    vi.mocked(fstatSync).mockImplementationOnce((fd) => {
      const stat = actualFs.fstatSync(fd);
      change();
      return stat;
    });
  };

  it("refuses an overlimit file without writing a receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-bounded-"));
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "results");
      writeFileSync(input, JSON.stringify(fixture()) + "\n");
      truncateSync(input, 32 * 1024 * 1024 + 1);
      await expect(contextEvaluationCommand({ fixtures: input }, output, deps)).rejects.toThrow(
        "context input exceeds 32 MiB",
      );
      expect(readdirSync(dir)).toEqual(["input.jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scores the opened file when its pathname is replaced after metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-bounded-"));
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "results");
      writeFileSync(input, JSON.stringify(fixture()) + "\n");
      const replacement = fixture();
      replacement.run.events.at(-1)!.text = JSON.stringify({
        facts: { environment: { value: "production", source: "turn:1" } },
      });
      const replacementBytes = JSON.stringify(replacement) + "\n";
      afterMetadata(() => {
        renameSync(input, join(dir, "original.jsonl"));
        writeFileSync(input, replacementBytes);
      });
      expect(await contextEvaluationCommand({ fixtures: input }, output, deps)).toBe(true);
      expect(readFileSync(input, "utf8")).toBe(replacementBytes);
      const receipt = JSON.parse(
        readFileSync(
          join(
            output,
            readdirSync(output).find((file) => file.endsWith(".json"))!,
          ),
          "utf8",
        ),
      );
      expect(receipt.scores).toMatchObject([{ passed: true, wrongFacts: [], runId: "recorded-fixture" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses valid input that grows past the byte budget after metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-bounded-"));
    try {
      const input = join(dir, "input.jsonl");
      const output = join(dir, "results");
      const initial = JSON.stringify(fixture()) + "\n";
      writeFileSync(input, initial);
      afterMetadata(() => appendFileSync(input, Buffer.alloc(32 * 1024 * 1024 + 1 - Buffer.byteLength(initial), " ")));
      await expect(contextEvaluationCommand({ fixtures: input }, output, deps)).rejects.toThrow(
        "context input exceeds 32 MiB",
      );
      expect(actualFs.statSync(input).size).toBe(33_554_433);
      expect(readdirSync(dir)).toEqual(["input.jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
