import { describe, expect, it, vi } from "vitest";
import {
  buildPlan,
  parseArgs,
  parseConfig,
  parseOpRef,
  runFill,
  stripJsonc,
  type FillDeps,
  type OpEnvConfig,
  type OpReader,
  type WranglerRunner,
} from "./opEnvFill.js";

// Feature: features/1password-env-fill.md — populate a deploy env's Worker
// secrets from 1Password via a read-only service account. UAT-only by default,
// prod hard-guarded, dry-run shows names (never values), apply resolves +
// pipes to wrangler, missing token fails closed.

const CONFIG: OpEnvConfig = {
  uat: {
    bot: {
      SLACK_BOT_TOKEN: "op://Switchboard UAT/slack/bot-token",
      ANTHROPIC_API_KEY: "op://Switchboard UAT/anthropic/api-key",
    },
    resident: {
      GITHUB_APP_ID: "op://Switchboard UAT/github-app/app-id",
    },
  },
  prod: {
    bot: {
      SLACK_BOT_TOKEN: "op://Switchboard PROD/slack/bot-token",
    },
  },
};

function mockDeps(overrides: Partial<FillDeps> = {}): FillDeps & {
  logs: string[];
  reader: OpReader & { read: ReturnType<typeof vi.fn> };
  runner: WranglerRunner & { putSecret: ReturnType<typeof vi.fn> };
} {
  const logs: string[] = [];
  const reader = { read: vi.fn(async (ref: string) => `VALUE::${ref}`) };
  const runner = { putSecret: vi.fn(async () => {}) };
  const deps: FillDeps = {
    config: CONFIG,
    env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_test-token" },
    repoRoot: "/repo",
    opReader: reader,
    wrangler: runner,
    log: (line) => logs.push(line),
    ...overrides,
  };
  return Object.assign(deps, { logs, reader, runner });
}

// ---------------------------------------------------------------------------

describe("stripJsonc", () => {
  it("preserves op:// (with its //) inside string values", () => {
    const src = '{ "K": "op://Vault/Item/field" }';
    expect(JSON.parse(stripJsonc(src))).toEqual({ K: "op://Vault/Item/field" });
  });

  it("strips line comments outside strings but not the op:// inside them", () => {
    const src = `{
      // a comment about the bot token
      "SLACK_BOT_TOKEN": "op://V/slack/token" // trailing note
    }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({ SLACK_BOT_TOKEN: "op://V/slack/token" });
  });

  it("strips block comments and trailing commas", () => {
    const src = `{
      /* block */ "A": "op://V/a/f",
      "B": "op://V/b/f",
    }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({ A: "op://V/a/f", B: "op://V/b/f" });
  });
});

describe("parseConfig", () => {
  it("parses a JSONC config with comments", () => {
    const cfg = parseConfig(`{
      // UAT only for now
      "uat": { "bot": { "TOK": "op://V/i/f" } }
    }`);
    expect(cfg.uat.bot.TOK).toBe("op://V/i/f");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseConfig("{ not json")).toThrow(/not valid JSONC/);
  });

  it("throws when a ref is not a string", () => {
    expect(() => parseConfig('{ "uat": { "bot": { "TOK": 5 } } }')).toThrow(/must be a string op:\/\/ ref/);
  });
});

