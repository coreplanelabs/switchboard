// Where the bot's runtime config comes from at deploy time.
//
// The image is one artifact for every installation and contains no config of
// its own; `deploy all` places the operator's config into the build context
// before the image builds, from wherever the deployment profile's
// `configSource` says. Three sources, one seam: a path on this machine (the
// default — most installations keep the file next to the profile), a file in
// a GitHub repository (an infrastructure repo, read with a token), or a
// 1Password item field (read with the `op` CLI and a service-account token).
// Anything the loader cannot read is a refusal that names the source and the
// variable it needed — never a silent build with yesterday's file.
//
// Pure decisions here; the I/O is injected so the loaders are unit-tested
// against fakes and the host wiring (src/deploy/run.ts) is a few lines.

export type ConfigSource =
  | { kind: "path"; path: string }
  | { kind: "github"; owner: string; repo: string; path: string; ref: string }
  | { kind: "op"; ref: string };

/** The env var a `github://` source is read with (a fine-grained token or an App installation token with contents:read on that one repo). */
export const CONFIG_REPO_TOKEN_ENV = "CONFIG_REPO_TOKEN";
/** The env var the `op` CLI reads a service-account token from. */
export const OP_TOKEN_ENV = "OP_SERVICE_ACCOUNT_TOKEN";

/** Pure: read the profile's `configSource` string. Unknown schemes and malformed
 *  references are problems, not guesses. */
export function parseConfigSource(s: string): { ok: true; source: ConfigSource } | { ok: false; problem: string } {
  const value = s.trim();
  if (value === "") return { ok: false, problem: "configSource is empty" };
  if (value.startsWith("github://")) {
    const m = /^github:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(.+?)(?:@([^@]+))?$/.exec(value);
    if (!m) return { ok: false, problem: `configSource "${value}" — expected github://owner/repo/path[@ref]` };
    return { ok: true, source: { kind: "github", owner: m[1], repo: m[2], path: m[3], ref: m[4] ?? "main" } };
  }
  if (value.startsWith("op://")) {
    // op://<vault>/<item>/<field> — three segments at least; `op read` does the rest.
    if (value.split("/").filter(Boolean).length < 4)
      return { ok: false, problem: `configSource "${value}" — expected op://Vault/Item/field` };
    return { ok: true, source: { kind: "op", ref: value } };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    return { ok: false, problem: `configSource "${value}" — unknown scheme; use a path, github://, or op://` };
  return { ok: true, source: { kind: "path", path: value } };
}

/** The I/O a loader needs; the host supplies the real ones, tests supply fakes. */
export interface ConfigSourceIO {
  readFile(path: string): Promise<string | undefined>;
  fetch(url: string, init: { headers: Record<string, string> }): Promise<{ status: number; text(): Promise<string> }>;
  /** Run `op read <ref>`; `undefined` when `op` is not installed. */
  opRead(ref: string): Promise<{ code: number; output: string } | undefined>;
  env: Record<string, string | undefined>;
}

export type ReadOutcome = { ok: true; text: string; how: string } | { ok: false; problem: string };

/** Read the config the source names. The `how` is what `deploy all` logs so the
 *  run record says where the config came from. */
export async function readConfigSource(source: ConfigSource, io: ConfigSourceIO): Promise<ReadOutcome> {
  switch (source.kind) {
    case "path": {
      const text = await io.readFile(source.path);
      if (text === undefined)
        return { ok: false, problem: `configSource: ${source.path} does not exist or cannot be read` };
      return { ok: true, text, how: `config from ${source.path}` };
    }
    case "github": {
      const token = io.env[CONFIG_REPO_TOKEN_ENV];
      if (!token)
        return {
          ok: false,
          problem: `configSource github://${source.owner}/${source.repo}/… needs ${CONFIG_REPO_TOKEN_ENV} in the environment`,
        };
      const encodedPath = source.path.split("/").map(encodeURIComponent).join("/");
      const url = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${encodedPath}?ref=${encodeURIComponent(source.ref)}`;
      const res = await io.fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github.raw+json",
          "user-agent": "switchboard-deploy",
        },
      });
      if (res.status !== 200) {
        return {
          ok: false,
          problem: `configSource github://${source.owner}/${source.repo}/${source.path}@${source.ref}: GET → HTTP ${res.status}${res.status === 404 ? " (wrong path or ref, or the token cannot read this repository)" : ""}`,
        };
      }
      return {
        ok: true,
        text: await res.text(),
        how: `config from github://${source.owner}/${source.repo}/${source.path}@${source.ref}`,
      };
    }
    case "op": {
      if (!io.env[OP_TOKEN_ENV])
        return { ok: false, problem: `configSource ${source.ref} needs ${OP_TOKEN_ENV} in the environment` };
      const r = await io.opRead(source.ref);
      if (!r) return { ok: false, problem: `configSource ${source.ref}: the 1Password CLI (op) is not installed` };
      if (r.code !== 0)
        return {
          ok: false,
          problem: `configSource ${source.ref}: op read exited ${r.code} — ${r.output.trim().split("\n").slice(-1)[0] ?? ""}`,
        };
      return { ok: true, text: r.output, how: `config from ${source.ref}` };
    }
  }
}

/** Pure: is materializing a no-op because the source IS the destination? A
 *  path source equal to the destination means the file is already in place. */
export function sourceIsDestination(source: ConfigSource, destination: string): boolean {
  return source.kind === "path" && normalize(source.path) === normalize(destination);
}

function normalize(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+/g, "/");
}
