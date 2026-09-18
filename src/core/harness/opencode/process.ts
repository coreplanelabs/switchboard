// How a run's OpenCode is launched (docs/reference/specs/harness.md, the
// OpenCode process item; record 0038's fourth amendment): the layout of the
// run's directory — per-run XDG roots, the configuration
// file, the relay plugin's directory, the server's logs, the feed the tailer
// writes, the pid files — the environment that hands `opencode serve` the run
// bearer as its provider key and the bot's URL as the provider's home (never a
// model key, never on a command line), the configuration that names the model
// proxy as the one provider and the `switchboard` agent whose rules ask the
// bot before every tool and hide what the identity does not hold, the launch
// through the container seam on a loopback port the seam picks, the readiness
// that reads the server's health, checks the configuration took and settles
// the plugin before the first session, and the tailer started beside it. Pure
// where it can be — strings and records — with one async function over the
// seam for the launch.

import { randomBytes } from "node:crypto";
import type { Identity } from "../../../agents/registry.js";
import { EFFORT_LEVELS, type Effort } from "../../../effort.js";
import type { ModelCard } from "../../modelCard.js";
import { bearerHashOf } from "../../modelProxy/runBearers.js";
import type { ProviderConfig } from "../../provider.js";
import type { Clock } from "../../trace/types.js";
import {
  HarnessContainerError,
  isContainerGone,
  LOG_READ_BYTES,
  PORT_ARG,
  type HarnessContainer,
  type HarnessPaths,
  type HarnessResponse,
} from "../container.js";
import type { OpenCodeHarnessFacts } from "../contract.js";
import { HARNESS_URL_ENV, PROXY_PROVIDER, RUN_BEARER_ENV, takesAdaptiveThinking } from "../pi/process.js";
import {
  OPENCODE_ROUTES,
  OPENCODE_VERSION,
  openCodeAuthHeader,
  parseConfigEntries,
  parseFeedRecord,
  parseHealth,
  type OpenCodeConfigEntry,
  type OpenCodePermissionRule,
} from "./client.js";
import { OPENCODE_PLUGIN_SOURCE } from "./pluginSource.js";
import { OPENCODE_SERVE_PID_ENV, OPENCODE_TAILER_SOURCE } from "./tailerSource.js";

/** The program the container starts: OpenCode on the container's PATH (`@opencode/cli`'s `opencode`). */
export const OPENCODE_BIN = "opencode";
/** The runtime the tailer runs on: Node, on every image's PATH and the bot host's. */
export const TAILER_BIN = "node";
/** The custom agent every run speaks as; `default_agent` names it so a session created without one is its. */
export const OPENCODE_AGENT = "switchboard";
/** The plugin entry in the configuration: a directory relative to the configuration
 *  file (`packages/core/src/config/plugin/source.ts:135-142` resolves `./` against
 *  the document's directory; a configured local plugin must be a directory, a file
 *  is dropped with a warning at 148-151), whose `index.js` is the entrypoint
 *  (`packages/plugin/src/host.ts:17-43`: `server`, then `index`). */
export const OPENCODE_PLUGIN_REF = "./plugins/switchboard";
/** The variable `serve` reads its password from (`packages/cli/src/env.ts:10-11`;
 *  `OPENCODE_SERVER_PASSWORD` is the legacy fallback). It stays in the server's
 *  environment in `serve` mode — only `--stdio` deletes it (`packages/cli/src/server-process.ts:70-74`). */
export const OPENCODE_PASSWORD_ENV = "OPENCODE_PASSWORD";
/** How long the server may take to answer its health with the pin's version. */
export const OPENCODE_READY_MS = 30_000;
/** Between two readiness probes that found no server yet. */
export const OPENCODE_READY_POLL_MS = 250;
/** The most a readiness poll backs off to, once the first second has passed with no answer. */
export const OPENCODE_READY_POLL_MAX_MS = 2_000;
/** The model's context window when the spec names none: OpenCode compacts against it. */
export const OPENCODE_DEFAULT_CONTEXT_TOKENS = 200_000;
/** How much of the server's stderr a readiness failure quotes. */
const READY_TAIL_BYTES = 2000;

/** The files and paths of one run's OpenCode, all under one directory of the
 *  run's own: the container seam's layout for `serve` (`HarnessPaths`: the
 *  root and the directories the start makes, a FIFO it never reads — the
 *  server is driven over HTTP — its stdout log, its stderr log, its pid file,
 *  the command directory) plus OpenCode's own roots and files, and a second
 *  seam layout for the tailer, whose stdout the seam appends to the feed. */
