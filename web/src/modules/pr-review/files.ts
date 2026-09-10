import { html as diff2html, parse as parseDiff } from "diff2html";
import type { DiffFile } from "diff2html/lib/types";

// The reading diff as files (docs/reference/specs/reading-diff.md item 6): the pure half of
// the two-column view. diff2html parses the unified diff into files and
// renders each file's hunks; this module names what the file list and the
// diff view both need about a file — its status, its counts, the one key both
// columns address it by — and the two geometry helpers the view's scroll
// behaviour rests on (which file is current at a scroll offset; which rows a
// line range covers). Nothing here touches the DOM.

export type FileStatus = "added" | "deleted" | "renamed" | "modified";

export interface DiffFileEntry {
  /** The path both columns address the file by: the new path, or the old one
   *  for a deletion. Unique within one diff. */
  path: string;
  /** The path before a rename (absent otherwise). */
  from?: string;
  status: FileStatus;
  added: number;
  deleted: number;
  binary: boolean;
  /** diff2html's rendering of this file alone — its own header is hidden by
   *  the view, which draws the file header itself. Library markup over
   *  escaped text: diff2html escapes the diff's content. */
  html: string;
}

export function fileStatus(file: Pick<DiffFile, "isNew" | "isDeleted" | "isRename" | "isCopy">): FileStatus {
  if (file.isNew) return "added";
  if (file.isDeleted) return "deleted";
  if (file.isRename || file.isCopy) return "renamed";
  return "modified";
}

/** Split a unified diff into the files the panel lists and renders. A diff
 *  with nothing parseable yields no files (the view shows the empty state). */
export function parseFiles(diff: string): DiffFileEntry[] {
  return parseDiff(diff).map((file) => {
    const status = fileStatus(file);
    return {
      path: status === "deleted" ? file.oldName : file.newName,
      ...(status === "renamed" && file.oldName !== file.newName ? { from: file.oldName } : {}),
      status,
      added: file.addedLines,
      deleted: file.deletedLines,
      binary: file.isBinary === true,
      html: diff2html([file], { drawFileList: false, outputFormat: "line-by-line", matching: "lines" }),
    };
  });
}

/** How many files a diff carries — the count alone, no rendering (the footer
 *  of an abridged diff says how many of the full diff's files it kept). */
export function countFiles(diff: string): number {
  return parseDiff(diff).length;
}

/** The directory and the name, for a list that dims the one and keeps the other. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** Scroll-spy: the index of the file the reader is on. `tops` are the files'
 *  offsets from the top of the scroll container, in order; the current file is
 *  the last one whose top has passed the container's top edge (with a small
 *  slack so a file sitting exactly at the edge counts), the first file before
 *  any has, and the last file once the container is scrolled to its end — the
 *  short tail files could never reach the edge otherwise. */
export function currentFileAt(tops: readonly number[], scrollTop: number, atEnd: boolean): number {
  if (tops.length === 0) return -1;
  if (atEnd) return tops.length - 1;
  let current = 0;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= scrollTop + 2) current = i;
  return current;
}

/** The rows a line range covers, as indexes into a file's rows: the rows whose
 *  new-side line number falls in `[from, to]`, plus every row between the first
 *  and the last of them — deletions interleaved with the range have no new
 *  number and belong to the reading of it. Empty when nothing matches. */
export function rowsInRange(newLines: readonly (number | null)[], from: number, to: number): number[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  let first = -1;
  let last = -1;
  newLines.forEach((n, i) => {
    if (n === null || n < lo || n > hi) return;
    if (first < 0) first = i;
    last = i;
  });
  if (first < 0) return [];
  return Array.from({ length: last - first + 1 }, (_, k) => first + k);
}
