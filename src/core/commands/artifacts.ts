// The `artifacts.*` registrations (docs/reference/specs/execution.md item 20,
// record 0033): the operator's two bucket commands. `artifacts lifecycle` applies
// the retention the config names as the bucket's lifecycle rules and reads them
// back; `artifacts check` reads whether the bucket is private. Both run under
// the operator's CLOUDFLARE_API_TOKEN like the `deploy` commands, never the
// bot's S3 token, so they are CLI-only and `deploy:write` like `deploy restart`.
// Without an `artifacts:` section there is no bucket to speak of: both refuse
// by name before any call.
import { ARTIFACT_DEFAULTS, type ArtifactsConfig } from "../../artifacts/config.js";
import {
  describeRules,
  lifecycleRulesFor,
  privacyOf,
  rulesMatch,
  type ArtifactsBucketIO,
  type LifecycleRule,
} from "../../deploy/artifactsBucket.js";
import {
  CommandError,
  commandDefiner,
  flag,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
} from "../commandRegistry.js";
import { z } from "zod";

export interface ArtifactsCommandDeps {
  artifacts: {
    /** The bot's `artifacts:` section, or undefined when the deployment configures no store. */
    config(): Promise<ArtifactsConfig | undefined>;
    /** The four Cloudflare calls (src/deploy/artifactsBucket.ts `artifactsBucketHost`). */
    bucket: ArtifactsBucketIO;
  };
}

const defineCommand = commandDefiner<ArtifactsCommandDeps>();

/** The one refusal both commands share: no section, no bucket, nothing to do. */
async function configured(deps: ArtifactsCommandDeps): Promise<ArtifactsConfig> {
  const cfg = await deps.artifacts.config();
  if (!cfg) {
    throw new CommandError(
      "unavailable",
      "artifacts: is not configured — name the bucket under `artifacts.r2` in config.yaml before managing it (docs/how-to/store-run-artifacts.md)",
    );
  }
  return cfg;
}

const lifecycleOptions = z.object({
  dryRun: flag.optional().describe("print the rules that would be applied and touch nothing"),
});

interface LifecycleOutput extends JsonObject {
  account: string;
  bucket: string;
  retentionDays: number;
  rules: LifecycleRule[];
  applied: boolean;
  readBack: boolean;
}

export const artifactsLifecycle = defineCommand({
  id: "artifacts.lifecycle",
  options: lifecycleOptions,
  action: "deploy:write",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Apply the artifacts bucket's lifecycle rules from config.yaml — objects expire after `artifacts.retentionDays` (default 30), incomplete multipart uploads abort after one day — and read them back; `--dry-run` prints the rules and touches nothing. Operator-side: CLOUDFLARE_API_TOKEN with Workers R2 Storage: Edit, never the bot's token.",
  render: (output) => {
    const o = output as LifecycleOutput;
    const lines = describeRules(o.rules).map((l) => `  - ${l}`);
    const head = o.applied
      ? `applied ${o.rules.length} lifecycle rule(s) to ${o.bucket} (account ${o.account}) and read them back equal:`
      : `dry run — would apply ${o.rules.length} lifecycle rule(s) to ${o.bucket} (account ${o.account}); nothing touched:`;
    return [head, ...lines].join("\n");
  },
  handler: async ({ options, deps }) => {
    const cfg = await configured(deps);
    const retentionDays = cfg.retentionDays ?? ARTIFACT_DEFAULTS.retentionDays;
    const rules = lifecycleRulesFor(retentionDays);
    const { accountId: account, bucket } = cfg.r2;
    const out: LifecycleOutput = { account, bucket, retentionDays, rules, applied: false, readBack: false };
    if (options.dryRun) return out;
    const put = await deps.artifacts.bucket.putLifecycle(account, bucket, rules);
    if (!put.ok)
      throw new CommandError("unavailable", `applying the lifecycle rules to ${bucket} failed — ${put.problem}`);
    const read = await deps.artifacts.bucket.getLifecycle(account, bucket);
    if (!read.ok)
      throw new CommandError(
        "unavailable",
        `this is a bug: the rules were applied to ${bucket}, but their read-back failed (${read.problem}) and no automatic confirmation was completed`,
      );
    const match = rulesMatch(read.value, rules);
    if (!match.ok)
      throw new CommandError(
        "unavailable",
        `the rules were applied to ${bucket} but the read-back differs — ${match.problem}; the bucket's configuration is not what config.yaml says`,
      );
    return { ...out, applied: true, readBack: true };
  },
});

interface CheckOutput extends JsonObject {
  account: string;
  bucket: string;
  private: boolean;
  open: string[];
  managedDomain: { domain: string; enabled: boolean };
  customDomains: Array<{ domain: string; enabled: boolean }>;
}

export const artifactsCheck = defineCommand({
  id: "artifacts.check",
  action: "deploy:write",
  effect: "read",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Report whether the artifacts bucket is private: its managed r2.dev domain must be disabled and no custom domain enabled — the two ways R2 serves a bucket without a signature. Operator-side: CLOUDFLARE_API_TOKEN with Workers R2 Storage: Read, never the bot's token.",
  render: (output) => {
    const o = output as CheckOutput;
    if (o.private) {
      return `${o.bucket} (account ${o.account}) is private: the managed domain ${o.managedDomain.domain} is disabled and ${
        o.customDomains.length === 0
          ? "no custom domain is attached"
          : `none of its ${o.customDomains.length} custom domain(s) is enabled`
      }`;
    }
    return [`${o.bucket} (account ${o.account}) is NOT private:`, ...o.open.map((l) => `  - ${l}`)].join("\n");
  },
  handler: async ({ deps }) => {
    const cfg = await configured(deps);
    const { accountId: account, bucket } = cfg.r2;
    const managed = await deps.artifacts.bucket.managedDomain(account, bucket);
    if (!managed.ok)
      throw new CommandError("unavailable", `reading ${bucket}'s managed domain failed — ${managed.problem}`);
    const custom = await deps.artifacts.bucket.customDomains(account, bucket);
    if (!custom.ok)
      throw new CommandError("unavailable", `reading ${bucket}'s custom domains failed — ${custom.problem}`);
    const verdict = privacyOf(managed.value, custom.value);
    const out: CheckOutput = {
      account,
      bucket,
      private: verdict.private,
      open: [...verdict.open],
      managedDomain: managed.value,
      customDomains: custom.value,
    };
    return out;
  },
});

export const artifactsCommands = [artifactsLifecycle, artifactsCheck] as const;

export function registerArtifactsCommands<D extends ArtifactsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of artifactsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