export interface OpenCodeRunPaths extends HarnessPaths {
  /** The four XDG roots (`packages/util/src/global-roots.ts:5-8`): every global path OpenCode has, under the run. */
  xdg: { data: string; config: string; cache: string; state: string };
  /** `OPENCODE_CONFIG`: the one configuration document the server loads. */
  config: string;
  /** The relay plugin's directory (`OPENCODE_PLUGIN_REF` resolved), and its entrypoint. */
  pluginDir: string;
  plugin: string;
  /** The run's feed: the tailer's stdout, one JSON record per line, read by offset. */
  feed: string;
  /** The tailer's script, written before it starts. */
  tailerScript: string;
  /** The tailer as a second process through the seam: the same root, its own FIFO, pid file and stderr, the feed as its log. */
  tailer: HarnessPaths;
}

/** Every path is derived from the run id, so two runs never share a file and a
 *  run's files are removable as one tree: directly under the sticky `/var/tmp`
 *  and outside the shared temp directory a suite or cleanup empties, for the
 *  reason pi's layout gives (`piRunPaths`). */
export function openCodeRunPaths(runId: string): OpenCodeRunPaths {
  return openCodeRunPathsAt(`${OPENCODE_RUN_ROOT_PREFIX}${runId}`);
}

/** Where a fresh run's root goes, the run id appended: the one constant the
 *  exec container's `makeRoot` answers as it is. Outside the shared temp
 *  directory — see pi's `piRunPaths`. */
export const OPENCODE_RUN_ROOT_PREFIX = "/var/tmp/switchboard-oc-";

/** The run's files under a given root: this build's own for a fresh run, or the
 *  root a row recorded for the server a previous build started, so a re-attach
 *  reads the feed where that build put it. The layout under the root is the
 *  contract between builds. */
export function openCodeRunPathsAt(dir: string): OpenCodeRunPaths {
  const xdg = {
    data: `${dir}/xdg/data`,
    config: `${dir}/xdg/config`,
    cache: `${dir}/xdg/cache`,
    state: `${dir}/xdg/state`,
  };
  const pluginDir = `${dir}/plugins/switchboard`;
  const commandDir = `${dir}/cmd`;
  const feed = `${dir}/feed.jsonl`;
  return {
    dir,
    // The directories the start makes at 700, the root first.
    dirs: [dir, xdg.data, xdg.config, xdg.cache, xdg.state, pluginDir, commandDir],
    fifo: `${dir}/serve.in`,
    log: `${dir}/serve.log`,
    errLog: `${dir}/serve.err`,
    pidFile: `${dir}/pid`,
    commandDir,
    xdg,
    config: `${dir}/opencode.json`,
    pluginDir,
    plugin: `${pluginDir}/index.js`,
    feed,
    tailerScript: `${dir}/tailer.js`,
    tailer: {
      dir,
      dirs: [dir],
      fifo: `${dir}/tailer.in`,
      log: feed,
      errLog: `${dir}/tailer.err`,
      pidFile: `${dir}/tailer.pid`,
      commandDir,
    },
  };
}

/** OpenCode's own tools a write run holds, by the tool names the model sees
 *  (`packages/core/src/tool/plugin/*.ts`). Each asserts a permission action
 *  that is its own name except `write` and `patch`, which assert `edit`. */
export const OPENCODE_BUILTIN_TOOLS: readonly string[] = ["read", "shell", "edit", "write", "glob", "grep", "skill"];
/** A read run's: the built-ins less what writes. */
export const OPENCODE_READ_TOOLS: readonly string[] = ["read", "shell", "glob", "grep", "skill"];
/** A run without an identity holds none: it has no workspace, and its server runs on the bot host. */
export const OPENCODE_NO_TOOLS: readonly string[] = [];

/** The rule that asks the bot before every asserted action: `*` matches every
 *  action and resource, and an unmatched action asks anyway
 *  (`packages/core/src/permission.ts:87-95`). */
export const ASK_ALL_RULE: OpenCodePermissionRule = { action: "*", resource: "*", effect: "ask" };

/** Actions denied for every identity, each a road around the gate or off the
 *  container: `question` (a dialog nobody answers headless), `subagent` (a
 *  child session whose calls evaluate under another agent's rules),
 *  `execute` (CodeMode: many tool calls inside one, `packages/core/src/tool.ts:232`
 *  disables it when this action is denied), `webfetch` and `websearch`
 *  (egress from the container that is not the proxy; the bot relays its own
 *  web tools). */
