// Types for the vocabulary ratchet's pure functions (scripts/vocabulary-check.mjs).

import type { RatchetWording } from "./public-hygiene.d.mts";

export const BASELINE_PATH: string;
export const WORDING: RatchetWording;
export const WORDS: Readonly<Record<string, RegExp>>;
export const EXEMPT_PATHS: ReadonlySet<string>;

export type Surface = "bot" | "registry" | "web" | "docs";
export interface Snippet {
  line: number;
  text: string;
}
export interface Hit {
  line: number;
  word: string;
  text: string;
}
export interface FileScan {
  counts: Record<string, number>;
  hits: Hit[];
}
export interface TreeScan {
  counts: Record<string, Record<string, number>>;
  hits: (Hit & { path: string })[];
}

export function surfaceFor(path: string): Surface | null;
export function extractTypeScriptStrings(path: string, text: string, mode: "all" | "describe"): Snippet[];
export function extractTemplateText(sfc: string): Snippet[];
export function extractFile(path: string, text: string): Snippet[];
export function scanSnippets(snippets: readonly Snippet[]): FileScan;
export function scanTree(root: string): TreeScan;
