import { ESLint, Linter } from "eslint";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_FALLBACKS as RULE_FALLBACKS,
  isPublicEnvName,
  SECRET_NAMES as RULE_NAMES,
  secretEnvPlugin,
} from "./secretEnv.mjs";
import { CREDENTIAL_FALLBACKS, SECRET_NAMES } from "./secrets.js";

// Feature: docs/reference/specs/routing-and-config.md item 19 — the lint half of
// the guarantee: a raw `process.env` read of a credential anywhere in the bot's
// production code is a lint error, so `npm run lint` (part of verify, so CI)
// refuses a new leak before it can run.

const ROOT = resolve(import.meta.dirname, "..");

/** Lint one snippet with the rule alone (no file-pattern wiring). */
function messages(code: string, options: { hostTooling?: boolean } = {}): string[] {
  const linter = new Linter();
  const results = linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        plugins: { secrets: secretEnvPlugin },
        languageOptions: { ecmaVersion: 2022, sourceType: "module" },
        rules: { "secrets/no-raw-env": ["error", options] },
      },
    ],
    { filename: "src/anything.ts" },
  );
  return results.map((m) => m.message);
}

describe("no-raw-env — the rule", () => {
  it("refuses a credential read by name, static or bracketed, naming the secret and the module to use", () => {
    expect(messages("const t = process.env.SLACK_BOT_TOKEN;")).toEqual([
      expect.stringMatching(/process\.env\.SLACK_BOT_TOKEN is a credential: read it through src\/secrets\.ts/),
    ]);
    expect(messages('const t = process.env["MEMORY_TOKEN"];')).toEqual([
      expect.stringMatching(/MEMORY_TOKEN is a credential/),
    ]);
    expect(messages("if (process.env.GH_TOKEN) {}")).toEqual([expect.stringMatching(/GH_TOKEN is a credential/)]);
    expect(messages("process.env.SWITCHBOARD_INGRESS_TOKENS;")).toEqual([
      expect.stringMatching(/SWITCHBOARD_INGRESS_TOKENS is a credential/),
    ]);
  });

  it("refuses a computed read — it can name any credential", () => {
    expect(messages("const k = process.env[cfg.apiKeyEnv];")).toEqual([
      expect.stringMatching(/can name any credential/),
    ]);
    expect(messages("const k = process.env[`${prefix}_TOKEN`];")).toEqual([
      expect.stringMatching(/can name any credential/),
    ]);
  });

  it("refuses the whole environment as a value — passed, spread, stored, destructured", () => {
    expect(messages("build(cfg, process.env);")).toEqual([expect.stringMatching(/carries every credential/)]);
    expect(messages("const deps = { env: process.env };")).toEqual([expect.stringMatching(/carries every credential/)]);
    expect(messages("const copy = { ...process.env };")).toEqual([expect.stringMatching(/carries every credential/)]);
    expect(messages("const { PORT } = process.env;")).toEqual([expect.stringMatching(/carries every credential/)]);
    expect(messages("const { SLACK_APP_TOKEN } = process.env;")).toEqual([
      expect.stringMatching(/SLACK_APP_TOKEN is a credential/),
      expect.stringMatching(/carries every credential/),
    ]);
  });

  it("allows the public variables by name and refuses a name that is neither public nor a credential", () => {
    expect(messages("const p = process.env.PORT ?? '3000';")).toEqual([]);
    expect(messages("const c = process.env.SWITCHBOARD_CONFIG;")).toEqual([]);
    expect(messages("const u = process.env.PUBLIC_BASE_URL?.trim();")).toEqual([]);
    expect(messages("if (process.env.ACCESS_DEV_BYPASS !== undefined) {}")).toEqual([]);
    expect(messages("const x = process.env.SOME_NEW_THING;")).toEqual([
      expect.stringMatching(/SOME_NEW_THING is not on the public list/),
    ]);
  });

  it("a host-tooling file keeps its bare and computed reads (it spawns wrangler with the operator's environment) but still may not read a credential by name", () => {
    const host = { hostTooling: true };
    expect(messages("spawn('npm', args, { env: process.env });", host)).toEqual([]);
    expect(messages("const env = { ...process.env, ...set };", host)).toEqual([]);
    expect(messages("if (!req.anyOf.some((v) => process.env[v])) {}", host)).toEqual([]);
    expect(messages("const t = process.env.CLOUDFLARE_API_TOKEN;", host)).toEqual([]);
    expect(messages("const t = process.env.MEMORY_TOKEN;", host)).toEqual([
      expect.stringMatching(/MEMORY_TOKEN is a credential/),
    ]);
    expect(messages("const { GITHUB_APP_PRIVATE_KEY } = process.env;", host)).toEqual([
      expect.stringMatching(/GITHUB_APP_PRIVATE_KEY is a credential/),
    ]);
  });

  it("ignores everything that is not process.env", () => {
    expect(messages("const e = env.MEMORY_TOKEN; const p = proc.env.X; const q = process.argv;")).toEqual([]);
  });
});

