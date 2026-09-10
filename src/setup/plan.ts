import { parseEnv } from "node:util";
import YAML from "yaml";
import { parseAppConfigText, type AppConfig } from "../config.js";
import { capabilitiesFrom, type Capabilities } from "../core/capabilities.js";
import { parseProfile } from "../deploy/profile.js";

// `switchboard init`, the pure half (docs/reference/specs/init.md). The
// operator's answers and the three checked-in templates go in; the files to
// write come out — each with its mode and the names of the secrets it carries —
// together with the config as the real loader reads it, the capabilities that
// config and that `.env` compute, and the commands to run next. Nothing here
// touches a disk, a terminal or the process environment: the host half
// (src/setup/host.ts) reads the templates and writes the files, the command
// (src/core/commands/setup.ts) asks the questions. A refusal is a value with a
// code the registry knows and every problem at once, never the first one.
//
// The files are DERIVED from the examples, not written from scratch: `.env`
// is `.env.example` with the given values on their lines and every unfilled
// placeholder commented out (nothing reads a fake value); `config.yaml` is
// `config.example.yaml` edited in place so the operator's config keeps the
// commentary that documents every optional block, still off; the profile is
// the example's shape with the two Workers the smallest production has. A
// rerun with the same answers produces the same bytes.

export const ENV_PATH = ".env";
export const CONFIG_PATH = "config/config.yaml";
export const PROFILE_PATH = "deploy/profile.json";

/** What the operator gave — flags, or a prompt's answer. Secrets are values here and nowhere after `.env`. */
export interface InitAnswers {
  /** The GitHub organization (or user) the installation serves — `config.yaml`'s required `organization`. */
  organization: string;
  /** The Worker name stem: `<name>` is the bot's script, `<name>-memory` the state Worker's. */
  name: string;
  anthropicKey?: string;
  /** An OpenAI-compatible endpoint's base URL (`https://api.openai.com/v1`, `http://localhost:11434/v1`). */
  openaiCompatible?: string;
  /** The endpoint's key, written as `OPENAI_API_KEY`; a local endpoint needs none. */
  modelKey?: string;
  /** The model every agent runs on at the endpoint (`openai/<model>` in `defaults.models`). */
  model?: string;
  slackAppToken?: string;
  slackBotToken?: string;
  githubAppId?: string;
  githubInstallationId?: string;
  /** The App's private key, PEM text (the command reads it from `--github-private-key-file`). */
  githubPrivateKey?: string;
  /** A Cloudflare account id: with `zone`, also write the deployment profile. */
  cloudflare?: string;
  zone?: string;
}

/** The three checked-in examples, as text. */
export interface InitTemplates {
  env: string;
  config: string;
  profile: string;
}

/** What the planner needs to know about the place the files go. */
export interface InitWorld {
  /** Planned paths that already exist (relative to the working directory). */
  existing: ReadonlySet<string>;
  force: boolean;
  /** True when the working directory is the repository root — where `deploy/` lives and `deploy all` runs. */
  inCheckout: boolean;
  /** The process environment: a variable set here wins over `.env`, as the loader's rule says. */
  env: Record<string, string | undefined>;
  /** `project.json`'s `image` — what the next commands run outside a checkout. */
  image: string;
  /** The published npm package this CLI runs from, when it does — `project.json`'s `package`; undefined in a checkout or the image. */
  package?: string;
}

export interface PlannedFile {
  path: string;
  text: string;
  /** `0o600` for the file that holds secrets, `0o644` otherwise. */
  mode: 0o600 | 0o644;
  /** The `.env` names whose values are secrets — what a preview masks. Empty for the other files. */
  secretNames: string[];
}

export type InitPlan =
  | {
      ok: true;
      files: PlannedFile[];
      /** The provider names the config declares, in config order. */
      providers: string[];
      /** The written config as `parseAppConfigText` reads it — the proof it loads. */
      config: AppConfig;
      /** What is on for this installation, from the written config and `.env` under the process environment. */
      capabilities: Capabilities;
      /** True when the deployment profile is among the files. */
      profile: boolean;
      /** The commands to run next, verbatim. */
      next: string[];
    }
  | { ok: false; code: "invalid_input" | "conflict" | "unavailable"; problems: string[] };

