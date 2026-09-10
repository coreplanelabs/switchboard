# pr-review module

The UI for **reading a pull-request review**: the change as a reviewer reads it
(the full `git diff`, or an abridged "reading diff" from a model-backed
producer such as meat.dev), under the PR's own title, with links back to the
PR. Feature contract:
[`docs/reference/specs/reading-diff.md`](../../../../docs/reference/specs/reading-diff.md) item 6.

## Boundary — deliberately liftable

This folder is a self-contained module intended to be abstracted out and
shared into another product later:

- **Props-only.** `PrReviewPanel` takes one `PrReviewData` object (see
  `types.ts`). Nothing here reads seeds, streams, stores, or routes.
- **No app imports.** Allowed dependencies: `vue`, Nuxt UI components,
  `diff2html` (its renderer and its stylesheet), and files inside this folder.
  Nothing from `../../lib`, `../../pages`, `@core/*`, or anything runs-shaped —
  **runs are Switchboard-specific and stay outside**.
- **Adapters live with the host.** Switchboard's mapping from run events to
  `PrReviewData` is `web/src/lib/prReviewCollector.ts`; another host writes its
  own adapter against `types.ts` and changes nothing here.
- **Theming through tokens.** Colors come from Nuxt UI's `--ui-*` tokens and
  diff2html's `--d2h-*` variables, set once for both themes. The two diff hues
  are `--pr-review-ins` / `--pr-review-del` on `.pr-review-panel` (defaults:
  `--ui-success` / `--ui-error`); a host retunes them with a style on the
  panel — Switchboard sets them to its run-page status colors.

## Shape

A header over two columns that scroll independently; the host gives the panel
a box (Switchboard: a slideout nearly the viewport wide) and the panel fills it.

- **Header** — the PR's title (`data.title`, else `owner/repo#N`) linking to the
  PR; one line of facts: the reference, the head sha, the base, `N files, +A −D`,
  the producer badge, `truncated` when the producer capped the diff, the
  files-on-GitHub link; the producer tabs when both diffs exist (abridged
  preferred; a segmented control — with one producer there is no tab bar, the
  badge names it), the wrap toggle, and — for a `closable` host — a close
  control that emits `close`. The three labels a reader cannot name carry a
  tooltip (`poweredByExplanation`, `truncatedExplanation`), on the tab and on
  the badge alike.
- **Left column** (`FileList.vue`, hidden below `md`) — stacked sections: the
  host's `#description` slot (the seat for the PR description's TL;DR), its
  `#tour` slot (the description's Tour steps), then the files: status icon, path with the directory dimmed, `+A −D`, the viewed
  mark. Clicking an entry scrolls the diff to that file; the current entry
  follows the diff's scroll (scroll-spy).
- **Right column** (`ReadingDiffView.vue`) — the producer's summary as a
  labelled lede block (`Summary · meat`, the sentence at a measure, the files'
  hairline under it), then one section per file: a sticky one-line header (collapse chevron,
  status, path — `old → new` for a rename —, counts or `binary`, the viewed
  checkbox) over diff2html's line-by-line rendering. Long lines scroll inside
  the file's code area; the wrap toggle folds them instead. The view exposes
  `scrollTo(path, fromLine, toLine)` — lights the rows the new-side line range
  covers, unfolds a folded file (measuring once the unfold has rendered) and
  scrolls to them; resolves `false`, leaving the previous light alone, for a
  file or range the diff does not carry — and `scrollToFile(path)`.
- **Viewed** folds a file (header stays, body hidden) and dims its entry; the
  marks are one `Set` of paths the panel keeps for its lifetime, shared by both
  columns and across the producer tabs.

## Pieces

- `types.ts` — the input contract (`PrRef`, `ReadingDiff`, `PrReviewData`) and
  the pure helpers (`prLinks` — GitHub links from shape-verified values only;
  `preferredDiff` — abridged first; `poweredByLabel`; `panelTitle`; the tooltip
  texts `poweredByExplanation` and `truncatedExplanation`).
- `files.ts` — the diff as files (`parseFiles`: path, status, counts, rename
  source, binary, and diff2html's rendering of that file alone) and the pure
  geometry the view rests on (`currentFileAt` for the scroll-spy, `rowsInRange`
  for a line range).
- `FileList.vue` — the left column.
- `LabelTip.vue` — the one tooltip setting for the labels that explain
  themselves (wrapping at a measure, below the label, collision-aware, a short
  delay).
- `ReadingDiffView.vue` — the right column; imports diff2html's stylesheet and
  layers the token overrides on it.
- `PrReviewPanel.vue` — the header, the two columns, the shared state.
- `prReview.test.ts` — the module's own tests, fixture-driven through props.
