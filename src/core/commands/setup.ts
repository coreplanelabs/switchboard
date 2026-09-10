import { z } from "zod";
import type { Prompter } from "../../setup/host.js";
import {
  CONFIG_PATH,
  ENV_PATH,
  maskedPreview,
  planInit,
  type InitAnswers,
  type InitPlan,
  type InitTemplates,
  type PlannedFile,
  PROFILE_PATH,
} from "../../setup/plan.js";
import type { Capabilities } from "../capabilities.js";
import {
  CommandError,
  commandDefiner,
  flag,
  type CommandDef,
  type CommandRegistry,
  type JsonValue,
} from "../commandRegistry.js";
import { deployInit, type DeployCommandDeps } from "./deploy.js";

// `setup init` — the one-command installer, `switchboard init` on the CLI
// (docs/reference/specs/init.md). From an empty directory to a runnable local
// loop: `.env` and `config/config.yaml` derived from the checked-in examples
// with the values the operator gives, and — with a Cloudflare account and a
// zone — `deploy/profile.json` plus every Worker's `wrangler.jsonc`, rendered
// by the registry's own `deploy init`. Flags first; a prompt only for what a
// flag did not give and only when the host has a terminal (`deps.setup.prompt`
// is undefined otherwise, and a missing answer is a refusal). The planning is
// pure (src/setup/plan.ts); the disk is `deps.setup` (src/setup/host.ts). CLI
// only: it writes the operator's working directory and reads their terminal.
// Secrets go into `.env` at mode 600 and appear in no output — the dry-run
// preview masks them.

export interface SetupCommandDeps {
  setup: {
    /** The three examples from the package (src/setup/host.ts `readTemplates`). */
    templates(): Promise<InitTemplates>;
    /** Whether a path exists under the working directory. */
    exists(path: string): Promise<boolean>;
    /** Write one planned file under the working directory at its mode. */
    write(file: PlannedFile): Promise<void>;
    /** A file the operator named (`--github-private-key-file`), from the working directory; undefined when absent. */
    readFile(path: string): Promise<string | undefined>;
    /** True when the working directory is the repository root — where the profile and `deploy/` live. */
    inCheckout(): boolean;
    /** The installation directory, when it is not the one the operator stands in (`~/.switchboard`,
     *  `SWITCHBOARD_HOME`): `init` names it so nobody hunts for the files. Undefined when they are here. */
    root(): string | undefined;
    /** `project.json`'s `image` — what the next commands run outside a checkout. */
    image(): string;
    /** The published npm package this CLI runs from, when it does — the next `ask` is that package's; undefined in a checkout or the image. */
    package(): string | undefined;
    env: Record<string, string | undefined>;
    /** How to ask for a missing answer; undefined when there is no terminal. */
    prompt?: Prompter;
  };
}

const defineCommand = commandDefiner<SetupCommandDeps & DeployCommandDeps>();

const secret = z.string().min(1);
const digits = z.string().regex(/^\d+$/, "expected a number");
/** A Worker script name: the bot's name, `<name>-memory` for the state Worker. */
const workerName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "expected a Worker name: lowercase letters, digits, hyphens");
const hostname = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "expected a bare DNS name (example.com)");
const httpUrl = z.string().regex(/^https?:\/\/\S+$/, "expected an http(s) URL");
const account = z.string().regex(/^[0-9a-f]{32}$/, "expected a Cloudflare account id: 32 hex characters");

