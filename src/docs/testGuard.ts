// The test guard (docs/reference/specs/specs-coverage.md item 6): a PR may
// remove or narrow a test only when the same PR changes a spec that covers
// that test's path — the same-PR rule the specs already hold for behavior,
// extended to the proofs.
//
// Two classes of line, both silenced only by a covering spec change:
//   removed: (class A) a deterministic loss — the test file deleted, a title
//            gone from the file with no new title added, a skip/only/todo
//            marker on a test the base ran. Fails the command.
//   check:   (class B) a signal a person disposes of — fewer `expect(` calls,
//            a title gone while another arrived (a rename or a split). Never
//            fails the command; the review prompt makes the reviewer say
//            "weakened" or "refactor, verification intact" for each.
//
// Pure: snapshots of each changed test file at the base and at the head, the
// diff's paths and the specs' coverage in; findings out. The host
// (scripts/specs-coverage.ts) reads git and parses the titles with the same
// static parse `specs:check` binds proofs with (`collectTestTitles`) — nothing
// under `src/` may import from `scripts/`, so the parse result is the input.

import { coveringSpecs, type SpecCoverage } from "./specCoverage.js";

export type TestMode = "skip" | "only" | "todo";

/** One describe/it/test call as `collectTestTitles` reports it. */
export interface TestBlock {
  /** The title path from the outermost describe down. */
  parts: string[];
  leaf: boolean;
  /** The modifier that takes the block out of the run; absent when it runs. */
  mode?: TestMode;
  /** The arguments after the title as written, whitespace collapsed. */
  body?: string;
}

export interface TestFileSnapshot {
  blocks: TestBlock[];
  expectCalls: number;
}

export interface ChangedTestFile {
  /** Repo-relative path at the head (at the base, for a deleted file). */
  path: string;
  /** null when the file did not exist at the base. */
  base: TestFileSnapshot | null;
  /** null when the file no longer exists at the head. */
  head: TestFileSnapshot | null;
}

export type FindingKind = "removed" | "check";

export interface TestFileChange {
  kind: FindingKind;
  what: string;
}

export interface TestGuardFinding extends TestFileChange {
  file: string;
  /** The specs whose Code/Tests headers cover the file, in spec order. */
  specs: string[];
  /** One of `specs` is among the diff's changed paths. */
  allowed: boolean;
}

export interface TestGuardResult {
  testFiles: number;
  findings: TestGuardFinding[];
}

/** The same shape `specs:check` reads test files by. */
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]s$/;

export const isTestFile = (path: string): boolean => TEST_FILE.test(path);

