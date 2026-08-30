import type { CompletionResult, TokenUsage } from "../providers/types.js";

// Run visibility (Area 2 / R12): a typed stream of what an agent is doing —
// tool calls and their (redacted, summarized) results — emitted by the runner.
// Today the in-channel status card consumes it live; the external live-view
// page (a follow-up) will consume the same stream. Keeping it a small typed
// seam here means neither consumer reaches into the runner's internals.

//
// Timing + lifecycle (Area 7b / #84): every event carries an optional `at`
// (epoch ms, stamped by the runner's injectable clock) so the run-friction
// analyzer (`runFriction.ts`) can attribute delay; a `tool_result` marks exec-
// INFRASTRUCTURE failures (`infra: true`, an `ExecInfraError` — the sandbox, not
// the command) so they are never confused with an ordinary nonzero exit; and
// `run_note` events carry the runner's lifecycle notices (wrap-up warning, budget
// exhaustion, dead sandbox) as typed kinds instead of only free-text progress.
// All additive: consumers that only know tool_call/tool_result keep working.

/** Typed lifecycle notices the runner emits alongside its `onProgress` text.
 *  `stop_requested` is published by the registry when an operator asks the run
 *  to stop from /runs (#101); `stopped` by the runner when it honors it. */
export type RunNoteKind =
  | "wrap_up"
  | "time_budget_exhausted"
  | "turn_budget_exhausted"
  | "sandbox_dead"
  | "stop_requested"
  | "stopped";

/** How an operator asked a run to stop (#101): `soft` — take no new steps and
 *  wrap up through the normal finale; `hard` — abort the in-flight call now, no
 *  finale, tear the workspace down. */
export type StopMode = "soft" | "hard";

export type RunEvent =
  /** `callId` is the provider's tool_use id — the explicit pair key between a
   *  call and its result (live-view item 13); absent only on legacy captures. */
  | { type: "tool_call"; tool: string; summary: string; callId?: string; at?: number }
  /** `ok` is "the tool succeeded": false when it threw AND (bash) when the
   *  command exited nonzero. `exitCode` rides on bash results (parsed from the
   *  executors' shared `exit N:` prefix, 0 for a clean run; absent when the code
   *  was not numeric). `output` is the tool's text — control-stripped, redacted,
   *  capped at TOOL_OUTPUT_CAP — for the run page's expandable card; the status
   *  card and the friction analyzer keep reading `summary`. */
  | {
      type: "tool_result";
      tool: string;
      ok: boolean;
      summary: string;
      callId?: string;
      exitCode?: number;
      output?: string;
      infra?: true;
      at?: number;
    }
  /** `mode` rides only on the stop notes (`stop_requested` / `stopped`). */
  | { type: "run_note"; kind: RunNoteKind; summary: string; mode?: StopMode; at?: number }
  /** The run's final answer — the same text the channel reply/PR post is
   *  projected from, redacted like every event (NOT capped: the run record is
   *  the source of truth, the summaries are). Published by the dispatcher once
   *  per run, before the reply goes out; absent when an AGENT run threw (the
   *  card shows ❌). An inline command run that throws still publishes one —
   *  the `⚠️ <error>` reply — so its record explains the `failed` status. */
  | { type: "answer"; text: string; at?: number }
  /** The request as received (directives stripped, attachments noted as a
   *  one-line suffix), redacted, uncapped. Published by the dispatcher once per
   *  run, right after the run is registered — the first event of the record, so
   *  the run page can lead with what was asked (features/live-view.md item 12). */
  | {
      type: "input";
      text: string;
      /** Where the request came from, for the Request block: the channel and
       *  user display names and a link back to the triggering message —
       *  whatever the adapter supplied (all optional). */
      source?: { url?: string; channel?: string; user?: string };
      at?: number;
    }
  /** The model's prose BETWEEN tool calls — text content that rode alongside
   *  tool_use in one completion. Emitted by the runner, redacted, uncapped. The
   *  final text-only completion is NOT one of these (that is the `answer`). */
  | { type: "assistant"; text: string; at?: number }
  /** One model call, as the runner saw it (live-view item 15): emitted when the
   *  provider returns, BEFORE the `assistant`/`tool_call` events that call
   *  produced — so a reader sees "thought for 5m 04s" above what the thinking
   *  led to, the way Claude Code / ChatGPT / Cursor show it. `at` is when the
   *  call returned; `startedAt` + `durationMs` are from the runner's clock, so
   *  `at - startedAt === durationMs`. `usage` rides only when the provider
   *  reported token counts. Shape follows the OTel GenAI `chat` span (duration,
   *  stop reason, input/output tokens) so it exports without translation. */
  | { type: "turn"; startedAt: number; durationMs: number; stopReason: CompletionResult["stopReason"]; usage?: TokenUsage; at?: number };

