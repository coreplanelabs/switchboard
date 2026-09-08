// Pure diff distiller: git's per-file statistics in, a compact human-readable
// digest out. No I/O, no process, no platform SDK — strings -> string — so it
// is trivially unit-testable and provider/channel-agnostic. The diff_digest
// tool (src/tools/workspace.ts) runs `git diff --numstat` and
// `git diff --name-status` over the merge-base range through the Executor seam
// and renders their output with this function; the coding agent shapes its PR
// description from the digest and the review agent orients with it.
// Feature: docs/reference/specs/distilled-diffs.md.
//
// Why statistics and not the unified diff: every Executor caps a command's
// output (`truncate`, 120k chars), and a unified diff of a mid-sized PR is
// larger than that. A digest parsed from the capped text silently counted the
// first files in `git diff`'s alphabetical order and nothing after them — a
// 41-file PR digested as 13 files, and a review approved on that. The stat
// formats cost one line per file, so the digest covers every file however
// large the change; the tool still refuses to state totals when even that
// output was cut.

type FileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

interface FileEntry {
  path: string;
  adds: number;
  dels: number;
  status: FileStatus;
  reasons: string[];
}

/** The digest's own totals — what the review post-step compares with the
 *  PR's `changed_files` / `additions` / `deletions` from GitHub. */
export interface DigestTotals {
  files: number;
  additions: number;
  deletions: number;
}

/** What the diff_digest tool reports to the run that owns it, once per call
 *  (the last call wins): the range it digested and either its totals or the
 *  reason it could not state them. */
export type DigestReport =
  { complete: true; base: string; totals: DigestTotals } | { complete: false; base: string; reason: string };

export interface Digest {
  text: string;
  totals: DigestTotals;
}

// Lockfiles are matched by exact basename (lowercased). Churn in a lockfile is
// mechanical, but a lockfile change riding along with a code change is worth a
// reviewer's glance (unexpected dependency movement / supply-chain risk).
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "poetry.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "pipfile.lock",
  "flake.lock",
]);

// Path-based risk heuristics. Deliberately biased toward over-flagging: a false
// positive costs a reviewer one glance; a missed migration/auth change costs
// more. Matched case-insensitively against the file path.
const MIGRATION_RE = /(^|\/)migrations?(\/|$)|\bmigrate\b|schema|\.sql$|\.prisma$/i;
const AUTH_RE =
  /auth|permission|\bperms?\b|credential|secret|password|passwd|(^|\/)\.env|\boauth\b|\brbac\b|\bacl\b|\bsession\b|login/i;

// Infra / deploy / CI config — a change here can alter how everything ships or
// runs, so it warrants a reviewer's eye even when the diff looks small.
const INFRA_RE =
  /(^|\/)\.github\/workflows\/|\.tf$|\.tfvars$|(^|\/)terraform\/|(^|\/)dockerfile|(^|\/)deploy\/|(^|\/)wrangler\.(jsonc?|toml)|(^|\/)k8s\//i;

// A single file changing this many lines (adds + dels) is flagged as a large
// change — worth calling out so a reviewer knows to budget time for it.
const LARGE_CHURN = 300;

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

// Decode git's C-style path quoting (core.quotepath=true, the default): a path
// with non-ASCII or special bytes is emitted inside double quotes with each
// such byte as a \NNN octal escape. Reassemble the raw bytes and read them back
// as UTF-8, so the digest shows the real filename instead of "\303\251".
function decodeGitQuoted(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const oct = s.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (oct) {
        bytes.push(parseInt(oct, 8) & 0xff);
        i += oct.length;
        continue;
      }
      const simple: Record<string, number> = { t: 9, n: 10, r: 13, '"': 34, "\\": 92 };
      const nx = s[i + 1];
      bytes.push(nx in simple ? simple[nx] : nx.charCodeAt(0) & 0xff);
      i += 1;
      continue;
    }
    bytes.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A path as git printed it: unquoted when it needed no quoting, else decoded. */
function unquotePath(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return decodeGitQuoted(s.slice(1, -1));
  return s;
}

// Risk is assessed against BOTH the new and old paths: a risky file renamed to
// an innocuous name (src/auth/x.ts → src/misc/y.ts, or .env → config.json) must
// still be flagged — the rename doesn't make the change safe.
function riskReasons(entry: FileEntry, paths: string[]): string[] {
  const reasons: string[] = [];
  const candidates = [...new Set(paths.filter(Boolean))];
  const any = (re: RegExp) => candidates.some((p) => re.test(p));
  if (any(MIGRATION_RE)) reasons.push("migration/schema");
  if (any(AUTH_RE)) reasons.push("auth/permission-sensitive");
  if (any(INFRA_RE)) reasons.push("infra/deploy config");
  if (entry.status === "deleted") reasons.push("whole-file deletion");
  if (candidates.some((p) => LOCKFILES.has(basename(p).toLowerCase()))) reasons.push("lockfile");
  const churn = entry.adds + entry.dels;
  if (churn >= LARGE_CHURN) reasons.push(`large change (${churn} lines)`);
  return reasons;
}

