// How a run's pi is launched (docs/reference/specs/harness-pi.md item 4): the
// argument list that pins RPC mode and turns every discovery off but the
// harness's own extension, the environment that hands pi the run bearer as its
// provider key and the bot's URL as the provider's home — never a model key,
// never on a command line — and the files pi's config directory holds for the
// run: the composed system prompt, a models.json whose one provider is the
// bot's model proxy, a settings file that never trusts the checkout, and the
// extension. Pure: strings and records; the container seam writes and runs them.

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
 *  pi writes lands in the repository or its snapshots. */
export function piRunPaths(runId: string, root = "/tmp/switchboard-pi"): PiRunPaths {
  const dir = `${root}/${runId}`;
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
  /** The composed system prompt the dispatcher would hand the native loop. */
  system: string;
  /** The harness's own tools the extension registers, so the prompt can name them. */
  relayTools: readonly string[];
  /** A session file to continue from (a resume after the container's pi died). */
  sessionPath?: string;
}

/** `pi --mode rpc` with discovery off: no `~/.pi/agent/extensions`, no project
 *  `.pi/extensions`, no skills, prompt templates or themes; the harness
 *  extension by explicit path; the tools allowlist (pi's own plus the relayed
 *  ones — pi's `--tools` filters extension tools too); the proxy's provider
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
    [...PI_BUILTIN_TOOLS, ...spec.relayTools].join(","),
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

/** pi's `models.json`: one provider, the bot's proxy, on the wire shape the
 *  run's provider speaks — `anthropic-messages` posts `/v1/messages` under the
 *  base, `openai-completions` posts `/chat/completions` under `<base>/v1` —
 *  with the key read from the bearer's variable at request time and a zero
 *  rate card, because pi's `usage.cost` is never what a page shows: the proxy
 *  meters. */
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
 *  under pi's names, and the rest of the run's tools keep theirs. Said once
 *  and last, so a prompt written for the native loop's `read_file` and
 *  `write_file` still lands on a tool that exists. */
export function harnessPromptNote(relayTools: readonly string[]): string {
  return [
    "HARNESS NOTE: this run's workspace tools are pi's own — `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`, all running in the worktree.",
    "Where these instructions say `read_file` use `read`; where they say `write_file` use `write` (a whole file) or `edit` (a targeted change).",
    relayTools.length > 0
      ? `Every other tool named above is available under its own name: ${relayTools.map((t) => `\`${t}\``).join(", ")}.`
      : "No other tools are available in this run.",
  ].join(" ");
}

/** The run's system prompt as pi reads it from `SYSTEM.md`: the dispatcher's
 *  composed prompt, then the harness note. */
export function piSystemPrompt(spec: PiLaunchSpec): string {
  return `${spec.system.trimEnd()}\n\n${harnessPromptNote(spec.relayTools)}\n`;
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
