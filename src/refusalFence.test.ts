import { ESLint, Linter } from "eslint";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { REFUSAL_FENCE_FILES, refusalFencePlugin } from "./refusalFence.mjs";

// Feature: docs/reference/specs/routing-and-config.md item 21 — the fence half
// of the refusal seam (record 0054): in a producing module a refusal
// reaches the person only as a `Refusal`, so `npm run lint` (part of verify,
// so CI) refuses a raw `io.reply(` or a raw `throw` before it can ship a
// sentence the renderer never saw.

const ROOT = resolve(import.meta.dirname, "..");

/** Lint one snippet with the rule alone (no file-pattern wiring). */
function findings(code: string): Array<{ line: number | undefined; message: string }> {
  const linter = new Linter();
  const results = linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        plugins: { refusals: refusalFencePlugin },
        languageOptions: { ecmaVersion: 2022, sourceType: "module" },
        rules: { "refusals/no-raw-refusal": "error" },
      },
    ],
    { filename: "src/core/dispatch/anything.ts" },
  );
  return results.map((m) => ({ line: m.line, message: m.message }));
}

describe("no-raw-refusal — the rule", () => {
  it("fails a fixture with a raw reply and a raw throw, two failures by line", () => {
    // Plain JS snippets: the bare Linter parses with espree; the tree pass
    // below proves the rule over the real TypeScript files.
    const fixture = [
      "export async function refuseBadly(io) {",
      '  await io.reply("🚫 no.");', // line 2
      '  throw new Error("no again");', // line 3
      "}",
    ].join("\n");
    expect(findings(fixture)).toEqual([
      { line: 2, message: expect.stringMatching(/bypasses the refusal seam.*renderRefusal/) },
      { line: 3, message: expect.stringMatching(/must carry a Refusal/) },
    ]);
  });

  it("fails a `throw helper()` whose helper is not a named builder — the residentFailure escape the record found", () => {
    expect(findings("throw somethingElse();")).toEqual([
      { line: 1, message: expect.stringMatching(/must carry a Refusal/) },
    ]);
    // The one named builder: its TypeScript return annotation (a CommandError)
    // is the proof it builds a fenced value.
    expect(findings("throw residentFailure(r);")).toEqual([]);
  });

  it("allows the fenced values and a rethrow", () => {
    expect(findings("throw new RefusalError(refusalOf('uncaught', 'x'));")).toEqual([]);
    expect(findings("throw new CommandError('not_found', 'x');")).toEqual([]);
    expect(findings("throw new McpServiceError('invalid_input', 'x');")).toEqual([]);
    expect(findings("try { f(); } catch (err) { throw err; }")).toEqual([]);
  });

  it("catches `p.io.reply(` too — the follow-up shape settle.ts used", () => {
    expect(findings("async function f(p) { await p.io.reply('x'); }")).toEqual([
      { line: 1, message: expect.stringMatching(/bypasses the refusal seam/) },
    ]);
  });
});

describe("no-raw-refusal — the tree, through the repo's own eslint.config.mjs", () => {
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: resolve(ROOT, "eslint.config.mjs") });
  const lintAs = async (filePath: string, code: string) => {
    const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
    return result.messages.filter((m) => m.ruleId === "refusals/no-raw-refusal").map((m) => m.message);
  };
  beforeAll(() => lintAs("src/core/dispatch/authorize.ts", "export {};\n"), 60_000);

  it("a planted raw refusal in a producing module fails the repo's own lint; the renderer and the tests are exempt", async () => {
    const planted = 'export const f = (io: { reply(t: string): Promise<void> }) => io.reply("🚫 no");\n';
    for (const file of ["src/core/dispatch/authorize.ts", "src/core/commands/repo.ts", "src/mcp/service.ts"]) {
      expect(await lintAs(file, planted), file).toEqual([expect.stringMatching(/bypasses the refusal seam/)]);
    }
    // The renderer is the seam's own machinery; a test file is not production.
    expect(await lintAs("src/core/dispatch/reply.ts", planted)).toEqual([]);
    expect(await lintAs("src/core/dispatch/authorize.test.ts", planted)).toEqual([]);
  }, 60_000);

  it("the tree passes: every producing module refuses through the seam", async () => {
    const results = await eslint.lintFiles(REFUSAL_FENCE_FILES);
    const hits = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === "refusals/no-raw-refusal")
        .map((m) => `${r.filePath}:${m.line} ${m.message}`),
    );
    expect(hits).toEqual([]);
  }, 120_000);
});
