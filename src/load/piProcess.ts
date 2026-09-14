// How `load:pi` starts pi (docs/reference/specs/load-harness.md, the pi
// driver items): the argument list that pins RPC mode and turns every
// discovery off but the one extension, the environment allowlist that hands
// pi the model key under the name pi reads and nothing else from the
// operator's shell, and the config directory pi is pointed at (so the
// operator's own `~/.pi/agent` — its auth.json, settings, extensions — is
// never read). pi runs in the checkout, not where the operator typed the
// command, and looks a relative path up there: every path it is handed —
// config directory, session directory, extension — is made absolute here,
// whatever the caller knew it as. The LF-only line reader is the protocol
// module's. This is the driver's one host-touching module beside the
// entrypoint: it runs on the operator's machine, like every load command.

import { execFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redactSecrets } from "../core/redact.js";
import { publicEnv, type EnvRecord, type Secret } from "../secrets.js";
import { takesAdaptiveThinking } from "../core/harness/pi/process.js";
import { jsonlLines, type PiTransport } from "../core/harness/pi/protocol.js";

/** The variable the harness hands a custom provider's key under: the name
 *  the generated models.json interpolates (`"apiKey": "$SWITCHBOARD_PI_MODEL_KEY"`). */
export const HARNESS_KEY_ENV = "SWITCHBOARD_PI_MODEL_KEY";

/** The variable pi reads for each of its built-in providers this harness
 *  names — pi's own `envMap` (packages/ai/src/env-api-keys.ts). */
const PI_PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
};

export const piKeyEnvFor = (provider: string): string => PI_PROVIDER_KEY_ENV[provider] ?? HARNESS_KEY_ENV;

/** The tools a pi coding child may call: pi's built-ins
 *  (packages/coding-agent/src/core/tools) and the harness extension's two
 *  terminal tools. pi's `--tools` allowlist applies to extension tools as
 *  well, so leaving `submit_pr_description` off it would hide the PR-shaped
 *  outcome; `submit_verdict` is listed on purpose, so a coding run that
 *  reaches for it is measured (the preview marks it outside the profile). */
export const PI_CODING_TOOLS: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "submit_pr_description",
  "submit_verdict",
];

export interface PiSpawnOptions {
  piBin: string;
  checkout: string;
  /** The harness extension, as the caller knows it — relative to the
   *  caller's cwd if it likes; pi gets it absolute. */
  extensionPath: string;
  provider: string;
  model: string;
  /** pi's thinking level (`off`…`max`), sent as the model suffix `:<level>`. */
  thinking?: string;
  /** The variable name pi reads the key from, and the key — revealed once,
   *  into the child's environment and nowhere else. */
  keyEnvName: string;
  keyValue: Secret;
  /** pi's config directory and its session directory, as the caller knows
   *  them — relative to the caller's cwd if it likes; pi gets them absolute. */
  agentDir: string;
  sessionDir: string;
  tools: readonly string[];
}

/** `pi --mode rpc` with discovery off: no `~/.pi/agent/extensions`, no
 *  project `.pi/extensions` (non-interactive modes never trust a project
 *  without a saved decision; the settings file says `never` anyway), no
 *  skills, prompt templates or themes; the harness extension by explicit
 *  path; the tools allowlist; the model; a session directory so the session
 *  file exists for the receipt. Every path absolute: pi's cwd is the
 *  checkout, and a relative path would be looked up there. Never
 *  `--api-key`: the key is in the environment, not on a command line `ps`
 *  shows. */
export function piArgs(o: PiSpawnOptions): string[] {
  return [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e",
    resolve(o.extensionPath),
    "--tools",
    o.tools.join(","),
    "--provider",
    o.provider,
    "--model",
    o.thinking ? `${o.model}:${o.thinking}` : o.model,
    "--session-dir",
    resolve(o.sessionDir),
  ];
}

/** The child's whole environment: PATH and HOME (pi and git need them), the
 *  key under pi's name, pi's config directory — absolute, since pi resolves
 *  the variable against its own cwd, the checkout, where a relative one
 *  finds no models.json and so no custom provider — and the switches that
 *  keep pi off the network for anything but the model (no update check, no
 *  telemetry, no catalog refresh). Nothing else from the operator's shell. */
export function piEnv(o: PiSpawnOptions, base: EnvRecord): Record<string, string> {
  const env: Record<string, string> = {};
  if (base.PATH) env.PATH = base.PATH;
  if (base.HOME) env.HOME = base.HOME;
  env[o.keyEnvName] = o.keyValue.reveal();
  env.PI_CODING_AGENT_DIR = resolve(o.agentDir);
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_OFFLINE = "1";
  env.PI_TELEMETRY = "0";
  return env;
}

/** What a models.json entry tells pi about a model beyond its id — pi's own
 *  fields, the ones a caller decides. A bare entry is a model pi knows
 *  nothing about: no reasoning (thinking forced off), a 128k window, a 16k
 *  output ceiling. How pi asks the model to think — adaptive or the legacy
 *  budget — is not a caller's to say: `writeAgentDir` writes it from the
 *  model and the shape. */