describe("no-raw-env — wired into eslint.config.mjs", () => {
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: resolve(ROOT, "eslint.config.mjs") });
  const lintAs = async (filePath: string, code: string) => {
    const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
    return result.messages.filter((m) => m.ruleId === "secrets/no-raw-env").map((m) => m.message);
  };

  it("a planted `process.env.SLACK_BOT_TOKEN` in a production file fails the repo's own lint", async () => {
    const planted = "export const token = process.env.SLACK_BOT_TOKEN;\n";
    for (const file of ["src/channels/planted.ts", "src/core/dispatch/planted.ts", "src/index.ts"]) {
      expect(await lintAs(file, planted)).toEqual([expect.stringMatching(/SLACK_BOT_TOKEN is a credential/)]);
    }
  });

  it("the same line in a host-tooling file fails too; a bare process.env there does not", async () => {
    expect(await lintAs("src/deploy/planted.ts", "export const t = process.env.SLACK_BOT_TOKEN;\n")).toEqual([
      expect.stringMatching(/SLACK_BOT_TOKEN is a credential/),
    ]);
    expect(await lintAs("src/deploy/planted.ts", "export const e = { ...process.env };\n")).toEqual([]);
  });

  it("src/secrets.ts, src/loadEnv.ts and the tests are exempt — they are where the environment is read", async () => {
    const read = "export const t = process.env.SLACK_BOT_TOKEN;\n";
    expect(await lintAs("src/secrets.ts", read)).toEqual([]);
    expect(await lintAs("src/loadEnv.ts", read)).toEqual([]);
    expect(await lintAs("src/channels/slack.test.ts", read)).toEqual([]);
    expect(await lintAs("src/core/testing/fixture.ts", read)).toEqual([]);
  });

  it("the tree passes: no production file under src/ reads a credential from process.env", async () => {
    const results = await eslint.lintFiles(["src/**/*.ts"]);
    const offenders = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === "secrets/no-raw-env")
        .map((m) => `${r.filePath.replace(`${ROOT}/`, "")}:${m.line} ${m.message}`),
    );
    expect(offenders).toEqual([]);
  }, 120_000);
});

describe("the two lists agree", () => {
  it("the rule and src/secrets.ts name the same credentials and the same fallbacks", () => {
    expect(new Set(RULE_NAMES)).toEqual(new Set(SECRET_NAMES));
    expect([...RULE_FALLBACKS]).toEqual([...CREDENTIAL_FALLBACKS]);
  });

  it("no credential is public, whatever its prefix", () => {
    for (const name of SECRET_NAMES) expect(isPublicEnvName(name), name).toBe(false);
    expect(isPublicEnvName("SWITCHBOARD_CONFIG")).toBe(true);
    expect(isPublicEnvName("PORT")).toBe(true);
  });
});
