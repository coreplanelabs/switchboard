import {
  isSetupInstallCommand,
  type FrictionCategory,
  type FrictionDiagnosis,
  type FrictionFinding,
  type FrictionSeverity,
} from "./runFriction.js";
import { formatDuration } from "./time/formatDuration.js";

// Friction proposer (Area 7b / #84, second piece): the PURE half of turning
// the run-friction ANALYSIS (#105, `analyzeRunFriction`) into ACTION. Given the
// diagnoses of many recent runs, it (1) reduces each finding to a stable
// cross-run signature, (2) clusters signatures that recur across DISTINCT runs,
// (3) ranks them, (4) renders the top ones as GitHub-issue proposals carrying
// the evidence and a concrete suggested fix, and (5) dedupes against proposals
// already open via a marker in the issue body. No I/O, no clock: the same
// records always yield the same proposals, so the whole step is testable
// against recorded runs — which is exactly why #105 made the analyzer pure.
//
// It never reimplements the analyzer: every pattern is built from the
// `FrictionFinding`s the analyzer already produced. The one cross-run signal it
// adds (`long_run`) cannot exist per run by definition.

/** One finished run as the ledger keeps it: identity + the analyzer's output. */
export interface FrictionRunRecord {
  /** The run registry id (unguessable; safe to print — it is not the view token). */
  runId: string;
  /** The human run label from the runs index (`agent · repo/channel · "snippet"`). */
  label?: string;
  /** Resolved agent name, when known (drives the long_run grouping). */
  agent?: string;
  /** Epoch ms at run finish. */
  finishedAt: number;
  diagnosis: FrictionDiagnosis;
}

/** Structural check on a record from outside the process (a ledger line, a
 *  Worker response, a CLI input file): only the fields the clusterer relies on.
 *  Pure — shared by the bot and the state Worker's FrictionDO. */
export function isFrictionRunRecord(v: unknown): v is FrictionRunRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.runId !== "string" || r.runId.length === 0) return false; // the id is the upsert key everywhere
  if (typeof r.finishedAt !== "number" || !Number.isFinite(r.finishedAt)) return false;
  if (r.label !== undefined && typeof r.label !== "string") return false;
  if (r.agent !== undefined && typeof r.agent !== "string") return false;
  return isDiagnosis(r.diagnosis);
}

/** Structural check on a `FrictionDiagnosis` from outside the process: the
 *  fields the clusterer relies on, with every category present in `byCategory`.
 *  Shared by the ledger record check and the run-history record check. */
export function isDiagnosis(v: unknown): v is FrictionDiagnosis {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  if (!Array.isArray(d.findings) || typeof d.eventCount !== "number" || typeof d.verdict !== "string") return false;
  if (typeof d.byCategory !== "object" || d.byCategory === null) return false;
  if (d.runMs !== undefined && typeof d.runMs !== "number") return false;
  // Every category PRESENT must be a totals object; categories the analyzer
  // gained after a record was written are simply absent (= zero). Requiring
  // the current list would make every older record in the durable ledger
  // unreadable the moment a category is added.
  return Object.values(d.byCategory as Record<string, unknown>).every((t) => typeof t === "object" && t !== null);
}

/** A pattern kind is an analyzer category, plus the one cross-run kind. */
export type PatternKind = FrictionCategory | "long_run";

export interface PatternExample {
  runId: string;
  label?: string;
  finishedAt: number;
  /** The analyzer's finding summary (already redacted upstream). */
  summary: string;
  durationMs?: number;
  severity: FrictionSeverity;
}

export interface FrictionPattern {
  /** Stable dedupe key: `<kind>:<signature>`. The same friction always maps here. */
  key: string;
  kind: PatternKind;
  signature: string;
  /** Distinct runs the pattern appeared in, oldest first. */
  runIds: string[];
  /** Total findings across those runs (a run may hit the pattern several times). */
  occurrences: number;
  /** Wall time attributed by the analyzer across all occurrences (0 without timings). */
  durationMs: number;
  /** Highest severity seen. */
  severity: FrictionSeverity;
  /** Most recent first, capped at MAX_EXAMPLES. */
  examples: PatternExample[];
}

