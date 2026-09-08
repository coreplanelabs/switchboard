/** Redaction and display-safety helpers shared by every surface that shows text
 *  it did not write: run-visibility streams, Slack cards and replies, resident
 *  state and error bodies, GitHub error messages. Node-free and import-free so
 *  the Workers can import it by relative path. */

// Credential shapes we must never surface in a run-visibility stream (which may
// be shown in-channel or on a shared page). Two layers: (1) specific known
// formats (below), and (2) a name-gated assignment pass (redactNamedAssignments)
// that hides the VALUE of any `…SECRET`/`…KEY`/`…TOKEN`-style identifier. We
// redact recognized shapes rather than any long string, to avoid mangling
// legitimate output (SHAs, UUIDs, digests, version numbers all pass through).
const REDACT: Array<{ re: RegExp; replace: string }> = [
  // PEM private keys — full block (incl. \n-escaped inside JSON) and a bare header.
  {
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replace: "«redacted-private-key»",
  },
  { re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, replace: "«redacted-private-key»" },
  // URL / connection-string basic-auth: scheme://user:password@host
  // Anchored to the start of a scheme-character run (not `\b`): one attempt per
  // run keeps a long pasted token linear, and `1https://u:p@h` still redacts.
  { re: /(?<![a-z0-9+.-])([a-z0-9+.-]+:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi, replace: "$1$2:«redacted»@" },
  // curl -u user:pass
  { re: /(^|\s)(-u|--user)(\s+|=)\S+:\S+/g, replace: "$1$2$3«redacted»" },
  // HTTP auth headers (Bearer / Basic / token) and bare Bearer tokens
  { re: /\b(Authorization\s*:\s*)(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "$1$2 «redacted»" },
  { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g, replace: "Bearer «redacted»" },
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
  { re: /AIza[0-9A-Za-z_-]{35}/g, replace: "«redacted-gcp-key»" },
  { re: /\b(?:whsec|sk_live|sk_test|rk_live|pk_live)_[A-Za-z0-9]{16,}/g, replace: "«redacted-stripe-key»" },
];

// An identifier component (split on _ or -) that marks its assignment's value as
// secret. Matched case-insensitively against each component, so `AWS_SECRET_
// ACCESS_KEY` (…SECRET, …KEY) and `STRIPE_WEBHOOK_SECRET` are caught while
// `PORT`, `REACT_VERSION`, `DATABASE_URL`, `MONKEY_BARS` are not.
const SECRET_COMPONENT =
  /^(secret|token|password|passwd|pwd|credential|credentials|key|apikey|auth|session|sessionid|cookie)$/i;

/** Redact the VALUE of any `<name> = value` / `<name>: value` where the name has
 *  a secret-marking component. Handles quoted values (with spaces) and unquoted,
 *  and a quoted NAME (`"password": "…"` in pasted JSON — the closing quote sits
 *  between the name and the separator). Name-gated so ordinary config
 *  assignments are untouched. */
function redactNamedAssignments(text: string): string {
  return text.replace(
    // The identifier is the WHOLE `[A-Za-z0-9_-]` run, anchored to its start by
    // the lookbehind: without an anchor a long unbroken token (pasted base64, a
    // minified line) is retried from every offset and each attempt backtracks
    // the whole tail — O(n²), ~0.5 s per 20 KB. A `\b` anchor is not enough:
    // it skips `_SECRET=`, `self._password =`, `2fa_token=` (a letter run
    // preceded by `_`/digit), and a letter-start id (`[A-Za-z][A-Za-z0-9]*`)
    // is still retried at every letter of a mixed alphanumeric run. Taking the
    // maximal run means one attempt per run; the component check below still
    // decides whether it names a secret (`_SECRET` → ["", "SECRET"]).
    /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)("?)(\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]{4,})/g,
    (whole, id: string, close: string, sep: string, val: string) => {
      if (!id.split(/[_-]/).some((p) => SECRET_COMPONENT.test(p))) return whole;
      const quote = val[0] === '"' || val[0] === "'" ? val[0] : "";
      return `${id}${close}${sep}${quote}«redacted»${quote}`;
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
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

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

/** The first non-empty line of `text`, with runs of whitespace collapsed to one
 *  space — for titles and labels, which are one line by construction and must
 *  never carry a second line of remote text. */
export function oneLine(text: string): string {
  const first = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.replace(/\s+/g, " ").trim();
}
