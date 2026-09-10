import { shellQuote } from "../execution/shellQuote.js";
import { redactSecrets, stripAnsi, type RunEvent } from "./runEvents.js";
import { systemClock } from "./trace/clock.js";
import type { Span } from "./trace/types.js";
import type { ExecTraceOptions } from "../execution/executor.js";

// The reading diff (docs/reference/specs/reading-diff.md): every PR review run publishes a
// `review_artifact` event carrying the change as a reviewer would read it —
// the full `git diff`, produced by the run's own executor concurrently with
// the review and joined before the answer, so every review's record carries
// one deterministically. This module is that BASELINE. The abridged reading
// diff (meat.dev's "conceptual meat" of the change) is a second artifact on the
// same record, produced AFTER the review on the bot host — reviewAbridge.ts,
// on demand (`review abridge <id>`) or automatically when
// `review.readingDiff.provider` is `meat`. Nothing here runs meat, and no
// execution container ever sees the Anthropic credential.

export type ReadingDiffProviderName = "git" | "meat";

/** `AppConfig.review.readingDiff` — the deploy-level switch. */
export interface ReadingDiffConfig {
  /** `git` (default): the full diff on every review; the abridged one on
   *  demand. `meat`: git PLUS an automatic abridged diff once the record is
   *  durable (one Opus-class call per review). `off`: no artifact is produced,
   *  so there is nothing to abridge either. */
  provider?: "git" | "meat" | "off";
  /** meat's `-model`. Default `claude-opus-5` — an Opus-class model is the
   *  measured minimum for a diff that is actually abridged. */
  meatModel?: string;
  /** meat's own runtime budget in seconds, enforced on the host process (the
   *  child is killed past it; a `failed` state, never a wait in a review). Default 240. */
  meatTimeoutS?: number;
}

export interface ResolvedReadingDiff {
  provider: ReadingDiffProviderName;
  /** Set whenever `provider` is `meat`. */
  meatModel?: string;
  meatTimeoutS: number;
}

export const MEAT_TIMEOUT_S_DEFAULT = 240;

/** meat's `-model` when config names none. Measured on a real PR: Opus 4.8
 *  kept 45 % in 96 s with everything kept load-bearing; Sonnet 5 kept 87 % in
 *  240 s, barely abridging — an Opus-class model is the floor. */
export const MEAT_MODEL_DEFAULT = "claude-opus-5";

/** Config + env → the effective choice, or null for off. The env override
 *  (`SWITCHBOARD_READING_DIFF=git|meat|off`) beats config so an operator can
 *  flip providers on a deployed bot without a config rebuild; an unrecognized
 *  env value is ignored. Absent everything → `git`: the artifact costs one git
 *  command and the panel can rely on it existing. With `meat`, `meatModel`
 *  falls back to `MEAT_MODEL_DEFAULT`. */
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
  const meatModel = cfg?.meatModel || (choice === "meat" ? MEAT_MODEL_DEFAULT : undefined);
  return { provider: choice, meatTimeoutS: timeout, ...(meatModel ? { meatModel } : {}) };
}

/** The one shell command of the baseline. The range is `origin/<base>...HEAD`
 *  (base falls back to the repository's default branch via `origin/HEAD`),
 *  quoted into one inert token; `--end-of-options` keeps a hostile ref from
 *  being parsed as a git option (same discipline as `diff_digest`). */
export function readingDiffCommand(baseRef: string | undefined): string {
  const range = shellQuote(`origin/${baseRef ?? "HEAD"}...HEAD`);
  return `git diff --no-color --end-of-options ${range}`;
}