export interface ClusterOptions {
  /** A pattern must appear in at least this many DISTINCT runs. Default 2. */
  minRuns?: number;
}

export const DEFAULT_MIN_RUNS = 2;
/** Examples kept per pattern (the issue's evidence table). */
export const MAX_EXAMPLES = 5;
/** A run is a `long_run` outlier at ≥ 2× the median run time, and never under this floor. */
export const LONG_RUN_MIN_MS = 10 * 60_000;
const LONG_RUN_FACTOR = 2;
const MAX_SIGNATURE_CHARS = 120;

const SEVERITY_RANK: Record<FrictionSeverity, number> = { low: 0, medium: 1, high: 2 };

const KIND_LABEL: Record<PatternKind, string> = {
  slow_tool: "slow tool call",
  slow_model_turn: "slow model turn",
  failed_tool: "failing tool call",
  retry: "retry",
  setup_install: "setup/install",
  wrap_up: "wrap-up",
  budget_hit: "budget hit",
  infra_failure: "infra failure",
  long_run: "long run",
};

// ---- signatures -------------------------------------------------------------

const RESULT_TAIL = / → [\s\S]*$/;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
/** ≥7 hex chars containing at least one digit — commit SHAs, digests, ids. */
const SHA_RE = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi;
/** Standalone numeric tokens (`12`, `1.2.3`, `--x=100`) — not digits glued to letters (`pip3`). */
const NUMBER_RE = /(?<![\w.-])\d+(?:\.\d+)*(?![\w.-])/g;

/**
 * Reduce a tool-call summary to a cross-run signature: the command with its
 * `$ ` prefix and any ` → result` tail removed, volatile tokens (URLs, hashes,
 * numbers) blanked, whitespace collapsed, length-capped. Deliberately coarse:
 * two runs that fail on `git checkout <different sha>` are the SAME friction.
 */
export function normalizeCommand(summary: string): string {
  let s = summary.replace(RESULT_TAIL, "").trim();
  if (s.startsWith("$ ")) s = s.slice(2);
  s = s.replace(URL_RE, "<url>").replace(SHA_RE, "<sha>").replace(NUMBER_RE, "<n>").replace(/\s+/g, " ").trim();
  return s.length > MAX_SIGNATURE_CHARS ? s.slice(0, MAX_SIGNATURE_CHARS).trimEnd() : s;
}

// ---- shell-aware signatures -------------------------------------------------
// Real agents chain the same work differently every run (`cd /tmp/ws/repo &&
// npm ci --silent 2>&1 | tail -2 && …` vs `cd ~/switchboard && npm ci --silent
// >/dev/null 2>&1; (npm test …)`), so an exact normalized command never recurs
// across runs even when both runs pay the same `npm ci`. The signature is
// therefore the sequence of MEANINGFUL program+subcommand tokens, one per shell
// segment, with navigation/echo/pipe-filter noise, redirections, env
// assignments, and volatile tokens dropped.

