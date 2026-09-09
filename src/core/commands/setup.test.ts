import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES } from "../../deploy/testing/profile.js";
import { PROJECT_FACTS_FILE, TEMPLATE_FILE } from "../../deploy/wranglerTemplate.js";
import { CONFIG_PATH, ENV_PATH, PROFILE_PATH, type PlannedFile } from "../../setup/plan.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { parseInvocation } from "../commandSurface.js";
import { callerWith } from "../testing/callers.js";
import { registerDeployCommands, type DeployCommandDeps } from "./deploy.js";
import { registerSetupCommands, setupInit, type SetupCommandDeps } from "./setup.js";

// Feature: docs/reference/specs/init.md — `setup init` (the CLI's `init`): the
// registry command over the pure planner and the injected host. What is
// asserted here is the command's own contract: flags first, a prompt only for
// what is missing and only when one exists, the refusals as registry codes,
// nothing written under --dry-run, the files written in order at their modes,
// `deploy init` run through the registry function when a profile is written,
// and no secret in any output.

const cli: Caller = callerWith("cli", "cli:local", "all");
const ACCOUNT = TEST_PROFILE.account;
const KEY = "sk-ant-secret-value-2f9b";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----\n";

const TEMPLATES = {
  env: readFileSync(".env.example", "utf8"),
  config: readFileSync("config/config.example.yaml", "utf8"),
  profile: readFileSync("deploy/profile.example.json", "utf8"),
};

interface World {
  existing?: string[];
  inCheckout?: boolean;
  /** The published npm package the CLI runs from; undefined in a checkout or the image. */
  package?: string;
  prompt?: (question: string, opts: { secret: boolean }) => Promise<string>;
  files?: Record<string, string>;
}

function bind(world: World = {}) {
  const registry = new CommandRegistry<SetupCommandDeps & DeployCommandDeps>({ audit: () => {} });
  registerSetupCommands(registry);
  registerDeployCommands(registry);
  const written: PlannedFile[] = [];
  const rendered: string[] = [];
  const asked: string[] = [];
  const existing = new Set(world.existing ?? []);
  const deps: SetupCommandDeps & DeployCommandDeps = {
    setup: {
      templates: async () => TEMPLATES,
      exists: async (path) => existing.has(path),
      write: async (file) => {
        written.push(file);
      },
      readFile: async (path) => world.files?.[path],
      inCheckout: () => world.inCheckout ?? true,
      image: () => "ghcr.io/example/switchboard",
      package: () => world.package,
      env: {},
      prompt: world.prompt
        ? async (q, o) => {
            asked.push(q);
            return world.prompt!(q, o);
          }
        : undefined,
    },
    deploy: {
      run: async () => {
        throw new Error("must not deploy");
      },
      restart: async () => {
        throw new Error("must not restart");
      },
      host: { root: { mode: "checkout", path: "/work/switchboard" }, hasNodeModules: () => true },
      affected: async () => {
        throw new Error("must not compute affected");
      },
      // `deploy init` reads the profile the way the host does: the one init just wrote.
      profile: async () => {
        const profile = written.find((f) => f.path === PROFILE_PATH);
        if (!profile) throw new Error("no deployment profile written yet");
        return { profile: JSON.parse(profile.text), origin: "profile", path: PROFILE_PATH };
      },
      files: {
        read: async (path) =>
          path.endsWith(TEMPLATE_FILE)
            ? '{ "name": "{{script}}" }\n'
            : path === PROJECT_FACTS_FILE
              ? JSON.stringify({
                  name: "switchboard",
                  docs: "https://docs.example.test",
                  images: TEST_PUBLISHED_IMAGES.names,
                })
              : undefined,
        write: async (path) => {
          rendered.push(path);
        },
      },
      secrets: {
        manifest: async () => undefined,
        present: async () => ({ ok: true, present: new Set() }),
        put: async () => ({ code: 0, output: "" }),
      },
      pushConfig: async () => ({ ok: false, problem: "must not push" }),
      images: {
        registry: async () => ({ error: "must not read the registry" }),
        docker: async () => ({ ok: false, problem: "must not probe docker" }),
        copy: async () => ({ code: 1, output: "must not copy" }),
      },
      cliVersion: () => TEST_PUBLISHED_IMAGES.version,
    },
  };
  return { commands: bindCommands(registry, deps), written, rendered, asked };
}

const invoke = (b: ReturnType<typeof bind>, argv: string[]) => {
  const bound = parseInvocation(b.commands.get("setup.init")!, argv);
  if (bound.kind !== "invoke") throw new Error(`grammar refused: ${JSON.stringify(bound)}`);
  return b.commands.invoke("setup.init", bound.input, cli);
};