/** `.env` names, in `.env.example` order, whose values must never leave the file. */
const SECRET_ENV_NAMES = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

/** The example's OpenAI-compatible provider: its name is the env var's prefix and the model ref's provider. */
const OPENAI_PROVIDER = "openai";
const OPENAI_KEY_ENV = "OPENAI_API_KEY";
/** The agents `config.example.yaml` gives a default model. */
const DEFAULT_MODEL_AGENTS = ["general", "coding", "review"] as const;

export function planInit(answers: InitAnswers, templates: InitTemplates, world: InitWorld): InitPlan {
  const problems = answerProblems(answers);
  if (problems.length > 0) return { ok: false, code: "invalid_input", problems };
  const wantsProfile = answers.cloudflare !== undefined;
  // The profile is written where `deploy all` runs from: the root of a checkout, or — from the
  // published package — the directory init runs in, which becomes the operator's deploy directory.
  // The container image is neither.
  if (wantsProfile && !world.inCheckout && world.package === undefined)
    return {
      ok: false,
      code: "unavailable",
      problems: [
        `${PROFILE_PATH} and the Worker configs are written where \`deploy all\` runs from: the root of a checkout, or any directory when this CLI is the published npm package — not from here (the local files need neither)`,
      ],
    };

  const files: PlannedFile[] = [envFile(answers, templates.env), configFile(answers, templates.config)];
  if (wantsProfile) {
    const profile = profileFile(answers, templates.profile, world.package !== undefined);
    if (!profile.ok) return { ok: false, code: "invalid_input", problems: profile.problems };
    files.push(profile.file);
  }

  const clobbered = files.filter((f) => world.existing.has(f.path)).map((f) => f.path);
  if (clobbered.length > 0 && !world.force)
    return {
      ok: false,
      code: "conflict",
      problems: [`refusing to overwrite ${clobbered.join(", ")} — pass --force to replace them`],
    };

  // The proof the files work: the config through the real loader, the
  // capabilities from that config and the written `.env` — a shell variable
  // wins over the file, exactly as `loadEnvFileIfPresent` leaves the process.
  const config = parseAppConfigText(files[1].text);
  const env = { ...parseEnv(files[0].text), ...definedOnly(world.env) };
  const capabilities = capabilitiesFrom(config, env);
  return {
    ok: true,
    files,
    providers: Object.keys(config.providers),
    config,
    capabilities,
    profile: wantsProfile,
    next: nextCommands(world, wantsProfile),
  };
}

/** Every inconsistency in the answers at once, in flag terms; empty when they cohere. */
function answerProblems(a: InitAnswers): string[] {
  const problems: string[] = [];
  const anthropic = a.anthropicKey !== undefined;
  const endpoint = a.openaiCompatible !== undefined;
  if (!anthropic && !endpoint)
    problems.push(
      "a model provider is needed: --anthropic-key <key>, or --openai-compatible <baseUrl> --model <name> [--model-key <key>]",
    );
  if (endpoint && !anthropic && a.model === undefined)
    problems.push("--openai-compatible needs --model <name>: the model every agent runs on at that endpoint");
  if (!endpoint && a.model !== undefined) problems.push("--model only means something with --openai-compatible");
  if (!endpoint && a.modelKey !== undefined) problems.push("--model-key only means something with --openai-compatible");
  if ((a.slackAppToken === undefined) !== (a.slackBotToken === undefined))
    problems.push("Slack needs both tokens: --slack-app-token (xapp-…) and --slack-bot-token (xoxb-…)");
  const github = [a.githubAppId, a.githubInstallationId, a.githubPrivateKey].filter((v) => v !== undefined).length;
  if (github > 0 && github < 3)
    problems.push(
      "the GitHub App needs all three: --github-app-id, --github-installation-id and --github-private-key-file",
    );
  if (a.cloudflare === undefined && a.zone !== undefined)
    problems.push("--zone only means something with --cloudflare");
  if (a.cloudflare !== undefined && a.zone === undefined)
    problems.push("--cloudflare needs --zone <domain>: the zone the Worker hostnames live under");
  return problems;
}

