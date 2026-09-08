export interface ProofRef {
  line: number;
  file: string | null;
  titles: string[];
  raw: string;
  ambiguous?: string[];
}
export interface HeaderPath {
  line: number;
  path: string;
}
export interface TestNode {
  parts: string[];
  leaf: boolean;
}
export interface Problem {
  kind?: "proof" | "header" | "gap";
  key?: string;
  line: number;
  raw: string;
  reason: string;
}

export const SPECS_DIR: string;
export const BASELINE_FILE: string;
export function parseProofRefs(markdown: string): ProofRef[];
export function titleReadings(titles: string[]): string[][];
export function explicitSegment(segment: string, parts: string[]): string;
export function explicitSpan(raw: string, nodes: TestNode[]): string | null;
export function resolveBareTestFile(name: string, candidates: string[]): { file: string; ambiguous: string[] };
export function parseHeaderPaths(markdown: string): HeaderPath[];
export function collectTestTitles(source: string, fileName?: string): TestNode[];
export function segmentMatches(segment: string, part: string): boolean;
export function refMatchesNode(titles: string[], node: TestNode): boolean;
export function resolveRefs(refs: ProofRef[], titlesFor: (file: string) => TestNode[] | null): Problem[];
export function checkSpec(
  specPath: string,
  ctx: { root: string; titlesFor: (file: string) => TestNode[] | null; testFiles: string[] },
): Problem[];
export function listTestFiles(root: string, dirs?: string[]): string[];
export function partitionAgainstBaseline<T extends { key?: string }>(
  problems: T[],
  known: string[],
): { fresh: T[]; known: T[]; stale: string[] };