describe("setup.init — flags", () => {
  it("is CLI-only, a setup:write, and its options are the installer's flags", () => {
    expect(setupInit.surfaces).toEqual({ chat: false, mcp: false, http: false });
    expect(setupInit.action).toBe("setup:write");
    expect(Object.keys(setupInit.options!.shape).sort()).toEqual(
      [
        "anthropicKey",
        "cloudflare",
        "dryRun",
        "force",
        "githubAppId",
        "githubInstallationId",
        "githubPrivateKeyFile",
        "model",
        "modelKey",
        "name",
        "openaiCompatible",
        "organization",
        "slackAppToken",
        "slackBotToken",
        "zone",
      ].sort(),
    );
  });

  it("writes .env then config/config.yaml with the given values, at 600 and 644; the output names the files, the providers, the capabilities and the next commands — never a secret", async () => {
    const b = bind();
    const res = await invoke(b, ["--organization", "acme", "--anthropic-key", KEY]);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(b.written.map((f) => [f.path, f.mode])).toEqual([
      [ENV_PATH, 0o600],
      [CONFIG_PATH, 0o644],
    ]);
    expect(b.written[0].text).toContain(`ANTHROPIC_API_KEY=${KEY}`);
    expect(b.rendered).toEqual([]);
    const value = res.ok ? res.value : undefined;
    expect(value).toMatchObject({
      dryRun: false,
      files: [
        { path: ENV_PATH, mode: "600", status: "written" },
        { path: CONFIG_PATH, mode: "644", status: "written" },
      ],
      providers: ["anthropic"],
      capabilities: { execution: "local", github: false, memory: false },
      next: [
        'npm run cli -- ask "what can you do?"',
        "npx tsx src/index.ts",
        "docker compose up -d   # the same bot from the published image ghcr.io/example/switchboard:latest",
      ],
    });
    const wire = JSON.stringify(value) + renderText(setupInit, value!);
    expect(wire).not.toContain(KEY);
    // From the published package the next `ask` is the package's own, and the bot is the image.
    const fromPackage = await invoke(bind({ inCheckout: false, package: "@example/switchboard" }), [
      "--organization",
      "acme",
      "--anthropic-key",
      KEY,
    ]);
    expect((fromPackage.ok ? (fromPackage.value as { next: string[] }) : undefined)?.next).toEqual([
      'npx @example/switchboard ask "what can you do?"',
      'docker run -d --restart unless-stopped --env-file .env -v "$PWD/config:/app/config:ro" ghcr.io/example/switchboard:latest   # the bot, from the published image',
    ]);
    const text = renderText(setupInit, value!);
    expect(text).toContain("wrote:");
    expect(text).toMatch(/\.env\s+\(mode 600\)/);
    expect(text).toContain("providers: anthropic");
    expect(text).toContain("execution local");
    expect(text).toContain("next:\n");
  });

  it("--github-private-key-file is read from the working directory; a missing file is not_found naming it; the PEM reaches .env and nothing else", async () => {
    const b = bind({ files: { "app.pem": PEM } });
    const res = await invoke(b, [
      "--organization",
      "acme",
      "--anthropic-key",
      KEY,
      "--github-app-id",
      "1",
      "--github-installation-id",
      "2",
      "--github-private-key-file",
      "app.pem",
    ]);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(b.written[0].text).toContain('GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nMIIEsecret');
    expect(JSON.stringify(res)).not.toContain("MIIEsecret");
    expect(res.ok && (res.value as { capabilities: { github: boolean } }).capabilities.github).toBe(true);
    const missing = await invoke(bind(), [
      "--organization",
      "acme",
      "--anthropic-key",
      KEY,
      "--github-app-id",
      "1",
      "--github-installation-id",
      "2",
      "--github-private-key-file",
      "nope.pem",
    ]);
    expect(missing).toMatchObject({
      ok: false,
      error: "not_found",
      message: "--github-private-key-file: no such file nope.pem",
    });
  });

  it("--cloudflare + --zone also writes deploy/profile.json and then renders the Worker configs through the registry's own deploy init; the next commands add the deploy steps", async () => {
    const b = bind();
    const res = await invoke(b, [
      "--organization",
      "acme",
      "--anthropic-key",
      KEY,
      "--name",
      "swb",
      "--cloudflare",
      ACCOUNT,
      "--zone",
      "example.com",
    ]);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(b.written.map((f) => f.path)).toEqual([ENV_PATH, CONFIG_PATH, PROFILE_PATH]);
    expect(b.rendered).toEqual([
      "deploy/cloudflare-memory/wrangler.jsonc",
      "deploy/cloudflare/wrangler.jsonc",
      "deploy/cloudflare-docs/wrangler.jsonc",
    ]);
    const value = res.ok ? (res.value as Record<string, unknown>) : {};
    expect(value.workerConfigs).toMatchObject({
      profile: { origin: "profile", path: PROFILE_PATH },
      files: [
        { path: "deploy/cloudflare-memory/wrangler.jsonc", status: "written" },
        { path: "deploy/cloudflare/wrangler.jsonc", status: "written" },
        { path: "deploy/cloudflare-docs/wrangler.jsonc", status: "written" },
      ],
    });
    expect((value.next as string[]).slice(-3)).toEqual([
      "npm run cli -- deploy secrets memory",
      "npm run cli -- deploy secrets bot",
      'MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" npm run cli -- deploy all',
    ]);
    const text = renderText(setupInit, res.ok ? res.value : null);
    expect(text).toContain(`Worker configs from ${PROFILE_PATH}:`);
  });
});

