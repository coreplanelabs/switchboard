// How a run's pi is launched (docs/reference/specs/harness-pi.md item 4): the
// argument list that pins RPC mode and turns every discovery off but the
// harness's own extension, the environment that hands pi the run bearer as its
// provider key and the bot's URL as the provider's home — never a model key,
// never on a command line — and the files pi's config directory holds for the
// run: the composed system prompt, a models.json whose one provider is the
// bot's model proxy, a settings file that never trusts the checkout, and the
// extension. Pure: strings and records; the container seam writes and runs them.

import type { Identity } from "../../../agents/registry.js";
import type { Effort } from "../../../effort.js";
import type { ProviderConfig } from "../../../providers/types.js";
import { PI_EXTENSION_SOURCE } from "./extensionSource.js";

export const PI_BIN = "pi";
/** The variable pi's models.json interpolates as the provider's key: the run bearer. */
export const RUN_BEARER_ENV = "SWITCHBOARD_RUN_BEARER";
/** Where the extension reaches the bot: the base URL the proxy and the harness routes hang under. */
export const HARNESS_URL_ENV = "SWITCHBOARD_HARNESS_URL";
/** The provider name pi knows the proxy by. */
export const PROXY_PROVIDER = "switchboard";

/** pi's own coding tools, the ones that run in the container beside the model. */
export const PI_BUILTIN_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** pi's own tools a read-identity run holds: the built-ins less `edit` and
 *  `write`. Off the allowlist, so pi never has them — the gate (toolRules.ts)
 *  would refuse a call, but a tool pi does not have is never called. */
export const PI_READ_TOOLS: readonly string[] = ["read", "bash", "grep", "find", "ls"];

/** The built-in tools a run's identity gives its pi (harness-pi item 10): a
 *  write run holds them all; a read run — and a preset without an identity —
 *  holds nothing that writes. */
export function piBuiltinToolsFor(identity: Identity): readonly string[] {
  return identity === "write" ? PI_BUILTIN_TOOLS : PI_READ_TOOLS;
}

/** The five effort tiers onto pi's seven thinking levels: the names coincide,
 *  so the map is the identity, and no effort leaves pi's own default for the
 *  model. (`off` and `minimal` are pi's alone — no tier reaches them.) */
export function piThinkingLevel(effort: Effort | undefined): string | undefined {
  return effort;
}

/** The files and paths of one run's pi, all under one directory of the run's own. */
export interface PiRunPaths {
  dir: string;
  /** `PI_CODING_AGENT_DIR`: settings.json, models.json, SYSTEM.md, sessions/. */
  agentDir: string;
  sessionDir: string;
  extension: string;
  fifo: string;
  log: string;
  errLog: string;
  pidFile: string;
  /** Where a command too long for one write lands before it is fed to the FIFO. */
  commandDir: string;
}

/** Every path is derived from the run id, so two runs never share a file and
 *  a run's files are removable as one tree. Outside the checkout, so nothing
 *  pi writes lands in the repository or its snapshots.
 *
 *  The directory is the run's own, directly under `/tmp`, which is sticky
 *  (mode 1777): whichever OS user runs the run's commands can create a
 *  sibling there, and only that user can remove it. That is the `mkdtemp`
 *  shape, the mechanism the OS has for exactly this, and it asks nothing of
 *  the harness about who runs the commands. There is no parent between `/tmp`
 *  and the root, shared or per user: the resident runs each thread's commands
 *  as that thread's pool user, and `mkdir -p` gives a parent it creates to
 *  its caller, so a parent shared by every run would belong to whichever user
 *  ran first and refuse every other user's run at its own mkdir, and a parent
 *  per user would only move that ownership to the runs that know their user.
 *  The run id is unique, so the name needs no suffix. */
export function piRunPaths(runId: string): PiRunPaths {
  return piRunPathsAt(`/tmp/switchboard-pi-${runId}`);
}

/** The run's files under a given root: this build's own for a fresh run
 *  (`piRunPaths`), or the root a row recorded for the pi a previous build
 *  started (docs/reference/specs/harness-pi.md item 8), so a re-attach reads
 *  pi's log and feeds its FIFO where that build put them, whatever root this
 *  one would choose. The layout under the root is the contract between
 *  builds: a build that changes it cannot re-attach to a pi of the old one. */
