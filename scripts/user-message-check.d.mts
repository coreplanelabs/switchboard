// Types for the user-message ratchet's pure functions.

import type { RatchetWording } from "./public-hygiene.d.mts";

export const BASELINE_PATH: string;
export const WORDING: RatchetWording;
export const PHRASES: Readonly<Record<string, RegExp>>;

export type Surface = "typescript" | "web";
export type MessageShape = "statement" | "confirmation" | "question";
export interface UserMessage {
  line: number;
  text: string;
  shape: MessageShape;
}
export interface Hit {
  line: number;
  phrase: string;
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
export function extractTypeScriptMessages(path: string, text: string): UserMessage[];
export function extractFile(path: string, text: string): UserMessage[];
export function scanMessages(messages: readonly UserMessage[]): FileScan;
export function scanTree(root: string): TreeScan;