export const OPENCODE_ALWAYS_DENIED: readonly string[] = ["question", "subagent", "execute", "webfetch", "websearch"];
/** What a run without an identity has no workspace for. */
export const OPENCODE_NONE_DENIED: readonly string[] = [
  "read",
  "edit",
  "shell",
  "glob",
  "grep",
  "skill",
  "external_directory",
];
/** What a read run must not do. */
export const OPENCODE_READ_DENIED: readonly string[] = ["edit"];

/** The actions the run's identity denies (record 0038's fourth amendment:
 *  "deny rules hide tools, so a preset without a workspace is a configuration
 *  shape"), the always-denied ones first. */
export function openCodeDeniedActions(identity: Identity): readonly string[] {
  if (identity === "write") return OPENCODE_ALWAYS_DENIED;
  if (identity === "read") return [...OPENCODE_ALWAYS_DENIED, ...OPENCODE_READ_DENIED];
  return [...OPENCODE_ALWAYS_DENIED, ...OPENCODE_NONE_DENIED];
}

/** The agent's rules, in the order the evaluator needs: the ask-on-all rule,
 *  then the identity's denies. OpenCode appends these after its own base
 *  policy (`packages/core/src/config/plugin/agent.ts:118-120`) and judges by
 *  the LAST matching rule (`findLast`), and `*` matches every action — so the
 *  ask must come first: a deny that follows it is the last word for its
 *  action and hides the tool (`packages/core/src/tool.ts:278-281`), while an
 *  ask that followed the denies would be the last word for everything and
 *  un-hide them. The rules go on the agent so a session created without any
 *  is still gated; a session may repeat them. */
export function openCodePermissionRules(identity: Identity): OpenCodePermissionRule[] {
  return [
    ASK_ALL_RULE,
    ...openCodeDeniedActions(identity).map((action) => ({ action, resource: "*", effect: "deny" as const })),
  ];
}

/** The built-in tools a run's identity gives its OpenCode: what the deny rules leave visible. */
export function openCodeBuiltinToolsFor(identity: Identity): readonly string[] {
  if (identity === "write") return OPENCODE_BUILTIN_TOOLS;
  if (identity === "read") return OPENCODE_READ_TOOLS;
  return OPENCODE_NO_TOOLS;
}

/** The thresholds a deployment may set on OpenCode's compaction, under
 *  OpenCode's own words (`packages/schema/src/config/compaction.ts`): `buffer`,
 *  the tokens kept free of the window before a compaction runs; `keepTokens`,
 *  how much of the newest turns it keeps. Unset, OpenCode's defaults stand. */
export interface OpenCodeCompactionConfig {
  buffer?: number;
  keepTokens?: number;
}

export interface OpenCodeLaunchSpec {
  runId: string;
  paths: OpenCodeRunPaths;
  /** The resolved model and the provider's wire shape — the proxy route the server calls.
   *  `contextTokens` is the model's window, which OpenCode compacts against; absent,
   *  `OPENCODE_DEFAULT_CONTEXT_TOKENS` stands and the compaction timing is a guess. */
  model: { id: string; providerType: ProviderConfig["type"]; maxTokens: number; contextTokens?: number };
  /** The bot's base URL as the server reaches it: the public one from a run's container, the bot's loopback from the bot host. */
  harnessUrl: string;
  identity: Identity;
  /** The composed system prompt the dispatcher would hand the native loop. */
  system: string;
  /** The harness's own tools the plugin will register, so the prompt can name them. */
  relayTools: readonly string[];
  /** The run's resolved model card (record 0052): what the configuration says
   *  of the model — `limit.context` from the window, `capabilities.input` from
   *  the inputs, one `variants` entry per tier whose `body` overlay spells the
   *  wire's word, the cap field — in place of the invented one. Absent (a
   *  hand-built spec), the defaults stand and no variants are declared. */
  card?: ModelCard;
  compaction?: OpenCodeCompactionConfig;
}

/** The provider package for the run's wire shape: both map onto providers the
 *  binary bundles (`packages/core/src/aisdk-native.ts:98-119`;
 *  `@ai-sdk/anthropic` 3.0.82 and `@ai-sdk/openai-compatible` 2.0.41 are
 *  `packages/core` dependencies), so nothing is installed at runtime. */
export function openCodeProviderPackage(providerType: ProviderConfig["type"]): string {
  return providerType === "anthropic" ? "aisdk:@ai-sdk/anthropic" : "aisdk:@ai-sdk/openai-compatible";
}

/** The proxy as the provider's base URL: both native providers hang their
 *  route under it — `/messages` on the Anthropic shape, `/chat/completions`
 *  on the OpenAI shape (measured against a logging fake) — and the proxy
 *  serves `/v1/messages` and `/v1/chat/completions`, so the base is `<bot>/v1`
 *  for either. */