/** One `--numstat` line: `<adds>\t<dels>\t<path>`, with `-\t-` for a binary
 *  file. The path is git's compact rename form (`dir/{old => new}`) when the
 *  file moved — the name-status line beside it carries both sides plainly. */
interface NumstatLine {
  adds: number;
  dels: number;
  binary: boolean;
  path: string;
}

function parseNumstat(text: string): NumstatLine[] {
  const out: NumstatLine[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const binary = m[1] === "-" || m[2] === "-";
    out.push({
      adds: binary ? 0 : Number(m[1]),
      dels: binary ? 0 : Number(m[2]),
      binary,
      path: unquotePath(m[3]),
    });
  }
  return out;
}

/** One `--name-status` line: `<X>[score]\t<path>` or, for a rename/copy,
 *  `R<score>\t<old>\t<new>`. */
interface NameStatusLine {
  status: FileStatus;
  oldPath: string;
  newPath: string;
}

function parseNameStatus(text: string): NameStatusLine[] {
  const out: NameStatusLine[] = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Z])\d*\t(.+)$/.exec(line);
    if (!m) continue;
    const parts = m[2].split("\t").map(unquotePath);
    const code = m[1];
    if (code === "R" || code === "C") {
      const [oldPath, newPath] = parts;
      // A copy (`C`) is a new file at its new path — the source is unchanged —
      // so it reads as added; its old path still counts for risk scoring.
      out.push({
        status: code === "R" ? "renamed" : "added",
        oldPath: oldPath ?? "",
        newPath: newPath ?? oldPath ?? "",
      });
      continue;
    }
    const p = parts[0] ?? "";
    out.push({ status: code === "A" ? "added" : code === "D" ? "deleted" : "modified", oldPath: p, newPath: p });
  }
  return out;
}

/** The two listings, zipped: git emits both over the same diff queue in the
 *  same order, so the i-th name-status line describes the i-th numstat line.
 *  A numstat line with no partner (the listings disagree — a malformed line)
 *  keeps its own path text and counts as modified rather than being dropped. */
function parse(numstat: string, nameStatus: string): FileEntry[] {
  const stats = parseNumstat(numstat);
  const names = parseNameStatus(nameStatus);
  const aligned = stats.length === names.length;
  return stats.map((s, i) => {
    const n = aligned ? names[i] : undefined;
    const newPath = n?.newPath || s.path;
    const oldPath = n?.oldPath || newPath;
    const status: FileStatus =
      s.binary && (n?.status ?? "modified") === "modified" ? "binary" : (n?.status ?? "modified");
    const entry: FileEntry = { path: newPath, adds: s.adds, dels: s.dels, status, reasons: [] };
    entry.reasons = riskReasons(entry, [newPath, oldPath]);
    return entry;
  });
}

/** Distill `git diff --numstat` and `git diff --name-status` output for one
 *  range into a compact digest — totals, per-file +adds/-dels (largest churn
 *  first), a risky-files section — plus the totals as data. */
export function distillDiffStats(numstat: string, nameStatus: string): Digest {
  const files = parse(numstat ?? "", nameStatus ?? "");
  if (files.length === 0) {
    return { text: "Diff digest — no changes (empty diff).", totals: { files: 0, additions: 0, deletions: 0 } };
  }

  const totalAdds = files.reduce((n, f) => n + f.adds, 0);
  const totalDels = files.reduce((n, f) => n + f.dels, 0);
  const sorted = [...files].sort((a, b) => b.adds + b.dels - (a.adds + a.dels));

  const lines: string[] = [];
  const noun = files.length === 1 ? "file" : "files";
  lines.push(`Diff digest — ${files.length} ${noun} changed, +${totalAdds} -${totalDels}`);
  lines.push("");
  for (const f of sorted) {
    const suffix = f.status === "modified" ? "" : `  (${f.status})`;
    lines.push(`  ${f.path}  +${f.adds} -${f.dels}${suffix}`);
  }

  const risky = sorted.filter((f) => f.reasons.length > 0);
  if (risky.length > 0) {
    lines.push("");
    lines.push("Risky files (review with care):");
    for (const f of risky) lines.push(`  ${f.path} — ${f.reasons.join(", ")}`);
  }

  return { text: lines.join("\n"), totals: { files: files.length, additions: totalAdds, deletions: totalDels } };
}

/** A `DigestReport` read back from a run ledger row (a resumed run): the shape
 *  is re-validated, never trusted as-is. Anything malformed → undefined. */
export function parseDigestReport(value: unknown): DigestReport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.base !== "string") return undefined;
  if (v.complete === true) {
    const t = v.totals as Record<string, unknown> | undefined;
    const n = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0;
    if (!t || !n(t.files) || !n(t.additions) || !n(t.deletions)) return undefined;
    return {
      complete: true,
      base: v.base,
      totals: { files: t.files as number, additions: t.additions as number, deletions: t.deletions as number },
    };
  }
  if (v.complete === false && typeof v.reason === "string") return { complete: false, base: v.base, reason: v.reason };
  return undefined;
}
