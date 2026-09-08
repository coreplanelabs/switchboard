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

export function inScope(path: string): boolean;
export function classesFor(path: string): string[];
export function parseAllowLines(text: string): Set<string>;
export function scanText(path: string, text: string, allow: ReadonlySet<string>): FileScan;
export function staleAllowEntries(allow: ReadonlySet<string>, used: ReadonlySet<string>): string[];
export function growthProblems(current: Record<string, Counts>, listed: Record<string, Counts>): string[];
export function ratchetProblems(current: Record<string, Counts>, listed: Record<string, Counts>): string[];
export function scanTree(root: string, allow: ReadonlySet<string>): TreeScan;