/** Pure: the `expect(` calls in a source, whatever follows each. */
export function countExpectCalls(source: string): number {
  return source.match(/\bexpect\s*\(/g)?.length ?? 0;
}

const keyOf = (parts: string[]) => parts.join("\u0000");
const titleOf = (parts: string[]) => parts.join(" > ");
const label = (b: TestBlock) => `${b.leaf ? "test" : "describe"} "${titleOf(b.parts)}"`;

/** A marker on the head block that the base block did not carry takes it (or, for `only`, every other test) out of the run. */
function markerAdded(base: TestBlock, head: TestBlock): TestFileChange | null {
  if (!head.mode || base.mode) return null;
  const who = head.mode === "only" ? `every test but "${titleOf(head.parts)}"` : label(head);
  return { kind: "removed", what: `${who} from the run — marked ${head.mode}` };
}

/**
 * Pure: what one test file lost between the base and the head, in base order.
 * A block is the same block when its title path is unchanged; a block that
 * kept its own title and body but sits under a retitled describe moved with
 * it and lost nothing; a block whose body is unchanged under a new title was
 * retitled (a check); a title gone while other titles arrived is a rename or
 * a split (a check); a title gone with nothing arriving in its place is
 * removed.
 */
export function compareTestFile(base: TestFileSnapshot | null, head: TestFileSnapshot | null): TestFileChange[] {
  if (base === null) return [];
  if (head === null) return [{ kind: "removed", what: "the test file" }];
  const out: TestFileChange[] = [];

  const headByKey = new Map(head.blocks.map((b) => [keyOf(b.parts), b]));
  const baseKeys = new Set(base.blocks.map((b) => keyOf(b.parts)));
  const gone: TestBlock[] = [];
  for (const b of base.blocks) {
    const h = headByKey.get(keyOf(b.parts));
    if (h === undefined) gone.push(b);
    else {
      const marker = markerAdded(b, h);
      if (marker) out.push(marker);
    }
  }

  const added = head.blocks.filter((b) => !baseKeys.has(keyOf(b.parts)));
  const taken = new Set<TestBlock>();
  const claim = (matches: (h: TestBlock) => boolean): TestBlock | undefined => {
    const h = added.find((x) => !taken.has(x) && matches(x));
    if (h) taken.add(h);
    return h;
  };
  const sameBody = (a: TestBlock, b: TestBlock) => a.leaf === b.leaf && a.body !== undefined && a.body === b.body;

  // Moved verbatim under another describe: the describe's own line covers it.
  const unmoved: TestBlock[] = [];
  for (const g of gone) {
    const h = claim((x) => sameBody(g, x) && x.parts.at(-1) === g.parts.at(-1));
    if (h === undefined) unmoved.push(g);
    else {
      const marker = markerAdded(g, h);
      if (marker) out.push(marker);
    }
  }
  // Same body under a new title: a rename to confirm.
  const unpaired: TestBlock[] = [];
  for (const g of unmoved) {
    const h = claim((x) => sameBody(g, x));
    if (h === undefined) unpaired.push(g);
    else {
      out.push({ kind: "check", what: `${label(g)} retitled "${titleOf(h.parts)}", body unchanged` });
      const marker = markerAdded(g, h);
      if (marker) out.push(marker);
    }
  }
  // Gone titles pair off with the new titles still unaccounted for, in order:
  // each pair is a rename or a split to confirm; a gone title with no new
  // title left to pair with is removed. N gone and M added give min(N, M)
  // checks and N − M removals, so a rename beside a deletion in one file still
  // reports the deletion.
  for (const g of unpaired) {
    const h = claim(() => true);
    if (h === undefined) out.push({ kind: "removed", what: label(g) });
    else
      out.push({
        kind: "check",
        what: `${label(g)} gone while "${titleOf(h.parts)}" was added in the same file — a rename or a split?`,
      });
  }

  if (head.expectCalls < base.expectCalls)
    out.push({ kind: "check", what: `expect() calls ${base.expectCalls} → ${head.expectCalls}` });
  return out;
}

/**
 * Pure: every finding over the changed test files, each carrying the specs
 * that cover its file and whether one of them is among the changed paths.
 */
export function testGuard(files: ChangedTestFile[], changedPaths: string[], specs: SpecCoverage[]): TestGuardResult {
  const changed = new Set(changedPaths);
  const findings: TestGuardFinding[] = [];
  for (const file of files) {
    const covering = coveringSpecs([file.path], specs).touched.map((t) => t.spec);
    const allowed = covering.some((spec) => changed.has(spec));
    for (const change of compareTestFile(file.base, file.head))
      findings.push({ file: file.path, ...change, specs: covering, allowed });
  }
  return { testFiles: files.length, findings };
}

/** Pure: the lines the command prints, and whether it passes (no unallowed class A line). */
export function formatTestGuard(result: TestGuardResult): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  for (const f of result.findings) {
    const head = `test-guard: ${f.file} — ${f.kind}: ${f.what}`;
    if (f.allowed) lines.push(`${head} — allowed by ${f.specs.join(", ")}`);
    else if (f.kind === "check") lines.push(head);
    else if (f.specs.length > 0)
      lines.push(`${head} — covered by ${f.specs.join(", ")}; change it in this PR or restore the test`);
    else lines.push(`${head} — no spec covers it; add its spec in this PR or restore the test`);
  }
  const removals = result.findings.filter((f) => f.kind === "removed" && !f.allowed).length;
  lines.push(
    removals === 0
      ? `test-guard ok — ${result.testFiles} test file(s) changed, no verification removed without its spec`
      : `test-guard FAILED — ${removals} removal(s) without a spec change`,
  );
  return { ok: removals === 0, lines };
}
