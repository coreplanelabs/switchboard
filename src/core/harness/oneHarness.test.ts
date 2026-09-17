import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS } from "../../agents/registry.js";

// Feature: docs/reference/specs/harness-pi.md item 1 — one harness. Record
// 0032's series (docs/decisions/0032-pi-is-the-harness-the-native-loop-retires.md)
// moved every preset onto pi and, at its last step, deleted the native turn
// loop, both provider adapters and the native tool table. This scan is the
// proof that stays: it walks `src/` and fails the build the day any of them
// comes back — a second loop behind a preset would be the quiet regression the
// record's "no two loops serve one preset" gate exists to catch.

const SRC = resolve(__dirname, "../..");
const REPO = resolve(SRC, "..");

/** Every `.ts` file under `src/`, as repo-relative paths. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith(".ts")) out.push(relative(REPO, path));
  }
  return out;
}

const THIS_FILE = relative(REPO, __filename);

/** The modules the series deleted; a path that exists again is the loop coming back. */
const DELETED = [
  "src/runner.ts",
  "src/runner.test.ts",
  "src/providers",
  "src/tools/workspace.ts",
  "src/tools/workspace.test.ts",
  "src/core/harness/select.ts",
  "src/core/harness/select.test.ts",
];

/** An import of a deleted module, however the relative path is spelt. */
const DELETED_IMPORT =
  /from\s+"(?:\.\.?\/)+(?:runner|providers\/(?:anthropic|openaiCompat|registry|types)|tools\/workspace|core\/harness\/select|harness\/select)\.js"/;

/** The deleted code by its own names: the loop's entry, the adapters and their
 *  registry, the loop's sandbox health counter and the harness selector. */
const DELETED_SYMBOLS = [
  /\brunAgent\s*\(/,
  /\bnew\s+ProviderRegistry\b/,
  /\bnew\s+AnthropicProvider\b/,
  /\bnew\s+OpenAICompatProvider\b/,
  /\bExecHealthTracker\b/,
  /\beffectiveHarness\s*\(/,
];

describe("one harness — the native loop, both provider adapters and the native tool table are gone (harness-pi.md item 1)", () => {
  it("the deleted modules are absent from the tree", () => {
    for (const path of DELETED) expect(existsSync(join(REPO, path)), path).toBe(false);
  });

  it("no module under src/ imports a deleted module or calls the deleted code by name", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === THIS_FILE) continue;
      const text = readFileSync(join(REPO, file), "utf8");
      const hit = DELETED_IMPORT.exec(text)?.[0] ?? DELETED_SYMBOLS.find((re) => re.test(text))?.source;
      if (hit) offenders.push(`${file}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the run stage has one loop: the harness object's open form (docs/reference/specs/harness.md item 7), never pi's function by name, and nothing that selects between two", () => {
    const runLoop = readFileSync(join(REPO, "src/core/dispatch/runLoop.ts"), "utf8");
    expect(runLoop).toContain("openThroughSeam(");
    expect(runLoop).not.toMatch(/\.harness\.open\(/);
    expect(runLoop).not.toMatch(/\brunPiHarnessOpen\b/);
    expect(runLoop).not.toMatch(/\brunAgent\b/);
    expect(runLoop).not.toMatch(/\beffectiveHarness\b/);
    expect(runLoop).not.toMatch(/harness\s*===\s*"/);
    // The roster is handed in (harness.md item 8): the loop imports no harness
    // class and constructs none — it picks an object off `deps.harness.harnesses`.
    expect(runLoop).not.toMatch(/\b(?:PiHarness|OpenCodeHarness)\b/);
    expect(runLoop).not.toMatch(/harness\/pi\/piHarness\.js|harness\/opencode\/harness\.js/);
  });

  it("the roster lives in the process wiring — src/index.ts and src/cli.ts construct every harness by class — and the run stage reads it as data", () => {
    for (const file of ["src/index.ts", "src/cli.ts"]) {
      const text = readFileSync(join(REPO, file), "utf8");
      expect(text, file).toMatch(/\bnew PiHarness\(/);
      expect(text, file).toMatch(/\bnew OpenCodeHarness\(/);
    }
  });

  it("no preset declares a harness, and the registry exports no table of harnesses", async () => {
    for (const agent of Object.values(AGENTS)) expect("harness" in agent, agent.name).toBe(false);
    const registry = (await import("../../agents/registry.js")) as Record<string, unknown>;
    for (const name of ["HARNESSES", "HARNESS_NAMES", "DEFAULT_HARNESS", "harnessForPreset", "harnessFor"])
      expect(registry[name], name).toBeUndefined();
    const source = readFileSync(join(REPO, "src/agents/registry.ts"), "utf8");
    expect(source).not.toMatch(/\b(?:PiHarness|OpenCodeHarness|HarnessRoster|HARNESS_NAMES)\b/);
  });

  it("the toolset table holds only tools the bot relays — none of the workspace tools pi has of its own", async () => {
    const { TOOLSETS } = await import("../../tools/toolsets.js");
    const piOwn = new Set(["bash", "read", "edit", "write", "grep", "find", "ls", "read_file", "write_file"]);
    for (const [name, tools] of Object.entries(TOOLSETS))
      for (const tool of tools) expect(piOwn.has(tool.name), `${name}: ${tool.name}`).toBe(false);
  });

  it("run-loop.md retired with its code: the spec is gone and the specs index no longer lists it", () => {
    expect(existsSync(join(REPO, "docs/reference/specs/run-loop.md"))).toBe(false);
    const index = readFileSync(join(REPO, "docs/reference/specs/README.md"), "utf8");
    expect(index).not.toContain("run-loop.md");
  });
});