export interface ModelEntryFields {
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** The entry for the model the bot's proxy fronts: pi's own catalog entry
 *  for the Claude family, so the through-proxy arm thinks at the same level
 *  and compacts at the same point as the direct arm — the window is the
 *  family's, the output ceiling its floor, so no model refuses a request
 *  for asking too much. */
export const PROXIED_MODEL_ENTRY: Readonly<Required<ModelEntryFields>> = {
  reasoning: true,
  contextWindow: 1_000_000,
  maxTokens: 64_000,
};

export interface AgentDirOptions {
  provider: string;
  model: string;
  /** A custom endpoint for a provider pi does not ship — the scripted provider
   *  in the dry run, the bot's model proxy in the through-proxy receipt.
   *  Written as a `models.json` provider. */
  baseUrl?: string;
  /** The endpoint's wire shape; the OpenAI completions shape unless named. */
  api?: "openai-completions" | "anthropic-messages";
  /** What the entry says about the model beyond its id; a bare entry unless given. */
  modelEntry?: ModelEntryFields;
}

export interface AgentDirLayout {
  settingsPath: string;
  modelsPath?: string;
  sessionDir: string;
}

/** pi's config directory for one harness run: a settings file that never
 *  trusts the project, a sessions directory, and — for a custom endpoint —
 *  a models.json whose key is interpolated from the harness's variable. On
 *  the Anthropic shape the model's entry also says which thinking payload
 *  the model takes (`compat.forceAdaptiveThinking`, from the production
 *  harness's `takesAdaptiveThinking`): pi's built-in catalog says that per
 *  Claude model, and a model behind a custom endpoint is not in it — without
 *  the flag pi sends the legacy budget, which a Claude 5 model refuses with a
 *  400 on its first thinking turn. The completions shape has no such switch. */
export function writeAgentDir(dir: string, o: AgentDirOptions): AgentDirLayout {
  mkdirSync(dir, { recursive: true });
  const sessionDir = join(dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultProjectTrust: "never" }, null, 2) + "\n");
  if (o.baseUrl === undefined) return { settingsPath, sessionDir };
  const modelsPath = join(dir, "models.json");
  const api = o.api ?? "openai-completions";
  const compat =
    api === "anthropic-messages" ? { compat: { forceAdaptiveThinking: takesAdaptiveThinking(o.model) } } : {};
  const models = {
    providers: {
      [o.provider]: {
        baseUrl: o.baseUrl,
        api,
        apiKey: `$${HARNESS_KEY_ENV}`,
        models: [{ id: o.model, ...o.modelEntry, ...compat }],
      },
    },
  };
  writeFileSync(modelsPath, JSON.stringify(models, null, 2) + "\n");
  return { settingsPath, modelsPath, sessionDir };
}

/** How much of pi's stderr an early-exit note shows. */
const EARLY_EXIT_STDERR_CHARS = 300;

/** A task pi left before its first turn (`exited`, no turn) has no stream
 *  to explain it; the receipt's note carries pi's own stderr for it —
 *  redacted, folded onto one line (the note is a list item), its first 300
 *  characters — so the operator reads the reason on the receipt and not
 *  only in the JSON. Nothing for a task that reached a turn or ended any
 *  other way: those the stream explains. */
export function earlyExitNote(
  task: string,
  run: { terminal: string; turns: number },
  stderr: string,
): string | undefined {
  if (run.terminal !== "exited" || run.turns > 0) return undefined;
  const text = redactSecrets(stderr).replace(/\s+/g, " ").trim();
  const shown = text.length > EARLY_EXIT_STDERR_CHARS ? `${text.slice(0, EARLY_EXIT_STDERR_CHARS)}…` : text;
  return `${task}: pi exited before its first turn — its stderr: ${shown || "(empty)"}`;
}

export interface PiProcess {
  transport: PiTransport;
  /** Resolves when pi exits; the code and signal as Node reports them. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** pi's stderr so far (capped). */
  stderr(): string;
  kill(): void;
}

const STDERR_CAP = 64 * 1024;

export type SpawnFn = (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess;

export function spawnPi(o: PiSpawnOptions, spawn: SpawnFn = nodeSpawn): PiProcess {
  const child = spawn(o.piBin, piArgs(o), {
    cwd: o.checkout,
    env: piEnv(o, publicEnv()),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-STDERR_CAP);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  if (!child.stdout || !child.stdin) throw new Error("pi was spawned without piped stdio");
  const stdin = child.stdin;
  let closed = false;
  const transport: PiTransport = {
    send: (command) => {
      if (!closed && stdin.writable) stdin.write(JSON.stringify(command) + "\n");
    },
    lines: jsonlLines(child.stdout),
    close: () => {
      if (closed) return;
      closed = true;
      stdin.end();
    },
  };
  return { transport, exited, stderr: () => stderr, kill: () => void child.kill("SIGKILL") };
}

/** Put the checkout on the task's branch before pi starts — the ship
 *  pipeline owns its children's branch the same way. `-B` resets a branch a
 *  previous run left behind. */
export function checkoutBranch(checkout: string, branch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["checkout", "-q", "-B", branch], { cwd: checkout }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`git checkout -B ${branch} failed: ${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}
