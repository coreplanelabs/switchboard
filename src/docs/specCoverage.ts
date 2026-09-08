// Spec coverage: which specs a change touches (docs/reference/specs/specs-coverage.md).
//
// A spec's coverage is its **Code** and **Tests** header lines — the paths it
// already names, which `specs:check` requires to exist — so there is no
// separate field to rot. A changed path is covered by a spec when it equals a
// header path or lies beneath one; a header path covers itself and everything
// under it, trailing slash or not, because a file can have no descendants and a
// directory's children are what the spec means when it names the directory.
//
// The touched-spec list is the review agent's input for the spec contradiction
// check; the uncovered list is the warn-then-error gate over source paths that
// no spec claims. Pure: paths in, lists out. The host (scripts/specs-coverage.ts)
// reads the tree and the diff.
//
// `parseHeaderPaths` is the same rule `scripts/specs-check.mjs` applies — kept
// here as its own copy because nothing under `src/` may import from `scripts/`
// (the bot image copies `src/` alone).

export interface HeaderPath {
  /** 1-based line in the spec. */
  line: number;
  path: string;
}

export interface SpecCoverage {
  /** Repo-relative spec path, e.g. `docs/reference/specs/authorization.md`. */
  path: string;
  headerPaths: string[];
}

export interface TouchedSpec {
  spec: string;
  /** The header paths the changed paths matched, in header order. */
  because: string[];
}

export interface CoverageResult {
  touched: TouchedSpec[];
  /** Changed source paths (`isSourcePath`) no spec covers. */
  uncovered: string[];
}

/** A path carries a directory and no wildcard: `src/x.ts`, `deploy/cloudflare/`; not `Actor`, `conversations.info`, `/runs`, `src/*.ts`. */
const PATH_SPAN = /^[\w.@-]+(?:\/[\w.@-]+)+\/?$/;

/** Pure: the paths a spec's **Code** / **Tests** header lines claim. */
export function parseHeaderPaths(markdown: string): HeaderPath[] {
  const paths: HeaderPath[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^- \*\*(Code|Tests)\*\*:/.test(line)) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const span = m[1];
      if (!PATH_SPAN.test(span)) continue;
      paths.push({ line: i + 1, path: span });
    }
  }
  return paths;
}

/** The trees whose code every spec together must cover. */
export const SOURCE_ROOTS = ["src/", "web/src/", "deploy/"] as const;
const CODE_FILE = /\.(?:[cm]?[jt]s|vue)$/;
const NOT_SOURCE = /(?:\.(?:test|spec)\.[cm]?[jt]s|\.d\.[cm]?ts)$|(?:^|\/)(?:__snapshots__|testing)\//;

/** Pure: a code file under one of the source roots — not a test, snapshot, fixture, declaration, config or doc. */
export function isSourcePath(path: string): boolean {
  if (!SOURCE_ROOTS.some((root) => path.startsWith(root))) return false;
  return CODE_FILE.test(path) && !NOT_SOURCE.test(path);
}

/** Pure: does `header` cover `changed` — equal, or `changed` beneath it (a trailing slash on the header is optional). */
export function covers(header: string, changed: string): boolean {
  const dir = header.endsWith("/") ? header : `${header}/`;
  return changed === header || changed.startsWith(dir);
}

/**
 * Pure: the specs a set of changed paths touches (each with the header paths
 * that matched, in spec order) and the changed source paths no spec covers.
 */
export function coveringSpecs(changed: string[], specs: SpecCoverage[]): CoverageResult {
  const touched: TouchedSpec[] = [];
  const covered = new Set<string>();
  for (const spec of specs) {
    const because = spec.headerPaths.filter((header) => {
      const hits = changed.filter((c) => covers(header, c));
      for (const c of hits) covered.add(c);
      return hits.length > 0;
    });
    if (because.length > 0) touched.push({ spec: spec.path, because: [...new Set(because)] });
  }
  const uncovered = changed.filter((c) => isSourcePath(c) && !covered.has(c));
  return { touched, uncovered };
}
