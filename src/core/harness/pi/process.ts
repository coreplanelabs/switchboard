// How a run's pi is launched (docs/reference/specs/harness-pi.md item 4): the
// argument list that pins RPC mode and turns every discovery off but the
// harness's own extension, the environment that hands pi the run bearer as its
// provider key and the bot's URL as the provider's home — never a model key,
// never on a command line — and the files pi's config directory holds for the
// run: the composed system prompt, a models.json whose one provider is the
// bot's model proxy, a settings file that never trusts the checkout, and the
// extension. Pure: strings and records; the container seam writes and runs them.

import type { Identity } from "../../../agents/registry.js";
import { EFFORT_LEVELS, type Effort } from "../../../effort.js";
import type { ModelCard } from "../../modelCard.js";
import { billerHarnessProvider, WIRE_ALIASES, type ProviderConfig, type Wire } from "../../provider.js";
import type { PiCompactionConfig } from "../../../config.js";
import type { HarnessPaths, HarnessStart } from "../container.js";
import { PI_EXTENSION_SOURCE } from "./extensionSource.js";

/** The program the container starts: pi on the container's PATH. */
export const PI_BIN = "pi";
/** What marks a streaming delta in pi's stdout: a line carrying it never reaches the log, on any container. */
export const MESSAGE_UPDATE_MARK = '"type":"message_update"';
/** pi's stdout filter for the container seam: the streaming deltas dropped at the source, because no reader wants a token at a time. */
export const PI_STDOUT_FILTER: NonNullable<HarnessStart["stdoutFilter"]> = { dropLinesContaining: MESSAGE_UPDATE_MARK };
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
/** pi's own tools a run without an identity holds: none. Such a run has no
 *  workspace (machine class `none`) and runs pi as a child of the bot, so a
 *  shell or a file tool would run on the bot host; its tools are the relayed
 *  ones alone (harness-pi item 12). */
export const PI_NO_TOOLS: readonly string[] = [];

/** The built-in tools a run's identity gives its pi (harness-pi items 10 and
 *  12): a write run holds them all; a read run holds nothing that writes; a
 *  run without an identity holds none of them. */
export function piBuiltinToolsFor(identity: Identity): readonly string[] {
  if (identity === "write") return PI_BUILTIN_TOOLS;
  if (identity === "read") return PI_READ_TOOLS;
  return PI_NO_TOOLS;
}

/** The five effort tiers onto pi's seven thinking levels: the names coincide,
 *  so the map is the identity, and no effort leaves pi's own default for the
 *  model. (`off` and `minimal` are pi's alone — no tier reaches them.) */
export function piThinkingLevel(effort: Effort | undefined): string | undefined {
  return effort;
}

/** The files and paths of one run's pi, all under one directory of the run's
 *  own: the container seam's layout (`HarnessPaths`: the root and the
 *  directories the start makes, the FIFO, the log, the error log, the pid
 *  file, the command directory) plus pi's own files. */
export interface PiRunPaths extends HarnessPaths {
  /** `PI_CODING_AGENT_DIR`: settings.json, models.json, SYSTEM.md, sessions/. */
  agentDir: string;
  sessionDir: string;
  extension: string;
}

/** Every path is derived from the run id, so two runs never share a file and
 *  a run's files are removable as one tree. Outside the checkout, so nothing
 *  pi writes lands in the repository or its snapshots.
 *
 *  The directory is the run's own, directly under `/var/tmp`, which is sticky
 *  (mode 1777) like `/tmp`: whichever OS user runs the run's commands can
 *  create a sibling there, and only that user can remove it. That is the
 *  `mkdtemp` shape, the mechanism the OS has for exactly this, and it asks
 *  nothing of the harness about who runs the commands. It is `/var/tmp` and
 *  not `/tmp` because the model's shell runs in the same container as the
 *  same user, and the shared temp directory (`/tmp`, `$TMPDIR`) is exactly
 *  what a checkout's test suite or cleanup empties — taking the harness's own
 *  FIFO with it — while nothing has a reason to touch `/var/tmp`. There is no
 *  parent between `/var/tmp` and the root, shared or per user: the resident
 *  runs each thread's commands as that thread's pool user, and `mkdir -p`
 *  gives a parent it creates to its caller, so a parent shared by every run
 *  would belong to whichever user ran first and refuse every other user's run
 *  at its own mkdir, and a parent per user would only move that ownership to
 *  the runs that know their user. The run id is unique, so the name needs no
 *  suffix. */
export function piRunPaths(runId: string): PiRunPaths {
  return piRunPathsAt(`${PI_RUN_ROOT_PREFIX}${runId}`);
}

