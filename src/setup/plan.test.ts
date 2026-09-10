import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { parseAppConfigText } from "../config.js";
import { parseProfile } from "../deploy/profile.js";
import { TEST_PROFILE } from "../deploy/testing/profile.js";
import {
  CONFIG_PATH,
  ENV_PATH,
  maskedPreview,
  planInit,
  PROFILE_PATH,
  renderEnv,
  type InitAnswers,
  type InitTemplates,
  type InitWorld,
} from "./plan.js";

// Feature: docs/reference/specs/init.md — the pure half of `switchboard init`:
// answers + the checked-in templates → the files to write (with their modes and
// the names of the secrets they carry), the providers block that matches the
// keys given, the config as the real loader reads it, the capabilities it
// computes, and the next commands. Refusals are values, never throws: a plan
// with `ok: false` names the code and every problem.

/** The real templates: the planner reads exactly these files on a host. */
const TEMPLATES: InitTemplates = {
  env: readFileSync(".env.example", "utf8"),
  config: readFileSync("config/config.example.yaml", "utf8"),
  profile: readFileSync("deploy/profile.example.json", "utf8"),
};

const ANTHROPIC = "sk-ant-test-0123456789";
const OPENAI = "sk-test-openai-9876543210";
const APP_TOKEN = "xapp-1-test-token";
const BOT_TOKEN = "xoxb-test-token";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEtest\nline2\n-----END RSA PRIVATE KEY-----\n";
const ACCOUNT = TEST_PROFILE.account;

const minimal: InitAnswers = { organization: "acme", name: "switchboard", anthropicKey: ANTHROPIC };

const world = (over: Partial<InitWorld> = {}): InitWorld => ({
  existing: new Set(),
  force: false,
  inCheckout: true,
  env: {},
  image: "ghcr.io/example/switchboard",
  ...over,
});

function planned(answers: InitAnswers, w: Partial<InitWorld> = {}) {
  const plan = planInit(answers, TEMPLATES, world(w));
  if (!plan.ok) throw new Error(`plan refused: ${plan.code} — ${plan.problems.join("; ")}`);
  return plan;
}

const fileAt = (plan: ReturnType<typeof planned>, path: string) => {
  const f = plan.files.find((x) => x.path === path);
  if (!f) throw new Error(`no planned file ${path} (have ${plan.files.map((x) => x.path).join(", ")})`);
  return f;
};

