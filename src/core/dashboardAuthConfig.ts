// The `dashboard` block of config.yaml and the one rule that picks the
// dashboard auth strategy (features/access-gate.md, plan D5). Pure — no
// crypto, no I/O — so the capabilities value (src/core/capabilities.ts) and
// the verifier that actually gates requests (src/channels/dashboardAuth.ts)
// both call `resolveDashboardAuthMode` and can never name different modes.

export const DASHBOARD_AUTH_MODES = ["access", "token", "none"] as const;
export type DashboardAuthMode = (typeof DASHBOARD_AUTH_MODES)[number];

/** The env var the `token` strategy reads when `dashboard.token.env` is not set. */
export const DEFAULT_DASHBOARD_TOKEN_ENV = "DASHBOARD_TOKEN";

/** `config.yaml`'s `dashboard` block. */
export interface DashboardConfig {
  /** Which credential the gate checks. Absent → `access` when ACCESS_TEAM_DOMAIN
   *  and ACCESS_AUD are both set, else `none`. */
  auth?: DashboardAuthMode;
  /** The `token` strategy's inputs. */
  token?: {
    /** The env var holding the bearer. Default `DASHBOARD_TOKEN`. */
    env?: string;
    /** The one actor id a matching bearer resolves to — `access:<name>`, the id
     *  its `grants` entry is keyed by. Required for `auth: token`. */
    actor?: string;
  };
}

/**
 * Which strategy runs: the configured one; absent → `access` when Access is
 * configured in the environment, else `none`. A deployed installation that
 * never wrote the key is unchanged (Access when Access is there; a public
 * address without it refuses everyone, as it did); a localhost deployment
 * without Access now admits its loopback callers without a variable.
 */
export function resolveDashboardAuthMode(
  configured: DashboardAuthMode | undefined,
  accessConfigured: boolean,
): DashboardAuthMode {
  if (configured !== undefined) return configured;
  return accessConfigured ? "access" : "none";
}

/** The `access:<name>` an operator writes in `dashboard.token.actor` → `<name>`
 *  (the `sub` the actor resolver turns back into that id), or undefined for a
 *  form the strategy does not serve as: a service-token id (`access:svc:…` is a
 *  command-surface credential only), another namespace, or an empty name. */
export function tokenSubjectOf(actor: string): string | undefined {
  const m = /^access:(\S+)$/.exec(actor);
  if (!m || m[1].startsWith("svc:")) return undefined;
  return m[1];
}

/**
 * The `dashboard` block is checked at load so a typo cannot silently become
 * "no auth" (a misspelled `auth` is refused, never defaulted): a mapping;
 * `auth` one of the three modes; `token` a mapping whose `env` is a non-blank
 * string and whose `actor` is `access:<name>`; `token.actor` required when
 * `auth` is `token`. Throws a message naming the key.
 */
export function validateDashboardConfig(raw: unknown): asserts raw is DashboardConfig | undefined {
  if (raw === undefined) return;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("config.yaml: dashboard must be a mapping");
  }
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (key !== "auth" && key !== "token") throw new Error(`config.yaml: dashboard.${key} is not a known key`);
  }
  if (block.auth !== undefined) {
    if (typeof block.auth !== "string" || !(DASHBOARD_AUTH_MODES as readonly string[]).includes(block.auth)) {
      throw new Error(`config.yaml: dashboard.auth must be one of ${DASHBOARD_AUTH_MODES.join(", ")}`);
    }
  }
  let actor: string | undefined;
  if (block.token !== undefined) {
    const t = block.token;
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      throw new Error("config.yaml: dashboard.token must be a mapping");
    }
    const token = t as Record<string, unknown>;
    for (const key of Object.keys(token)) {
      if (key !== "env" && key !== "actor") throw new Error(`config.yaml: dashboard.token.${key} is not a known key`);
    }
    if (token.env !== undefined && (typeof token.env !== "string" || token.env.trim() === "")) {
      throw new Error("config.yaml: dashboard.token.env must name an environment variable");
    }
    if (token.actor !== undefined) {
      if (typeof token.actor !== "string" || tokenSubjectOf(token.actor) === undefined) {
        throw new Error("config.yaml: dashboard.token.actor must be an actor id of the form access:<name>");
      }
      actor = token.actor;
    }
  }
  if (block.auth === "token" && actor === undefined) {
    throw new Error(
      "config.yaml: dashboard.auth is token, so dashboard.token.actor must name the bearer's actor (access:<name>)",
    );
  }
}
