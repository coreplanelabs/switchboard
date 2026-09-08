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

/** The Workers an installation may run, in deploy order. The project's docs
 *  site (deploy/cloudflare-docs/) is not one of them: it is the project's
 *  website, deployed by the project's own CI from project.json's facts, never
 *  a copy an installation runs (src/deploy/wranglerTemplate.ts `siteView`). */
export const WORKER_KINDS = ["memory", "bot", "resident", "sandbox"] as const;
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
  /** The zone that hostname lives in, when it is not the profile's `zone` — one
   *  Worker on a second domain the account also owns. Must be a zone in the
   *  same account. */
  zone: hostname.optional(),
});

/** `path` | `github://owner/repo/path@ref` | `op://Vault/Item/field` — parsed by src/deploy/configSource.ts. */
const source = z.string().min(1);

/** Where a Worker's container image comes from (src/deploy/images.ts): `build` —
 *  each Worker's `image` is its Dockerfile and wrangler builds it at deploy time
 *  (a checkout; this project's own production); `registry` — the release's
 *  published images, copied into the account registry by `deploy all` (or
 *  `deploy images` ahead of it) and referenced as
 *  `registry.cloudflare.com/<account>/<name>:<version>`. */
export const IMAGE_MODES = ["build", "registry"] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];

export const profileSchema = z.object({
  /** The Cloudflare account every Worker deploys to (32 hex characters). */
  account: z.string().regex(/^[0-9a-f]{32}$/, "a Cloudflare account id: 32 hex characters"),
  /** The zone the hostnames live under; every hostname must be in it unless its
   *  Worker names its own `zone`. */
  zone: hostname,
  /** The Workers this installation runs. The bot is the one every installation
   *  has; the state Worker (memory), the resident and the sandbox are optional —
   *  a profile without one has no step for it (`deploy plan` iterates what is
   *  here) and no URL derived for it. */
  workers: z.object({
    memory: endpoint.optional(),
    bot: endpoint,
    resident: endpoint.optional(),
    sandbox: endpoint.optional(),
  }),
  /** Where the bot's runtime config comes from at deploy time; `deploy all`
   *  materializes it into the image's build context. */
  configSource: source,
  /** Where `secrets put` reads values from: a directory of `<NAME>` files, or
   *  `op://Vault/Item` with the secret's name as the field. Optional: the
   *  secrets tooling has its own default directory. */
  secretsSource: source.optional(),
  /** How the bot, resident and sandbox images reach wrangler (`IMAGE_MODES`).
   *  Absent means `build` — the checkout deploys what it builds. */
  images: z.enum(IMAGE_MODES).default("build"),
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
    if (!ep) continue;
    const zone = ep.zone ?? p.zone;
    if (ep.hostname !== zone && !ep.hostname.endsWith(`.${zone}`))
      problems.push(`workers.${kind}.hostname: not under zone ${zone}`);
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

/** Pure: the URLs the tooling derives — never stored twice, never typed by hand.
 *  A Worker the profile does not have has no URL (`undefined`); the bot's are
 *  always there, the bot being the one required Worker. */
export function profileUrls(p: DeploymentProfile) {
  const origin = (kind: WorkerKind): string | undefined => {
    const worker = p.workers[kind];
    return worker ? `https://${worker.hostname}` : undefined;
  };
  const bot = `https://${p.workers.bot.hostname}`;
  return {
    /** A Worker's origin — what its deploy preflight is pointed at; undefined when the profile lacks it. */
    baseUrl: origin,
    /** `GET /healthz` of a Worker; undefined when the profile lacks it. */
    healthUrl: (kind: WorkerKind): string | undefined => {
      const o = origin(kind);
      return o === undefined ? undefined : `${o}/healthz`;
    },
    /** The bot's public origin — live-view links, the dashboards. */
    publicBaseUrl: bot,
    /** The state Worker other Workers record firings on and the bot reads its config from; undefined without one. */
    stateWorkerUrl: origin("memory"),
    /** The bot Worker's restart route (`deploy restart`). */
    botAdminRestartUrl: `${bot}/admin/restart`,
  };
}

/** Pure: is this the example profile? The example's account is the one
 *  placeholder that can never be a real Cloudflare account. */
export const EXAMPLE_ACCOUNT = "00000000000000000000000000000000";
export function isExampleProfile(p: DeploymentProfile): boolean {
  return p.account === EXAMPLE_ACCOUNT;
}
