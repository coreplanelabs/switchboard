import { shellQuote } from "../execution/shellQuote.js";
import { redactSecrets, stripAnsi, type RunEvent } from "./runEvents.js";
import { systemClock } from "./trace/clock.js";
import type { Span } from "./trace/types.js";
import type { ExecTraceOptions } from "../execution/executor.js";

// The reading diff (features/reading-diff.md): every PR review run publishes a
// `review_artifact` event carrying the change as a reviewer would read it —
// either the full `git diff` or meat.dev's abridged "reading diff" (the
// conceptual meat of the change, style/noise dropped). Which one is a
// config/env switch; the system functions identically either way — the only
// difference is the artifact's `poweredBy` (and meat's one-line summary). meat
// is an external Go binary that makes its OWN model calls from the execution
// environment (it needs ANTHROPIC_API_KEY there, and an Opus-class model —
// measured on a real PR: Opus 4.8 kept 45 % in 96 s; Sonnet 5 kept 87 % in
// 240 s, barely abridging), so every meat failure — binary missing, key
// missing, API error, bad output — falls back to the git provider with the
// reason recorded on the artifact.

export type ReadingDiffProviderName = "git" | "meat";

/** `AppConfig.review.readingDiff` — the deploy-level switch. */
export interface ReadingDiffConfig {
  /** `git` (default): the full diff. `meat`: git PLUS meat.dev's abridged
   *  reading diff as an upgrade artifact. `off`: no artifact is produced (the
   *  run page's on-the-fly command remains the way to get one — roadmap). */
  provider?: "git" | "meat" | "off";
  /** meat's `-model` (e.g. `claude-opus-4-8`). Omit for meat's built-in default. */
  meatModel?: string;
  /** meat's own runtime budget in seconds (the producer's bound, enforced with
   *  `timeout` around the command — never a wait in the pipeline). Default 240. */
  meatTimeoutS?: number;
}

export interface ResolvedReadingDiff {
  provider: ReadingDiffProviderName;
  meatModel?: string;
  meatTimeoutS: number;
}

export const MEAT_TIMEOUT_S_DEFAULT = 240;

/** Config + env → the effective choice, or null for off. The env override
 *  (`SWITCHBOARD_READING_DIFF=git|meat|off`) beats config so an operator can
 *  flip providers on a deployed bot without a config rebuild; an unrecognized
 *  env value is ignored. Absent everything → `git`: the artifact costs one git
 *  command and the panel can rely on it existing. */
export function resolveReadingDiff(
  cfg: ReadingDiffConfig | undefined,
  env: Record<string, string | undefined>,
): ResolvedReadingDiff | null {
  const envRaw = env.SWITCHBOARD_READING_DIFF?.trim().toLowerCase();
  const envChoice = envRaw === "git" || envRaw === "meat" || envRaw === "off" ? envRaw : undefined;
  const choice = envChoice ?? cfg?.provider ?? "git";
  if (choice === "off") return null;
  const timeout =
    typeof cfg?.meatTimeoutS === "number" && cfg.meatTimeoutS > 0
      ? Math.floor(cfg.meatTimeoutS)
      : MEAT_TIMEOUT_S_DEFAULT;
  return { provider: choice, meatTimeoutS: timeout, ...(cfg?.meatModel ? { meatModel: cfg.meatModel } : {}) };
}

/** The one shell command per provider. The range is `origin/<base>...HEAD`
 *  (base falls back to the repository's default branch via `origin/HEAD`),
 *  quoted into one inert token; `--end-of-options` keeps a hostile ref from
 *  being parsed as a git option (same discipline as `diff_digest`). */