describe("parseOpRef", () => {
  it("splits vault/item/field", () => {
    expect(parseOpRef("op://My Vault/my-item/my-field")).toEqual({
      vault: "My Vault",
      item: "my-item",
      field: "my-field",
    });
  });

  it("folds a trailing section path into field", () => {
    expect(parseOpRef("op://V/item/section/field")).toEqual({ vault: "V", item: "item", field: "section/field" });
  });

  it("rejects a non-op ref and a too-short ref", () => {
    expect(() => parseOpRef("https://example.com")).toThrow(/must start with op:\/\//);
    expect(() => parseOpRef("op://V/only-item")).toThrow(/malformed op:\/\//);
  });
});

describe("parseArgs", () => {
  it("parses --env, repeated --target, and defaults to dry-run", () => {
    const r = parseArgs(["--env", "uat", "--target", "bot", "--target", "resident"]);
    expect(r).toEqual({ env: "uat", targets: ["bot", "resident"], apply: false, allowProd: false, configPath: "deploy/op-env.jsonc" });
  });

  it("--target both expands to both targets", () => {
    const r = parseArgs(["--env=uat", "--target=both"]);
    expect(r).toMatchObject({ targets: ["bot", "resident"] });
  });

  it("--apply and --i-understand-prod set their flags", () => {
    const r = parseArgs(["--env", "prod", "--target", "bot", "--apply", "--i-understand-prod"]);
    expect(r).toMatchObject({ apply: true, allowProd: true });
  });

  it("requires --env and --target", () => {
    expect(parseArgs(["--target", "bot"])).toEqual({ error: expect.stringMatching(/--env is required/) });
    expect(parseArgs(["--env", "uat"])).toEqual({ error: expect.stringMatching(/--target is required/) });
  });

  it("rejects unknown targets and unknown args", () => {
    expect(parseArgs(["--env", "uat", "--target", "nope"])).toEqual({ error: expect.stringMatching(/unknown --target/) });
    expect(parseArgs(["--env", "uat", "--target", "bot", "--wat"])).toEqual({ error: expect.stringMatching(/unknown argument/) });
  });
});

describe("buildPlan — prod hard-guard + env isolation", () => {
  it("refuses prod without the override", () => {
    expect(() => buildPlan(CONFIG, { env: "prod", targets: ["bot"], apply: false, allowProd: false })).toThrow(
      /REFUSING to target prod/,
    );
  });

  it("proceeds to prod only with the override", () => {
    const plan = buildPlan(CONFIG, { env: "prod", targets: ["bot"], apply: true, allowProd: true });
    expect(plan.map((e) => e.ref)).toEqual(["op://Switchboard PROD/slack/bot-token"]);
  });

  it("a uat run only reads uat refs, never prod", () => {
    const plan = buildPlan(CONFIG, { env: "uat", targets: ["bot", "resident"], apply: false, allowProd: false });
    expect(plan.map((e) => e.secretName)).toEqual(["SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_APP_ID"]);
    expect(plan.every((e) => e.vault === "Switchboard UAT")).toBe(true);
  });

  it("throws on an unknown environment", () => {
    expect(() => buildPlan(CONFIG, { env: "staging", targets: ["bot"], apply: false, allowProd: false })).toThrow(
      /unknown environment "staging"/,
    );
  });
});

describe("runFill — dry-run", () => {
  it("prints names + refs, and calls neither op-read nor wrangler", async () => {
    const deps = mockDeps();
    const res = await runFill({ env: "uat", targets: ["bot"], apply: false, allowProd: false }, deps);

    expect(res.applied).toBe(false);
    expect(deps.reader.read).not.toHaveBeenCalled();
    expect(deps.runner.putSecret).not.toHaveBeenCalled();

    const text = deps.logs.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("SLACK_BOT_TOKEN");
    expect(text).toContain("op://Switchboard UAT/slack/bot-token");
    // no resolved value ever appears
    expect(text).not.toContain("VALUE::");
  });
});

describe("runFill — apply", () => {
  it("resolves + sets each secret once, value only on stdin, and never logs the value", async () => {
    const deps = mockDeps();
    const res = await runFill({ env: "uat", targets: ["bot", "resident"], apply: true, allowProd: false }, deps);

    expect(res.applied).toBe(true);
    expect(deps.reader.read).toHaveBeenCalledTimes(3);
    expect(deps.runner.putSecret).toHaveBeenCalledTimes(3);

    // wrangler gets the resolved value + the correct per-target worker dir
    expect(deps.runner.putSecret).toHaveBeenCalledWith({
      name: "SLACK_BOT_TOKEN",
      value: "VALUE::op://Switchboard UAT/slack/bot-token",
      cwd: "/repo/deploy/cloudflare",
    });
    expect(deps.runner.putSecret).toHaveBeenCalledWith({
      name: "GITHUB_APP_ID",
      value: "VALUE::op://Switchboard UAT/github-app/app-id",
      cwd: "/repo/deploy/cloudflare-resident",
    });

    // resolved values never leak into the log stream
    expect(deps.logs.join("\n")).not.toContain("VALUE::");
  });

  it("fails closed when OP_SERVICE_ACCOUNT_TOKEN is missing — no op-read, no wrangler", async () => {
    const deps = mockDeps({ env: {} });
    await expect(runFill({ env: "uat", targets: ["bot"], apply: true, allowProd: false }, deps)).rejects.toThrow(
      /OP_SERVICE_ACCOUNT_TOKEN is not set/,
    );
    expect(deps.reader.read).not.toHaveBeenCalled();
    expect(deps.runner.putSecret).not.toHaveBeenCalled();
  });

  it("prod apply is still refused without the override, before any op-read", async () => {
    const deps = mockDeps();
    await expect(runFill({ env: "prod", targets: ["bot"], apply: true, allowProd: false }, deps)).rejects.toThrow(
      /REFUSING to target prod/,
    );
    expect(deps.reader.read).not.toHaveBeenCalled();
    expect(deps.runner.putSecret).not.toHaveBeenCalled();
  });
});
