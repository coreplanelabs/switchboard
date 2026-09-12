// The reading diff as files (docs/reference/specs/reading-diff.md item 12): the pure half of
// the Files changed view. The parser is the one the diff renders with, behind
// the same one load. Nothing here touches the DOM.

import { loadDiffs } from "./diffsLibrary";

export interface DiffFileStats {
  /** The path the list and the rendered diff address the file by: the new
   *  path, or the old one for a deletion. Unique within one diff. */
  path: string;
  additions: number;
  deletions: number;
}

export interface DiffStats {
  files: DiffFileStats[];
  additions: number;
  deletions: number;
}

/** Each file of a unified diff with its added and removed line counts, and
 *  the totals. Text that is not a diff yields no files and zeros. */
export async function diffStats(diff: string): Promise<DiffStats> {
  const { parsePatchFiles } = await loadDiffs();
  const files = parsePatchFiles(diff)
    .flatMap((patch) => patch.files)
    .map((file) => ({
      path: file.name,
      additions: file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
      deletions: file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
    }));
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/** Keeps both ends of a long name, since the start (the folder) and the end
 *  (the file) are what a person recognises; the middle is what goes. */
export function ellipsizeMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(1, max - 1);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
