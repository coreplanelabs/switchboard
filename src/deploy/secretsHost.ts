// The host half of `deploy secrets`: the real manifest file, the real source
// (files under a directory, or a 1Password item through the `op` CLI), and the
// real `wrangler secret put`. The value of a secret is read here and handed to
// wrangler on STDIN in the same function — it never crosses the command's seam,
// never touches argv or the environment, and never appears in output. The
// testable logic (the plan) is src/deploy/secrets.ts; the command
// (src/core/commands/deploy.ts) calls these through `deps.deploy.secrets` so its
// tests run over fakes.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PACKAGE_ROOT, RUNS_FROM_PUBLISHED_PACKAGE } from "../packageRoot.js";
import { DEFAULT_SECRETS_DIR, MANIFEST_PATH, type SecretsSource } from "./secrets.js";

/** What the command needs from the host — the manifest, which names have a value, and one put. */
export interface SecretsHostIO {
  /** The manifest file, parsed as JSON (not yet validated); `undefined` when absent. */
  manifest(): Promise<unknown>;
  /** Which of `names` the source holds a value for, or why the source cannot be read at all. */
  present(
    source: SecretsSource,
    names: readonly string[],
  ): Promise<{ ok: true; present: Set<string> } | { ok: false; problem: string }>;
  /** Read one value from the source and pipe it into `wrangler secret put <name>` in the Worker's dir. */
  put(source: SecretsSource, dir: string, name: string): Promise<{ code: number; output: string }>;
}

/** Where a relative `secretsSource` directory is looked for: the package root — the checkout, where the profile lives. */
export interface SecretsDirRoot {
  root: string;
  /** True when this process is the published npm package: a relative path would land inside its shipped assets. */
  published: boolean;
}

const HOST_ROOT: SecretsDirRoot = { root: PACKAGE_ROOT, published: RUNS_FROM_PUBLISHED_PACKAGE };

/**
 * `~` at the front of a path is the operator's home; an absolute path is as
 * written; a relative path is under the package root — the checkout. From the
 * published package there is no checkout: a relative path would resolve inside
 * the package's own `dist/assets/`, which holds no operator's secrets, so it is
 * refused (thrown) naming the forms that do work, rather than read as "no such
 * directory" somewhere under node_modules.
 */
export function expandDir(path: string, at: SecretsDirRoot = HOST_ROOT): string {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  if (isAbsolute(path)) return path;
  if (at.published)
    throw new Error(
      `secretsSource ${path}: a relative directory resolves inside the installed package (${at.root}), not an operator's secrets — use an absolute path or ~/<dir> (the default is ${DEFAULT_SECRETS_DIR})`,
    );
  return resolve(at.root, path);
}

interface Spawned {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnCollect(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<Spawned> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolvePromise({ code: 127, stdout, stderr: `${stderr}\n${e.message}` }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** The 1Password item's field labels — one `op item get`, never a read per name. */
async function opFieldLabels(
  source: Extract<SecretsSource, { kind: "op" }>,
): Promise<{ ok: true; labels: Set<string> } | { ok: false; problem: string }> {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN && !process.env.OP_SESSION)
    return {
      ok: false,
      problem: `secretsSource op://${source.vault}/${source.item} needs OP_SERVICE_ACCOUNT_TOKEN (or an \`op signin\` session) in the environment`,
    };
  const r = await spawnCollect("op", ["item", "get", source.item, "--vault", source.vault, "--format", "json"]);
  if (r.code === 127)
    return {
      ok: false,
      problem: `secretsSource op://${source.vault}/${source.item}: the 1Password CLI (op) is not installed`,
    };
  if (r.code !== 0)
    return {
      ok: false,
      problem: `secretsSource op://${source.vault}/${source.item}: op item get exited ${r.code} — ${r.stderr.trim().split("\n").at(-1) ?? ""}`,
    };
  try {
    const item = JSON.parse(r.stdout) as { fields?: { label?: string }[] };
    return { ok: true, labels: new Set((item.fields ?? []).map((f) => f.label ?? "").filter(Boolean)) };
  } catch {
    return { ok: false, problem: `secretsSource op://${source.vault}/${source.item}: op item get returned no JSON` };
  }
}

/** The Worker dir's pinned wrangler when installed; PATH otherwise. */
function wranglerBin(dir: string): string {
  const local = join(dir, "node_modules", ".bin", "wrangler");
  return existsSync(local) ? local : "wrangler";
}

export const hostSecretsIO: SecretsHostIO = {
  manifest: async () => {
    const abs = join(PACKAGE_ROOT, MANIFEST_PATH);
    return existsSync(abs) ? (JSON.parse(readFileSync(abs, "utf8")) as unknown) : undefined;
  },
  present: async (source, names) => {
    if (source.kind === "dir") {
      let dir: string;
      try {
        dir = expandDir(source.path);
      } catch (err) {
        return { ok: false, problem: err instanceof Error ? err.message : String(err) };
      }
      if (!existsSync(dir)) return { ok: false, problem: `secretsSource ${source.path}: no such directory (${dir})` };
      return { ok: true, present: new Set(names.filter((n) => existsSync(join(dir, n)))) };
    }
    const labels = await opFieldLabels(source);
    if (!labels.ok) return labels;
    return { ok: true, present: new Set(names.filter((n) => labels.labels.has(n))) };
  },
  put: async (source, dir, name) => {
    let value: string;
    if (source.kind === "dir") {
      value = readFileSync(join(expandDir(source.path), name), "utf8");
    } else {
      const r = await spawnCollect("op", ["read", `op://${source.vault}/${source.item}/${name}`]);
      if (r.code !== 0) return { code: r.code, output: `op read exited ${r.code} — ${r.stderr.trim()}` };
      // op appends one trailing newline; the file form keeps the file as written.
      value = r.stdout.replace(/\n$/, "");
    }
    const cwd = join(PACKAGE_ROOT, dir);
    const r = await spawnCollect(wranglerBin(cwd), ["secret", "put", name], { cwd, input: value });
    return { code: r.code, output: `${r.stdout}${r.stderr}` };
  },
};
