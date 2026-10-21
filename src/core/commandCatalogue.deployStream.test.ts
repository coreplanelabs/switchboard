import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config.js";
import { CLI_CALLER, parseCliArgv, runCommand } from "../cli.js";
import { TEST_PROFILE } from "../deploy/testing/profile.js";
import { secretsFrom } from "../secrets.js";
import { buildCoreCommands } from "./commandCatalogue.js";
import { RunRegistry } from "./runRegistry.js";

const runner = vi.hoisted(() => ({
  run: vi.fn(async (_plan, io: { stream(chunk: string): void }) => {
    io.stream("npm deploy output\n");
    return { kind: "ran" as const, ok: true, results: [], notAttempted: [] };
  }),
}));

vi.mock("../deploy/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../deploy/run.js")>()),
  runDeployPlanOnHost: runner.run,
}));

describe("deploy CLI output", () => {
  it("keeps streamed Worker text on stderr so --json stays parseable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-cli-stream-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      const configPath = join(dir, "config.yaml");
      writeFileSync(
        configPath,
        "organization: acme\nproviders:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: anthropic/m\n",
      );
      const commands = buildCoreCommands(new ConfigStore(configPath, join(dir, "overrides.json")), null, {
        registry: new RunRegistry(),
        secrets: secretsFrom({}),
        dataDir: dir,
        warn: () => {},
        profile: async () => ({ profile: TEST_PROFILE, origin: "profile", path: "fixture" }),
      });
      const parsed = parseCliArgv(["deploy", "all", "--only", "memory", "--allow-branch", "--json"], commands);
      if (parsed.kind !== "command") throw new Error("deploy command did not parse");
      const result = await runCommand(commands, parsed, CLI_CALLER);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ plan: { steps: [{ name: "memory" }] } });
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(["npm deploy output\n"]);
      expect(runner.run).toHaveBeenCalledOnce();
    } finally {
      outWrite.mockRestore();
      errWrite.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
