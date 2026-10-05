import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forcePushWithLease, localGitRunner, patchUnchanged, rebaseOntoBase, type GitRunner } from "./gitRebase.js";
import { resolveGithubIdentity, resolveGithubToken } from "./githubApp.js";
import type { SweepGit, SweepPullRequest, SweepPreparedSource } from "../core/pullSweep.js";

// The checkout rung one of the pull sweep runs in (record 0071, mechanism two;
// docs/reference/specs/agent-ship.md item 20): `SweepGit` over a throwaway
// clone of the pull request's branch. Each `rebase` clones the branch into a
// fresh temporary directory, `patchUnchanged` and `forcePushWithLease` reuse
// that checkout, and the directory is removed as soon as the pull request's
// walk ends — a conflict, a push, or any error. The git work itself is
// src/execution/gitRebase.ts (the repository's own merge drivers, rerere with
// auto-staging, the range-diff gate, the lease push); nothing here re-decides
// it. The clone URL and the credential are two seams: production hands a
// plain URL plus an `Authorization` header the clone stores in its own config
// (gone with the directory) — the token never rides the remote URL, so git's
// failure messages, which quote that URL verbatim, cannot carry it onto the
// pull request's user-facing line. Tests hand a local path and no credential.

export interface SweepCheckoutOpts {
  /** Runs one git invocation; default: `git` as a child process. */
  runner?: GitRunner;
  /** The URL `git clone` and the lease push talk to. Production:
   *  `sweepCloneUrl` (credential-free — the token rides `authHeader`); tests:
   *  a local repository path. */
  cloneUrl: (repo: string) => Promise<string>;
  /** An HTTP header carrying the credential, stored in the clone's config for
   *  the fetch and the lease push. Production: `sweepAuthHeader`; tests: none. */
  authHeader?: (repo: string) => Promise<string>;
  /** The committer identity a rebase writes (record 0062: the bot commits).
   *  Default: the App's own identity; a fallback name when it cannot be read. */
  identity?: () => Promise<{ name: string; email: string }>;
  /** Where the throwaway checkouts live; default: the host's tmpdir. */
  tmpRoot?: string;
}

/** Production's clone URL: credential-free on purpose. Git quotes the remote
 *  URL verbatim in its failure messages (`fatal: unable to access '<url>': …`),
 *  and those words become the pull request's user-facing line — so the token
 *  rides `sweepAuthHeader`, never the URL. */
export async function sweepCloneUrl(repo: string): Promise<string> {
  return `https://github.com/${repo}.git`;
}

/** Production's credential: the GitHub App installation token — exactly what
 *  the sweep's REST calls already hold — as the `Authorization` header git
 *  sends with every request, stored only in the throwaway clone's config.
 *  Throws when no credential is configured — the pull request's line names the
 *  failure. */