describe("planInit — the files", () => {
  it("an Anthropic key alone: .env (mode 600) and config/config.yaml (mode 644), no profile; the config loads through the real loader with one provider and the example's default models", () => {
    const plan = planned(minimal);
    expect(plan.files.map((f) => [f.path, f.mode])).toEqual([
      [ENV_PATH, 0o600],
      [CONFIG_PATH, 0o644],
    ]);
    const env = parseEnv(fileAt(plan, ENV_PATH).text);
    expect(env.ANTHROPIC_API_KEY).toBe(ANTHROPIC);
    // Placeholders the operator gave no value for are commented out — nothing reads a fake value.
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.E2B_API_KEY).toBeUndefined();
    const config = parseAppConfigText(fileAt(plan, CONFIG_PATH).text);
    expect(config.organization).toBe("acme");
    expect(Object.keys(config.providers)).toEqual(["anthropic"]);
    expect(config.defaults.models.general).toBe("anthropic/claude-haiku-4-5");
    expect(plan.providers).toEqual(["anthropic"]);
    expect(plan.config).toEqual(config);
    // Everything optional is off: the example's blocks stay commented out.
    expect(config.memory).toBeUndefined();
    expect(config.runHistory).toBeUndefined();
    expect(config.execution).toEqual({ type: "local" });
  });

  it("the config keeps the example's commentary (the operator's config documents itself) and is byte-stable on a rerun with the same answers", () => {
    const a = fileAt(planned(minimal), CONFIG_PATH).text;
    const b = fileAt(planned(minimal), CONFIG_PATH).text;
    expect(a).toBe(b);
    expect(a).toContain("# memory:");
    expect(a).toContain("# runHistory:");
    expect(a).not.toContain("Copy to config/config.yaml");
    expect(a).toContain("# Written by `switchboard init`; edit freely");
    expect(fileAt(planned(minimal), ENV_PATH).text).toBe(fileAt(planned(minimal), ENV_PATH).text);
  });

  it("an OpenAI-compatible endpoint alone: the `openai` provider with that baseUrl, OPENAI_API_KEY when a key is given, every agent on openai/<model>", () => {
    const plan = planned({
      organization: "acme",
      name: "switchboard",
      openaiCompatible: "https://api.groq.com/openai/v1",
      modelKey: OPENAI,
      model: "llama-3.3-70b",
    });
    const config = parseAppConfigText(fileAt(plan, CONFIG_PATH).text);
    expect(config.providers).toEqual({
      openai: { type: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "OPENAI_API_KEY" },
    });
    expect(config.defaults.models).toEqual({
      general: "openai/llama-3.3-70b",
      coding: "openai/llama-3.3-70b",
      review: "openai/llama-3.3-70b",
    });
    expect(parseEnv(fileAt(plan, ENV_PATH).text).OPENAI_API_KEY).toBe(OPENAI);
    expect(plan.providers).toEqual(["openai"]);
  });

  it("a local endpoint needs no key: without --model-key the provider has no apiKeyEnv and .env sets no OPENAI_API_KEY", () => {
    const plan = planned({
      organization: "acme",
      name: "switchboard",
      openaiCompatible: "http://localhost:11434/v1",
      model: "llama3",
    });
    const config = parseAppConfigText(fileAt(plan, CONFIG_PATH).text);
    expect(config.providers.openai).toEqual({ type: "openai-compatible", baseUrl: "http://localhost:11434/v1" });
    expect(parseEnv(fileAt(plan, ENV_PATH).text).OPENAI_API_KEY).toBeUndefined();
  });

  it("both providers: both blocks, the example's Anthropic defaults unless --model picks the endpoint's model for every agent", () => {
    const both: InitAnswers = {
      ...minimal,
      openaiCompatible: "https://api.openai.com/v1",
      modelKey: OPENAI,
    };
    const a = parseAppConfigText(fileAt(planned(both), CONFIG_PATH).text);
    expect(Object.keys(a.providers)).toEqual(["anthropic", "openai"]);
    expect(a.defaults.models.general).toBe("anthropic/claude-haiku-4-5");
    const b = parseAppConfigText(fileAt(planned({ ...both, model: "gpt-5" }), CONFIG_PATH).text);
    expect(b.defaults.models).toEqual({ general: "openai/gpt-5", coding: "openai/gpt-5", review: "openai/gpt-5" });
  });

  it("Slack tokens and the GitHub App land in .env on their example lines; the PEM is one double-quoted line Node's parser reads back whole; the ids are not secrets", () => {
    const plan = planned({
      ...minimal,
      slackAppToken: APP_TOKEN,
      slackBotToken: BOT_TOKEN,
      githubAppId: "123456",
      githubInstallationId: "12345678",
      githubPrivateKey: PEM,
    });
    const file = fileAt(plan, ENV_PATH);
    const env = parseEnv(file.text);
    expect(env.SLACK_APP_TOKEN).toBe(APP_TOKEN);
    expect(env.SLACK_BOT_TOKEN).toBe(BOT_TOKEN);
    expect(env.GITHUB_APP_ID).toBe("123456");
    expect(env.GITHUB_APP_INSTALLATION_ID).toBe("12345678");
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe(PEM);
    expect(file.text.split("\n").filter((l) => l.startsWith("GITHUB_APP_PRIVATE_KEY="))).toHaveLength(1);
    expect(file.secretNames).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "ANTHROPIC_API_KEY",
      "GITHUB_APP_PRIVATE_KEY",
    ]);
    // The GitHub capability computes ON from the written file alone.
    expect(plan.capabilities.github).toBe(true);
  });

  it("--cloudflare + --zone: deploy/profile.json from the example — bot + state Worker only, names from --name, configSource the example's; it parses", () => {
    const plan = planned({ ...minimal, name: "swb", cloudflare: ACCOUNT, zone: "example.com" });
    const file = fileAt(plan, PROFILE_PATH);
    expect(file.mode).toBe(0o644);
    expect(file.secretNames).toEqual([]);
    const raw = JSON.parse(file.text);
    expect(raw).toEqual({
      account: ACCOUNT,
      zone: "example.com",
      workers: {
        memory: { script: "swb-memory", hostname: "swb-memory.example.com" },
        bot: { script: "swb", hostname: "swb.example.com" },
      },
      configSource: "config/config.yaml",
    });
    expect(parseProfile(raw)).toMatchObject({ ok: true });
    expect(file.text.endsWith("\n")).toBe(true);
    expect(plan.profile).toBe(true);
  });
});

