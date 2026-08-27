// Pure diff distiller: a unified git diff in, a compact human-readable digest
// out. No I/O, no process, no platform SDK — string -> string — so it is
// trivially unit-testable and provider/channel-agnostic. The diff_digest tool
// (src/tools/workspace.ts) runs `git diff` through the Executor seam and renders
// its output with this function; the coding agent puts the digest in a PR body
// (a distilled summary, not the raw diff — R14) and the review agent uses it to
// orient before analyzing (R15). Feature: features/validated-review.md.

type FileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

interface FileEntry {
  path: string;
  adds: number;
  dels: number;
  status: FileStatus;
  reasons: string[];
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

// Strip git's a//b/ (and w//i//c//o/) path prefixes and surrounding quotes;
// "/dev/null" (new/deleted side) resolves to no path.
function stripPrefix(raw: string): string {
  if (raw === "/dev/null") return "";
  let s = raw;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = decodeGitQuoted(s.slice(1, -1));
  if (/^[abciwo]\//.test(s)) s = s.slice(2);
  return s;
}

// Old + new paths from the "diff --git a/OLD b/NEW" header (used for renames /
// binaries that carry no ---/+++ lines). Both sides matter for risk scoring.
function pathsFromHeader(line: string): { old: string; new: string } {
  const rest = line.slice("diff --git ".length);
  const m = /^a\/(.+) b\/(.+)$/.exec(rest);
  if (m) return { old: m[1], new: m[2] };
  const only = stripPrefix(rest.split(" ")[0] ?? "");
  return { old: only, new: only };
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

interface Acc {
  header: string;
  pathPlus: string;
  pathMinus: string;
  status: FileStatus;
  adds: number;
  dels: number;
  inHunk: boolean;
}

function finalize(a: Acc): FileEntry {
  const header = pathsFromHeader(a.header);
  // Prefer the new-side path for display; keep the old side for risk scoring.
  const newPath = a.pathPlus || header.new || "(unknown)";
  const oldPath = a.pathMinus || header.old || newPath;
  const entry: FileEntry = { path: newPath, adds: a.adds, dels: a.dels, status: a.status, reasons: [] };
  entry.reasons = riskReasons(entry, [newPath, oldPath]);
  return entry;
}

function parse(diff: string): FileEntry[] {
  const files: FileEntry[] = [];
  let cur: Acc | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) files.push(finalize(cur));
      cur = { header: line, pathPlus: "", pathMinus: "", status: "modified", adds: 0, dels: 0, inHunk: false };
      continue;
    }
    if (!cur) continue; // ignore any preamble before the first file block

    if (line.startsWith("@@")) {
      cur.inHunk = true;
      continue;
    }
    if (!cur.inHunk) {
      // Metadata region: status markers and the ---/+++ path header live here.
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ") || line.startsWith("rename to ")) cur.status = "renamed";
      else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        if (cur.status === "modified") cur.status = "binary";
      } else if (line.startsWith("+++ ")) cur.pathPlus = stripPrefix(line.slice(4).trim());
      else if (line.startsWith("--- ")) cur.pathMinus = stripPrefix(line.slice(4).trim());
      // A malformed block may carry +/- content lines with no @@ header — count
      // them too, so counts survive a broken hunk header.
      else if (line.startsWith("+")) cur.adds++;
      else if (line.startsWith("-")) cur.dels++;
      continue;
    }
    // Inside a hunk: count content adds/dels.
    if (line.startsWith("+")) cur.adds++;
    else if (line.startsWith("-")) cur.dels++;
  }
  if (cur) files.push(finalize(cur));
  return files;
}

/** Distill a unified git diff into a compact digest: totals, per-file
 *  +adds/-dels (largest churn first), and a risky-files section. */
export function distillDiff(unifiedDiff: string): string {
  const files = parse(unifiedDiff ?? "");
  if (files.length === 0) return "Diff digest — no changes (empty diff).";

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

  return lines.join("\n");
}
