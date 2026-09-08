// The deployment profile: everything about WHERE an installation runs that the
// code must not know. Cloudflare account, the zone the Workers sit under, each
// Worker's script name and hostname, where the runtime config comes from, and
// where secrets come from. The product is installed, not forked: this file is
// the operator's, the code reads it, and nothing under src/ or deploy/ names
// an account or a hostname of its own.
//
// Two files: `deploy/profile.json` (an installation's own; today the
// repository's own production values, gitignored once they move to the
// infrastructure repo) and `deploy/profile.example.json` (checked in, the
// shape with placeholders). `deploy plan` falls back to the example so the
// plan can be read anywhere — CI on a pull request, a fresh clone — but the
// plan says so, and `deploy all` refuses a plan computed from the example: a
// placeholder account is not a place to deploy to.
//
// Pure: parsing, validation, and the URLs derived from the profile. Reading
// the file is the runner's job (src/deploy/run.ts).

import { z } from "zod";

/** The Workers an installation may run. The four runtime Workers deploy in
 *  this order; the docs Worker is assets only and deploys on its own. */
export const WORKER_KINDS = ["memory", "bot", "resident", "sandbox", "docs"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

export const PROFILE_PATH = "deploy/profile.json";
export const PROFILE_EXAMPLE_PATH = "deploy/profile.example.json";
/** Overrides the profile's location — a second installation's profile, a test fixture. */
export const PROFILE_ENV = "SWITCHBOARD_DEPLOY_PROFILE";

const hostname = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    "a bare DNS hostname, no scheme, no path",
  );

const endpoint = z.object({
  /** The Cloudflare Worker script name (what `wrangler deployments list` shows). */
  script: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "a Worker script name: lowercase, digits, hyphens"),
  /** The hostname the Worker's custom domain route serves. */
  hostname,
});

/** `path` | `github://owner/repo/path@ref` | `op://Vault/Item/field` — parsed by src/deploy/configSource.ts. */
const source = z.string().min(1);

export const profileSchema = z.object({
  /** The Cloudflare account every Worker deploys to (32 hex characters). */
  account: z.string().regex(/^[0-9a-f]{32}$/, "a Cloudflare account id: 32 hex characters"),
  /** The zone the hostnames live under; every hostname must be in it. */
  zone: hostname,
  workers: z.object({
    memory: endpoint,
    bot: endpoint,
    resident: endpoint,
    sandbox: endpoint,
    docs: endpoint.optional(),
  }),
  /** Where the bot's runtime config comes from at deploy time; `deploy all`
   *  materializes it into the image's build context. */
  configSource: source,
  /** Where `secrets put` reads values from: a directory of `<NAME>` files, or
   *  `op://Vault/Item` with the secret's name as the field. Optional: the
   *  secrets tooling has its own default directory. */
  secretsSource: source.optional(),
  /** The Cloudflare Access application in front of the bot's dashboards, when
   *  there is one: the team domain the JWT is issued by and the app's AUD. */
  access: z.object({ teamDomain: hostname, aud: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
});

export type DeploymentProfile = z.infer<typeof profileSchema>;

/** Pure: a parsed, validated profile, or the problems that make it unusable —
 *  each naming the field, never the value. A hostname outside the zone is a
 *  problem: the custom-domain route would be for a zone the account does not own. */
export function parseProfile(
  raw: unknown,
): { ok: true; profile: DeploymentProfile } | { ok: false; problems: string[] } {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const p = parsed.data;
  const problems: string[] = [];
  for (const [kind, ep] of Object.entries(p.workers)) {
    if (ep && ep.hostname !== p.zone && !ep.hostname.endsWith(`.${p.zone}`))
      problems.push(`workers.${kind}.hostname: not under zone ${p.zone}`);
  }
  const scripts = Object.values(p.workers)
    .filter((e): e is z.infer<typeof endpoint> => !!e)
    .map((e) => e.script);
  if (new Set(scripts).size !== scripts.length) problems.push("workers: two Workers share a script name");
  return problems.length > 0 ? { ok: false, problems } : { ok: true, profile: p };
}

/** Where the profile came from — `deploy all` refuses the example. */
export type ProfileOrigin = "profile" | "example";

export interface LoadedProfile {
  profile: DeploymentProfile;
  origin: ProfileOrigin;
  /** The path that was read, repo-relative or as the env var gave it. */
  path: string;
}

/** Pure: the URLs the tooling derives — never stored twice, never typed by hand. */
export function profileUrls(p: DeploymentProfile) {
  const origin = (kind: Exclude<WorkerKind, "docs">) => `https://${p.workers[kind].hostname}`;
  return {
    /** A runtime Worker's origin — what its deploy preflight is pointed at. */
    baseUrl: origin,
    /** `GET /healthz` of a runtime Worker. */
    healthUrl: (kind: Exclude<WorkerKind, "docs">) => `${origin(kind)}/healthz`,
    /** The bot's public origin — live-view links, the dashboards. */
    publicBaseUrl: origin("bot"),
    /** The state Worker other Workers record firings on. */
    stateWorkerUrl: origin("memory"),
    /** The bot Worker's restart route (`deploy restart`). */
    botAdminRestartUrl: `${origin("bot")}/admin/restart`,
    /** The docs site's origin, when the installation publishes one. */
    docsBaseUrl: p.workers.docs ? `https://${p.workers.docs.hostname}` : undefined,
  };
}

/** Pure: is this the example profile? The example's account is the one
 *  placeholder that can never be a real Cloudflare account. */
export const EXAMPLE_ACCOUNT = "00000000000000000000000000000000";
export function isExampleProfile(p: DeploymentProfile): boolean {
  return p.account === EXAMPLE_ACCOUNT;
}