export function piRunPathsAt(dir: string): PiRunPaths {
  return {
    dir,
    agentDir: `${dir}/agent`,
    sessionDir: `${dir}/agent/sessions`,
    extension: `${dir}/extension.js`,
    fifo: `${dir}/rpc.in`,
    log: `${dir}/rpc.log`,
    errLog: `${dir}/rpc.err`,
    pidFile: `${dir}/pi.pid`,
    commandDir: `${dir}/cmd`,
  };
}

export interface PiLaunchSpec {
  runId: string;
  paths: PiRunPaths;
  /** The resolved `<provider>/<model>` and the provider's wire shape — the proxy route pi calls. */
  model: { id: string; providerType: ProviderConfig["type"]; maxTokens: number };
  /** The bot's base URL as the container reaches it (through the shim). */
  harnessUrl: string;
  effort?: Effort;
  /** The preset's identity: it decides which of pi's own tools the allowlist
   *  carries and what the harness note says of them. */
  identity: Identity;
  /** The composed system prompt the dispatcher would hand the native loop. */
  system: string;
  /** The harness's own tools the extension registers, so the prompt can name them. */
  relayTools: readonly string[];
  /** A session file to continue from (a resume after the container's pi died). */
  sessionPath?: string;
}

/** `pi --mode rpc` with discovery off: no `~/.pi/agent/extensions`, no project
 *  `.pi/extensions`, no skills, prompt templates or themes; the harness
 *  extension by explicit path; the tools allowlist (pi's own for the run's
 *  identity plus the relayed ones — pi's `--tools` filters extension tools
 *  too); the proxy's provider
 *  and the run's model, with the thinking level as pi's model suffix; the
 *  session directory, or the session to continue. Never `--api-key`: the key
 *  is in the environment, not on a command line `ps` shows. */
export function piLaunchArgs(spec: PiLaunchSpec): string[] {
  const thinking = piThinkingLevel(spec.effort);
  return [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e",
    spec.paths.extension,
    "--tools",
    [...piBuiltinToolsFor(spec.identity), ...spec.relayTools].join(","),
    "--provider",
    PROXY_PROVIDER,
    "--model",
    thinking ? `${spec.model.id}:${thinking}` : spec.model.id,
    ...(spec.sessionPath ? ["--session", spec.sessionPath] : ["--session-dir", spec.paths.sessionDir]),
  ];
}

/** The process's environment beyond what the executor's shell already has:
 *  the bearer under the name models.json interpolates, the bot's URL for the
 *  extension, the run's id, pi's config directory, and the switches that keep
 *  pi off the network for anything but the model. The bearer is revealed here
 *  into the env record and nowhere else. */