// Credential shapes we must never surface in a run-visibility stream (which may
// be shown in-channel or on a shared page). Two layers: (1) specific known
// formats (below), and (2) a name-gated assignment pass (redactNamedAssignments)
// that hides the VALUE of any `…SECRET`/`…KEY`/`…TOKEN`-style identifier. We
// redact recognized shapes rather than any long string, to avoid mangling
// legitimate output (SHAs, UUIDs, digests, version numbers all pass through).
const REDACT: Array<{ re: RegExp; replace: string }> = [
  // PEM private keys — full block (incl. \n-escaped inside JSON) and a bare header.
  { re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, replace: "«redacted-private-key»" },
  { re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, replace: "«redacted-private-key»" },
  // URL / connection-string basic-auth: scheme://user:password@host
  { re: /([a-z][a-z0-9+.\-]*:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi, replace: "$1$2:«redacted»@" },
  // curl -u user:pass
  { re: /(^|\s)(-u|--user)(\s+|=)\S+:\S+/g, replace: "$1$2$3«redacted»" },
  // HTTP auth headers (Bearer / Basic / token) and bare Bearer tokens
  { re: /\b(Authorization\s*:\s*)(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=\-]{8,}/gi, replace: "$1$2 «redacted»" },
  { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/\-]{12,}=*/g, replace: "Bearer «redacted»" },
  // Cookies (whole header value)
  { re: /\b((?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi, replace: "$1«redacted»" },
  // Provider / cloud token formats
  { re: /xox[baprs]-[A-Za-z0-9-]{8,}/g, replace: "«redacted-slack-token»" },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: "«redacted-github-token»" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, replace: "«redacted-github-pat»" },
  { re: /x-access-token:[^@\s/'"]+/gi, replace: "x-access-token:«redacted»" },
  { re: /sk-ant-[A-Za-z0-9_-]{16,}/g, replace: "«redacted-anthropic-key»" },
  { re: /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, replace: "«redacted-api-key»" },
  { re: /AKIA[0-9A-Z]{16}/g, replace: "«redacted-aws-key»" },
  { re: /AIza[0-9A-Za-z_\-]{35}/g, replace: "«redacted-gcp-key»" },
  { re: /\b(?:whsec|sk_live|sk_test|rk_live|pk_live)_[A-Za-z0-9]{16,}/g, replace: "«redacted-stripe-key»" },
];

// An identifier component (split on _ or -) that marks its assignment's value as
// secret. Matched case-insensitively against each component, so `AWS_SECRET_
// ACCESS_KEY` (…SECRET, …KEY) and `STRIPE_WEBHOOK_SECRET` are caught while
// `PORT`, `REACT_VERSION`, `DATABASE_URL`, `MONKEY_BARS` are not.
const SECRET_COMPONENT = /^(secret|token|password|passwd|pwd|credential|credentials|key|apikey|auth|session|sessionid|cookie)$/i;

/** Redact the VALUE of any `<name> = value` / `<name>: value` where the name has
 *  a secret-marking component. Handles quoted values (with spaces) and unquoted.
 *  Name-gated so ordinary config assignments are untouched. */
function redactNamedAssignments(text: string): string {
  return text.replace(
    /([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)(\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]{4,})/g,
    (whole, id: string, sep: string, val: string) => {
      if (!id.split(/[_-]/).some((p) => SECRET_COMPONENT.test(p))) return whole;
      const quote = val[0] === '"' || val[0] === "'" ? val[0] : "";
      return `${id}${sep}${quote}«redacted»${quote}`;
    },
  );
}

/** Strip known credential formats from text before it enters a run-visibility
 *  stream: specific shapes first, then the name-gated assignment pass. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of REDACT) out = out.replace(re, replace);
  return redactNamedAssignments(out);
}

// Terminal control sequences: CSI (`ESC [ … final`, covers SGR colors, cursor
// moves, erase), OSC (`ESC ] … BEL|ST`, covers hyperlinks/titles; an OSC cut
// off by truncation is stripped to end of line so its payload never shows),
// two-byte ESC sequences, plus C0 controls other than \n and \t (so \r is
// dropped too: CRLF becomes \n and progress-bar rewrites collapse). Tool
// output from vitest/git/npm carries these; a browser drops the ESC byte and
// shows the bare `[32m` remainder, so strip the whole sequence before display.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** Remove terminal escape/control sequences, leaving printable text, `\n`, `\t`.
 *  Callers strip BEFORE redactSecrets: an escape embedded mid-token would
 *  otherwise split a secret across the redaction regex and let it leak. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Redact THEN cap — the correct order for a length-limited display string, so a
 *  secret near a truncation boundary can never be emitted as a raw fragment. */
export function redactAndCap(text: string, cap = 200): string {
  const redacted = redactSecrets(stripAnsi(text));
  return redacted.length > cap ? `${redacted.slice(0, cap)}…` : redacted;
}

const SUMMARY_CAP = 200;

/** One-line, control-stripped, redacted, length-capped summary of a tool's output for the run
 *  stream — the first non-empty line plus a size note. */
export function summarizeToolResult(output: string): string {
  return summarizeClean(redactSecrets(stripAnsi(output)));
}

/** `summarizeToolResult` for text that is ALREADY control-stripped and redacted. */
function summarizeClean(clean: string): string {
  const trimmed = clean.trim();
  if (trimmed === "") return "(no output)";
  const firstLine = trimmed.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const head = firstLine.length > SUMMARY_CAP ? `${firstLine.slice(0, SUMMARY_CAP)}…` : firstLine;
  const lineCount = trimmed.split("\n").length;
  const more = trimmed.length > head.length ? ` (${trimmed.length} chars${lineCount > 1 ? `, ${lineCount} lines` : ""})` : "";
  return head + more;
}

/** Every executor renders a nonzero command exit as an `exit <code>:` first line
 *  (`LocalExecutor.exec`, `ResidentExecutor.exec`, `CloudflareSandboxExecutor.exec`)
 *  so the model sees the status. This is the single reader of that contract.
 *  `failed` is true for any such prefix; `exitCode` is the code when numeric
 *  (execFile can report an errno string instead). Ordinary output — including
 *  text that merely mentions "exit 1:" later on — is a clean 0. */
export function parseExitPrefix(output: string): { failed: boolean; exitCode?: number } {
  const m = /^\s*exit (\S+?):/.exec(stripAnsi(output));
  if (!m) return { failed: false, exitCode: 0 };
  return /^\d+$/.test(m[1]) ? { failed: true, exitCode: Number(m[1]) } : { failed: true };
}

/** Upper bound on a `tool_result.output` — large enough for a test run or a
 *  diff to read in full on the run page, small enough that the registry's
 *  1000-event backlog stays in the low megabytes worst case. */
export const TOOL_OUTPUT_CAP = 8_000;

/** The full tool output as it may leave the process: control-stripped, then
 *  redacted, then capped (that order — see redactAndCap). Empty output → "". */
export function prepareToolOutput(output: string): string {
  return capClean(redactSecrets(stripAnsi(output)));
}

/** `prepareToolOutput` for text that is ALREADY control-stripped and redacted. */
function capClean(clean: string): string {
  const text = clean.trim();
  if (text.length <= TOOL_OUTPUT_CAP) return text;
  return `${text.slice(0, TOOL_OUTPUT_CAP)}…[${text.length - TOOL_OUTPUT_CAP} more chars]`;
}

/** Both `tool_result` display fields from ONE strip+redact pass. The redaction
 *  battery is ~20 regexes over up to 120k chars of raw tool output; paying it
 *  once per result instead of twice (summary, then output) halves the
 *  synchronous CPU the runner spends per tool call. Byte-identical to calling
 *  `summarizeToolResult` and `prepareToolOutput` separately. */
export function prepareToolResult(output: string): { summary: string; output: string } {
  const clean = redactSecrets(stripAnsi(output));
  return { summary: summarizeClean(clean), output: capClean(clean) };
}

/** `5m 04s` / `1.3s` / `800ms` — the one duration format every surface that
 *  names a model turn uses (status card, CLI; the page's inlined timeline has
 *  its own copy because it cannot import). */
export function formatTurnDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms - m * 60_000) / 1000);
  return `${m}m ${s < 10 ? "0" : ""}${s}s`;
}