export function openCodeProviderBaseUrl(harnessUrl: string): string {
  return `${harnessUrl.replace(/\/$/, "")}/v1`;
}

/** The card's effort tiers as the model's `variants` (record 0052): one entry
 *  per tier the card does not refuse, the tier as the variant's id — the word
 *  a session selects the tier by (`model.variant`; the harness's `effort()`
 *  answers the tier itself) — and a `body` overlay that spells the wire's own
 *  word for it, so the word on the wire is the card's and never one the
 *  harness chose: `reasoning_effort` on the completions dialect;
 *  `output_config.effort` with adaptive thinking on the Anthropic dialect,
 *  where only a model that takes adaptive thinking carries an effort word at
 *  all (a budget model has no word to spell, so it gets no variants and the
 *  tier is left to the provider's default). Unknown levels are the identity
 *  map — the asked tier's own word, unvouched, never a silent clamp. */
export function openCodeVariants(
  model: { id: string; providerType: ProviderConfig["type"] },
  card: ModelCard | undefined,
): Array<{ id: string; body: Record<string, unknown> }> | undefined {
  if (card === undefined) return undefined;
  const anthropic = model.providerType === "anthropic";
  if (anthropic && !takesAdaptiveThinking(model.id)) return undefined;
  const variants: Array<{ id: string; body: Record<string, unknown> }> = [];
  for (const tier of EFFORT_LEVELS) {
    const level = card.levels === "unknown" ? undefined : card.levels[tier];
    if (level === "refused") continue;
    const word = level === undefined ? tier : level.word;
    variants.push({
      id: tier,
      body: anthropic
        ? { thinking: { type: "adaptive" }, output_config: { effort: word } }
        : { reasoning_effort: word },
    });
  }
  return variants.length > 0 ? variants : undefined;
}

/** The variant a run's tier selects on the session's model ref: the tier
 *  itself, exactly when the configuration declares it (`openCodeVariants`), so
 *  a session never names a variant the document does not carry. */
export function openCodeVariantId(
  effort: Effort | undefined,
  model: { id: string; providerType: ProviderConfig["type"] },
  card: ModelCard | undefined,
): string | undefined {
  if (effort === undefined) return undefined;
  return openCodeVariants(model, card)?.some((v) => v.id === effort) ? effort : undefined;
}

/** What the system prompt gains under OpenCode: the workspace tools are
 *  OpenCode's own, under its names — the ones the run's identity holds — and
 *  the rest of the run's tools keep theirs. Said once and last, as pi's note
 *  is, so a prompt written for the native loop's names lands on a tool that
 *  exists. */
export function openCodePromptNote(relayTools: readonly string[], identity: Identity): string {
  const named = relayTools.map((t) => `\`${t}\``).join(", ");
  if (identity === "none") {
    return [
      "HARNESS NOTE: this run has no workspace, so none of OpenCode's own tools (`read`, `shell`, `edit`, `write`, `glob`, `grep` and `skill`) is available, and a call to any of them is refused.",
      relayTools.length > 0
        ? `This run's tools are exactly these, each under its own name: ${named}.`
        : "No tools are available in this run.",
    ].join(" ");
  }
  const write = identity === "write";
  return [
    write
      ? "HARNESS NOTE: this run's workspace tools are OpenCode's own — `read`, `shell`, `edit`, `write`, `glob`, `grep` and `skill`, all running in the worktree."
      : "HARNESS NOTE: this run's workspace tools are OpenCode's own — `read`, `shell`, `glob`, `grep` and `skill`, all running in the worktree; it has no `edit` and no `write`: the run is read-only, and a call to either is refused.",
    write
      ? "Where these instructions say `read_file` use `read`; where they say `write_file` use `write` (a whole file) or `edit` (a targeted change); where they say `bash` use `shell`."
      : "Where these instructions say `read_file` use `read`; where they say `bash` use `shell`.",
    relayTools.length > 0
      ? `Every other tool named above is available under its own name: ${named}.`
      : "No other tools are available in this run.",
  ].join(" ");
}

/** The agent's system prompt: the dispatcher's composed prompt, then the harness note. */
export function openCodeSystemPrompt(spec: OpenCodeLaunchSpec): string {
  return `${spec.system.trimEnd()}\n\n${openCodePromptNote(spec.relayTools, spec.identity)}\n`;
}