export function piLaunchEnv(spec: PiLaunchSpec, bearer: string): Record<string, string> {
  return {
    [RUN_BEARER_ENV]: bearer,
    [HARNESS_URL_ENV]: spec.harnessUrl,
    SWITCHBOARD_RUN_ID: spec.runId,
    PI_CODING_AGENT_DIR: spec.paths.agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
}

/** Whether a Claude model takes adaptive thinking (`thinking.type: "adaptive"`
 *  plus `output_config.effort`) or the legacy budget (`thinking.type:
 *  "enabled"` plus `budget_tokens`). Anthropic drew the line at the 4.6
 *  generation: Opus 4.6 and Sonnet 4.6 take both; everything after them —
 *  Opus 4.7 and 4.8, Sonnet 5, Opus 5, the Fable family — refuses the budget
 *  with a 400 (`"thinking.type.enabled" is not supported for this model`);
 *  everything before — Haiku 4.5, Sonnet 4.5, Opus 4.5 and older — refuses
 *  adaptive. pi sends the budget unless the model's entry says
 *  `compat.forceAdaptiveThinking`, which its built-in Anthropic catalog sets
 *  per model along the same line; a model behind the proxy is not in that
 *  catalog, so the harness says it here. The generation is the id's first
 *  version number — `claude-fable-5` is 5, `claude-opus-4-6` 4.6,
 *  `claude-sonnet-4-5-20250929` 4.5 (a minor is one or two digits, so a
 *  date is never read as one) — and an id with none is taken for the current
 *  generation, since every model Anthropic ships now is adaptive. */
export function takesAdaptiveThinking(modelId: string): boolean {
  const version = /(?:^|-)(\d{1,2})(?:-(\d{1,2}))?(?=-|$)/.exec(modelId);
  if (!version) return true;
  const major = Number(version[1]);
  const minor = version[2] === undefined ? 0 : Number(version[2]);
  return major > 4 || (major === 4 && minor >= 6);
}

/** pi's `models.json`: one provider, the bot's proxy, on the wire shape the
 *  run's provider speaks — `anthropic-messages` posts `/v1/messages` under the
 *  base, `openai-completions` posts `/chat/completions` under `<base>/v1` —
 *  with the key read from the bearer's variable at request time, the thinking
 *  payload the model takes on the Anthropic shape (`takesAdaptiveThinking`;
 *  the completions shape has no such switch), and a zero rate card, because
 *  pi's `usage.cost` is never what a page shows: the proxy meters. */
export function piModelsJson(spec: PiLaunchSpec): string {
  const anthropic = spec.model.providerType === "anthropic";
  const base = spec.harnessUrl.replace(/\/$/, "");
  return (
    JSON.stringify(
      {
        providers: {
          [PROXY_PROVIDER]: {
            baseUrl: anthropic ? base : `${base}/v1`,
            api: anthropic ? "anthropic-messages" : "openai-completions",
            apiKey: `$${RUN_BEARER_ENV}`,
            models: [
              {
                id: spec.model.id,
                name: spec.model.id,
                reasoning: true,
                ...(anthropic ? { compat: { forceAdaptiveThinking: takesAdaptiveThinking(spec.model.id) } } : {}),
                input: ["text", "image"],
                contextWindow: 200_000,
                maxTokens: spec.model.maxTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** What the system prompt gains under pi: the workspace tools are pi's own,
 *  under pi's names — the ones the run's identity holds — and the rest of the
 *  run's tools keep theirs. Said once and last, so a prompt written for the
 *  native loop's `read_file` and `write_file` still lands on a tool that
 *  exists; a read run is told it has no `edit` or `write`, so a prompt that
 *  names neither is not contradicted and one that did would be. */
export function harnessPromptNote(relayTools: readonly string[], identity: Identity): string {
  const write = identity === "write";
  return [
    write
      ? "HARNESS NOTE: this run's workspace tools are pi's own — `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`, all running in the worktree."
      : "HARNESS NOTE: this run's workspace tools are pi's own — `read`, `bash`, `grep`, `find` and `ls`, all running in the worktree; it has no `edit` and no `write`: the run is read-only, and a call to either is refused.",
    write
      ? "Where these instructions say `read_file` use `read`; where they say `write_file` use `write` (a whole file) or `edit` (a targeted change)."
      : "Where these instructions say `read_file` use `read`.",
    relayTools.length > 0
      ? `Every other tool named above is available under its own name: ${relayTools.map((t) => `\`${t}\``).join(", ")}.`
      : "No other tools are available in this run.",
  ].join(" ");
}

/** The run's system prompt as pi reads it from `SYSTEM.md`: the dispatcher's
 *  composed prompt, then the harness note. */
export function piSystemPrompt(spec: PiLaunchSpec): string {
  return `${spec.system.trimEnd()}\n\n${harnessPromptNote(spec.relayTools, spec.identity)}\n`;
}

/** pi's settings for a run: the checkout is never trusted (its `.pi/` never
 *  loads — `--no-extensions` already keeps discovery off; this is the second
 *  lock), no update checks. */
export function piSettingsJson(): string {
  return JSON.stringify({ defaultProjectTrust: "never", checkForUpdates: false }, null, 2) + "\n";
}

export interface PiFile {
  path: string;
  content: string;
}

/** Every file the container must hold before pi starts, none of them a secret. */
export function piLaunchFiles(spec: PiLaunchSpec): PiFile[] {
  return [
    { path: `${spec.paths.agentDir}/settings.json`, content: piSettingsJson() },
    { path: `${spec.paths.agentDir}/models.json`, content: piModelsJson(spec) },
    { path: `${spec.paths.agentDir}/SYSTEM.md`, content: piSystemPrompt(spec) },
    { path: spec.paths.extension, content: PI_EXTENSION_SOURCE },
  ];
}