describe("setup.init — refusals and --dry-run", () => {
  it("an existing file is a conflict naming it, and nothing is written; --force replaces it", async () => {
    const b = bind({ existing: [CONFIG_PATH] });
    const res = await invoke(b, ["--organization", "acme", "--anthropic-key", KEY]);
    expect(res).toMatchObject({
      ok: false,
      error: "conflict",
      message: `refusing to overwrite ${CONFIG_PATH} — pass --force to replace them`,
    });
    expect(b.written).toEqual([]);
    const forced = await invoke(b, ["--organization", "acme", "--anthropic-key", KEY, "--force"]);
    expect(forced.ok).toBe(true);
    expect(forced.ok && (forced.value as { files: { status: string }[] }).files.map((f) => f.status)).toEqual([
      "written",
      "replaced",
    ]);
  });

  it("incoherent flags are invalid_input with every problem; --cloudflare outside a checkout is unavailable; the schema refuses a bad account, zone or name without echoing it", async () => {
    const b = bind();
    expect(await invoke(b, ["--organization", "acme", "--anthropic-key", KEY, "--zone", "example.com"])).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "--zone only means something with --cloudflare",
    });
    const outside = bind({ inCheckout: false });
    expect(
      await invoke(outside, [
        "--organization",
        "acme",
        "--anthropic-key",
        KEY,
        "--cloudflare",
        ACCOUNT,
        "--zone",
        "example.com",
      ]),
    ).toMatchObject({ ok: false, error: "unavailable" });
    for (const [flag, bad] of [
      ["--cloudflare", "not-hex"],
      ["--zone", "Not A Zone"],
      ["--name", "Bad_Name"],
      ["--openai-compatible", "ftp://x"],
      ["--github-app-id", "abc"],
    ]) {
      const res = await b.commands.invoke(
        "setup.init",
        {
          options: {
            organization: "acme",
            anthropicKey: KEY,
            [flag.slice(2).replace(/-(\w)/g, (_m, c: string) => c.toUpperCase())]: bad,
          },
        },
        cli,
      );
      expect(res.ok, flag).toBe(false);
      expect(!res.ok && res.error).toBe("invalid_input");
      expect(!res.ok && res.message).not.toContain(bad);
    }
    expect(b.written).toEqual([]);
  });

  it("without a prompt, a missing organization or provider is invalid_input naming the flag (a pipe or CI never hangs)", async () => {
    const b = bind();
    expect(await invoke(b, ["--anthropic-key", KEY])).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "--organization is required: the GitHub organization (or user) this installation serves",
    });
    expect(await invoke(b, ["--organization", "acme"])).toMatchObject({ ok: false, error: "invalid_input" });
    expect(b.written).toEqual([]);
  });

  it("--dry-run writes nothing and returns each file's masked preview: the secret lines show a mask, the config shows whole", async () => {
    const b = bind();
    const res = await invoke(b, [
      "--organization",
      "acme",
      "--anthropic-key",
      KEY,
      "--slack-app-token",
      "xapp-secret-1",
      "--slack-bot-token",
      "xoxb-secret-2",
      "--dry-run",
    ]);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(b.written).toEqual([]);
    const value = res.ok
      ? (res.value as { dryRun: boolean; files: { path: string; status: string; preview: string }[] })
      : undefined;
    expect(value?.dryRun).toBe(true);
    expect(value?.files.map((f) => [f.path, f.status])).toEqual([
      [ENV_PATH, "planned"],
      [CONFIG_PATH, "planned"],
    ]);
    const env = value!.files[0].preview;
    expect(env).toContain("ANTHROPIC_API_KEY=••••••••");
    expect(env).toContain("SLACK_APP_TOKEN=••••••••");
    expect(env).toContain("SLACK_BOT_TOKEN=••••••••");
    expect(value!.files[1].preview).toContain("organization: acme");
    const wire = JSON.stringify(res) + renderText(setupInit, res.ok ? res.value : null);
    for (const secret of [KEY, "xapp-secret-1", "xoxb-secret-2"]) expect(wire).not.toContain(secret);
    expect(renderText(setupInit, res.ok ? res.value : null)).toContain("would write:");
    expect(renderText(setupInit, res.ok ? res.value : null)).toContain(`--- ${ENV_PATH} ---`);
  });
});