/** Where a fresh run's root goes, the run id appended: the one constant the
 *  exec container's `makeRoot` answers as it is. Outside the shared temp
 *  directory — see `piRunPaths`. */
export const PI_RUN_ROOT_PREFIX = "/var/tmp/switchboard-pi-";

/** The run's files under a given root: this build's own for a fresh run
 *  (`piRunPaths`), or the root a row recorded for the pi a previous build
 *  started (docs/reference/specs/harness-pi.md item 8), so a re-attach reads
 *  pi's log and feeds its FIFO where that build put them, whatever root this
 *  one would choose. The layout under the root is the contract between
 *  builds: a build that changes it cannot re-attach to a pi of the old one. */
export function piRunPathsAt(dir: string): PiRunPaths {
  const sessionDir = `${dir}/agent/sessions`;
  const commandDir = `${dir}/cmd`;
  return {
    dir,
    // The directories the start makes at 700, the root first (harness-pi item 4).
    dirs: [dir, sessionDir, commandDir],
    agentDir: `${dir}/agent`,
    sessionDir,
    extension: `${dir}/extension.js`,
    fifo: `${dir}/rpc.in`,
    log: `${dir}/rpc.log`,
    errLog: `${dir}/rpc.err`,
    pidFile: `${dir}/pi.pid`,
    commandDir,
  };
}

export interface PiLaunchSpec {
  runId: string;
  paths: PiRunPaths;
  /** The resolved `<provider>/<model>` and the provider's wire shape — the proxy route pi calls. */
  model: { id: string; providerType: ProviderConfig["type"]; maxTokens: number };
  /** The bot's base URL as pi reaches it: the public one (through the shim)
   *  from a run's container, the bot's own loopback from the bot host. */
  harnessUrl: string;
  effort?: Effort;
  /** The preset's identity: it decides which of pi's own tools the allowlist
   *  carries and what the harness note says of them. */
  identity: Identity;
  /** The composed system prompt the dispatcher would hand the native loop. */
  system: string;
  /** The harness's own tools the extension registers, so the prompt can name them. */
  relayTools: readonly string[];
  /** The run's resolved model card (record 0052): what `models.json` says of
   *  the model — the level map, the window, the cap field, the cache rule —
   *  in place of the invented one, so the word on the wire is the card's and
   *  never one pi chose. Absent (a hand-built spec), the wire-default card
   *  stands: the identity level map, pi's unknown window, the wire's cap field. */
  card?: ModelCard;
  /** The model stream's HTTP idle and provider request bound. It is the
   *  run lease remaining when this pi starts, never a transport's fixed
   *  thirty-second default; the harness still cuts the active turn at its own
   *  earlier loop/finale bound. */
  modelStreamTimeoutMs: number;
  /** A session file to continue from (a resume after the container's pi died). */
  sessionPath?: string;
  /** The deployment's compaction thresholds for pi's settings (`pi.compaction`
   *  in the config; harness-pi item 4). Absent, pi's own defaults stand and the
   *  settings file is exactly what it was before the block existed. */
  compaction?: PiCompactionConfig;
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
 *  version number — a `<family>-5` id is 5, `<family>-4-6` 4.6, a dated
 *  `<family>-4-5-<yyyymmdd>` 4.5 (a minor is one or two digits, so a
 *  date is never read as one) — and an id with none is taken for the current
 *  generation, since every model Anthropic ships now is adaptive. */
export function takesAdaptiveThinking(modelId: string): boolean {
  const version = /(?:^|-)(\d{1,2})(?:-(\d{1,2}))?(?=-|$)/.exec(modelId);
  if (!version) return true;
  const major = Number(version[1]);
  const minor = version[2] === undefined ? 0 : Number(version[2]);
  return major > 4 || (major === 4 && minor >= 6);
}

/** The card's level map as pi's `thinkingLevelMap`: each tier the wire's word
 *  the card resolved (a fallback's word included, so pi clamps nothing the
 *  card did not), `null` for a refused tier — the dispatcher refuses such a
 *  run before pi exists; the null keeps pi honest if one slips by. Unknown
 *  levels (no layer names them) are the identity map: the asked tier's own
 *  word goes out unvouched, never pi's silent clamp of `xhigh` to `high`. */
export function piThinkingLevelMap(levels: ModelCard["levels"] | undefined): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const tier of EFFORT_LEVELS) {
    const level = levels === undefined || levels === "unknown" ? undefined : levels[tier];
    map[tier] = level === "refused" ? null : level === undefined ? tier : level.word;
  }
  return map;
}

/** The wire a run's pi speaks: the card's (record 0052 — every dispatched run
 *  carries one), else the legacy provider type's alias for a hand-built spec. */
