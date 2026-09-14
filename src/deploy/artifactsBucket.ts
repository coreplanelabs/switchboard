// The artifacts bucket's operator-side settings (docs/reference/specs/execution.md
// item 20, record 0033): the lifecycle rules that expire a run's files after
// `artifacts.retentionDays` and abort an incomplete multipart upload after a
// day, and the two domain settings that decide whether the bucket is public.
// Both go through Cloudflare's REST API under the OPERATOR's token
// (CLOUDFLARE_API_TOKEN, as the `deploy` commands authenticate) — never the
// bot's object-scoped S3 token, which cannot change a bucket's configuration
// and must not be able to. The rules and the privacy verdict are pure; the
// four calls are one injectable seam, so the commands are tested against a
// Cloudflare double and the host module holds the only `fetch`.
import { API_TOKEN_ENV } from "./imagesHost.js";

/** Incomplete multipart uploads are aborted after this many days, whatever the retention. */
export const ABORT_MULTIPART_AFTER_DAYS = 1;

const DAY_SECONDS = 86_400;

/** One R2 lifecycle rule as the API takes and returns it (the fields this module sets). */
export type LifecycleRule = {
  id: string;
  enabled: boolean;
  conditions: { prefix: string };
  deleteObjectsTransition?: { condition: { type: "Age"; maxAge: number } };
  abortMultipartUploadsTransition?: { condition: { type: "Age"; maxAge: number } };
};

export const EXPIRE_RULE_ID = "switchboard-artifacts-expire";
export const ABORT_RULE_ID = "switchboard-artifacts-abort-multipart";

/** Pure: the two rules for a retention — every key (the empty prefix), objects
 *  deleted after `retentionDays`, incomplete multipart uploads aborted after a day. */
export function lifecycleRulesFor(retentionDays: number): LifecycleRule[] {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`retentionDays must be an integer >= 1, got ${String(retentionDays)}`);
  }
  return [
    {
      id: EXPIRE_RULE_ID,
      enabled: true,
      conditions: { prefix: "" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: retentionDays * DAY_SECONDS } },
    },
    {
      id: ABORT_RULE_ID,
      enabled: true,
      conditions: { prefix: "" },
      abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: ABORT_MULTIPART_AFTER_DAYS * DAY_SECONDS } },
    },
  ];
}

/** Pure: one line per rule, as a person reads it. */
export function describeRules(rules: readonly LifecycleRule[]): string[] {
  return rules.map((r) => {
    const days = (s: number) => `${s / DAY_SECONDS} day${s === DAY_SECONDS ? "" : "s"}`;
    if (r.deleteObjectsTransition)
      return `${r.id}: delete every object ${days(r.deleteObjectsTransition.condition.maxAge)} after it was written`;
    if (r.abortMultipartUploadsTransition)
      return `${r.id}: abort an incomplete multipart upload after ${days(r.abortMultipartUploadsTransition.condition.maxAge)}`;
    return `${r.id}: (no transition)`;
  });
}

/** Pure: does what the API read back carry both rules as written? A rule of another
 *  id is someone else's and left alone; a missing or different one of ours is named. */
export function rulesMatch(
  readBack: unknown,
  wanted: readonly LifecycleRule[],
): { ok: true } | { ok: false; problem: string } {
  const rules = Array.isArray((readBack as { rules?: unknown } | null)?.rules)
    ? ((readBack as { rules: unknown[] }).rules as Array<Partial<LifecycleRule>>)
    : null;
  if (!rules) return { ok: false, problem: "the read-back carries no `rules` array" };
  const problems: string[] = [];
  for (const want of wanted) {
    const got = rules.find((r) => r?.id === want.id);
    if (!got) {
      problems.push(`rule ${want.id} is missing`);
      continue;
    }
    if (got.enabled !== true) problems.push(`rule ${want.id} is not enabled`);
    const wantAge =
      want.deleteObjectsTransition?.condition.maxAge ?? want.abortMultipartUploadsTransition?.condition.maxAge;
    const gotAge =
      got.deleteObjectsTransition?.condition?.maxAge ?? got.abortMultipartUploadsTransition?.condition?.maxAge;
    if (gotAge !== wantAge) problems.push(`rule ${want.id} has maxAge ${String(gotAge)}, not ${String(wantAge)}`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problem: problems.join("; ") };
}

export type ManagedDomain = {
  /** The `pub-<hash>.r2.dev` hostname Cloudflare would serve the bucket on. */
  domain: string;
  /** Whether that hostname serves the bucket — the one switch that makes an R2 bucket public without a zone. */
  enabled: boolean;
};

export type CustomDomain = {
  domain: string;
  /** Whether the bucket is served at this domain. */
  enabled: boolean;
};

export type Privacy = { private: true; open: [] } | { private: false; open: string[] };

/** Pure: a bucket is private exactly when its managed domain is disabled and no
 *  custom domain is enabled — the two ways R2 serves a bucket without a signature.
 *  `open` names each setting that is on, so the verdict says what to turn off. */
export function privacyOf(managed: ManagedDomain, custom: readonly CustomDomain[]): Privacy {
  const open: string[] = [];
  if (managed.enabled) open.push(`the managed r2.dev domain ${managed.domain} is enabled`);
  for (const d of custom) if (d.enabled) open.push(`the custom domain ${d.domain} is enabled`);
  return open.length === 0 ? { private: true, open: [] } : { private: false, open };
}

export type BucketOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };

/** The four Cloudflare calls the commands make, over an account and a bucket —
 *  injectable so the commands' tests hand in a double. */
export interface ArtifactsBucketIO {
  /** `PUT …/r2/buckets/<bucket>/lifecycle` with `{ rules }` — replaces the bucket's whole lifecycle configuration. */
  putLifecycle(account: string, bucket: string, rules: readonly LifecycleRule[]): Promise<BucketOutcome<void>>;
  /** `GET …/r2/buckets/<bucket>/lifecycle` — the configuration as the API holds it (`{ rules }`). */
  getLifecycle(account: string, bucket: string): Promise<BucketOutcome<unknown>>;
  /** `GET …/r2/buckets/<bucket>/domains/managed`. */
  managedDomain(account: string, bucket: string): Promise<BucketOutcome<ManagedDomain>>;
  /** `GET …/r2/buckets/<bucket>/domains/custom`. */
  customDomains(account: string, bucket: string): Promise<BucketOutcome<CustomDomain[]>>;
}

const API = "https://api.cloudflare.com/client/v4";

/** Pure: why nothing can start without the token, naming the permission each command needs. */
export function bucketTokenMissingProblem(): string {
  return `${API_TOKEN_ENV} is not set — the bucket's lifecycle rules and domain settings are read and written with a Cloudflare API token holding Workers R2 Storage: Edit (Read suffices for \`artifacts check\`); the bot's ARTIFACTS_R2_* token cannot do this and is never used here`;
}

/** Pure: a refused or failed call, in the API's own words where it gave any. */
export function bucketCallProblem(method: string, url: string, status: number, text: string): string {
  const words = text.trim().slice(0, 300);
  const permission =
    status === 401 || status === 403
      ? ` — the token lacks the permission (Workers R2 Storage: ${method === "GET" ? "Read" : "Edit"} on this account)`
      : "";
  return `${method} ${url} answered HTTP ${status}${permission}${words ? `: ${words}` : ""}`;
}

export interface ArtifactsBucketHostOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

/** The host's implementation over `fetch` and CLOUDFLARE_API_TOKEN. Each call reads
 *  the token when it runs, so a missing one is the call's problem, not a startup failure. */
export function artifactsBucketHost(options: ArtifactsBucketHostOptions = {}): ArtifactsBucketIO {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const call = async (method: "GET" | "PUT", path: string, body?: unknown): Promise<BucketOutcome<unknown>> => {
    const token = env[API_TOKEN_ENV]?.trim();
    if (!token) return { ok: false, problem: bucketTokenMissingProblem() };
    const url = `${API}${path}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      return { ok: false, problem: `${method} ${url} failed — ${err instanceof Error ? err.message : String(err)}` };
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, problem: bucketCallProblem(method, url, res.status, text) };
    let envelope: { success?: unknown; errors?: unknown; result?: unknown };
    try {
      envelope = JSON.parse(text) as typeof envelope;
    } catch {
      return { ok: false, problem: `${method} ${url} answered HTTP ${res.status} with a body that is not JSON` };
    }
    if (envelope.success !== true) {
      const errors = Array.isArray(envelope.errors)
        ? envelope.errors.map((e) => (e as { message?: string })?.message ?? JSON.stringify(e)).join("; ")
        : "no error given";
      return { ok: false, problem: `${method} ${url} answered success: false — ${errors}` };
    }
    return { ok: true, value: envelope.result };
  };
  const bucketPath = (account: string, bucket: string, tail: string) =>
    `/accounts/${encodeURIComponent(account)}/r2/buckets/${encodeURIComponent(bucket)}/${tail}`;
  return {
    async putLifecycle(account, bucket, rules) {
      const r = await call("PUT", bucketPath(account, bucket, "lifecycle"), { rules });
      return r.ok ? { ok: true, value: undefined } : r;
    },
    getLifecycle(account, bucket) {
      return call("GET", bucketPath(account, bucket, "lifecycle"));
    },
    async managedDomain(account, bucket) {
      const r = await call("GET", bucketPath(account, bucket, "domains/managed"));
      if (!r.ok) return r;
      const v = r.value as { domain?: unknown; enabled?: unknown } | null;
      if (!v || typeof v.domain !== "string" || typeof v.enabled !== "boolean") {
        return {
          ok: false,
          problem: `the managed-domain answer has no domain/enabled: ${JSON.stringify(r.value).slice(0, 200)}`,
        };
      }
      return { ok: true, value: { domain: v.domain, enabled: v.enabled } };
    },
    async customDomains(account, bucket) {
      const r = await call("GET", bucketPath(account, bucket, "domains/custom"));
      if (!r.ok) return r;
      const list = (r.value as { domains?: unknown } | null)?.domains;
      if (!Array.isArray(list)) {
        return {
          ok: false,
          problem: `the custom-domains answer has no domains array: ${JSON.stringify(r.value).slice(0, 200)}`,
        };
      }
      const domains: CustomDomain[] = [];
      for (const d of list as Array<{ domain?: unknown; enabled?: unknown }>) {
        if (typeof d?.domain !== "string" || typeof d.enabled !== "boolean") {
          return {
            ok: false,
            problem: `a custom domain entry has no domain/enabled: ${JSON.stringify(d).slice(0, 200)}`,
          };
        }
        domains.push({ domain: d.domain, enabled: d.enabled });
      }
      return { ok: true, value: domains };
    },
  };
}