describe("setup.init — prompts", () => {
  it("half a Slack pair on a terminal asks for the missing token, whichever it is — never a refusal", async () => {
    const ask = (expected: string, answer: string) => async (q: string) => {
      if (q !== expected) throw new Error(`asked ${q}, expected ${expected}`);
      return answer;
    };
    const botMissing = bind({ prompt: ask("Slack bot token, xoxb-…: ", "xoxb-from-prompt") });
    const a = await invoke(botMissing, [
      "--organization",
      "acme",
      "--anthropic-key",
      KEY,
      "--slack-app-token",
      "xapp-flag",
    ]);
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect(botMissing.written[0].text).toContain("SLACK_BOT_TOKEN=xoxb-from-prompt");
    const appMissing = bind({ prompt: ask("Slack app-level token, xapp-…: ", "xapp-from-prompt") });
    const b = await invoke(appMissing, [
      "--organization",
      "acme",
      "--anthropic-key",
      KEY,
      "--slack-bot-token",
      "xoxb-flag",
    ]);
    expect(b.ok, JSON.stringify(b)).toBe(true);
    expect(appMissing.written[0].text).toContain("SLACK_APP_TOKEN=xapp-from-prompt");
    expect(appMissing.written[0].text).toContain("SLACK_BOT_TOKEN=xoxb-flag");
    expect(appMissing.asked).toEqual(["Slack app-level token, xapp-…: "]);
    // Without a terminal the same half pair is the planner's refusal, naming both flags.
    const piped = await invoke(bind(), [
      "--organization",
      "acme",
      "--anthropic-key",
      KEY,
      "--slack-bot-token",
      "xoxb-flag",
    ]);
    expect(piped).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "Slack needs both tokens: --slack-app-token (xapp-…) and --slack-bot-token (xoxb-…)",
    });
  });

  it("asks only for what the flags did not give — organization (plain), then the Anthropic key (secret), then the Slack tokens (secret; empty skips) — and never for the GitHub App or Cloudflare", async () => {
    const answers: Record<string, string> = {
      "GitHub organization (or user) this installation serves: ": "acme",
      "Anthropic API key (empty to use an OpenAI-compatible endpoint instead): ": KEY,
      "Slack app-level token, xapp-… (empty to skip Slack for now): ": "",
    };
    const secretFlags: Record<string, boolean> = {};
    const b = bind({
      prompt: async (q, o) => {
        secretFlags[q] = o.secret;
        if (!(q in answers)) throw new Error(`unexpected question: ${q}`);
        return answers[q];
      },
    });
    const res = await invoke(b, []);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(b.asked).toEqual(Object.keys(answers));
    expect(secretFlags).toEqual({
      "GitHub organization (or user) this installation serves: ": false,
      "Anthropic API key (empty to use an OpenAI-compatible endpoint instead): ": true,
      "Slack app-level token, xapp-… (empty to skip Slack for now): ": true,
    });
    expect(b.written[0].text).toContain(`ANTHROPIC_API_KEY=${KEY}`);
    expect(b.written[0].text).toContain("# SLACK_BOT_TOKEN=");
  });

  it("an empty Anthropic answer asks for the endpoint, its model and its key; a given Slack app token asks for the bot token; flags given are never asked again", async () => {
    const script = [
      ["Anthropic API key (empty to use an OpenAI-compatible endpoint instead): ", ""],
      [
        "OpenAI-compatible base URL (e.g. https://api.openai.com/v1, http://localhost:11434/v1): ",
        "http://localhost:11434/v1",
      ],
      ["Model every agent runs on at that endpoint: ", "llama3"],
      ["API key for that endpoint (empty for a local endpoint): ", ""],
      ["Slack bot token, xoxb-…: ", "xoxb-from-prompt"],
    ];
    let i = 0;
    const b = bind({
      prompt: async (q) => {
        const [expected, answer] = script[i++] ?? ["(nothing)", ""];
        if (q !== expected) throw new Error(`asked ${q}, expected ${expected}`);
        return answer;
      },
    });
    const res = await invoke(b, ["--organization", "acme", "--slack-app-token", "xapp-flag"]);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(i).toBe(script.length);
    expect(b.written[0].text).toContain("SLACK_BOT_TOKEN=xoxb-from-prompt");
    expect(b.written[0].text).toContain("SLACK_APP_TOKEN=xapp-flag");
    expect(b.written[1].text).toContain("baseUrl: http://localhost:11434/v1");
    expect(b.written[1].text).toContain("general: openai/llama3");
    expect(res.ok && (res.value as { providers: string[] }).providers).toEqual(["openai"]);
  });
});