/** The run's configuration as the object the file holds (`packages/schema/src/config.ts`):
 *  the proxy as the one provider, its key the bearer's variable interpolated by
 *  OpenCode at load (`packages/core/src/config/variable.ts:27-33`; a provider with
 *  `settings.apiKey` needs no credential-store entry,
 *  `packages/core/src/model-resolver.ts:262`) and a zero rate card because the
 *  proxy meters — the entry the run's card (record 0052): `limit.context` from
 *  the card's window, `capabilities.input` from its inputs, one `variants`
 *  entry per tier with the wire's word (`openCodeVariants`), the cap field as
 *  `compatibility.maxTokensField` on the completions dialect; that model as the default; the `switchboard` agent as the
 *  default agent, primary, with the composed prompt and the gate's rules; the
 *  `title` agent removed (`packages/core/src/config/plugin/agent.ts:97-100`), or
 *  every session's first prompt spends one more model call — a proxy turn — on a
 *  title (`packages/core/src/session/context.ts:96-98`); the relay plugin's
 *  directory; every phone-home off (`update`, `share`), no snapshots (the
 *  worktree is Switchboard's), no language servers and no formatters (both keys
 *  take `false`: `packages/schema/src/config/lsp.ts:19`, `formatter.ts:14`); and
 *  the compaction thresholds when the deployment sets them. */