const initOptions = z.object({
  organization: z
    .string()
    .min(1)
    .optional()
    .describe("the GitHub organization (or user) this installation serves — config.yaml's `organization`"),
  anthropicKey: secret.optional().describe("an Anthropic API key → ANTHROPIC_API_KEY and the `anthropic` provider"),
  openaiCompatible: httpUrl
    .optional()
    .describe(
      "an OpenAI-compatible endpoint's base URL (https://api.openai.com/v1, http://localhost:11434/v1) → the `openai` provider",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("with --openai-compatible: the model every agent runs on at that endpoint (openai/<model>)"),
  modelKey: secret
    .optional()
    .describe("with --openai-compatible: the endpoint's key → OPENAI_API_KEY (a local endpoint needs none)"),
  slackAppToken: secret.optional().describe("the Slack app-level token (xapp-…) → SLACK_APP_TOKEN"),
  slackBotToken: secret.optional().describe("the Slack bot token (xoxb-…) → SLACK_BOT_TOKEN"),
  githubAppId: digits.optional().describe("the GitHub App's id → GITHUB_APP_ID"),
  githubInstallationId: digits.optional().describe("the GitHub App's installation id → GITHUB_APP_INSTALLATION_ID"),
  githubPrivateKeyFile: z
    .string()
    .min(1)
    .optional()
    .describe("path to the GitHub App's private key (PEM) → GITHUB_APP_PRIVATE_KEY, one quoted line"),
  cloudflare: account
    .optional()
    .describe(
      "a Cloudflare account id: also write deploy/profile.json and render the Worker configs (needs --zone; from a checkout's root, or anywhere when this CLI is the published package)",
    ),
  zone: hostname.optional().describe("with --cloudflare: the zone the Worker hostnames live under"),
  name: workerName
    .optional()
    .describe("the Worker name stem: <name> is the bot, <name>-memory the state Worker (default switchboard)"),
  force: flag.optional().describe("replace .env, config/config.yaml or deploy/profile.json when one already exists"),
  dryRun: flag.optional().describe("write nothing; print each file as it would be written, secrets masked"),
});

const DEFAULT_NAME = "switchboard";

interface InitOutput {
  dryRun: boolean;
  /** Where the files went, when not the current directory. */
  root?: string;
  files: { path: string; mode: string; status: "planned" | "written" | "replaced"; preview?: string }[];
  providers: string[];
  capabilities: Capabilities;
  /** `deploy init`'s own output, when a profile was written (never under --dry-run). */
  workerConfigs?: JsonValue;
  next: string[];
}

export const setupInit = defineCommand({
  id: "setup.init",
  options: initOptions,
  action: "setup:write",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "The one-command installer: write .env (mode 600) and config/config.yaml from the checked-in examples with the values given — flags first, prompts only on a terminal — and, with --cloudflare and --zone, deploy/profile.json plus every Worker's wrangler.jsonc; then load the config and say what is on and what to run next. Refuses to overwrite without --force; --dry-run writes nothing and previews with secrets masked, existing files or not.",
  render: (output) => {
    const o = output as unknown as InitOutput;
    const where = o.root ? ` to ${o.root}` : "";
    const lines = [o.dryRun ? `would write${where}:` : `wrote${where}:`];
    for (const f of o.files)
      lines.push(
        `  ${f.path.padEnd(22)}${f.mode === "600" ? "(mode 600)" : ""}${f.status === "replaced" ? " (replaced)" : ""}`.trimEnd(),
      );
    lines.push(`providers: ${o.providers.join(", ")}`, `capabilities: ${capabilityLine(o.capabilities)}`);
    if (o.workerConfigs !== undefined) lines.push(deployInit.render!(o.workerConfigs));
    lines.push("next:", ...o.next.map((c) => `  ${c}`));
    if (o.dryRun) for (const f of o.files) lines.push("", `--- ${f.path} ---`, (f.preview ?? "").trimEnd());
    return lines.join("\n");
  },
  handler: async ({ options, deps, caller, span }) => {
    const answers = await gatherAnswers(options, deps.setup);
    const templates = await deps.setup.templates();
    const paths = [ENV_PATH, CONFIG_PATH, PROFILE_PATH];
    const existing = new Set<string>();
    for (const p of paths) if (await deps.setup.exists(p)) existing.add(p);
    const dryRun = options.dryRun ?? false;
    const plan: InitPlan = planInit(answers, templates, {
      existing,
      // A dry run writes nothing, so an existing file is no conflict: it previews either way; `--force` matters to a real write only.
      force: (options.force ?? false) || dryRun,
      inCheckout: deps.setup.inCheckout(),
      env: deps.setup.env,
      image: deps.setup.image(),
      ...(deps.setup.package() !== undefined ? { package: deps.setup.package() } : {}),
    });
    if (!plan.ok) throw new CommandError(plan.code, plan.problems.join("\n"));
    const root = deps.setup.root();
    const output: InitOutput = {
      dryRun,
      ...(root !== undefined ? { root } : {}),
      files: plan.files.map((f) => ({
        path: f.path,
        mode: f.mode.toString(8),
        status: dryRun ? "planned" : existing.has(f.path) ? "replaced" : "written",
        ...(dryRun ? { preview: maskedPreview(f) } : {}),
      })),
      providers: plan.providers,
      capabilities: plan.capabilities,
      next: plan.next,
    };
    if (dryRun) return output as unknown as JsonValue;
    for (const f of plan.files) await deps.setup.write(f);
    // The profile is on disk: render the Worker configs the way `deploy init`
    // does — the registry function itself, with the same deps it is bound to.
    if (plan.profile)
      output.workerConfigs = await deployInit.handler({
        args: {},
        options: {},
        caller,
        deps,
        ...(span ? { span } : {}),
      });
    return output as unknown as JsonValue;
  },
});

const ASK = {
  organization: "GitHub organization (or user) this installation serves: ",
  anthropicKey: "Anthropic API key (empty to use an OpenAI-compatible endpoint instead): ",
  openaiCompatible: "OpenAI-compatible base URL (e.g. https://api.openai.com/v1, http://localhost:11434/v1): ",
  model: "Model every agent runs on at that endpoint: ",
  modelKey: "API key for that endpoint (empty for a local endpoint): ",
  slackAppToken: "Slack app-level token, xapp-… (empty to skip Slack for now): ",
  /** Asked when the other Slack token was given: the pair is incomplete, so no "empty skips". */
  slackAppTokenMissing: "Slack app-level token, xapp-…: ",
  slackBotToken: "Slack bot token, xoxb-…: ",
} as const;

/**
 * Flags first; a prompt only for what is missing among the answers a local
 * loop needs — the organization, one provider, and Slack: both tokens when
 * neither was given (an empty app token skips Slack), the missing one when
 * only one was — and only when there is a prompt. The GitHub App and Cloudflare are flags only: both need values
 * copied from another screen, which a prompt does not make easier. Without a
 * prompt, a missing organization or provider is `invalid_input` naming the flag.
 */
async function gatherAnswers(o: z.output<typeof initOptions>, setup: SetupCommandDeps["setup"]): Promise<InitAnswers> {
  const ask = setup.prompt;
  const given = <T>(v: T | undefined): v is T => v !== undefined;
  const nonEmpty = (v: string): string | undefined => (v === "" ? undefined : v);

  let organization = o.organization;
  if (!given(organization) && ask) organization = nonEmpty(await ask(ASK.organization, { secret: false }));
  if (!given(organization))
    throw new CommandError(
      "invalid_input",
      "--organization is required: the GitHub organization (or user) this installation serves",
    );

  let { anthropicKey, openaiCompatible, model, modelKey, slackAppToken, slackBotToken } = o;
  if (!given(anthropicKey) && !given(openaiCompatible) && ask) {
    anthropicKey = nonEmpty(await ask(ASK.anthropicKey, { secret: true }));
    if (!given(anthropicKey)) {
      openaiCompatible = nonEmpty(await ask(ASK.openaiCompatible, { secret: false }));
      if (given(openaiCompatible)) {
        if (!given(model)) model = nonEmpty(await ask(ASK.model, { secret: false }));
        if (!given(modelKey)) modelKey = nonEmpty(await ask(ASK.modelKey, { secret: true }));
      }
    }
  }
  if (ask && !given(slackAppToken) && !given(slackBotToken))
    slackAppToken = nonEmpty(await ask(ASK.slackAppToken, { secret: true }));
  // Half a pair is never refused on a terminal: the missing token is asked for, whichever it is.
  if (ask && given(slackAppToken) && !given(slackBotToken))
    slackBotToken = nonEmpty(await ask(ASK.slackBotToken, { secret: true }));
  if (ask && given(slackBotToken) && !given(slackAppToken))
    slackAppToken = nonEmpty(await ask(ASK.slackAppTokenMissing, { secret: true }));

  let githubPrivateKey: string | undefined;
  if (given(o.githubPrivateKeyFile)) {
    githubPrivateKey = await setup.readFile(o.githubPrivateKeyFile);
    if (githubPrivateKey === undefined)
      throw new CommandError("not_found", `--github-private-key-file: no such file ${o.githubPrivateKeyFile}`);
  }

  return {
    organization,
    name: o.name ?? DEFAULT_NAME,
    ...(given(anthropicKey) ? { anthropicKey } : {}),
    ...(given(openaiCompatible) ? { openaiCompatible } : {}),
    ...(given(model) ? { model } : {}),
    ...(given(modelKey) ? { modelKey } : {}),
    ...(given(slackAppToken) ? { slackAppToken } : {}),
    ...(given(slackBotToken) ? { slackBotToken } : {}),
    ...(given(o.githubAppId) ? { githubAppId: o.githubAppId } : {}),
    ...(given(o.githubInstallationId) ? { githubInstallationId: o.githubInstallationId } : {}),
    ...(given(githubPrivateKey) ? { githubPrivateKey } : {}),
    ...(given(o.cloudflare) ? { cloudflare: o.cloudflare } : {}),
    ...(given(o.zone) ? { zone: o.zone } : {}),
  };
}

/** One line of what is on: `execution local · github on · memory off · …`, in the contract's axis order. */
function capabilityLine(c: Capabilities): string {
  const onOff = (v: boolean) => (v ? "on" : "off");
  return [
    `execution ${c.execution}`,
    `github ${onOff(c.github)}`,
    `memory ${onOff(c.memory)}`,
    `run history ${onOff(c.runHistory)}`,
    `run ledger ${onOff(c.runLedger)}`,
    `mcp ${onOff(c.mcp)}`,
    `costs ${onOff(c.costs)}`,
    `schedules ${onOff(c.schedules)}`,
    `ingress ${onOff(c.ingress)}`,
    `residents ${onOff(c.residents)}`,
    `dashboard auth ${c.dashboardAuth}`,
  ].join(" · ");
}

export const setupCommands: readonly CommandDef<SetupCommandDeps & DeployCommandDeps>[] = [
  setupInit,
] as unknown as CommandDef<SetupCommandDeps & DeployCommandDeps>[];

export function registerSetupCommands<D extends SetupCommandDeps & DeployCommandDeps>(
  registry: CommandRegistry<D>,
): void {
  for (const cmd of setupCommands) registry.register(cmd as unknown as CommandDef<D>);
}