export function piRunWire(spec: { model: { providerType: ProviderConfig["type"] }; card?: ModelCard }): Wire {
  return spec.card?.wire ?? WIRE_ALIASES[spec.model.providerType] ?? "openai-chat";
}

/** The two spellings pi's completions compat takes for the output cap; the
 *  card's field is written only when it is one of them (`max_output_tokens`
 *  is the Responses wire's own spelling, which its adapter writes natively). */
const PI_MAX_TOKENS_FIELDS = ["max_completion_tokens", "max_tokens"] as const;
type PiMaxTokensField = (typeof PI_MAX_TOKENS_FIELDS)[number];
function piMaxTokensField(capField: string | undefined): PiMaxTokensField | undefined {
  return (PI_MAX_TOKENS_FIELDS as readonly string[]).includes(capField ?? "")
    ? (capField as PiMaxTokensField)
    : undefined;
}

/** pi's `models.json`: one provider, the bot's proxy, on the wire shape the
 *  run's provider speaks — `anthropic-messages` posts `/v1/messages` under the
 *  base, `openai-completions` posts `/chat/completions` and `openai-responses`
 *  posts `/responses`, both under `<base>/v1` —
 *  with the key read from the bearer's variable at request time and a zero
 *  rate card, because pi's `usage.cost` is never what a page shows: the proxy
 *  meters. The model entry is the run's card (record 0052), never one pi
 *  invents: the resolved level map (`piThinkingLevelMap`; the identity map
 *  when no layer names the levels, so pi clamps nothing), the card's window
 *  as `contextWindow`, the card's inputs, the cap field as
 *  `compat.maxTokensField` on the completions shape, and the thinking payload
 *  the model takes on the Anthropic shape (`takesAdaptiveThinking`). A
 *  completions block whose biller a harness speaks natively
 *  (`billerHarnessProvider`, record 0052's amendment) carries the biller's own
 *  compat words beside the card's, so pi through the proxy behaves as pi does
 *  against the biller directly — through the proxy pi sees the bot's URL, and
 *  its own detection would take the biller for a generic endpoint:
 *  `cacheControlFormat: "anthropic"` when the card's cache rule is markers (an
 *  Anthropic vendor through the aggregator), `thinkingFormat` and
 *  `sessionAffinityFormat` from the biller's table row, and
 *  `supportsDeveloperRole` said either way from the biller's id prefixes. A
 *  markers card on a biller no harness speaks natively carries no marker word:
 *  its cache row is already `degraded` (`decideControls`), never a silent
 *  marker no endpoint honours. */