// ---- .env --------------------------------------------------------------------

function envFile(a: InitAnswers, template: string): PlannedFile {
  const values: Record<string, string> = {};
  if (a.slackBotToken !== undefined) values.SLACK_BOT_TOKEN = a.slackBotToken;
  if (a.slackAppToken !== undefined) values.SLACK_APP_TOKEN = a.slackAppToken;
  if (a.anthropicKey !== undefined) values.ANTHROPIC_API_KEY = a.anthropicKey;
  if (a.modelKey !== undefined) values[OPENAI_KEY_ENV] = a.modelKey;
  if (a.githubAppId !== undefined) values.GITHUB_APP_ID = a.githubAppId;
  if (a.githubInstallationId !== undefined) values.GITHUB_APP_INSTALLATION_ID = a.githubInstallationId;
  if (a.githubPrivateKey !== undefined) values.GITHUB_APP_PRIVATE_KEY = a.githubPrivateKey;
  return {
    path: ENV_PATH,
    text: renderEnv(template, values),
    mode: 0o600,
    secretNames: SECRET_ENV_NAMES.filter((n) => n in values),
  };
}

const ENV_LINE = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;

/**
 * `.env.example` → `.env`: a line `NAME=…` (commented out or not) whose name
 * has a value becomes `NAME=<value>`; an uncommented placeholder with no value
 * is commented out, so nothing reads `xoxb-...` as a token; every other line —
 * the comments that explain each variable — stays. A name the example does not
 * have is appended. Deterministic for the same inputs.
 */
export function renderEnv(template: string, values: Readonly<Record<string, string>>): string {
  const pending = new Set(Object.keys(values));
  const lines = template.split("\n").map((line) => {
    const m = ENV_LINE.exec(line);
    if (!m) return line;
    const [, hash, name] = m;
    if (name in values) {
      pending.delete(name);
      return `${name}=${encodeEnvValue(values[name])}`;
    }
    return hash ? line : `# ${line}`;
  });
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // Names the example does not have: their own paragraph at the end.
  if (pending.size > 0) lines.push("", ...[...pending].map((name) => `${name}=${encodeEnvValue(values[name])}`));
  return `${lines.join("\n")}\n`;
}

/** A value with a newline, a quote, a `#` or surrounding whitespace is double-quoted
 *  with `\n` escapes — the form `.env.example` shows for the PEM and the one Node's
 *  parser expands; anything else is written bare. */
