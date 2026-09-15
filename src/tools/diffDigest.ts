// The `diff_digest` tool: a distilled summary of the branch's diff — per-file
// churn, totals, and risky-file flags — NOT the raw diff. The coding agent
// shapes its PR description from it; the review agent orients with it. The
// parse/render lives in the pure distillDiffStats (src/core/diffDigest.ts); this
// tool only bridges the Executor, and reports the digest's totals to the run
// through `ctx.onDigest` so the review post-step can hold them against the
// PR's. Relayed to pi like every bot tool (docs/reference/specs/harness-pi.md
// item 7); its toolset wiring stays in src/tools/workspace.ts.
//
// The range is the merge-base diff `<base>...HEAD`, and what runs over it is
// `git diff --numstat` + `git diff --name-status` — one line per file — never
// the unified diff: every Executor caps command output at 120k characters, and
// a unified diff larger than that came back cut, so the digest counted the
// first files in git's alphabetical order and silently dropped the rest (13 of
// 41 files; the review approved on it). A stat listing that is itself cut is
// reported as incomplete rather than rendered as a smaller change.

import { distillDiffStats } from "../core/diffDigest.js";
import { shellQuote } from "../execution/shellQuote.js";
import type { RunnableTool } from "./runnableTool.js";

const NAME_STATUS_MARK = "@@diff_digest:name-status@@";
// The marker as a whole line: a path can carry the marker text inside a
// `adds\tdels\tpath` line, so only the line we echoed ourselves separates the
// two listings.
const NAME_STATUS_MARK_LINE = /^@@diff_digest:name-status@@$/m;
const OUTPUT_CUT_RE = /^\.\.\.\[truncated \d+ chars\]$/m;

export const diffDigestTool: RunnableTool = {
  sideEffectFree: true,
  name: "diff_digest",
  description:
    "Summarize the current branch's whole change against a base ref as a compact digest: per-file +adds/-dels, totals, " +
    "and risky-file flags (migrations/schema, auth/permission, whole-file deletions, lockfiles, very large files). " +
    "This is a DISTILLED summary, not the raw diff — use it to shape a PR description, or to orient before a review. " +
    "Runs `git diff --numstat` and `--name-status` over the merge-base range `<base>...HEAD` in the workspace, so it covers " +
    "every file however large the change; base defaults to the repo's default branch (origin/HEAD). " +
    "The totals it states are the whole change — a diff you read that shows fewer files or lines was cut short.",
  inputSchema: {
    type: "object",
    properties: {
      base: {
        type: "string",
        description:
          "Base ref to diff against (e.g. 'main' or a SHA). Defaults to the repo's default branch via origin/HEAD.",
      },
    },
  },
  async run(input, ctx) {
    const base = String(input.base ?? "").trim();
    const baseName = base || "origin/HEAD";
    // git OPTION injection (distinct from shell injection): a base like
    // `--output=/path` or `-O/etc/passwd` is parsed by GIT itself as an option
    // — arbitrary file write/read — even though the shell token is inert. Reject
    // a leading dash, and pass `--end-of-options` so git treats the token as a
    // revision regardless.
    if (base.startsWith("-")) {
      return "diff_digest: base ref may not start with '-' (rejected to prevent git option injection).";
    }
    // Quote a caller-supplied base into one inert shell token so it can't break
    // out of the argument. No base → resolve the default branch at run time,
    // falling back to origin/main when origin/HEAD isn't set.
    const baseExpr = base
      ? shellQuote(base)
      : '"$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)"';
    const range = `--end-of-options ${baseExpr}...HEAD`;
    const listing = `git diff --numstat ${range} && echo ${NAME_STATUS_MARK} && git diff --name-status ${range}`;
    let raw = await ctx.executor.exec(listing);
    // The Executor's output cap, checked FIRST: a listing this long (one line
    // per file) means thousands of files, and the cut can land before the
    // marker — which would otherwise read as a failed command. Totals from a
    // cut listing would be a smaller change than the real one — the exact
    // failure this tool exists to prevent.
    const incomplete = (): string => {
      const reason = "the file listing exceeded the executor's output cap";
      ctx.onDigest?.({ complete: false, base: baseName, reason });
      return `diff_digest: ${reason} — the digest cannot state totals for this change (base \`${baseName}\`). Read the diff file by file (\`git diff --name-only ${baseName}...HEAD\`).`;
    };
    if (OUTPUT_CUT_RE.test(raw)) return incomplete();
    // A merge-base range needs the base's history. A shallow clone (the cold
    // sandbox's own `git clone --depth`) may hold neither the base ref nor the
    // merge base; deepen it once — the whole history, every branch — and retry.
    // A full clone is never fetched here (the resident's read-only tree has an
    // origin it cannot fetch from, by design; its failure stays legible).
    let marker = NAME_STATUS_MARK_LINE.exec(raw);
    if (!marker) {
      const shallow = (await ctx.executor.exec("git rev-parse --is-shallow-repository")).trim() === "true";
      if (shallow) {
        await ctx.executor.exec('git fetch --unshallow --quiet origin "+refs/heads/*:refs/remotes/origin/*"');
        raw = await ctx.executor.exec(listing);
        if (OUTPUT_CUT_RE.test(raw)) return incomplete();
        marker = NAME_STATUS_MARK_LINE.exec(raw);
      }
    }
    // The Executor returns command failures as text (never throws). If the diff
    // failed, an empty listing would render a misleading "no changes" — surface
    // the error instead.
    if (!marker) {
      return `diff_digest: could not compute the diff (base \`${baseName}\`).\n${raw.trim()}`;
    }
    const digest = distillDiffStats(raw.slice(0, marker.index), raw.slice(marker.index + marker[0].length));
    ctx.onDigest?.({ complete: true, base: baseName, totals: digest.totals });
    return digest.text;
  },
};