describe("planInit — the capability summary and the next commands", () => {
  it("capabilities come from the written config + the written .env, with the process environment winning (as the loader does): nothing optional is on", () => {
    const plan = planned(minimal);
    expect(plan.capabilities).toMatchObject({
      execution: "local",
      github: false,
      memory: false,
      runHistory: false,
      mcp: false,
      dashboardAuth: "none",
    });
    const withShellToken = planned(minimal, { env: { GH_TOKEN: "github_pat_from_shell" } });
    expect(withShellToken.capabilities.github).toBe(true);
  });

  it("in a checkout the next commands are the CLI's ask, the bot from source, and docker compose with the image fact; a profile adds deploy secrets/config/all", () => {
    const local = planned(minimal);
    expect(local.next).toEqual([
      'npm run cli -- ask "what can you do?"',
      "npx tsx src/index.ts",
      "docker compose up -d   # the same bot from the published image ghcr.io/example/switchboard:latest",
    ]);
    const prod = planned({ ...minimal, cloudflare: ACCOUNT, zone: "example.com" });
    expect(prod.next.slice(3)).toEqual([
      "npm run cli -- deploy secrets memory",
      "npm run cli -- deploy secrets bot",
      'MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npm run cli -- deploy all',
    ]);
  });

  it("from the published npm package the next commands are the package's own ask and the bot from the image; a profile adds the package's own deploy steps", () => {
    const plan = planned(minimal, { inCheckout: false, package: "@example/switchboard" });
    expect(plan.next).toEqual([
      'npx @example/switchboard ask "what can you do?"',
      'docker run -d --restart unless-stopped --env-file .env -v "$PWD/config:/app/config:ro" ghcr.io/example/switchboard:latest   # the bot, from the published image',
    ]);
    // The profile is written into the directory init runs in: from the package, that directory is where the deploy runs from.
    const prod = planned(
      { ...minimal, cloudflare: ACCOUNT, zone: "example.com" },
      { inCheckout: false, package: "@example/switchboard" },
    );
    expect(prod.profile).toBe(true);
    expect(prod.files.map((f) => f.path)).toEqual([ENV_PATH, CONFIG_PATH, PROFILE_PATH]);
    // From the package there is no tree to build an image from: the profile has all four Workers and deploys
    // the release's published images, copied into the account registry by `deploy all` itself. A checkout's
    // profile has the two smallest and says nothing about images — it builds (the test above).
    const raw = JSON.parse(fileAt(prod, PROFILE_PATH).text) as { images?: string; workers: Record<string, unknown> };
    expect(raw.images).toBe("registry");
    expect(raw.workers).toEqual({
      memory: { script: "switchboard-memory", hostname: "switchboard-memory.example.com" },
      bot: { script: "switchboard", hostname: "switchboard.example.com" },
      resident: { script: "switchboard-resident", hostname: "switchboard-resident.example.com" },
      sandbox: { script: "switchboard-sandbox", hostname: "switchboard-sandbox.example.com" },
    });
    expect(parseProfile(raw)).toMatchObject({ ok: true, profile: { images: "registry" } });
    expect(prod.next.slice(2)).toEqual([
      "npx @example/switchboard deploy secrets memory",
      "npx @example/switchboard deploy secrets bot",
      "npx @example/switchboard deploy secrets resident",
      "npx @example/switchboard deploy secrets sandbox",
      'MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npx @example/switchboard deploy all',
    ]);
  });

  it("outside a checkout (the container) the next commands run the published image against the written files", () => {
    const plan = planned(minimal, { inCheckout: false });
    expect(plan.next).toEqual([
      'docker run --rm -it --env-file .env -v "$PWD/config:/app/config:ro" ghcr.io/example/switchboard:latest ask "what can you do?"',
      'docker run -d --restart unless-stopped --env-file .env -v "$PWD/config:/app/config:ro" ghcr.io/example/switchboard:latest',
    ]);
  });
});