export function piModelsJson(spec: PiLaunchSpec): string {
  const wire = piRunWire(spec);
  const anthropic = wire === "anthropic-messages";
  const base = spec.harnessUrl.replace(/\/$/, "");
  const card = spec.card;
  const capField = wire === "openai-chat" ? piMaxTokensField(card?.capField) : undefined;
  const biller = wire === "openai-chat" ? billerHarnessProvider(card?.block) : undefined;
  const completionsCompat = {
    ...(capField !== undefined ? { maxTokensField: capField } : {}),
    ...(biller !== undefined && card?.cache === "markers" ? { cacheControlFormat: "anthropic" } : {}),
    ...(biller !== undefined
      ? {
          thinkingFormat: biller.piCompat.thinkingFormat,
          sessionAffinityFormat: biller.piCompat.sessionAffinityFormat,
          supportsDeveloperRole: biller.piCompat.developerRoleIdPrefixes.some((p) => spec.model.id.startsWith(p)),
        }
      : {}),
  };
  const compat = anthropic
    ? { forceAdaptiveThinking: takesAdaptiveThinking(spec.model.id) }
    : Object.keys(completionsCompat).length > 0
      ? completionsCompat
      : undefined;
  return (
    JSON.stringify(
      {
        providers: {
          [PROXY_PROVIDER]: {
            baseUrl: anthropic ? base : `${base}/v1`,
            api: anthropic
              ? "anthropic-messages"
              : wire === "openai-responses"
                ? "openai-responses"
                : "openai-completions",
            apiKey: `$${RUN_BEARER_ENV}`,
            models: [
              {
                id: spec.model.id,
                name: spec.model.id,
                reasoning: true,
                ...(card !== undefined ? { thinkingLevelMap: piThinkingLevelMap(card.levels) } : {}),
                ...(compat !== undefined ? { compat } : {}),
                input: card?.inputs.image === false ? ["text"] : ["text", "image"],
                contextWindow: card?.window ?? 200_000,
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
 *  names neither is not contradicted and one that did would be; a run without
 *  a workspace is told it has none of pi's own tools, and no native name is
 *  mapped onto one. */
export function harnessPromptNote(relayTools: readonly string[], identity: Identity): string {
  const named = relayTools.map((t) => `\`${t}\``).join(", ");
  if (identity === "none") {
    return [
      "HARNESS NOTE: this run has no workspace, so none of pi's own tools (`read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`) is available, and a call to any of them is refused.",
      relayTools.length > 0
        ? `This run's tools are exactly these, each under its own name: ${named}.`
        : "No tools are available in this run.",
    ].join(" ");
  }
  const write = identity === "write";
  return [
    write
      ? "HARNESS NOTE: this run's workspace tools are pi's own — `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`, all running in the worktree."
      : "HARNESS NOTE: this run's workspace tools are pi's own — `read`, `bash`, `grep`, `find` and `ls`, all running in the worktree; it has no `edit` and no `write`: the run is read-only, and a call to either is refused.",
    write
      ? "Where these instructions say `read_file` use `read`; where they say `write_file` use `write` (a whole file) or `edit` (a targeted change)."
      : "Where these instructions say `read_file` use `read`.",
    relayTools.length > 0
      ? `Every other tool named above is available under its own name: ${named}.`
      : "No other tools are available in this run.",
  ].join(" ");
}

/** The run's system prompt as pi reads it from `SYSTEM.md`: the dispatcher's
 *  composed prompt, then the harness note. */
export function piSystemPrompt(spec: PiLaunchSpec): string {
  return `${spec.system.trimEnd()}\n\n${harnessPromptNote(spec.relayTools, spec.identity)}\n`;
}

/** What pi's settings prepend to every bash command (`shellCommandPrefix`),
 *  so the tool's timeout ends the command whatever it does with its pipes
 *  (docs/reference/specs/harness-pi.md item 15). pi kills the command's
 *  process group at the deadline, but its post-exit wait re-arms on every
 *  output chunk, so a descendant outside the group (a `setsid`'d daemon, a
 *  build tool's own group) that kept the tool's pipe open and kept writing
 *  held a call open far past its bound. This prefix routes the shell's stdout
 *  and stderr through one forwarder inside the group (bash process
 *  substitution — pi's shell is bash by name): descendants inherit the pipe
 *  into the forwarder, never the tool's own, so the deadline's group kill
 *  closes the tool's read side and the call returns pi's own timeout result
 *  with the output captured. */
export const PI_SHELL_COMMAND_PREFIX = "exec > >(exec cat) 2>&1";

/** pi's settings for a run: the checkout is never trusted (its `.pi/` never
 *  loads — `--no-extensions` already keeps discovery off; this is the second
 *  lock), no update checks, the shell command prefix that makes the bash
 *  tool's timeout final (`PI_SHELL_COMMAND_PREFIX`), and the model stream's
 *  HTTP idle/provider timeout set to the run's remaining lease. pi applies
 *  `httpIdleTimeoutMs` both to undici's between-byte bound and to provider SDK
 *  calls, so a reasoning pause is never cut by a library default shorter than
 *  the turn. When the deployment sets them, pi's compaction thresholds ride
 *  under pi's own key (`compaction.reserveTokens`,
 *  `compaction.keepRecentTokens`): pi compacts when the context passes the
 *  window less the reserve, so a reserve near the window makes a short run
 *  compact. Unset, the file names no `compaction` and pi's defaults stand. */
export function piSettingsJson(compaction?: PiCompactionConfig, modelStreamTimeoutMs?: number): string {
  const settings: Record<string, unknown> = {
    defaultProjectTrust: "never",
    checkForUpdates: false,
    shellCommandPrefix: PI_SHELL_COMMAND_PREFIX,
    ...(modelStreamTimeoutMs !== undefined ? { httpIdleTimeoutMs: modelStreamTimeoutMs } : {}),
  };
  const thresholds = {
    ...(compaction?.reserveTokens !== undefined ? { reserveTokens: compaction.reserveTokens } : {}),
    ...(compaction?.keepRecentTokens !== undefined ? { keepRecentTokens: compaction.keepRecentTokens } : {}),
  };
  if (Object.keys(thresholds).length > 0) settings.compaction = thresholds;
  return JSON.stringify(settings, null, 2) + "\n";
}

export interface PiFile {
  path: string;
  content: string;
}

/** Every file the container must hold before pi starts, none of them a secret. */
export function piLaunchFiles(spec: PiLaunchSpec): PiFile[] {
  return [
    {
      path: `${spec.paths.agentDir}/settings.json`,
      content: piSettingsJson(spec.compaction, spec.modelStreamTimeoutMs),
    },
    { path: `${spec.paths.agentDir}/models.json`, content: piModelsJson(spec) },
    { path: `${spec.paths.agentDir}/SYSTEM.md`, content: piSystemPrompt(spec) },
    { path: spec.paths.extension, content: PI_EXTENSION_SOURCE },
  ];
}
