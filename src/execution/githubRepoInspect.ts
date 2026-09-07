import { resolveGithubToken } from "./githubApp.js";
import type { RepoRootFacts } from "../core/repoToolchain.js";

// What `repo onboard` reads before it chooses a command table
// (features/resident-repos.md item 52): the repo root's entry names and its
// package.json, over the GitHub REST API with the App's READ-scoped installation
// token (AGENTS.md invariant 5 — never a `gh` shell-out, never a clone). Two
// GET calls, ~200 ms; a failure is reported, never guessed around: the command
// falls back to the npm defaults and SAYS the root was not inspected.

const REQUEST_TIMEOUT_MS = 10_000;
const PACKAGE_JSON_CAP_BYTES = 256 * 1024;

export type RepoInspection = { ok: true; facts: RepoRootFacts } | { ok: false; reason: string };

export type RepoInspector = (slug: string, ref: string) => Promise<RepoInspection>;

export interface GithubRepoInspectorOptions {
  fetch?: typeof fetch;
  /** The read-scoped credential; default: the App's read token (or GH_TOKEN). */
  token?: () => Promise<string | null>;
}

/** The production inspector. `ref` is the branch the resident will keep warm;
 *  an unknown ref (or a repo outside the installation) is a named failure. */
export function githubRepoInspector(opts: GithubRepoInspectorOptions = {}): RepoInspector {
  const fetchImpl = opts.fetch ?? fetch;
  const token = opts.token ?? (() => resolveGithubToken("read"));
  return async (slug, ref) => {
    let bearer: string | null;
    try {
      bearer = await token();
    } catch (err) {
      return {
        ok: false,
        reason: `GitHub credential unavailable (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    if (!bearer) return { ok: false, reason: "no GitHub credential configured (GitHub App or GH_TOKEN)" };
    const headers = (accept: string) => ({ authorization: `Bearer ${bearer}`, accept, "user-agent": "switchboard" });
    const base = `https://api.github.com/repos/${slug}`;
    try {
      const tree = await fetchImpl(`${base}/git/trees/${encodeURIComponent(ref)}`, {
        headers: headers("application/vnd.github+json"),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (tree.status === 404)
        return {
          ok: false,
          reason: `GitHub answered 404 for ${slug}@${ref} — the repo is outside the App installation, or the ref does not exist`,
        };
      if (!tree.ok) return { ok: false, reason: `GitHub tree lookup failed: HTTP ${tree.status}` };
      const body = (await tree.json()) as { tree?: Array<{ path?: unknown }> };
      const entries = (body.tree ?? []).map((e) => e.path).filter((p): p is string => typeof p === "string");
      if (!entries.includes("package.json")) return { ok: true, facts: { entries } };

      const pkg = await fetchImpl(`${base}/contents/package.json?ref=${encodeURIComponent(ref)}`, {
        headers: headers("application/vnd.github.raw+json"),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!pkg.ok) return { ok: false, reason: `GitHub package.json read failed: HTTP ${pkg.status}` };
      const text = await pkg.text();
      if (text.length > PACKAGE_JSON_CAP_BYTES) return { ok: true, facts: { entries, packageJson: null } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: true, facts: { entries, packageJson: null } };
      }
      const obj = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      return {
        ok: true,
        facts: {
          entries,
          packageJson: {
            ...(typeof obj.scripts === "object" && obj.scripts !== null
              ? { scripts: obj.scripts as Record<string, unknown> }
              : {}),
            ...(obj.packageManager !== undefined ? { packageManager: obj.packageManager } : {}),
          },
        },
      };
    } catch (err) {
      return { ok: false, reason: `GitHub request failed (${err instanceof Error ? err.message : String(err)})` };
    }
  };
}
