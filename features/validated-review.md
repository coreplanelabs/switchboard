# Validated review + distilled diffs

Two behaviors that make agent PRs easier to trust (R14, R15):

- **R14 — distilled diffs.** When the coding agent opens a PR it includes a *distilled* summary of the change, not the raw diff: per-file `+adds/-dels`, totals, and a "risky files" section that flags migrations/schema, auth/permission-sensitive files, whole-file deletions, lockfiles, and very large files. A reviewer sees the shape and the danger zones at a glance.
- **R15 — validated review.** The review agent doesn't only read the diff — in its resident worktree (dependencies already warm) it actually **runs the project's tests and build** and reports exactly what it ran and whether each passed or failed, alongside its findings. It also uses the distilled digest to orient before reading.

The parsing/rendering core is `distillDiff`, a pure `string -> string` function (no I/O, no process, no platform SDK), so it is provider- and channel-agnostic and unit-testable in isolation. The `diff_digest` tool is the only thing that touches the world, and only through the `Executor` seam — never a direct shell-out — honoring the "tools never touch the host directly" invariant.

- **Code**: `src/core/diffDigest.ts` (the pure `distillDiff`); `src/tools/workspace.ts` (the `diff_digest` `RunnableTool` + `full`/`readonly` toolset wiring; reuses `src/execution/shellQuote.ts` to quote the base ref); `src/agents/registry.ts` (`CODING_SYSTEM_RESIDENT` puts the digest in the PR body; `REVIEW_SYSTEM_RESIDENT` runs tests/build and reports pass/fail).
- **Tests**: `src/core/diffDigest.test.ts`, `src/tools/workspace.test.ts`, `src/agents/registry.test.ts`.

## Behavior

1. **`distillDiff` is pure and provider-agnostic** (R14 core): unified git diff in, compact digest out — totals line, per-file `+adds/-dels` (largest churn first), and a risky-files section. No Executor, no filesystem, no network. Empty/whitespace input returns a clear "no changes" message.
2. **Per-file/total counts are parsed from the diff**: added lines (`+`, not `+++`), removed lines (`-`, not `---`), per file and summed. File status (added / deleted / renamed / binary) is detected from the git metadata; deleted-file paths resolve from the old (`a/`) side, new files from the new (`b/`) side. Binary files count zero content lines. Parsing tolerates a malformed/absent `@@` hunk header without throwing.
3. **Risky-file heuristics** (biased to over-flag — a false positive costs one glance, a missed migration costs more): path matches for migrations/schema (`migrations/`, `*.sql`, `*.prisma`, `schema`), auth/permission (`auth`, `permission`, `credential`, `secret`, `password`, `.env`, `login`, `session`, `oauth`, `rbac`, `acl`); whole-file deletions; lockfiles (exact basename: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`, …); and single-file churn ≥ 300 lines. Ordinary source files are not flagged.
4. **`diff_digest` tool bridges the Executor** (R14): runs `git diff <base>...HEAD` via `ctx.executor.exec` and renders the output with `distillDiff`. `base` is optional and defaults to the repo's default branch (`origin/HEAD`, falling back to `origin/main`). A caller-supplied base is `shellQuote`d into one inert token (no shell injection). A git failure (`fatal:`/`exit`/…) is surfaced as an error, never rendered as a misleading empty diff.
5. **Enablement**: `diff_digest` is in the `full` (coding) and `readonly` (review) toolsets; `web` and `none` are unchanged. ≥2-implementations and channel-agnostic invariants hold — `distillDiff` is our own implementation and does not depend on `meat.dev` (absent from the node-only resident image).
6. **Coding agent includes the digest in the PR body** (R14): the resident coding prompt directs the agent to call `diff_digest` before opening the PR and put the distilled digest — not the raw diff — in the body.
7. **Review agent runs validation** (R15): the resident review prompt directs the agent, in its gather phase, to use `diff_digest` to orient and to run the project's own tests and build in the warm worktree, then report exactly what it ran and each command's pass/fail result alongside its findings. It stays read-only — running tests never modifies tracked code, commits, or pushes — and keeps the existing "gather once, analyze once" discipline.

## Validation criteria

| Criterion | Evidence |
|-----------|----------|
| distillDiff computes correct per-file and total add/delete counts | `[unit]` `src/core/diffDigest.test.ts::distillDiff::computes correct per-file and total add/delete counts`, `::uses singular wording for a single-file diff` |
| File status labeled; deleted paths resolved from the a/ side; binaries counted as zero | `[unit]` `::labels file status (added / deleted) and resolves deleted paths from the a/ side`, `::detects binary files without counting content lines` |
| Risky flags: migration, auth, whole-file deletion, lockfile, large file; ordinary files not flagged | `[unit]` `::flags risky files: migration, auth, whole-file deletion, lockfile`, `::flags a very large file by total churn`, `::does not flag ordinary source files as risky` |
| Empty diff and malformed-hunk tolerance | `[unit]` `::returns an empty-diff message for empty or whitespace input`, `::tolerates a malformed hunk (missing @@ header) without throwing` |
| diff_digest tool distills executor output; diffs against provided base; defaults to origin/HEAD | `[unit]` `src/tools/workspace.test.ts::diff_digest tool::distills the diff the executor returns`, `::diffs against the provided base ref`, `::defaults to the repo's default branch (origin/HEAD) when no base is given` |
| diff_digest surfaces git failures; base ref is not shell-injectable | `[unit]` `::diff_digest tool::surfaces a git failure instead of reporting an empty diff`, `::does not shell-inject through the base ref` |
| Enablement: diff_digest in full + readonly, not web/none | `[unit]` `src/tools/workspace.test.ts::diff_digest toolset wiring::is in the coding (full) and review (readonly) toolsets, not web/none` |
| Coding resident prompt puts the distilled digest (not the raw diff) in the PR body | `[unit]` `src/agents/registry.test.ts::validated-review prompt behavior (resident variants)::coding resident: calls diff_digest and puts the distilled digest in the PR body (R14)` |
| Review resident prompt runs tests + build, reports pass/fail, orients with the digest, stays read-only + gather-once | `[unit]` `::review resident: runs tests + build and reports what it ran + pass/fail (R15)`, `::review resident keeps the gather-once discipline` |
| Live: coding PR body actually carries a distilled digest; review actually runs the tests/build and reports real pass/fail | `[agent]` (post-deploy) — pending. Send `agent:coding …` and confirm the opened PR body contains a "Diff digest" block; send `agent:review <PR>` and confirm the reply names the test/build commands run and their results. Requires the resident deployment. |