export interface MeatResult {
  diff: string;
  summary?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** meat's `-json` wire shape (`{smart_diff, summary, input_tokens,
 *  output_tokens, elision}`). Anything else — a shell error line, non-JSON,
 *  JSON without `smart_diff` — throws with a reason the caller records. */
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
  // cap (`sanitizeArtifactText` — the redact-then-cap order redactAndCap documents).
  let end = cap;
  const last = diff.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  const omitted = diff.length - end;
  return { diff: `${diff.slice(0, end)}…[${omitted} more chars]`, truncated: true };
}

/** The stream's hygiene contract (`RunRegistry` publishes events as-is): every
 *  string that leaves for the stream or the record is control-stripped and
 *  redacted FIRST, capped after — a diff of a PR that accidentally commits a
 *  credential must not carry it onto the run page or the record. Shared with
 *  the host-side abridger (reviewAbridge.ts), whose artifact reaches the same
 *  record. */
export function sanitizeArtifactText(text: string): string {
  return redactSecrets(stripAnsi(text));
}

/** What `produceReadingDiff` yields — the payload of the `review_artifact`
 *  event minus the event envelope. */
export interface ReadingDiffArtifact {
  poweredBy: "git";
  baseRef: string;
  diff: string;
  truncated: boolean;
}

function firstLine(s: string): string {
  return s.trim().split("\n", 1)[0].slice(0, 200);
}

/** Executors never throw on nonzero exit — failures arrive as text: the
 *  executors' shared `exit N:` first line, or git's own `fatal:`/`error:`. */
function failedOutput(out: string): boolean {
  return /^(exit \d+|exit [A-Z]+|fatal|error):/i.test(out.trimStart());
}

/** The dispatcher's one call (docs/reference/specs/reading-diff.md item 4): the git
 *  baseline, produced concurrently from run start and published as soon as it
 *  exists. The dispatcher JOINS this promise before the answer publish — a
 *  join on a seconds-long command started minutes earlier, so every PR
 *  review's record carries a reading diff deterministically. Resolves `true`
 *  iff published; never rejects. `off` → resolves false, nothing runs. */
export function startReviewReadingDiff(args: {
  executor: { exec(command: string, opts?: ExecTraceOptions): Promise<string> };
  cfg: ReadingDiffConfig | undefined;
  env: Record<string, string | undefined>;
  baseRef: string | undefined;
  publish: (event: RunEvent) => void;
  /** The request's root: the production becomes a `run.reading_diff`
   *  background span under it, `outcome` saying whether it published, and the
   *  diff's exec is that span's child (docs/reference/specs/tracing.md item 18).
   *  Absent, nothing is measured. */
  parent?: Span;
}): { baseline: Promise<boolean> } {
  if (!resolveReadingDiff(args.cfg, args.env)) return { baseline: Promise.resolve(false) };
  const produce = async (span: Span | undefined): Promise<boolean> => {
    try {
      const artifact = await produceReadingDiff(args.executor, { baseRef: args.baseRef }, span);
      if (!artifact) return false;
      args.publish({ type: "review_artifact", artifact: "reading_diff", ...artifact, at: systemClock() });
      return true;
    } catch {
      return false;
    }
  };
  if (!args.parent) return { baseline: produce(undefined) };
  return {
    baseline: args.parent.span("run.reading_diff", async (span) => {
      const published = await produce(span);
      span.setAttrs({ outcome: published ? "published" : "none" });
      return published;
    }),
  };
}

/** Produce the git reading diff with the run's own executor (a read-only
 *  command in the run's workspace). Any failure — a git error, an executor
 *  throw, an empty diff — yields null, never a throw into the run that owns
 *  the executor. */
export async function produceReadingDiff(
  executor: { exec(command: string, opts?: ExecTraceOptions): Promise<string> },
  opts: { baseRef: string | undefined },
  /** The production's own span; the executor's `exec.exec` hangs under it. */
  span?: Span,
): Promise<ReadingDiffArtifact | null> {
  const baseRef = opts.baseRef ?? "HEAD";
  try {
    const out = await executor.exec(readingDiffCommand(opts.baseRef), span ? { span } : undefined);
    if (out.trim() === "" || failedOutput(out)) return null;
    const capped = capDiff(sanitizeArtifactText(out));
    return { poweredBy: "git", baseRef, diff: capped.diff, truncated: capped.truncated };
  } catch {
    return null;
  }
}
