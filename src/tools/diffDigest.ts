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

import { distillDiffStats, type DigestRange, type DigestReport } from "../core/diffDigest.js";
import { redactAndCap } from "../core/redact.js";
import { shellQuote } from "../execution/shellQuote.js";
import { gitInCheckout } from "../execution/workspaceAdvance.js";
import type { RunnableTool } from "./runnableTool.js";

const NAME_STATUS_MARK = "@@diff_digest:name-status@@";
// The marker as a whole line: a path can carry the marker text inside a
// `adds\tdels\tpath` line, so only the line we echoed ourselves separates the
// two listings.
const NAME_STATUS_MARK_LINE = /^@@diff_digest:name-status@@$/m;

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
    const target = ctx.digestTarget?.();
    const baseName = base || (target ? `origin/${target.baseRef}` : "origin/HEAD");
    let observedRange: DigestRange | undefined;
    const report = (
      value: DigestReport,
      reason?: "review_target_unavailable" | "listing_truncated" | "range_unconfirmed" | "command_failed",
    ) => {
      if (reason)
        console.log(
          JSON.stringify({
            event: "review_digest_refused",
            repo: ctx.repo,
            agent: ctx.agentName,
            // Caller expressions can contain private data. Keep only the
            // bounded source category; the controller already supplies pins.
            base: base ? "custom" : target ? "canonical" : "origin/HEAD",
            pr: ctx.reviewHistory?.target.number,
            head: target && /^[0-9a-f]{40}$/i.test(target.head) ? target.head : undefined,
            baseRef: target?.baseRef,
            reason,
          }),
        );
      ctx.onDigest?.({ ...value, ...(observedRange ? { range: observedRange } : {}) });
    };
    if (ctx.digestTarget && (!target || !/^[0-9a-f]{40}$/i.test(target.head))) {
      report(
        { complete: false, base: baseName, reason: "the canonical review range is unavailable" },
        "review_target_unavailable",
      );
      return "diff_digest: the canonical review range is unavailable.";
    }
    // git OPTION injection (distinct from shell injection): a base like
    // `--output=/path` or `-O/etc/passwd` is parsed by GIT itself as an option
    // — arbitrary file write/read — even though the shell token is inert. Reject
    // a leading dash, and pass `--end-of-options` so git treats the token as a
    // revision regardless.
    if (base.startsWith("-")) {
      return "diff_digest: base ref may not start with '-' (rejected to prevent git option injection).";
    }
    const git = gitInCheckout(ctx.checkout?.());
    // Quote a caller-supplied base into one inert shell token so it can't break
    // out of the argument. No base → resolve the default branch at run time,
    // falling back to origin/main when origin/HEAD isn't set.
    const baseExpr = base
      ? shellQuote(base)
      : `"$(${git} rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)"`;
    const selectedBase = base || (target ? `origin/${target.baseRef}` : undefined);
    const range = target ? '"$digest_base..$digest_head"' : `--end-of-options ${baseExpr}...HEAD`;
    const pin = target
      ? `digest_head=$(${git} rev-parse --verify HEAD) && ` +
        `digest_base=$(${git} rev-parse --verify --end-of-options ${shellQuote(`${selectedBase}^{commit}`)}) && ` +
        `digest_target=$(${git} rev-parse --verify --end-of-options ${shellQuote(`origin/${target.baseRef}^{commit}`)}) && ` +
        `digest_base=$(${git} merge-base "$digest_base" "$digest_head") && ` +
        `digest_target=$(${git} merge-base "$digest_target" "$digest_head") && ` +
        `printf '%s\\n' '@@diff_digest:range@@' "$digest_base" "$digest_head" "$digest_target" && `
      : "";
    const listing = `${pin}${git} diff --numstat ${range} && echo ${NAME_STATUS_MARK} && ${git} diff --name-status ${range}`;
    const failed = (detail: string): string => {
      report(
        { complete: false, base: baseName, reason: "the Git command did not complete successfully" },
        "command_failed",
      );
      return `diff_digest: could not compute the diff (base \`${baseName}\`).\n${redactAndCap(detail, 1000)}`;
    };
    const execute = ctx.executor.execResult?.bind(ctx.executor);
    if (!execute) return failed("structured command outcomes are unavailable");
    let result = await execute(listing);
    let raw = result.stdout;
    const readRange = () => {
      const match = /^@@diff_digest:range@@\n([0-9a-f]{40})\n([0-9a-f]{40})\n([0-9a-f]{40})\n/.exec(raw);
      observedRange =
        target && match && match[2] === target.head.toLowerCase()
          ? { base: match[1], head: match[2], canonicalBase: match[3], baseRef: target.baseRef }
          : undefined;
    };
    // This fixed prefix is a complete machine frame even when the later
    // file listing is cut. It binds retention, never totals from that cut.
    readRange();
    const incomplete = (): string => {
      const reason = "the file listing exceeded the executor's output cap";
      report({ complete: false, base: baseName, reason }, "listing_truncated");
      return `diff_digest: ${reason} — the digest cannot state totals for this change (base \`${baseName}\`). Read the diff file by file (\`git diff --name-only ${baseName}...HEAD\`).`;
    };
    // Native stream caps can be smaller than the display renderer's cap.
    // Only the structured result proves that both listings arrived in full.
    if (result.truncated) return incomplete();
    let marker = NAME_STATUS_MARK_LINE.exec(raw);
    if (result.exitCode !== 0 && !marker) {
      // A shallow clone can lack the merge base. Deepen once only after a
      // complete, successful observation; an unknown fetch is never replayed.
      const shallow = await execute(`${git} rev-parse --is-shallow-repository`);
      if (shallow.exitCode !== 0 || shallow.truncated) return failed(shallow.stderr || shallow.stdout);
      if (shallow.stdout.trim() === "true") {
        const fetched = await execute(`${git} fetch --unshallow --quiet origin "+refs/heads/*:refs/remotes/origin/*"`);
        if (fetched.exitCode !== 0 || fetched.truncated) return failed(fetched.stderr || fetched.stdout);
        result = await execute(listing);
        raw = result.stdout;
        readRange();
        if (result.truncated) return incomplete();
        marker = NAME_STATUS_MARK_LINE.exec(raw);
      }
    }
    if (result.exitCode !== 0 || !marker) return failed(result.stderr || result.stdout);
    if (target && !observedRange) {
      const reason = "the digest did not confirm the pinned review head and base";
      report({ complete: false, base: baseName, reason }, "range_unconfirmed");
      return `diff_digest: ${reason}.`;
    }
    const digest = distillDiffStats(raw.slice(0, marker.index), raw.slice(marker.index + marker[0].length));
    report({ complete: true, base: baseName, totals: digest.totals });
    return digest.text;
  },
};