function encodeEnvValue(value: string): string {
  if (!/[\n"#]|^\s|\s$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** A preview of a planned file with every secret value masked: the `NAME=…`
 *  lines of its `secretNames` show a fixed mask, so neither the value nor its
 *  length leaves the file. A file without secrets previews as written. */
export function maskedPreview(file: PlannedFile): string {
  if (file.secretNames.length === 0) return file.text;
  const secret = new Set(file.secretNames);
  return file.text
    .split("\n")
    .map((line) => {
      const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
      return m && secret.has(m[1]) ? `${m[1]}=••••••••` : line;
    })
    .join("\n");
}

// ---- config.yaml -----------------------------------------------------------------

/** `config.example.yaml` edited in place (the `yaml` document keeps every
 *  comment): the organization, the providers the keys given call for, and the
 *  default models — every optional block stays as the example has it, off. */
function configFile(a: InitAnswers, template: string): PlannedFile {
  const doc = YAML.parseDocument(template);
  doc.set("organization", a.organization);
  if (a.anthropicKey === undefined) doc.deleteIn(["providers", "anthropic"]);
  if (a.openaiCompatible === undefined) doc.deleteIn(["providers", OPENAI_PROVIDER]);
  else {
    doc.setIn(["providers", OPENAI_PROVIDER, "baseUrl"], a.openaiCompatible);
    if (a.modelKey === undefined) doc.deleteIn(["providers", OPENAI_PROVIDER, "apiKeyEnv"]);
  }
  if (a.model !== undefined)
    for (const agent of DEFAULT_MODEL_AGENTS) doc.setIn(["defaults", "models", agent], `${OPENAI_PROVIDER}/${a.model}`);
  // The example's header tells a reader to copy it; this file IS the copy.
  const text = doc
    .toString()
    .replace(
      "# Copy to config/config.yaml and adjust.",
      "# Written by `switchboard init`; edit freely — every optional block below is off until you uncomment it.",
    );
  return { path: CONFIG_PATH, text, mode: 0o644, secretNames: [] };
}

// ---- deploy/profile.json ---------------------------------------------------------

/** The example profile's shape with this installation's account and zone;
 *  `configSource` is the example's. In a checkout: the two Workers the smallest
 *  production has, building their images (the profile says nothing about
 *  `images`). From the published package: all four Workers, deploying the
 *  release's published images (`images: registry`) — there is no tree to build
 *  an image from, and `deploy all` copies them into the account registry
 *  itself. Validated with the same `parseProfile` `deploy` reads it with. */
function profileFile(
  a: InitAnswers,
  template: string,
  fromPackage: boolean,
): { ok: true; file: PlannedFile } | { ok: false; problems: string[] } {
  const example = JSON.parse(template) as { configSource?: unknown };
  const zone = a.zone as string;
  const raw = {
    account: a.cloudflare,
    zone,
    workers: {
      memory: { script: `${a.name}-memory`, hostname: `${a.name}-memory.${zone}` },
      bot: { script: a.name, hostname: `${a.name}.${zone}` },
      ...(fromPackage
        ? {
            resident: { script: `${a.name}-resident`, hostname: `${a.name}-resident.${zone}` },
            sandbox: { script: `${a.name}-sandbox`, hostname: `${a.name}-sandbox.${zone}` },
          }
        : {}),
    },
    configSource: typeof example.configSource === "string" ? example.configSource : CONFIG_PATH,
    ...(fromPackage ? { images: "registry" } : {}),
  };
  const parsed = parseProfile(raw);
  if (!parsed.ok) return { ok: false, problems: parsed.problems.map((p) => `${PROFILE_PATH}: ${p}`) };
  return {
    ok: true,
    file: { path: PROFILE_PATH, text: `${JSON.stringify(raw, null, 2)}\n`, mode: 0o644, secretNames: [] },
  };
}

// ---- what comes next -------------------------------------------------------------

function nextCommands(world: InitWorld, profile: boolean): string[] {
  const image = `${world.image}:latest`;
  const bot = `docker run -d --restart unless-stopped --env-file .env -v "$PWD/config:/app/config:ro" ${image}`;
  const deploySteps = (cli: string, workers: string[]) => [
    ...workers.map((w) => `${cli} deploy secrets ${w}`),
    `MEMORY_TOKEN="$(cat ~/.secrets/switchboard/MEMORY_TOKEN)" ${cli} deploy all`,
  ];
  // From the npm package: `ask`, `start` — the bot, the same process the image runs — and the
  // deploy commands are all the same package, run from this directory; the image is the one-line
  // alternative for a machine that would rather run a container.
  if (world.package !== undefined) {
    const cli = `npx ${world.package}`;
    return [
      `${cli} ask "what can you do?"`,
      `${cli} start`,
      `${bot}   # the same bot from the published image`,
      ...(profile ? deploySteps(cli, ["memory", "bot", "resident", "sandbox"]) : []),
    ];
  }
  if (!world.inCheckout)
    return [`docker run --rm -it --env-file .env -v "$PWD/config:/app/config:ro" ${image} ask "what can you do?"`, bot];
  return [
    'npm run cli -- ask "what can you do?"',
    "npm run dev",
    `docker compose up -d   # the same bot from the published image ${image}`,
    ...(profile ? deploySteps("npm run cli --", ["memory", "bot"]) : []),
  ];
}

function definedOnly(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}
