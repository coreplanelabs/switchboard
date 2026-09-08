import { WORKER_SPECS, type WorkerName, type WorkerSpec } from "./plan.js";

// Which Workers a tree needs deployed — DERIVED, never declared
// (docs/reference/specs/release-and-deploy.md items 4–7). A PR body saying "bot deploy
// only" is a claim; this module works from facts: the commit each Worker is
// serving (`build.commit` on its /healthz), the paths that changed between
// that and HEAD, and each Worker's real inputs — the relative-import closure
// of its `worker.ts`, its own directory, its workspace's PRODUCTION closure in
// the one root lockfile, and for the bot the sources its Dockerfile COPYs and
// installs. Tests, docs, CI and the
// deploy tooling are an explicit inert list. Anything neither claimed nor
// inert is unclassified, and an unclassified path makes every Worker unsure:
// the fleet deploys and the report says which path to classify. A missed
// deploy is an incident; an extra one is a rollout.
//
// Pure: no node:* imports. The probe (git, /healthz) is injected
// (src/deploy/run.ts builds the real one); every decision below is a function
// of what the probe returns, unit-tested in affected.test.ts.

/** Paths that change no deployed artifact, each with the rule that says so. */
export const INERT_RULES: readonly { rule: string; test: RegExp }[] = [
  { rule: "tests", test: /\.test\.[cm]?[jt]sx?$/ },
  { rule: "tests", test: /(^|\/)testing\// },
  { rule: "tests", test: /(^|\/)vitest\.config\.[cm]?[jt]s$/ },
  { rule: "tests", test: /(^|\/)test-env\.d\.ts$/ },
  { rule: "tests", test: /(^|\/)__snapshots__\// },
  { rule: "docs", test: /^docs\// },
  { rule: "specs", test: /^features\// },
  // Not under skills/: the bot image COPYs skills/ and loads every SKILL.md at startup.
  { rule: "markdown", test: /^(?!skills\/).*\.md$/ },
  { rule: "ci", test: /^\.github\// },
  { rule: "scripts", test: /^scripts\// },
  { rule: "deploy tooling", test: /^deploy\/bin\// },
  { rule: "deploy tooling", test: /^deploy\/[^/]+\/preflight(\.test)?\.mjs$/ },
  { rule: "deploy tooling", test: /^deploy\/cloudflare\/write-build\.mjs$/ },
  { rule: "docs Worker (its own CI deploy)", test: /^deploy\/cloudflare-docs\// },
  {
    rule: "operator manifests (a new secret is a `wrangler secret put`, not a deploy)",
    test: /^deploy\/(secrets\.manifest\.json|agent-env\.jsonc|agent-env-bootstrap\.sh)$/,
  },
  // The deployment profile says WHERE the fleet is; it is read by the deploy
  // tooling, never bundled or copied into an image.
  { rule: "deployment profile", test: /^deploy\/profile(\.example)?\.json$/ },
  // The bot reads its config from the state Worker (`deploy config` pushes it); the image never holds it.
  { rule: "bot runtime config (pushed to the state Worker, never built into the image)", test: /^config\// },
  {
    rule: "repo metadata",
    test: /^(\.gitignore|\.nvmrc|\.env\.example|LICENSE|NOTICE|docker-compose\.yml|tsconfig\.scripts\.json|release-please-config\.json|\.release-please-manifest\.json|project\.json|switchboard\.png)$/,
  },
  { rule: "lint and format config", test: /^(\.prettierignore|\.prettierrc(\.json)?|eslint\.config\.[cm]?js)$/ },
  // One npm workspace, one lockfile: a per-workspace lockfile in a diff
  // is the retired file disappearing, never a dependency changing — the root
  // lockfile is judged instead (`ROOT_LOCKFILE`, per Worker by its workspace).
  { rule: "retired per-workspace lockfile", test: /^(deploy\/[^/]+|web|docs)\/package-lock\.json$/ },
];

/** The one lockfile (npm workspaces). Judged per Worker: the dependency
 *  closure of ITS workspace(s), not the file as a whole. */
export const ROOT_LOCKFILE = "package-lock.json";

export type PathClass =
  { kind: "input"; workers: WorkerName[] } | { kind: "inert"; rule: string } | { kind: "unclassified" };

/** Who claims a path: an inert rule, the Workers whose declared inputs cover
 *  it (a dir prefix ends with `/`, anything else is an exact file), or nobody.
 *  Inert wins over a claim — a test under `src/` never reaches the image. */
export function classifyPath(path: string, workers: readonly WorkerSpec[] = WORKER_SPECS): PathClass {
  const inert = INERT_RULES.find((r) => r.test.test(path));
  if (inert) return { kind: "inert", rule: inert.rule };
  const claimed = workers
    .filter((w) => w.inputs.paths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p)))
    .map((w) => w.name);
  return claimed.length > 0 ? { kind: "input", workers: claimed } : { kind: "unclassified" };
}

// ---- import closure ------------------------------------------------------------------------------

/** Strip comments so a specifier quoted in prose is not followed. A `//` right
 *  after `:` or a quote is a URL inside a string, not a comment. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every RELATIVE module specifier a source imports — static (`import … from`,
 *  `import type`, `export … from`, `export * from`), side-effect (`import "x"`)
 *  and dynamic (`import("x")`) — in source order, once each. Bare package names
 *  and `node:` / `cloudflare:` builtins are not inputs of the tree. */
export function importSpecifiers(source: string): string[] {
  const text = stripComments(source);
  const found: { index: number; spec: string }[] = [];
  for (const re of [
    /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const m of text.matchAll(re)) found.push({ index: m.index ?? 0, spec: m[1] });
  }
  const out: string[] = [];
  for (const f of found.sort((a, b) => a.index - b.index)) {
    if ((f.spec.startsWith("./") || f.spec.startsWith("../")) && !out.includes(f.spec)) out.push(f.spec);
  }
  return out;
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

const JS_TO_TS: Record<string, string> = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts", ".jsx": ".tsx" };

/** The files a specifier may name, most likely first: a `.js` specifier is how
 *  TypeScript sources import their `.ts` neighbours, so the `.ts` twin comes
 *  first, then the literal path, then a directory index. */
export function resolveImportCandidates(fromFile: string, specifier: string): string[] {
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const joined = normalizePath(`${dir}/${specifier}`);
  const ext = /\.[a-z]+$/i.exec(joined)?.[0] ?? "";
  const candidates: string[] = [];
  if (JS_TO_TS[ext]) candidates.push(joined.slice(0, -ext.length) + JS_TO_TS[ext]);
  if (!ext) candidates.push(`${joined}.ts`);
  candidates.push(joined, `${joined}/index.ts`);
  return candidates;
}

export interface ImportClosure {
  /** Every file reachable from the entry through relative imports, the entry included, sorted. */
  files: string[];
  /** Specifiers that resolved to no file — the Worker is unsure, never silently narrower. */
  unresolved: { from: string; specifier: string }[];
}

/** Crawl the relative-import graph from `entry` over `read` (a tree at one
 *  commit: `git show <ref>:<path>`, or the filesystem). Type-only imports are
 *  followed too — the file is part of the program, and over-inclusion is the
 *  safe direction. */
export async function importClosure(
  entry: string,
  read: (path: string) => Promise<string | undefined>,
): Promise<ImportClosure> {
  const entrySource = await read(entry);
  if (entrySource === undefined) return { files: [], unresolved: [{ from: "", specifier: entry }] };
  const sources = new Map<string, string>([[entry, entrySource]]);
  const unresolved: { from: string; specifier: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of importSpecifiers(sources.get(file)!)) {
      let resolved: string | undefined;
      for (const candidate of resolveImportCandidates(file, spec)) {
        const known = sources.get(candidate);
        if (known !== undefined) {
          resolved = candidate;
          break;
        }
        const text = await read(candidate);
        if (text !== undefined) {
          sources.set(candidate, text);
          queue.push(candidate);
          resolved = candidate;
          break;
        }
      }
      if (!resolved) unresolved.push({ from: file, specifier: spec });
    }
  }
  return { files: [...sources.keys()].sort(), unresolved };
}

// ---- lockfiles and package.json --------------------------------------------------------------------

interface LockPackage {
  version?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /** npm ≥7 installs peers too; an optional peer (`peerDependenciesMeta`) may legitimately be absent. */
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  /** Shipped INSIDE this package's tarball: no lockfile entry of their own, moved by this package's version. */
  bundleDependencies?: string[];
}

/** The edges npm follows out of one installed package (or the workspace itself). */
function lockEdges(pkg: LockPackage, { includeDev }: { includeDev: boolean }): { name: string; peer: boolean }[] {
  const bundled = new Set(pkg.bundleDependencies ?? []);
  const names = new Set(
    Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...(includeDev ? pkg.devDependencies : {}) }),
  );
  const edges = [...names].filter((n) => !bundled.has(n)).map((name) => ({ name, peer: false }));
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    if (names.has(name) || bundled.has(name) || pkg.peerDependenciesMeta?.[name]?.optional) continue;
    edges.push({ name, peer: true });
  }
  return edges;
}

/** npm's own resolution over the lockfile's `packages` keys: the nearest
 *  `node_modules/<name>` walking up from `fromPath` (a nested install first,
 *  the hoisted one last). `undefined` when no entry resolves. */
function resolveLockPackage(packages: Record<string, LockPackage>, fromPath: string, name: string): string | undefined {
  let dir = fromPath;
  for (;;) {
    const key = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (key in packages) return key;
    if (dir === "") return undefined;
    const i = dir.lastIndexOf("/node_modules/");
    dir = i >= 0 ? dir.slice(0, i) : "";
  }
}

/**
 * The dependency closure of one npm workspace in the ROOT `package-lock.json`
 * (v2/v3 `packages` map), as `{ lockfile path → version }` — what wrangler
 * bundles for that Worker (`includeDev: false`), or what an image's `npm ci`
 * installs for it (`includeDev: true`; the toolchain builds the artifact).
 * The workspace itself is `""` for the root package, else its directory.
 * `undefined` when the text is not a lockfile or the workspace is not in it —
 * the caller fails open.
 */
export function workspaceDependencies(
  lockfileText: string | undefined,
  workspace: string,
  { includeDev }: { includeDev: boolean },
): Map<string, string> | undefined {
  if (lockfileText === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockfileText);
  } catch {
    return undefined;
  }
  const packages = (parsed as { packages?: unknown } | null)?.packages;
  if (typeof packages !== "object" || packages === null) return undefined;
  const all = packages as Record<string, LockPackage>;
  const root = all[workspace];
  if (typeof root !== "object" || root === null) return undefined;
  const out = new Map<string, string>();
  const queue: { from: string; edges: { name: string; peer: boolean }[] }[] = [
    { from: workspace, edges: lockEdges(root, { includeDev }) },
  ];
  while (queue.length > 0) {
    const { from, edges } = queue.shift()!;
    for (const { name, peer } of edges) {
      const key = resolveLockPackage(all, from, name);
      if (key === undefined) {
        // A peer nobody installed is not part of what ships. Anything else
        // named but absent from the lockfile is recorded, so a diff shows it.
        if (!peer) out.set(`${from ? `${from}/` : ""}node_modules/${name}`, "unresolved");
        continue;
      }
      if (out.has(key)) continue;
      const pkg = all[key];
      out.set(key, typeof pkg.version === "string" ? pkg.version : "?");
      // Inside the closure only what npm installs matters: a dependency's own
      // devDependencies never are; its peers are (npm ≥7), unless optional.
      queue.push({ from: key, edges: lockEdges(pkg, { includeDev: false }) });
    }
  }
  return out;
}

const depName = (key: string) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

/** Human lines for what moved between two production dependency sets; empty when nothing did. */
export function prodDepsDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(key);
    const b = after.get(key);
    if (a === b) continue;
    if (a === undefined) lines.push(`+ ${depName(key)} ${b}`);
    else if (b === undefined) lines.push(`− ${depName(key)}`);
    else lines.push(`${depName(key)} ${a} → ${b}`);
  }
  return lines;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Whether a `package.json` diff touches anything the artifact is built from.
 *  `version` never does (release-please bumps it on every release); for a
 *  Worker's own package.json neither do `devDependencies` (wrangler bundles
 *  production dependencies; the toolchain never enters the bundle) — the
 *  caller passes `ignoreDevDependencies` for those. Anything unparsable or
 *  newly present is a change: fail open. */
export function packageJsonChangeKind(
  before: string | undefined,
  after: string | undefined,
  { ignoreDevDependencies = false } = {},
): "unchanged" | "inert-only" | "changed" {
  if (before === after) return "unchanged";
  if (before === undefined || after === undefined) return "changed";
  try {
    const a = JSON.parse(before) as Record<string, unknown>;
    const b = JSON.parse(after) as Record<string, unknown>;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return "changed";
    const strip = ({ version: _v, devDependencies, ...rest }: Record<string, unknown>) =>
      ignoreDevDependencies ? rest : { ...rest, devDependencies };
    if (canonicalJson(strip(a)) !== canonicalJson(strip(b))) return "changed";
    return canonicalJson(a) === canonicalJson(b) ? "unchanged" : "inert-only";
  } catch {
    return "changed";
  }
}

// ---- the decision ----------------------------------------------------------------------------------

/** What the selection reads from the host. src/deploy/run.ts implements it over git and fetch. */
export interface AffectedProbe {
  /** `git rev-parse HEAD`. */
  head(): Promise<string>;
  /** The commit a Worker serves: `build.commit` from its `/healthz` (the sandbox needs its bearer). */
  liveCommit(worker: WorkerName): Promise<{ commit: string } | { error: string }>;
  /** `git merge-base --is-ancestor <commit> <head>`. */
  isAncestor(commit: string, head: string): Promise<boolean>;
  /** The last release before HEAD (`git describe --tags --match 'v*' --abbrev=0 HEAD^`), resolved. */
  lastRelease(): Promise<{ tag: string; commit: string } | undefined>;
  /** `git diff --name-only <base> <head>` (renames as both sides); `undefined`
   *  when git fails (a base that is not in this checkout) — never `[]`, which
   *  would read as a confident "nothing changed". */
  changedPaths(base: string, head: string): Promise<string[] | undefined>;
  /** `git show <ref>:<path>`; undefined when the path is not in that tree. */
  fileAt(ref: string, path: string): Promise<string | undefined>;
}

export type AffectedBase =
  | { kind: "live"; commit: string }
  | { kind: "release"; tag: string; commit: string }
  | { kind: "ref"; ref: string }
  | { kind: "none"; reason: string };

export interface WorkerAffected {
  name: WorkerName;
  decision: "deploy" | "skip";
  base: AffectedBase;
  /** Changed inputs (a path, `<path> (imported by <entry>)`, `<lock>: production dependencies changed — …`) or `unsure: …` lines. */
  reasons: string[];
}

export interface AffectedReport {
  head: string;
  workers: WorkerAffected[];
  /** The Workers to deploy, in deploy order. */
  selected: WorkerName[];
  /** Changed paths no rule claims — each makes every Worker unsure. */
  unclassified: string[];
  deployAll: boolean;
  markdown: string;
}

const short = (commit: string) => commit.slice(0, 7);

/** Judge a live commit as a base: only a plain hex commit that is an ancestor of HEAD. */
async function liveBase(
  probe: AffectedProbe,
  worker: WorkerName,
  head: string,
): Promise<{ base: AffectedBase } | { reason: string }> {
  const live = await probe.liveCommit(worker);
  if (!("commit" in live)) return { reason: `/healthz: ${live.error}` };
  const c = live.commit.trim();
  if (c === "unknown") return { reason: 'serving commit "unknown" — the image was built without a stamp' };
  if (c.endsWith("-dirty")) return { reason: `serving ${short(c)}-dirty — a dirty build is not a commit` };
  if (!/^[0-9a-f]{7,40}$/.test(c))
    return { reason: `serving an unrecognizable build identity ${JSON.stringify(c.slice(0, 40))}` };
  if (!(await probe.isAncestor(c, head)))
    return { reason: `live commit ${short(c)} is not an ancestor of HEAD ${short(head)}` };
  return { base: { kind: "live", commit: c } };
}

/**
 * The selection. Per Worker: a base (`opts.base` for every Worker, else its
 * live commit, else the last release, else none = unsure), the paths changed
 * from that base to HEAD, and which of them are its inputs. Then the fleet-wide
 * rule: an unclassified path anywhere makes every Worker unsure.
 */
export async function computeAffected(
  probe: AffectedProbe,
  opts: { base?: string } = {},
  workers: readonly WorkerSpec[] = WORKER_SPECS,
): Promise<AffectedReport> {
  const head = await probe.head();
  let lastRelease: Promise<{ tag: string; commit: string } | undefined> | undefined;
  const fallback = () => (lastRelease ??= probe.lastRelease());
  const readHead = (p: string) => probe.fileAt(head, p);

  const judged: WorkerAffected[] = [];
  const unclassified = new Set<string>();
  const diffs = new Map<string, Promise<string[] | undefined>>();
  const changedFrom = (ref: string) => {
    if (head.startsWith(ref) && ref.length >= 7) return Promise.resolve<string[] | undefined>([]);
    let d = diffs.get(ref);
    if (!d) diffs.set(ref, (d = probe.changedPaths(ref, head)));
    return d;
  };

  for (const w of workers) {
    let base: AffectedBase;
    const reasons: string[] = [];
    if (!/^[0-9a-f]{40}$/.test(head)) {
      // No HEAD to judge against (not a git checkout, or git failed): nothing
      // below can be trusted, and "no input changed" must never be the answer.
      base = {
        kind: "none",
        reason: `HEAD could not be read (${JSON.stringify(head.slice(0, 40))}) — not a git checkout?`,
      };
      reasons.push(`unsure: ${base.reason}`);
    } else if (opts.base !== undefined) {
      base = { kind: "ref", ref: opts.base };
    } else {
      const live = await liveBase(probe, w.name, head);
      if ("base" in live) base = live.base;
      else {
        const rel = await fallback();
        if (rel) base = { kind: "release", tag: rel.tag, commit: rel.commit };
        else {
          base = { kind: "none", reason: live.reason };
          reasons.push(`unsure: no base — ${live.reason}; no release tag before HEAD`);
        }
      }
    }

    if (base.kind !== "none") {
      const baseRef = base.kind === "ref" ? base.ref : base.commit;
      const changed = await changedFrom(baseRef);
      if (changed === undefined) {
        // A failed diff is not an empty diff: the base may not exist in this
        // checkout (a typo'd --base, a shallow clone). Unsure, never "skip".
        reasons.push(
          `unsure: git diff ${baseRef.length === 40 ? short(baseRef) : baseRef}..HEAD failed — is the base in this checkout?`,
        );
      } else if (changed.length > 0) {
        const closure = await importClosure(w.entry, readHead);
        for (const u of closure.unresolved)
          reasons.push(`unsure: import ${u.specifier} from ${u.from || "(entry)"} resolves to no file`);
        for (const path of changed) {
          if (path === ROOT_LOCKFILE) {
            // One lockfile for every workspace: judged per Worker by the
            // dependency closure of ITS workspace(s), never by the file as a whole.
            const [beforeText, afterText] = [await probe.fileAt(baseRef, path), await readHead(path)];
            for (const { workspace, includeDev } of w.inputs.lockfile) {
              const kind = includeDev ? "dependencies" : "production dependencies";
              const label = workspace === "" ? "the root package" : workspace;
              const before = workspaceDependencies(beforeText, workspace, { includeDev });
              const after = workspaceDependencies(afterText, workspace, { includeDev });
              if (!before || !after)
                reasons.push(`${path}: ${kind} of ${label} could not be read — treated as changed`);
              else {
                const moved = prodDepsDiff(before, after);
                if (moved.length > 0) reasons.push(`${path}: ${kind} of ${label} changed — ${moved.join(", ")}`);
              }
            }
            continue;
          }
          const cls = classifyPath(path, workers);
          if (cls.kind === "inert") continue;
          if (cls.kind === "unclassified") {
            unclassified.add(path);
            continue;
          }
          if (cls.workers.includes(w.name)) {
            if (path === "package.json" || path.endsWith("/package.json")) {
              // A Worker dir's own package.json: its devDependencies are the toolchain, not the bundle.
              const ignoreDevDependencies = path === `${w.dir}/package.json`;
              if (
                packageJsonChangeKind(await probe.fileAt(baseRef, path), await readHead(path), {
                  ignoreDevDependencies,
                }) === "changed"
              )
                reasons.push(path);
            } else {
              reasons.push(path);
            }
          } else if (closure.files.includes(path)) {
            reasons.push(`${path} (imported by ${w.entry})`);
          }
        }
      }
    }
    judged.push({ name: w.name, decision: reasons.length > 0 ? "deploy" : "skip", base, reasons });
  }

  const unclassifiedPaths = [...unclassified].sort();
  if (unclassifiedPaths.length > 0) {
    for (const w of judged) {
      for (const p of unclassifiedPaths)
        w.reasons.push(`unsure: unclassified path ${p} — no rule claims it (src/deploy/affected.ts)`);
      w.decision = "deploy";
    }
  }
  const report = {
    head,
    workers: judged,
    selected: judged.filter((w) => w.decision === "deploy").map((w) => w.name),
    unclassified: unclassifiedPaths,
    deployAll: unclassifiedPaths.length > 0,
  };
  return { ...report, markdown: formatAffectedMarkdown(report) };
}

// ---- rendering -------------------------------------------------------------------------------------

const REASONS_SHOWN = 8;

function describeBase(base: AffectedBase, code: (s: string) => string): string {
  switch (base.kind) {
    case "live":
      return `live ${code(short(base.commit))}`;
    case "release":
      return `release ${code(base.tag)}`;
    case "ref":
      return `ref ${code(/^[0-9a-f]{40}$/.test(base.ref) ? short(base.ref) : base.ref)}`;
    case "none":
      return "none";
  }
}

/** A reason with its path(s) in code spans; `unsure:` lines stay prose. */
function markdownReason(reason: string): string {
  if (reason.startsWith("unsure:"))
    return reason.replace(/(unclassified path |import )(\S+)/, (_m, pre: string, p: string) => `${pre}\`${p}\``);
  return reason
    .replace(/^(\S+?)(?=$| \(imported by |: (production )?dependencies)/, "`$1`")
    .replace(/\(imported by (\S+)\)/, "(imported by `$1`)");
}

function capped(reasons: string[], render: (r: string) => string, sep: string): string {
  const shown = reasons.slice(0, REASONS_SHOWN).map(render);
  if (reasons.length > REASONS_SHOWN) shown.push(`… +${reasons.length - REASONS_SHOWN} more`);
  return shown.join(sep);
}

/** The table the release PR comment and the job summary show. */
export function formatAffectedMarkdown(report: Omit<AffectedReport, "markdown">): string {
  const code = (s: string) => `\`${s}\``;
  const headline =
    report.selected.length === 0
      ? `Deploy targets for ${short(report.head)}: **nothing to deploy** — every Worker already serves this tree's inputs.`
      : `Deploy targets for ${short(report.head)}: **${report.selected.length} of ${report.workers.length} Workers** — ${report.selected.join(", ")}`;
  const rows = report.workers.map((w) => {
    const decision = w.decision === "deploy" ? "**deploy**" : "skip";
    const why = w.reasons.length === 0 ? "no input changed" : capped(w.reasons, markdownReason, "<br>");
    return `| ${w.name} | ${decision} | ${describeBase(w.base, code)} | ${why.replace(/\|/g, "\\|")} |`;
  });
  const unclassified =
    report.unclassified.length === 0
      ? "Unclassified paths: none."
      : `**Unclassified paths (every Worker deploys):** ${report.unclassified.map(code).join(", ")} — add a rule in \`src/deploy/affected.ts\`.`;
  return [
    headline,
    "",
    "| Worker | Decision | Judged against | Why |",
    "|---|---|---|---|",
    ...rows,
    "",
    unclassified,
  ].join("\n");
}

/** The same report as plain lines, for `deploy plan` on the CLI and in chat
 *  (bullets, never padded columns — the chat shape the conformance suite holds). */
export function formatAffectedText(report: Omit<AffectedReport, "markdown">): string {
  const lines = [
    report.selected.length === 0
      ? `Affected: nothing to deploy — every Worker already serves this tree's inputs (HEAD ${short(report.head)})`
      : `Affected: ${report.selected.join(", ")} (HEAD ${short(report.head)}; judged per Worker against what it serves)`,
  ];
  for (const w of report.workers) {
    const why = w.reasons.length === 0 ? "no input changed" : capped(w.reasons, (r) => r, "; ");
    lines.push(`  - ${w.name}: ${w.decision} — ${describeBase(w.base, (s) => s)} — ${why}`);
  }
  if (report.unclassified.length > 0)
    lines.push(
      `  - UNCLASSIFIED (every Worker deploys): ${report.unclassified.join(", ")} — add a rule in src/deploy/affected.ts`,
    );
  return lines.join("\n");
}
