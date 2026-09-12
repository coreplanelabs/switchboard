// The one load of @pierre/diffs. The library carries the highlighter, which no
// page needs before it shows a diff, so it is fetched on demand — and once:
// the file counts and the renderer both wait on the same promise, however
// many renders overlap.

let library: Promise<typeof import("@pierre/diffs")> | undefined;

export function loadDiffs(): Promise<typeof import("@pierre/diffs")> {
  library ??= import("@pierre/diffs");
  return library;
}