export function openCodeConfig(spec: OpenCodeLaunchSpec): Record<string, unknown> {
  const { id, maxTokens, providerType, contextTokens } = spec.model;
  const card = spec.card;
  const compaction = {
    ...(spec.compaction?.buffer !== undefined ? { buffer: spec.compaction.buffer } : {}),
    ...(spec.compaction?.keepTokens !== undefined ? { keep: { tokens: spec.compaction.keepTokens } } : {}),
  };
  const variants = openCodeVariants(spec.model, card);
  // The cap field the completions dialect spells the output cap with, the
  // card's word when it is one the schema takes (`compatibility.maxTokensField`
  // knows the two chat spellings; the Anthropic dialect's cap is always
  // `max_tokens` and the Responses route is a later slice's).
  const capField =
    providerType !== "anthropic" && (card?.capField === "max_completion_tokens" || card?.capField === "max_tokens")
      ? card.capField
      : undefined;
  return {
    providers: {
      [PROXY_PROVIDER]: {
        name: "Switchboard model proxy",
        package: openCodeProviderPackage(providerType),
        settings: { baseURL: openCodeProviderBaseUrl(spec.harnessUrl), apiKey: `{env:${RUN_BEARER_ENV}}` },
        models: {
          [id]: {
            name: id,
            limit: { context: card?.window ?? contextTokens ?? OPENCODE_DEFAULT_CONTEXT_TOKENS, output: maxTokens },
            ...(card !== undefined
              ? {
                  capabilities: {
                    tools: true,
                    input: card.inputs.image === false ? ["text"] : ["text", "image"],
                    output: ["text"],
                  },
                }
              : {}),
            ...(variants !== undefined ? { variants } : {}),
            ...(capField !== undefined ? { compatibility: { maxTokensField: capField } } : {}),
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    },
    model: `${PROXY_PROVIDER}/${id}`,
    default_agent: OPENCODE_AGENT,
    agents: {
      [OPENCODE_AGENT]: {
        mode: "primary",
        system: openCodeSystemPrompt(spec),
        permissions: openCodePermissionRules(spec.identity),
      },
      title: { disabled: true },
    },
    plugins: [OPENCODE_PLUGIN_REF],
    update: "disable",
    share: "disabled",
    snapshots: false,
    lsp: false,
    formatter: false,
    ...(Object.keys(compaction).length > 0 ? { compaction } : {}),
  };
}

/** The configuration file's text. Never a secret: the key is the variable's name. */
export function openCodeConfigJson(spec: OpenCodeLaunchSpec): string {
  return JSON.stringify(openCodeConfig(spec), null, 2) + "\n";
}

/** The relay plugin's module until the relay lands: a valid plugin
 *  (`packages/core/src/plugin/module.ts:60-73`: a default export with an id and a
 *  setup) that registers nothing, so the configuration's reference names a
 *  directory that loads and the server logs no failure. The relay unit
 *  replaces this text with the tool that speaks the bot's protocol. */
export const OPENCODE_PLUGIN_PLACEHOLDER = `// Switchboard's OpenCode plugin. Written into the run's directory by the bot
// before the server starts. This build registers nothing here: the relayed
// tools arrive with the relay.
export default { id: "switchboard", async setup() {} };
`;

export interface OpenCodeFile {
  path: string;
  content: string;
}

/** Every file the container must hold before the server starts, none of them a
 *  secret: the configuration, the relay plugin (the tool that speaks the bot's
 *  protocol; U12's `OPENCODE_PLUGIN_SOURCE`), the tailer. */
export function openCodeLaunchFiles(spec: OpenCodeLaunchSpec): OpenCodeFile[] {
  return [
    { path: spec.paths.config, content: openCodeConfigJson(spec) },
    { path: spec.paths.plugin, content: OPENCODE_PLUGIN_SOURCE },
    { path: spec.paths.tailerScript, content: OPENCODE_TAILER_SOURCE },
  ];
}

/** `opencode serve` on loopback, on the port the seam picks (`PORT_ARG`): a
 *  server started without `--port` scans upward from 4096
 *  (`packages/server/src/process.ts:150-153`), so the port is always passed. */
export function openCodeLaunchArgs(): string[] {
  return ["serve", "--hostname", "127.0.0.1", "--port", PORT_ARG];
}

/** The server's password for one run: the bearer's hash (`bearerHashOf`), so it
 *  is per run and random because the bearer is, derivable by a later generation
 *  from the row's `bearerHash` alone — which holds no bearer — and worth nothing
 *  at the proxy or the bot's door; a bearer of another shape, which no row can
 *  name, gets a random password and no re-attach, pi's rule for it. */
export function openCodePassword(bearer: string): string {
  return bearerHashOf(bearer) ?? randomBytes(24).toString("base64url");
}

/** The server's environment beyond what the executor's shell already has: the
 *  bearer under the name the configuration interpolates, the bot's URL for the
 *  plugin, the run's id, the four XDG roots under the run (every global path
 *  OpenCode has, `packages/util/src/global-roots.ts:5-8`; `HOME` is left the
 *  container user's, so the model's shell sees the same `~/.gitconfig`,
 *  `~/.npmrc` and the rest that pi's shell sees), the one configuration document with the
 *  project's own configuration disabled under both names the server reads
 *  (`packages/cli/src/server-process.ts:107-109`: the first wins when both are
 *  set), the models catalogue and the update check off, the store in memory,
 *  and the password. Nothing of the bot's own environment: no provider key
 *  reaches this record, whatever the bot holds. The bearer is revealed here
 *  into the env record and nowhere else. */
export function openCodeLaunchEnv(spec: OpenCodeLaunchSpec, bearer: string, password: string): Record<string, string> {
  const { paths } = spec;
  return {
    [RUN_BEARER_ENV]: bearer,
    [HARNESS_URL_ENV]: spec.harnessUrl,
    SWITCHBOARD_RUN_ID: spec.runId,
    XDG_DATA_HOME: paths.xdg.data,
    XDG_CONFIG_HOME: paths.xdg.config,
    XDG_CACHE_HOME: paths.xdg.cache,
    XDG_STATE_HOME: paths.xdg.state,
    OPENCODE_CONFIG: paths.config,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DB: ":memory:",
    [OPENCODE_PASSWORD_ENV]: password,
  };
}

/** The tailer's environment: the password for the server's auth and the
 *  server's pid to watch; the port rides the seam's own variable
 *  (`HARNESS_PORT_ENV`), since the start names it. */
export function openCodeTailerEnv(password: string, servePid: number): Record<string, string> {
  return { [OPENCODE_PASSWORD_ENV]: password, [OPENCODE_SERVE_PID_ENV]: String(servePid) };
}

/** The keys of the loaded document the readiness holds against what was
 *  written — the ones that carry the clauses: the provider (credential), the
 *  agent and its default (gate, identity), the title agent gone (the proxy's
 *  turn count), the plugin (relay), and the four phone-home and side-effect
 *  switches. A key OpenCode dropped as mistyped is absent from the echo. */
export function configProblem(info: Record<string, unknown>, spec: OpenCodeLaunchSpec): string | undefined {
  const providers = info.providers as Record<string, unknown> | undefined;
  const agents = info.agents as Record<string, Record<string, unknown>> | undefined;
  if (typeof providers?.[PROXY_PROVIDER] !== "object") return `providers.${PROXY_PROVIDER} did not take`;
  if (info.default_agent !== OPENCODE_AGENT) return `default_agent is not ${OPENCODE_AGENT}`;
  if (typeof agents?.[OPENCODE_AGENT] !== "object") return `agents.${OPENCODE_AGENT} did not take`;
  if (agents?.title?.disabled !== true) return "agents.title.disabled did not take";
  if (!Array.isArray(info.plugins) || !info.plugins.includes(OPENCODE_PLUGIN_REF)) return "plugins did not take";
  if (info.update !== "disable") return "update is not disable";
  if (info.share !== "disabled") return "share is not disabled";
  if (info.snapshots !== false) return "snapshots is not false";
  if (info.lsp !== false) return "lsp is not false";
  if (info.formatter !== false) return "formatter is not false";
  if (spec.compaction && Object.keys(spec.compaction).length > 0 && typeof info.compaction !== "object")
    return "compaction did not take";
  return undefined;
}

/** The document the server loaded from the run's file, among the entries it lists; nothing when it is not there. */
export function loadedDocument(
  entries: OpenCodeConfigEntry[],
  configPath: string,
): Record<string, unknown> | undefined {
  const document = entries.find((e) => e.type === "document" && e.path === configPath);
  return document && document.type === "document" ? document.info : undefined;
}

/** Thrown when the run's server did not become ready: which step refused it
 *  and why, by name — the health that never answered in time, a password the
 *  server refused, a version on PATH other than the pin, a configuration key
 *  that did not take, a plugin activation that failed — with the server's
 *  stderr tail when it has one. Never quotes a body that could carry the bearer. */
export class OpenCodeNotReadyError extends Error {
  constructor(
    readonly reason: string,
    stderr: string,
  ) {
    super(`opencode serve is not ready: ${reason}${stderr.trim() ? ` (stderr: ${stderr.trim().slice(-600)})` : ""}`);
    this.name = "OpenCodeNotReadyError";
  }
}

export interface OpenCodeLaunchDeps {
  container: HarnessContainer;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  /** Between two readiness probes; the seam's default otherwise. */
  pollMs?: number;
  /** The bound on readiness; the seam's default otherwise. */
  readyMs?: number;
}

/** What a launch answers: the server's pid (the wrapper's, the group it runs
 *  in) and its loopback port — the row's facts — the tailer's pid, the
 *  password the requests carry, the paths the files went to (the root the
 *  container made), and the version the health answered. */
export interface OpenCodeStarted {
  pid: number;
  port: number;
  tailerPid: number;
  password: string;
  paths: OpenCodeRunPaths;
  version: string;
  /** The feed byte after the tailer's `connected` note: the first `logOffset` the row carries. */
  feedOffset: number;
}

/** The launch: the root the container makes for the run, the files, the
 *  server on a free loopback port with the environment above, readiness —
 *  `GET /api/health` with the password answering 200 with the pin's version
 *  within the bound (a 401 is the password refused, a version off the pin is
 *  a binary this build does not drive, a server that exited is its stderr;
 *  each a named failure at once), then `GET /api/config` echoing the run's
 *  document with every clause-carrying key present, then plugin activation
 *  settled — and the tailer started beside it, its stdout the feed. */
export async function launchOpenCode(
  deps: OpenCodeLaunchDeps,
  spec: OpenCodeLaunchSpec,
  bearer: string,
): Promise<OpenCodeStarted> {
  const { container, clock, sleep } = deps;
  const pollMs = deps.pollMs ?? OPENCODE_READY_POLL_MS;
  const readyMs = deps.readyMs ?? OPENCODE_READY_MS;
  const root = await container.makeRoot(spec.paths.dir);
  const paths = root === spec.paths.dir ? spec.paths : openCodeRunPathsAt(root);
  const placed: OpenCodeLaunchSpec = { ...spec, paths };
  for (const file of openCodeLaunchFiles(placed)) await container.writeFile(file.path, file.content);
  const password = openCodePassword(bearer);
  const started = await container.start({
    paths,
    command: OPENCODE_BIN,
    args: openCodeLaunchArgs(),
    env: openCodeLaunchEnv(placed, bearer, password),
    port: "free",
  });
  if (started.port === undefined)
    throw new HarnessContainerError("start", "the start answered no port for opencode serve");
  const { pid, port } = started;
  const auth = { Authorization: openCodeAuthHeader(password) };
  const request = (route: { method: string; path: string }): Promise<HarnessResponse> =>
    container.request(paths, { method: route.method, port, path: route.path, secretHeaders: auth });
  const notReady = async (reason: string, errLog = paths.errLog) =>
    new OpenCodeNotReadyError(reason, await container.tail(errLog, READY_TAIL_BYTES));

  const startedAt = clock();
  const deadline = startedAt + readyMs;
  let last = "no answer yet";
  let version: string | undefined;
  // A server that answered any status is alive: the pid is probed only before
  // the first request and after a request that reached no server, and the
  // poll backs off once the first second has passed — on the exec classes
  // every probe and every request is one command.
  let probePid = true;
  let poll = pollMs;
  while (version === undefined) {
    if (probePid && !(await container.alive(pid)))
      throw await notReady("the server exited before it answered its health");
    let res: HarnessResponse | undefined;
    try {
      res = await request(OPENCODE_ROUTES["health.get"]);
      probePid = false;
    } catch (err) {
      if (isContainerGone(err)) throw err;
      last = err instanceof Error ? err.message : String(err);
      probePid = true;
    }
    if (res) {
      if (res.status === 401) throw await notReady("the server refused the run's password");
      // 500 is the server's own word for a start that failed (`packages/server/src/process.ts:214-224`): nothing to poll for.
      if (res.status === 500) throw await notReady("the server reported that its start failed (health answered 500)");
      if (res.status === 200) {
        const health = parseHealth(res.body);
        if (!health) throw await notReady("the health answered something that is not the health shape");
        if (health.version !== OPENCODE_VERSION)
          throw await notReady(`the opencode on PATH is ${health.version}; this build drives ${OPENCODE_VERSION}`);
        version = health.version;
        break;
      }
      last = `the health answered ${res.status}`;
    }
    if (clock() >= deadline)
      throw await notReady(`the server did not answer its health within ${readyMs} ms (${last})`);
    await sleep(poll);
    if (clock() - startedAt >= 1000) poll = Math.min(OPENCODE_READY_POLL_MAX_MS, poll * 2);
  }

  const config = await request(OPENCODE_ROUTES["config.get"]);
  if (config.status !== 200) throw await notReady(`the configuration route answered ${config.status}`);
  const entries = parseConfigEntries(config.body);
  if (!entries) throw await notReady("the configuration route answered something that is not the entry list");
  const info = loadedDocument(entries, paths.config);
  if (!info) throw await notReady("the server did not load the run's configuration file");
  const problem = configProblem(info, placed);
  if (problem) throw await notReady(`the run's configuration ${problem}`);

  const activation = await request(OPENCODE_ROUTES["plugin.awaitActivation"]);
  if (activation.status < 200 || activation.status >= 300)
    throw await notReady(`plugin activation answered ${activation.status}`);

  const tailer = await container.start({
    paths: paths.tailer,
    command: TAILER_BIN,
    args: [paths.tailerScript],
    env: openCodeTailerEnv(password, pid),
    port,
    // The feed is read by offset and a later generation may restart the
    // tailer over it: its log is never truncated by a start.
    keepLog: true,
  });
  // Readiness ends when the tailer is subscribed, not when it is started: the
  // first session's earliest events — its creation, its first step, a
  // first-step ask — would otherwise be emitted before anyone listens, and the
  // step-end refill repairs messages, never asks. The end of the tailer's
  // `connected` note is the feed byte the row starts reading from.
  let feedOffset: number | undefined;
  poll = pollMs;
  while (feedOffset === undefined) {
    const text = Buffer.from(await container.readLog(paths.feed, 0, LOG_READ_BYTES)).toString("utf8");
    let consumed = 0;
    for (const line of text.split("\n").slice(0, -1)) {
      consumed += Buffer.byteLength(line, "utf8") + 1;
      const record = parseFeedRecord(line);
      if (record?.feed === "tailer" && record.note === "connected") {
        feedOffset = consumed;
        break;
      }
    }
    if (feedOffset !== undefined) break;
    if (!(await container.alive(tailer.pid)))
      throw await notReady("the tailer exited before it connected to the event stream", paths.tailer.errLog);
    if (clock() >= deadline)
      throw await notReady(`the tailer did not connect to the event stream within ${readyMs} ms`, paths.tailer.errLog);
    await sleep(poll);
    if (clock() - startedAt >= 1000) poll = Math.min(OPENCODE_READY_POLL_MAX_MS, poll * 2);
  }
  return { pid, port, tailerPid: tailer.pid, password, paths, version, feedOffset };
}

/** What a run's row remembers about its OpenCode (`OpenCodeHarnessFacts`): the
 *  launch's pid and port and root, the session the conversation opened, the
 *  feed byte the ledger's effect reaches, the bearer's hash (never the
 *  bearer), the container's word, and the loop's relaunch count. */
export function openCodeFacts(
  started: Pick<OpenCodeStarted, "pid" | "port" | "paths" | "tailerPid">,
  run: { sessionID: string; logOffset: number; bearer?: string; container?: string; relaunches: number },
): OpenCodeHarnessFacts {
  const bearerHash = run.bearer === undefined ? undefined : bearerHashOf(run.bearer);
  return {
    harness: "opencode",
    pid: started.pid,
    port: started.port,
    tailerPid: started.tailerPid,
    logOffset: run.logOffset,
    sessionID: run.sessionID,
    root: started.paths.dir,
    relaunches: run.relaunches,
    ...(bearerHash === undefined ? {} : { bearerHash }),
    ...(run.container === undefined ? {} : { container: run.container }),
  };
}