/** Segment separators: `&&`, `||`, `;`, `|`, and a lone `&` (backgrounding). Order matters: the two-char forms first. */
const SEGMENT_SPLIT = /&&|\|\||;|\||&/;
/** Quoted string literals: prose to the shell, not command words. */
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
/** Programs that carry no information about what the step IS. */
const NOISE_PROGRAMS = new Set([
  "cd",
  "echo",
  "export",
  "printf",
  "tail",
  "head",
  "grep",
  "sed",
  "awk",
  "wc",
  "sort",
  "uniq",
  "cat",
  "tee",
  "cut",
  "tr",
  "xargs",
  "sleep",
  "set",
  "source",
  "pushd",
  "popd",
  "true",
  "time",
  "exit",
]);
/** Wrappers whose NEXT word is the real program. */
const WRAPPER_PROGRAMS = new Set(["sudo", "corepack", "exec", "nice", "nohup", "env"]);
/** Programs whose first non-flag argument is a subcommand worth keeping. */
const SUBCOMMAND_PROGRAMS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "git",
  "gh",
  "cargo",
  "go",
  "pip",
  "pip3",
  "poetry",
  "uv",
  "docker",
  "make",
  "apt",
  "apt-get",
  "apk",
  "brew",
  "bundle",
  "gem",
  "kubectl",
  "wrangler",
  "terraform",
]);
/** `npm run <script>` / `yarn <script>` — the script name is the identity. */
const RUN_SUBCOMMANDS = new Set(["run", "run-script", "exec"]);
/** Install flags that only change verbosity/telemetry, not what is installed. */
const QUIET_FLAGS = new Set([
  "--silent",
  "--quiet",
  "-q",
  "-s",
  "--no-audit",
  "--no-fund",
  "--no-progress",
  "--progress=false",
  "-y",
  "--yes",
  "--prefer-offline",
]);
const MAX_SEGMENTS = 4;

/** Split a command summary (`$ …`, result tail already cut) into shell segments
 *  with quoted strings blanked, redirections/env assignments removed. */
function segments(summary: string): string[][] {
  let s = summary.replace(RESULT_TAIL, "").trim();
  if (s.startsWith("$ ")) s = s.slice(2);
  s = s
    .replace(QUOTED, '""')
    .replace(/[()]/g, " ")
    .replace(URL_RE, "<url>")
    .replace(SHA_RE, "<sha>")
    .replace(NUMBER_RE, "<n>");
  return s
    .split(SEGMENT_SPLIT)
    .map((seg) =>
      seg
        .trim()
        .split(/\s+/)
        .filter((w) => w && !/^\d*[<>]|^[<>]/.test(w) && w !== '""' && !/^\/dev\/null$/.test(w)),
    )
    .map((words) => {
      // Leading env assignments (`FOO=1 cmd`) and wrappers (`sudo cmd`).
      while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || WRAPPER_PROGRAMS.has(words[0])))
        words.shift();
      return words;
    })
    .filter((words) => words.length > 0);
}