export function readingDiffCommand(
  provider: ReadingDiffProviderName,
  baseRef: string | undefined,
  meatModel?: string,
  meatTimeoutS = MEAT_TIMEOUT_S_DEFAULT,
): string {
  const range = shellQuote(`origin/${baseRef ?? "HEAD"}...HEAD`);
  if (provider === "git") return `git diff --no-color --end-of-options ${range}`;
  // meat's runtime bound is enforced HERE, on the producer (coreutils timeout;
  // exit 124 is the executors' documented timeout convention) — the pipeline
  // never waits on meat, so this is the only clock meat answers to.
  const meat = meatModel ? `meat -json -model ${shellQuote(meatModel)} ${range}` : `meat -json ${range}`;
  return `timeout ${Math.floor(meatTimeoutS)} ${meat}`;
}

export interface MeatResult {
  diff: string;
  summary?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** meat's `-json` wire shape (`{smart_diff, summary, input_tokens,
 *  output_tokens, elision}`). Anything else — a shell error line, non-JSON,
 *  JSON without `smart_diff` — throws with a reason the fallback records. */
export function parseMeatJson(raw: string): MeatResult {
  const text = raw.trim();
  if (text === "") throw new Error("meat produced no output");
  if (failedOutput(text)) throw new Error(firstLine(text));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`meat output is not JSON: ${firstLine(text)}`);
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.smart_diff !== "string") throw new Error("meat JSON has no smart_diff");
  return {
    diff: o.smart_diff,
    ...(typeof o.summary === "string" && o.summary.trim() !== "" ? { summary: o.summary.trim() } : {}),
    ...(typeof o.input_tokens === "number" ? { inputTokens: o.input_tokens } : {}),
    ...(typeof o.output_tokens === "number" ? { outputTokens: o.output_tokens } : {}),
  };
}

/** The artifact's diff budget. A diff is kept whole up to this many chars —
 *  run records carry their own byte budget (`fitRecordToBudget`), this cap
 *  keeps one artifact from dominating it. */
export const READING_DIFF_CAP = 120_000;

export function capDiff(diff: string, cap = READING_DIFF_CAP): { diff: string; truncated: boolean } {
  if (diff.length <= cap) return { diff, truncated: false };
  // Never split a surrogate pair at the cut (a lone high surrogate renders as
  // mojibake); secrets cannot be split here because redaction runs BEFORE the
  // cap (`sanitize` below — the redact-then-cap order redactAndCap documents).
  let end = cap;
  const last = diff.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  const omitted = diff.length - end;
  return { diff: `${diff.slice(0, end)}…[${omitted} more chars]`, truncated: true };
}

/** The stream's hygiene contract (`RunRegistry` publishes events as-is): every
 *  string that leaves this module for the stream is control-stripped and
 *  redacted FIRST, capped after — a diff of a PR that accidentally commits a
 *  credential must not carry it onto the run page or the record. */
function sanitize(text: string): string {
  return redactSecrets(stripAnsi(text));
}

/** What `produceReadingDiff` yields — the payload of the `review_artifact`
 *  event minus the event envelope. */
export interface ReadingDiffArtifact {
  poweredBy: ReadingDiffProviderName;
  baseRef: string;
  diff: string;
  truncated: boolean;
  /** meat's one-line summary of the change (meat only). */
  summary?: string;
  /** meat's own model usage for the abridging call(s) (meat only). */
  meatTokens?: { input: number; output: number };
}

function firstLine(s: string): string {
  return s.trim().split("\n", 1)[0].slice(0, 200);
}

/** Executors never throw on nonzero exit — failures arrive as text: the
 *  executors' shared `exit N:` first line, or git's own `fatal:`/`error:`. */
function failedOutput(out: string): boolean {
  return /^(exit \d+|exit [A-Z]+|fatal|error):/i.test(out.trimStart());
}

/** The dispatcher's one call (features/reading-diff.md item 4). Guarantees by
 *  construction, no waits in the pipeline:
 *  - `baseline`: the git artifact, produced concurrently from run start and
 *    published as soon as it exists. The dispatcher JOINS this promise before
 *    the answer publish — a join on a seconds-long command started minutes
 *    earlier, so every PR review's record carries a reading diff
 *    deterministically. Resolves `true` iff published; never rejects.
 *  - `upgrade` (provider `meat` only): meat's abridged artifact, produced
 *    concurrently under meat's OWN runtime budget (`timeout` in the command)
 *    and published the moment it is done. The dispatcher never awaits it: meat
 *    lands iff it finishes within the review — a late publish is dropped by
 *    the registry's finished-run rule, and the baseline still stands. */
export function startReviewReadingDiff(args: {
  executor: { exec(command: string, opts?: ExecTraceOptions): Promise<string> };
  cfg: ReadingDiffConfig | undefined;
  env: Record<string, string | undefined>;
  baseRef: string | undefined;
  publish: (event: RunEvent) => void;
  /** The request's root: each production becomes a `run.reading_diff` /
   *  `run.reading_diff.upgrade` background span under it, `outcome` saying
   *  whether it published, and the diff's exec is that span's child
   *  (features/tracing.md item 18). Absent, nothing is measured. */
  parent?: Span;
}): { baseline: Promise<boolean>; upgrade?: Promise<boolean> } {
  const resolved = resolveReadingDiff(args.cfg, args.env);
  if (!resolved) return { baseline: Promise.resolve(false) };
  const produce = async (provider: ReadingDiffProviderName, span: Span | undefined): Promise<boolean> => {
    try {
      const artifact = await produceReadingDiff(
        args.executor,
        { provider, baseRef: args.baseRef, meatModel: resolved.meatModel, meatTimeoutS: resolved.meatTimeoutS },
        span,
      );
      if (!artifact) return false;
      args.publish({ type: "review_artifact", artifact: "reading_diff", ...artifact, at: systemClock() });
      return true;
    } catch {
      return false;
    }
  };
  const publishArtifact = (provider: ReadingDiffProviderName): Promise<boolean> => {
    if (!args.parent) return produce(provider, undefined);
    const baseline = provider === "git";
    return args.parent.span(baseline ? "run.reading_diff" : "run.reading_diff.upgrade", async (span) => {
      const published = await produce(provider, span);
      span.setAttrs({ outcome: published ? "published" : baseline ? "none" : "did_not_land" });
      return published;
    });
  };
  return {
    baseline: publishArtifact("git"),
    ...(resolved.provider === "meat" ? { upgrade: publishArtifact("meat") } : {}),
  };
}

/** Produce ONE provider's reading diff with the run's own executor (read-only
 *  commands in the run's workspace). Any failure — meat missing, its key
 *  missing, a git error, an empty diff — yields null, never a throw into the
 *  run that owns the executor; the baseline/upgrade split above is what keeps
 *  an artifact guaranteed. */
export async function produceReadingDiff(
  executor: { exec(command: string, opts?: ExecTraceOptions): Promise<string> },
  opts: { provider: ReadingDiffProviderName; baseRef: string | undefined; meatModel?: string; meatTimeoutS?: number },
  /** The production's own span; the executor's `exec.exec` hangs under it. */
  span?: Span,
): Promise<ReadingDiffArtifact | null> {
  const baseRef = opts.baseRef ?? "HEAD";
  try {
    const out = await executor.exec(
      readingDiffCommand(opts.provider, opts.baseRef, opts.meatModel, opts.meatTimeoutS),
      span ? { span } : undefined,
    );
    if (opts.provider === "meat") {
      const meat = parseMeatJson(out); // throws → null below (the baseline covers)
      const capped = capDiff(sanitize(meat.diff));
      return {
        poweredBy: "meat",
        baseRef,
        diff: capped.diff,
        truncated: capped.truncated,
        // meat's summary is model prose generated FROM the diff — same hygiene.
        ...(meat.summary ? { summary: sanitize(meat.summary) } : {}),
        ...(meat.inputTokens !== undefined && meat.outputTokens !== undefined
          ? { meatTokens: { input: meat.inputTokens, output: meat.outputTokens } }
          : {}),
      };
    }
    if (out.trim() === "" || failedOutput(out)) return null;
    const capped = capDiff(sanitize(out));
    return { poweredBy: "git", baseRef, diff: capped.diff, truncated: capped.truncated };
  } catch {
    return null;
  }
}
