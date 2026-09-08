// A Worker's secrets, provisioned from the manifest: WHICH secrets each Worker
// holds is deploy/secrets.manifest.json (names, Workers, optional — the
// contract the Worker's `Env` interface and the container's forwarding list are
// tested against); WHERE the values come from is the deployment profile's
// `secretsSource` — a directory of `<NAME>` files (the default) or a 1Password
// item (`op://Vault/Item`, the secret's name as the field). `deploy secrets
// <worker>` plans the puts from the two, refuses BEFORE any upload when a
// required value is absent (a half-provisioned Worker is worse than an
// unprovisioned one), and pipes each value into `wrangler secret put` on stdin.
// Values never appear in argv, in the environment, or in any output.
//
// Pure: the manifest's shape, the source's shape, and the plan. Reading files,
// `op`, and wrangler are the host's (src/deploy/secretsHost.ts).

import { z } from "zod";
import { DEPLOY_ORDER, WORKER_SPECS, type WorkerName } from "./plan.js";

export const MANIFEST_PATH = "deploy/secrets.manifest.json";
/** Where values live when the profile names no `secretsSource`: one mode-600 file per secret. */
export const DEFAULT_SECRETS_DIR = "~/.secrets/switchboard";

const secretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "a SCREAMING_SNAKE secret name");

export const manifestSchema = z.object({
  $comment: z.string().optional(),
  secrets: z
    .array(
      z.object({
        name: secretName,
        workers: z.array(z.enum(DEPLOY_ORDER as [WorkerName, ...WorkerName[]])).min(1),
        optional: z.boolean().optional(),
        note: z.string().optional(),
      }),
    )
    .min(1),
});

export type SecretsManifest = z.infer<typeof manifestSchema>;
export type SecretDef = SecretsManifest["secrets"][number];

/** Pure: the manifest, or its problems by field. Two entries with one name are a problem too. */
export function parseManifest(
  raw: unknown,
): { ok: true; manifest: SecretsManifest } | { ok: false; problems: string[] } {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const names = parsed.data.secrets.map((s) => s.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0)
    return { ok: false, problems: [`secrets: duplicate name(s) ${[...new Set(dupes)].join(", ")}`] };
  return { ok: true, manifest: parsed.data };
}

export type SecretsSource = { kind: "dir"; path: string } | { kind: "op"; vault: string; item: string };

/** Pure: read the profile's `secretsSource` (or the default). A directory path, or
 *  `op://Vault/Item` — exactly two segments; the secret's name is the field. */
export function parseSecretsSource(
  value: string | undefined,
): { ok: true; source: SecretsSource } | { ok: false; problem: string } {
  const s = (value ?? DEFAULT_SECRETS_DIR).trim();
  if (s === "") return { ok: false, problem: "secretsSource is empty" };
  if (s.startsWith("op://")) {
    const segments = s.slice("op://".length).split("/").filter(Boolean);
    if (segments.length !== 2 || s.slice("op://".length).split("/").length !== 2)
      return { ok: false, problem: `secretsSource "${s}" — expected op://Vault/Item (the secret's name is the field)` };
    return { ok: true, source: { kind: "op", vault: segments[0], item: segments[1] } };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s))
    return { ok: false, problem: `secretsSource "${s}" — unknown scheme; use a directory path or op://Vault/Item` };
  return { ok: true, source: { kind: "dir", path: s } };
}

/** Pure: where one secret's value is read from — what the plan prints, never the value. */
export function secretRef(source: SecretsSource, name: string): string {
  return source.kind === "dir" ? `${source.path}/${name}` : `op://${source.vault}/${source.item}/${name}`;
}

export interface SecretPutPlan {
  worker: WorkerName;
  /** The Worker's directory — where `wrangler secret put` runs (its wrangler.jsonc names the script and account). */
  dir: string;
  /** In manifest order: the secrets that have a value and will be put. */
  puts: string[];
  /** Optional secrets with no value — skipped, and said. */
  skippedOptional: string[];
  /** Required secrets with no value — the plan is refused when non-empty. */
  missing: string[];
}

/** Pure: which of the Worker's secrets to put, given which names the source has a
 *  value for. `only` narrows to named secrets; a name that is not one of the
 *  Worker's is a problem (a typo must never become a silent no-op). */
export function planSecretPuts(
  manifest: SecretsManifest,
  worker: WorkerName,
  present: ReadonlySet<string>,
  only?: readonly string[],
): { ok: true; plan: SecretPutPlan } | { ok: false; problem: string } {
  const mine = manifest.secrets.filter((s) => s.workers.includes(worker));
  let wanted: SecretDef[] = mine;
  if (only) {
    const unknown = only.filter((n) => !mine.some((s) => s.name === n));
    if (unknown.length > 0)
      return {
        ok: false,
        problem: `${unknown.join(", ")} ${unknown.length === 1 ? "is not a" : "are not"} ${worker} secret${unknown.length === 1 ? "" : "s"} (manifest: ${mine.map((s) => s.name).join(", ")})`,
      };
    wanted = only.map((n) => mine.find((s) => s.name === n)!);
  }
  const dir = WORKER_SPECS.find((w) => w.name === worker)!.dir;
  const plan: SecretPutPlan = { worker, dir, puts: [], skippedOptional: [], missing: [] };
  for (const s of wanted) {
    if (present.has(s.name)) plan.puts.push(s.name);
    else if (s.optional) plan.skippedOptional.push(s.name);
    else plan.missing.push(s.name);
  }
  return { ok: true, plan };
}

/** What to quote from a failed `wrangler secret put`: its `[ERROR]` line(s) — the words an
 *  operator needs (an authentication error names the token and the API call) — else the last
 *  non-empty line, which for wrangler is usually only where the log went. */
export function wranglerFailureLine(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const errors = lines.filter((l) => l.includes("[ERROR]"));
  if (errors.length > 0) return errors.map((l) => l.replace(/^✘\s*/, "")).join(" ");
  return lines.at(-1) ?? "";
}