describe("planInit — refusals", () => {
  const refused = (answers: InitAnswers, w: Partial<InitWorld> = {}) => {
    const plan = planInit(answers, TEMPLATES, world(w));
    if (plan.ok) throw new Error("expected a refusal");
    return plan;
  };

  it("no provider is invalid_input naming both ways to give one", () => {
    const r = refused({ organization: "acme", name: "switchboard" });
    expect(r.code).toBe("invalid_input");
    expect(r.problems).toEqual([
      "a model provider is needed: --anthropic-key <key>, or --openai-compatible <baseUrl> --model <name> [--model-key <key>]",
    ]);
  });

  it("an endpoint without a model, a model or key without an endpoint, one Slack token, a partial GitHub App, a zone without an account or an account without a zone — each names the missing flag", () => {
    expect(refused({ organization: "acme", name: "switchboard", openaiCompatible: "http://x/v1" }).problems).toEqual([
      "--openai-compatible needs --model <name>: the model every agent runs on at that endpoint",
    ]);
    expect(refused({ ...minimal, model: "gpt-5" }).problems).toEqual([
      "--model only means something with --openai-compatible",
    ]);
    expect(refused({ ...minimal, modelKey: OPENAI }).problems).toEqual([
      "--model-key only means something with --openai-compatible",
    ]);
    expect(refused({ ...minimal, slackBotToken: BOT_TOKEN }).problems).toEqual([
      "Slack needs both tokens: --slack-app-token (xapp-…) and --slack-bot-token (xoxb-…)",
    ]);
    expect(refused({ ...minimal, githubAppId: "1" }).problems).toEqual([
      "the GitHub App needs all three: --github-app-id, --github-installation-id and --github-private-key-file",
    ]);
    expect(refused({ ...minimal, zone: "example.com" }).problems).toEqual([
      "--zone only means something with --cloudflare",
    ]);
    expect(refused({ ...minimal, cloudflare: ACCOUNT }).problems).toEqual([
      "--cloudflare needs --zone <domain>: the zone the Worker hostnames live under",
    ]);
    // Every problem is reported at once, not the first one only.
    expect(refused({ ...minimal, model: "x", zone: "example.com" }).problems).toHaveLength(2);
  });

  it("--cloudflare outside a checkout and not from the package (the container) is unavailable: the profile is written where deploy all runs from", () => {
    const r = refused({ ...minimal, cloudflare: ACCOUNT, zone: "example.com" }, { inCheckout: false });
    expect(r.code).toBe("unavailable");
    expect(r.problems[0]).toMatch(/deploy\/profile\.json .*checkout.*published npm package/);
  });

  it("an existing file is a conflict naming every file it would overwrite and --force; with --force the same files are planned", () => {
    const r = refused(minimal, { existing: new Set([ENV_PATH, CONFIG_PATH]) });
    expect(r.code).toBe("conflict");
    expect(r.problems).toEqual([`refusing to overwrite ${ENV_PATH}, ${CONFIG_PATH} — pass --force to replace them`]);
    const forced = planned(minimal, { existing: new Set([ENV_PATH]), force: true });
    expect(forced.files.map((f) => f.path)).toEqual([ENV_PATH, CONFIG_PATH]);
    // A file that is not planned is never a conflict.
    expect(planInit(minimal, TEMPLATES, world({ existing: new Set([PROFILE_PATH]) })).ok).toBe(true);
  });
});

describe("renderEnv and maskedPreview", () => {
  const template = [
    "# Slack",
    "SLACK_BOT_TOKEN=xoxb-...",
    "SLACK_APP_TOKEN=xapp-...",
    "",
    "ANTHROPIC_API_KEY=sk-ant-...",
    "# PORT=8080",
    "# GITHUB_APP_ID=123456",
    "",
  ].join("\n");

  it("a given value replaces its example line (commented or not); an ungiven placeholder is commented out; a comment stays; an unknown name is appended", () => {
    const out = renderEnv(template, { ANTHROPIC_API_KEY: "k1", GITHUB_APP_ID: "42", BRAVE_SEARCH_API_KEY: "b" });
    expect(out.split("\n")).toEqual([
      "# Slack",
      "# SLACK_BOT_TOKEN=xoxb-...",
      "# SLACK_APP_TOKEN=xapp-...",
      "",
      "ANTHROPIC_API_KEY=k1",
      "# PORT=8080",
      "GITHUB_APP_ID=42",
      "",
      "BRAVE_SEARCH_API_KEY=b",
      "",
    ]);
    expect(parseEnv(out)).toEqual({ ANTHROPIC_API_KEY: "k1", GITHUB_APP_ID: "42", BRAVE_SEARCH_API_KEY: "b" });
  });

  it("a multi-line value is written as one double-quoted line with \\n escapes — the form the example documents and Node's parser expands", () => {
    const out = renderEnv("# GITHUB_APP_PRIVATE_KEY=x\n", { GITHUB_APP_PRIVATE_KEY: "a\nb\n" });
    expect(out).toBe('GITHUB_APP_PRIVATE_KEY="a\\nb\\n"\n');
    expect(parseEnv(out).GITHUB_APP_PRIVATE_KEY).toBe("a\nb\n");
  });

  it("maskedPreview replaces every secret line's value with a fixed mask — the value's length leaks nothing — and leaves the rest", () => {
    const plan = planned({
      ...minimal,
      slackAppToken: APP_TOKEN,
      slackBotToken: BOT_TOKEN,
      githubAppId: "1",
      githubInstallationId: "2",
      githubPrivateKey: PEM,
    });
    const preview = maskedPreview(fileAt(plan, ENV_PATH));
    for (const secret of [ANTHROPIC, APP_TOKEN, BOT_TOKEN, "MIIEtest"]) expect(preview).not.toContain(secret);
    expect(preview).toContain("ANTHROPIC_API_KEY=••••••••");
    expect(preview).toContain("GITHUB_APP_PRIVATE_KEY=••••••••");
    expect(preview).toContain("GITHUB_APP_ID=1");
    expect(maskedPreview(fileAt(plan, CONFIG_PATH))).toBe(fileAt(plan, CONFIG_PATH).text);
  });
});