/** `program [subcommand [script]]` for one segment; undefined for noise. */
function segmentHead(words: string[]): string | undefined {
  const program = words[0].replace(/^.*\//, ""); // `/usr/bin/npm` → `npm`
  if (NOISE_PROGRAMS.has(program)) return undefined;
  if (program === "python" || program === "python3") {
    // `python -m pip install …` → treat the module as the program.
    const m = words.indexOf("-m");
    if (m !== -1 && words[m + 1]) return segmentHead(words.slice(m + 1));
    return program;
  }
  if (!SUBCOMMAND_PROGRAMS.has(program)) return program;
  const args = words.slice(1).filter((w) => !w.startsWith("-"));
  const sub = args[0];
  if (!sub) return program;
  if (RUN_SUBCOMMANDS.has(sub) && args[1]) return `${program} ${sub} ${args[1]}`;
  return `${program} ${sub}`;
}

/** The ordered, de-duplicated heads of a command's segments, capped. */
export function commandSignature(summary: string): string {
  const heads: string[] = [];
  for (const words of segments(summary)) {
    const head = segmentHead(words);
    if (head && !heads.includes(head)) heads.push(head);
    if (heads.length >= MAX_SEGMENTS) break;
  }
  return heads.join(", ") || normalizeCommand(summary);
}

/** The install step inside a command: its head plus the flags that change WHAT
 *  is installed (`--frozen-lockfile`), quiet/telemetry flags dropped. Undefined
 *  when no segment is a setup/install command. */
export function installSignature(summary: string): string | undefined {
  for (const words of segments(summary)) {
    if (!isSetupInstallCommand(words.join(" "))) continue;
    const head = segmentHead(words);
    if (!head) continue;
    const flags = words.slice(1).filter((w) => w.startsWith("--") && !QUIET_FLAGS.has(w) && !w.includes("<"));
    return [head, ...flags].join(" ");
  }
  return undefined;
}

/** The analyzer's per-category label prefixes on tool findings, stripped before normalizing. */
const TOOL_PREFIX = /^(?:install failed|slow install|install|retried after failure|took [^:]+):\s*/;

/** `<category>:<signature>` for one finding — the clustering key. Note findings
 *  key on their KIND (free text varies per run); tool findings on the
 *  normalized command; an unknown-tool failure (tool misuse) on the tool name. */
export function patternSignature(f: FrictionFinding): string {
  const summary = typeof f.summary === "string" ? f.summary : "";
  switch (f.category) {
    case "budget_hit": {
      const m = /^budget hit \((time|turns)\)/.exec(summary);
      return `budget_hit:${m ? m[1] : "other"}`;
    }
    case "wrap_up":
      return "wrap_up:wrap_up";
    case "slow_model_turn":
      // A slow think is a property of the agent/model tier, not of the command
      // the model eventually issued — one key, so it clusters across runs.
      return "slow_model_turn:model_turn";
    case "infra_failure": {
      if (summary.startsWith("sandbox dead")) return "infra_failure:sandbox_dead";
      const mid = /^no result for tool call \(run ended mid-tool\):\s*/.exec(summary);
      if (mid) return `infra_failure:mid-tool ${commandSignature(summary.slice(mid[0].length))}`;
      const during = /^exec infrastructure failed during\s*/.exec(summary);
      return `infra_failure:${commandSignature(during ? summary.slice(during[0].length) : summary)}`;
    }
    case "setup_install": {
      const cmd = summary.replace(TOOL_PREFIX, "");
      return `setup_install:${installSignature(cmd) ?? commandSignature(cmd)}`;
    }
    default: {
      if (/\bunknown tool\b/.test(summary)) return `${f.category}:unknown tool ${f.tool ?? "?"}`;
      return `${f.category}:${commandSignature(summary.replace(TOOL_PREFIX, ""))}`;
    }
  }
}

// ---- clustering -------------------------------------------------------------

interface Accumulator {
  kind: PatternKind;
  signature: string;
  runIds: Set<string>;
  occurrences: number;
  durationMs: number;
  severity: FrictionSeverity;
  examples: PatternExample[];
}

function maxSeverity(a: FrictionSeverity, b: FrictionSeverity): FrictionSeverity {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Cluster the findings of many runs into recurring patterns, ranked most
 * actionable first: distinct runs affected, then peak severity, then attributed
 * time, then key (a total order — the output is deterministic). A finding that
 * repeats within ONE run is one run's worth of recurrence: "recurring" means
 * across runs, which is what makes it a process problem rather than a bad day.
 *
 * `long_run` (the cost-spike proxy — there is no per-run token accounting yet)
 * flags runs whose `runMs` is ≥ LONG_RUN_FACTOR× the median of all timed runs
 * (and ≥ LONG_RUN_MIN_MS), grouped per agent. A fleet where every run is long
 * has no outliers and yields nothing — the analyzer's per-run findings cover it.
 * Never mutates `records`.
 */
export function clusterFriction(records: readonly FrictionRunRecord[], opts: ClusterOptions = {}): FrictionPattern[] {
  const minRuns = opts.minRuns ?? DEFAULT_MIN_RUNS;
  const ordered = [...records].sort((a, b) => a.finishedAt - b.finishedAt || a.runId.localeCompare(b.runId));
  const acc = new Map<string, Accumulator>();

  const add = (
    key: string,
    kind: PatternKind,
    signature: string,
    rec: FrictionRunRecord,
    example: Omit<PatternExample, "runId" | "label" | "finishedAt">,
    durationMs: number,
  ) => {
    let a = acc.get(key);
    if (!a) {
      a = { kind, signature, runIds: new Set(), occurrences: 0, durationMs: 0, severity: "low", examples: [] };
      acc.set(key, a);
    }
    a.runIds.add(rec.runId);
    a.occurrences++;
    a.durationMs += durationMs;
    a.severity = maxSeverity(a.severity, example.severity);
    a.examples.push({
      runId: rec.runId,
      ...(rec.label !== undefined ? { label: rec.label } : {}),
      finishedAt: rec.finishedAt,
      ...example,
    });
  };

  for (const rec of ordered) {
    for (const f of rec.diagnosis.findings) {
      const key = patternSignature(f);
      add(
        key,
        f.category,
        key.slice(key.indexOf(":") + 1),
        rec,
        {
          summary: typeof f.summary === "string" ? f.summary : String(f.summary),
          severity: f.severity,
          ...(f.durationMs !== undefined ? { durationMs: f.durationMs } : {}),
        },
        f.durationMs ?? 0,
      );
    }
  }

  const timed = ordered.filter((r) => typeof r.diagnosis.runMs === "number");
  if (timed.length >= 2) {
    const med = median(timed.map((r) => r.diagnosis.runMs as number));
    const threshold = Math.max(med * LONG_RUN_FACTOR, LONG_RUN_MIN_MS);
    for (const rec of timed) {
      const runMs = rec.diagnosis.runMs as number;
      if (runMs < threshold) continue;
      const agent = rec.agent ?? "unknown";
      add(
        `long_run:${agent}`,
        "long_run",
        agent,
        rec,
        {
          summary: `run took ${formatDuration(runMs, "report")} (median ${formatDuration(med, "report")} across ${timed.length} timed runs)`,
          severity: runMs >= threshold * LONG_RUN_FACTOR ? "high" : "medium",
          durationMs: runMs,
        },
        runMs,
      );
    }
  }

  const patterns: FrictionPattern[] = [];
  for (const [key, a] of acc) {
    if (a.runIds.size < minRuns) continue;
    const examples = [...a.examples]
      .sort((x, y) => y.finishedAt - x.finishedAt || y.runId.localeCompare(x.runId))
      .slice(0, MAX_EXAMPLES);
    patterns.push({
      key,
      kind: a.kind,
      signature: a.signature,
      runIds: [...a.runIds],
      occurrences: a.occurrences,
      durationMs: a.durationMs,
      severity: a.severity,
      examples,
    });
  }
  return patterns.sort(
    (x, y) =>
      y.runIds.length - x.runIds.length ||
      SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] ||
      y.durationMs - x.durationMs ||
      x.key.localeCompare(y.key),
  );
}

// ---- proposals --------------------------------------------------------------

export interface ImprovementProposal {
  /** The pattern key — also embedded in `body` as the dedupe marker. */
  key: string;
  title: string;
  /** GitHub-flavored Markdown. */
  body: string;
  labels: string[];
  pattern: FrictionPattern;
}

export interface ProposeOptions {
  /** How many of the ranked patterns become proposals. Default 3. */
  top?: number;
  /** Runs the patterns were clustered from — for the "N of M runs" recurrence line. */
  runsAnalyzed: number;
  /** The triage label every proposal carries. Default `self-improvement`. */
  label?: string;
}

export const DEFAULT_TOP = 3;
export const DEFAULT_PROPOSAL_LABEL = "self-improvement";
const MAX_TITLE_CHARS = 120;
const TRACKING_ISSUE_URL = "https://github.com/coreplanelabs/switchboard/issues/84";

/** The HTML-comment marker that makes a proposal recognizable on re-runs. */
export const PROPOSAL_MARKER_PREFIX = "<!-- switchboard-friction-pattern:";

export function proposalMarker(key: string): string {
  return `${PROPOSAL_MARKER_PREFIX} ${key} -->`;
}

const MARKER_RE = /<!--\s*switchboard-friction-pattern:\s*([^\s][^]*?)\s*-->/;

/** The pattern key an issue body was filed for, or undefined for any other body. */
export function findProposalKey(body: string): string | undefined {
  const m = MARKER_RE.exec(body);
  return m ? m[1].trim() : undefined;
}

/** Render the top `top` patterns as issue proposals, in rank order. */
export function proposeImprovements(patterns: readonly FrictionPattern[], opts: ProposeOptions): ImprovementProposal[] {
  const top = opts.top ?? DEFAULT_TOP;
  const label = opts.label ?? DEFAULT_PROPOSAL_LABEL;
  return patterns.slice(0, top).map((pattern) => ({
    key: pattern.key,
    title: proposalTitle(pattern, opts.runsAnalyzed),
    body: proposalBody(pattern, opts.runsAnalyzed),
    labels: [label],
    pattern,
  }));
}

function proposalTitle(p: FrictionPattern, runsAnalyzed: number): string {
  const title = `[friction] ${KIND_LABEL[p.kind]} recurs in ${p.runIds.length} of ${runsAnalyzed} runs: ${p.signature}`;
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : title;
}

function proposalBody(p: FrictionPattern, runsAnalyzed: number): string {
  const share = runsAnalyzed > 0 ? ` (${Math.round((p.runIds.length / runsAnalyzed) * 100)}%)` : "";
  const rows = p.examples.map((e) => {
    const run = e.label ? `\`${e.runId}\` — ${escapeCell(e.label)}` : `\`${e.runId}\``;
    const when = Number.isFinite(e.finishedAt) ? new Date(e.finishedAt).toISOString() : "?";
    return `| ${run} | ${when} | ${escapeCell(e.summary)} | ${e.durationMs !== undefined ? formatDuration(e.durationMs, "report") : "-"} |`;
  });
  // Runs not represented in the examples table (a run can contribute several
  // examples, so this is set difference, not arithmetic on the counts).
  const shown = new Set(p.examples.map((e) => e.runId));
  const rest = p.runIds.filter((id) => !shown.has(id));
  const more =
    rest.length > 0 ? `\n_…and ${rest.length} more run(s): ${rest.map((id) => `\`${id}\``).join(", ")}_` : "";
  return [
    proposalMarker(p.key),
    "",
    `Switchboard's self-improvement pass ([#84](${TRACKING_ISSUE_URL})) found this friction recurring across its own recent runs. This issue is a **proposal for a human to triage** — nothing was changed automatically.`,
    "",
    "## Pattern",
    "",
    `- **Kind:** \`${p.kind}\` (${KIND_LABEL[p.kind]})`,
    `- **Signature:** \`${p.signature}\``,
    `- **Recurrence:** ${p.runIds.length} of ${runsAnalyzed} runs analyzed${share}, ${p.occurrences} occurrence${p.occurrences === 1 ? "" : "s"}`,
    `- **Attributed time:** ${p.durationMs > 0 ? formatDuration(p.durationMs, "report") : "n/a (untimed)"}`,
    `- **Peak severity:** ${p.severity}`,
    "",
    "## Evidence",
    "",
    "| Run | Finished | Finding | Time |",
    "|---|---|---|---|",
    ...rows,
    more,
    "",
    "## Suggested fix",
    "",
    suggestedFix(p),
    "",
    "## Provenance",
    "",
    `Generated by \`friction propose\` from the friction ledger: each run's event stream was diagnosed by \`analyzeRunFriction\` ([features/run-friction.md](https://github.com/coreplanelabs/switchboard/blob/main/features/run-friction.md)) and the diagnoses clustered across runs ([features/self-improvement.md](https://github.com/coreplanelabs/switchboard/blob/main/features/self-improvement.md)). Finding text is redacted at the source. Dedupe key \`${p.key}\`: re-running the pass will not refile this pattern while this issue is open.`,
  ].join("\n");
}

