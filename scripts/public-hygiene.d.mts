// Types for the public-hygiene ratchet's pure functions (scripts/public-hygiene.mjs).

export const ALLOWLIST_PATH: string;
export const ALLOW_LINES_PATH: string;
export const CLASSES: Readonly<Record<"names" | "trackers" | "planIds" | "ids" | "dates", RegExp>>;

export type Counts = Record<string, number>;
export interface Hit {
  line: number;
  cls: string;
  text: string;
}
export interface FileScan {
  counts: Counts;
  hits: Hit[];
  used: Set<string>;
}
export interface TreeScan {
  counts: Record<string, Counts>;
  hits: (Hit & { path: string })[];
  used: Set<string>;
}

/**
 * The allow file's entries: `path<TAB>trimmed line`, or `path<TAB>=~ regex` for a line
 * whose text moves without its reason changing. Iterates the entries verbatim.
 */
export class AllowLines implements Iterable<string> {
  /** Adds one entry; throws naming the entry when a pattern does not compile. */
  add(entry: string): void;
  /** The entry that allows this line of this path, or undefined. */
  match(path: string, trimmed: string): string | undefined;
  readonly size: number;
  [Symbol.iterator](): Iterator<string>;
}

export function inScope(path: string): boolean;
export function classesFor(path: string): string[];
export function parseAllowLines(text: string): AllowLines;
export function scanText(path: string, text: string, allow: AllowLines): FileScan;
export function staleAllowEntries(allow: Iterable<string>, used: ReadonlySet<string>): string[];
export function growthProblems(current: Record<string, Counts>, listed: Record<string, Counts>): string[];
export function ratchetProblems(current: Record<string, Counts>, listed: Record<string, Counts>): string[];
export function scanTree(root: string, allow: AllowLines): TreeScan;