export async function sweepAuthHeader(_repo: string): Promise<string> {
  const token = await resolveGithubToken();
  if (!token) throw new Error("no GitHub credential available to clone the pull request's branch");
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

/** The App's committer identity, as GitHub credits an App's commits. */
export async function sweepIdentity(): Promise<{ name: string; email: string }> {
  const id = await resolveGithubIdentity().catch(() => undefined);
  if (!id) return { name: "pull-sweep", email: "pull-sweep@localhost" };
  return { name: id.login, email: `${id.id}+${id.login}@users.noreply.github.com` };
}

interface CheckoutState {
  dir: string;
  preRebaseHead: string;
  preparedSource: SweepPreparedSource;
  newHead: string;
}

const keyOf = (pr: SweepPullRequest): string => `${pr.repo}#${pr.number}`;

/** `SweepGit` over a throwaway clone per pull request. The sweep service calls
 *  the three methods in order for one pull request at a time (its own
 *  per-repository bound), so the per-key state map never sees interleaving. */
export function createSweepGit(opts: SweepCheckoutOpts): SweepGit {
  const runner = opts.runner ?? localGitRunner;
  const tmpRoot = opts.tmpRoot ?? tmpdir();
  const states = new Map<string, CheckoutState>();
  const cleanup = async (key: string): Promise<void> => {
    const state = states.get(key);
    states.delete(key);
    if (state) await rm(state.dir, { recursive: true, force: true }).catch(() => {});
  };
  const stateOf = (pr: SweepPullRequest): CheckoutState => {
    const state = states.get(keyOf(pr));
    if (!state) throw new Error(`no checkout is open for ${keyOf(pr)} — rebase() opens it`);
    return state;
  };
  const prepare = async (pr: SweepPullRequest, saved?: SweepPreparedSource) => {
    const key = keyOf(pr);
    await cleanup(key); // a retried walk never reuses a stale checkout
    const dir = await mkdtemp(join(tmpRoot, "pull-sweep-"));
    try {
      const url = await opts.cloneUrl(pr.repo);
      // `--config` lands in the new clone's config before the fetch, so the
      // credential authenticates the clone AND the later fetch and lease push
      // without ever appearing in the remote URL git quotes on failure.
      const auth = opts.authHeader ? ["--config", `http.extraHeader=${await opts.authHeader(pr.repo)}`] : [];
      const clone = await runner.run(["clone", ...auth, "--branch", pr.branch, url, dir], tmpRoot);
      if (clone.code !== 0) throw new Error(`git clone failed: ${clone.stderr.trim() || clone.stdout.trim()}`);
      const who = saved?.committer ?? (await (opts.identity ?? sweepIdentity)());
      for (const [k, v] of [
        ["user.name", who.name],
        ["user.email", who.email],
      ] as const) {
        const set = await runner.run(["config", k, v], dir);
        if (set.code !== 0) throw new Error(`git config ${k} failed: ${set.stderr.trim()}`);
      }
      const head = await runner.run(["rev-parse", "HEAD"], dir);
      if (head.code !== 0) throw new Error(`git rev-parse failed: ${head.stderr.trim()}`);
      let preRebaseHead = head.stdout.trim();
      if (saved) {
        const fetchOld = await runner.run(["fetch", "origin", pr.headSha], dir);
        if (fetchOld.code !== 0) throw new Error("original rebase source unavailable");
        const checkout = await runner.run(["checkout", "--detach", pr.headSha], dir);
        if (checkout.code !== 0) throw new Error("original rebase source unavailable");
        preRebaseHead = pr.headSha;
      }
      if (!/^[a-f0-9]{40}$/i.test(preRebaseHead) || preRebaseHead.toLowerCase() !== pr.headSha.toLowerCase())
        throw new Error("pull request source moved before rebase");
      let baseHead = saved?.baseHead;
      if (!baseHead) {
        const fetched = await runner.run(["fetch", "origin", pr.base], dir);
        if (fetched.code !== 0) throw new Error("rebase base unavailable");
        const base = await runner.run(["rev-parse", "FETCH_HEAD"], dir);
        if (base.code !== 0) throw new Error("rebase base unavailable");
        baseHead = base.stdout.trim();
      }
      if (!/^[a-f0-9]{40}$/i.test(baseHead)) throw new Error("exact rebase base unavailable");
      const preparedSource = { baseHead, committer: who };
      const outcome = await rebaseOntoBase(runner, { dir, base: pr.base, baseHead });
      if (outcome.kind === "conflict") {
        // Rung one is over for this pull request; rung two runs elsewhere.
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        return outcome;
      }
      states.set(key, { dir, preRebaseHead, preparedSource, newHead: outcome.newHead });
      return { ...outcome, preparedSource };
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  };
  return {
    rebase: (pr) => prepare(pr),
    release: (pr) => cleanup(keyOf(pr)),
    async canPush(pr, newHead, source) {
      try {
        if (!/^[a-f0-9]{40}$/i.test(newHead) || !/^[a-f0-9]{40}$/i.test(pr.headSha)) return false;
        if (!states.has(keyOf(pr))) {
          if (!source || !/^[a-f0-9]{40}$/i.test(source.baseHead)) return false;
          const rebuilt = await prepare(pr, source);
          if (rebuilt.kind !== "clean" || rebuilt.newHead.toLowerCase() !== newHead.toLowerCase()) {
            await cleanup(keyOf(pr));
            return false;
          }
        }
        const state = stateOf(pr);
        if (
          state.preRebaseHead.toLowerCase() !== pr.headSha.toLowerCase() ||
          state.newHead.toLowerCase() !== newHead.toLowerCase()
        )
          return false;
        const actual = await runner.run(["rev-parse", "HEAD"], state.dir);
        return actual.code === 0 && actual.stdout.trim().toLowerCase() === newHead.toLowerCase();
      } catch {
        return false;
      }
    },
    async patchUnchanged(pr, newHead) {
      const state = stateOf(pr);
      try {
        return await patchUnchanged(runner, {
          dir: state.dir,
          base: pr.base,
          preRebaseHead: state.preRebaseHead,
          newHead,
        });
      } catch (err) {
        await cleanup(keyOf(pr));
        throw err;
      }
    },
    async forcePushWithLease(pr, newHead) {
      const state = stateOf(pr);
      try {
        const actual = await runner.run(["rev-parse", "HEAD"], state.dir);
        if (
          actual.code !== 0 ||
          actual.stdout.trim().toLowerCase() !== newHead.toLowerCase() ||
          state.preRebaseHead.toLowerCase() !== pr.headSha.toLowerCase()
        )
          return { state: "refused", cause: "external_refused" };
        await forcePushWithLease(runner, { dir: state.dir, branch: pr.branch, preRebaseHead: pr.headSha, newHead });
        return { state: "accepted", commitSha: newHead };
      } finally {
        await cleanup(keyOf(pr));
      }
    },
  };
}