/** Pipes and newlines would break the Markdown table. */
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/** A concrete, kind-specific fix, sharpened by what the evidence says. */
function suggestedFix(p: FrictionPattern): string {
  const evidence = p.examples.map((e) => e.summary).join("\n");
  switch (p.kind) {
    case "setup_install": {
      const failing = /install failed/.test(evidence);
      const lockfile = /frozen-lockfile|OUTDATED_LOCKFILE|lockfile/i.test(`${p.signature}\n${evidence}`);
      const clone = /^git clone/.test(p.signature);
      const parts = [
        `Every affected run pays for \`${p.signature}\`. In order of leverage:`,
        clone
          ? "1. Onboard the repo as a resident (`repo onboard <owner/name>`) — resident runs start in a warm worktree, so the clone (and the install after it) leave the critical path entirely."
          : "1. Onboard the repo as a resident (`repo onboard <owner/name>`) so runs start with dependencies already installed and this step disappears from the critical path.",
      ];
      if (failing) {
        parts.push(
          lockfile
            ? '2. The install FAILS: `--frozen-lockfile` refuses a lockfile that is out of date with `package.json`. Regenerate and commit the lockfile in the target repo, or document the correct install command in its AGENTS.md / the resident command table (`repo reconfigure <owner/name> install="…"`).'
            : "2. The install FAILS (see evidence) — fix the root cause in the target repo (prerequisites, registry access, the right package manager) and document the working command in its AGENTS.md / the resident command table so the agent stops rediscovering it.",
        );
      }
      parts.push(
        `${failing ? 3 : 2}. Pre-bake the package manager and a dependency cache into the sandbox image (\`deploy/cloudflare-sandbox/Dockerfile\`) so a cold per-thread sandbox installs from cache.`,
      );
      return parts.join("\n");
    }
    case "failed_tool":
      if (/command not found|No such file or directory: .*bin|not installed/i.test(evidence)) {
        return `\`${p.signature}\` fails because the command is missing from the execution image. Add it to \`deploy/cloudflare-sandbox/Dockerfile\` (and the resident image if repo runs hit it), or tell the agent in the target repo's AGENTS.md which command to use instead.`;
      }
      if (/unknown tool/.test(p.signature)) {
        return `The model keeps calling \`${p.signature.replace(/^unknown tool /, "")}\`, a tool this agent does not have — tool misuse. Align the agent definition (\`src/agents/registry.ts\` toolset) and its prompt with the tools actually available, or add the tool behind the executor seam if the need is real.`;
      }
      return `\`${p.signature}\` fails run after run. The fix belongs where the agent reads before acting: the target repo's AGENTS.md (correct invocation, prerequisites, what to run instead) or its onboarded command table (\`repo reconfigure <owner/name> test="…"\`) — so every future run gets it right the first time.`;
    case "retry":
      return `Runs keep retrying \`${p.signature}\` after it fails once — the agent recovers by hand each time, and the first attempt's failure plus the retry are both paid. Make the first attempt succeed: encode the working invocation (flags, prerequisites) in the target repo's AGENTS.md or the resident command table, and check the paired \`failed_tool\` proposal for the root cause.`;
    case "slow_tool":
      return `\`${p.signature}\` is the slow step. Cut its wall time: cache its inputs (a dependency cache in the sandbox image, or a resident worktree), narrow the command (targeted tests instead of the whole suite when the task is local), or move the affected agent to a larger sandbox tier if the step is CPU/RAM-bound (AGENTS.md → container sizing).`;
    case "slow_model_turn":
      return `The model itself is the slow step: ${p.occurrences} turns across ${p.runIds.length} runs spent ${formatDuration(p.durationMs, "report")} thinking between one tool result and the next call. Lower the affected agent's \`effort\` (\`src/agents/registry.ts\`; review runs \`medium\` for this reason), or make each turn do more — prompt for batched gathering (several files / commands per call) so the same work takes fewer, cheaper thinks. The evidence rows show what each slow turn produced: a one-line grep after minutes of thought is the signature of the wrong effort tier.`;
    case "wrap_up":
      return `Runs keep reaching the wrap-up warning (${p.runIds.length} runs; ${formatDuration(p.durationMs, "report")} spent winding down). Either the affected agent's \`maxMinutes\` (\`src/agents/registry.ts\`) is too tight for this shape of work, or the prompt should push batching (fewer, larger tool calls) — the evidence rows say which agent and how close to the deadline each run got.`;
    case "budget_hit":
      return p.signature === "turns"
        ? `Runs exhaust the TURN budget. Raise \`maxTurns\` for the affected agent (\`src/agents/registry.ts\`) or have its prompt batch tool calls (several commands per \`bash\` call) so the same work takes fewer turns.`
        : `Runs exhaust the TIME budget and are cut off mid-work. Raise \`maxMinutes\` for the affected agent (\`src/agents/registry.ts\`), or split the task shape that triggers it — a run that is forced to write up findings is a run whose work was wasted.`;
    case "infra_failure":
      if (p.signature === "sandbox_dead") {
        return `The sandbox died mid-run in ${p.runIds.length} runs. Check container sizing first (AGENTS.md: the 1 GiB \`basic\` tier died running vitest; thread sandboxes are \`standard-3\`, residents \`standard-1\`), then the memory footprint of the failing command, then the sandbox/resident Worker logs (\`deploy/bin/cf-logs\`) around the affected runs.`;
      }
      if (p.signature.startsWith("mid-tool ")) {
        return `Runs ended with \`${p.signature.replace(/^mid-tool /, "")}\` still outstanding — the run (or its transport) was cut while the tool ran. Correlate the affected runs with deploys/drains (\`[drain]\` log lines), the sandbox command timeout (exit 124 / heartbeat streaming, features/execution.md), and the executor's error surfacing.`;
      }
      return `The exec transport failed during \`${p.signature}\` in ${p.runIds.length} runs (the sandbox, not the command). Check the sandbox/resident Worker logs (\`deploy/bin/cf-logs\`) around the affected runs for the underlying error, and whether the command's runtime exceeds the executor's timeout.`;
    case "long_run":
      return `These \`${p.signature}\` runs took ≥ ${LONG_RUN_FACTOR}× the median run time — the closest available proxy for a cost spike (there is no per-run token accounting yet). Open each affected run's friction report for its dominant cause; if the shape of work is legitimately long, split it or lower the agent's effort tier; if it is not, tighten \`maxMinutes\` so a runaway run is cut earlier.`;
  }
}

// ---- dedupe -----------------------------------------------------------------

/** An already-open issue, as the tracker lists it. */
export interface ExistingIssue {
  number: number;
  url: string;
  title: string;
  body: string;
}

export interface DedupeResult {
  /** Proposals with no open counterpart — to be filed. */
  fresh: ImprovementProposal[];
  /** Proposals whose pattern is already open, with the issue that covers it. */
  duplicates: Array<{ proposal: ImprovementProposal; issue: ExistingIssue }>;
}

/** Split proposals by whether an open issue already carries their marker. The
 *  marker — not the title — is the identity: titles change with run counts. */
export function dedupeProposals(
  proposals: readonly ImprovementProposal[],
  open: readonly ExistingIssue[],
): DedupeResult {
  const byKey = new Map<string, ExistingIssue>();
  for (const issue of open) {
    const key = findProposalKey(issue.body ?? "");
    if (key && !byKey.has(key)) byKey.set(key, issue);
  }
  const fresh: ImprovementProposal[] = [];
  const duplicates: DedupeResult["duplicates"] = [];
  for (const proposal of proposals) {
    const issue = byKey.get(proposal.key);
    if (issue) duplicates.push({ proposal, issue });
    else fresh.push(proposal);
  }
  return { fresh, duplicates };
}
