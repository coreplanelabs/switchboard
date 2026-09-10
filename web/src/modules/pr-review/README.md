# pr-review module

The UI for **reading a pull-request review**: the change as a reviewer reads it
(the full `git diff`, or an abridged "reading diff" from a model-backed
producer such as meat.dev), under the PR's own title, with links back to the
PR. Feature contract:
[`docs/reference/specs/reading-diff.md`](../../../../docs/reference/specs/reading-diff.md) item 12.

## Boundary — deliberately liftable

This folder is a self-contained module intended to be abstracted out and
shared into another product later:

- **Props-only.** `PrReviewPanel` takes one `PrReviewData` object (see
  `types.ts`) and, optionally, an `AbridgeControl` — the state of an abridging
  the host can run, and a `start()` to ask for it. Nothing here reads seeds,
  streams, stores, routes, or the network.
- **No app imports, one exception.** Allowed dependencies: `vue`, Nuxt UI
  components, `diff2html` (its renderer and its stylesheet), files inside this
  folder, and the app's generic `../../components/ExpandableText.vue` (prose
  folded to N lines) — a lift takes that one file along. Nothing from
  `../../lib`, `../../pages`, `@core/*`, or anything runs-shaped — **runs are
  Switchboard-specific and stay outside**.
- **Adapters live with the host.** Switchboard's mapping from run events to
  `PrReviewData` is `web/src/lib/prReviewCollector.ts`, and its abridge
  control is `web/src/lib/reviewAbridge.ts` (the `/api/review.abridge` calls
  and the polling); another host writes its own against `types.ts` and
  changes nothing here.
- **Theming through tokens.** Colors come from Nuxt UI's `--ui-*` tokens and
  diff2html's `--d2h-*` variables, set once for both themes. The two diff hues
  are `--pr-review-ins` / `--pr-review-del` on `.pr-review-panel` (defaults:
  `--ui-success` / `--ui-error`), and the Tour's mark — the lit rows and the
  active step — is `--pr-review-mark` (default `--ui-info`: a third hue, so a
  lit range of added lines does not vanish into the insertion green); a host
  retunes them with a style on the panel — Switchboard sets the two diff hues
  to its run-page status colors.

## Shape

A header over two columns that scroll independently; the host gives the panel
a box (Switchboard: a slideout nearly the viewport wide) and the panel fills it.

- **Header** — the PR's title (`data.description.title`, else `owner/repo#N`)
  linking to the PR; one line of facts: the reference, the head sha, the base,
  `N files, +A −D`, the producer badge, `truncated` when the producer capped
  the diff, the files-on-GitHub link; the producer tabs when both diffs exist
  (abridged preferred; a segmented control — with one producer there is no
  tab bar, the badge names it), the wrap toggle, and — for a `closable` host —
  a close control that emits `close`. The three labels a reader cannot name
  carry a tooltip (`poweredByExplanation`, `truncatedExplanation`), on the tab
  and on the badge alike. Where the tabs would be, while only the full diff
  exists and the host passed an `abridge` control: the **Abridge with meat**
  button (a tooltip says what it does and that it costs one model call), then
  the running note (spinner, "Abridging… usually 1–3 minutes") or the failure
  (the reason, a Retry); once the abridged diff arrives in `readingDiffs` the
  tabs take over with it selected. No control → nothing renders.
- **Left column** (`FileList.vue`, 19rem wide, hidden below `md`) — stacked sections, each
  rendered only when there is something to show: the **description**
  (`DescriptionBlock.vue`: the TL;DR and, after it, the What & why, folded to
  five lines by `ExpandableText` with a Show more; a muted note when the
  description was parsed from the PR body and came up short), the **Tour**
  (`TourList.vue`: `Tour · N steps`; each step a button — number, title and
  description each clamped to two lines, `Look for:`, the anchor as
  `path:from–to` in mono on one line, truncating from the left so the file
  name stays, the placement note under it; a warning badge when the anchor's
  sha is not the reviewed head, its label and the step's tooltip naming both;
  then **Remaining
  changes**, path and note each), then the files: status icon, path with the
  directory dimmed, `+A −D`, the viewed mark. The Tour holds still: no hover
  or active state changes an element's size, and what a clamp hides rides one
  `LabelTip` per step whose trigger is the step itself — a focusable button
  or link, so keyboard focus opens it as hover does — saying only what the
  step cannot show (title and description whole, the full anchor, the stale
  explanation), enabled only while something is hidden; overflow is measured
  and remeasured when the text changes in place or the list resizes. Clicking
  a step lights its lines in the diff and
  marks the step with the same mark (a left bar and a tint in
  `--pr-review-mark`); a step whose file only the full diff carries says
  `not in the reading diff · open full diff` and the jump switches producer
  first — as does a step whose lines the abridged diff dropped; a step in no
  diff while the full diff on record is `truncated` is *beyond* it — the file
  may lie past the cut — and is a link to the file on GitHub at the reviewed
  head with the lines selected (`fileLink`), reading `beyond the recorded
  diff · open on GitHub ↗` (muted and inert without a repo and head to link
  to); a step in no diff with the whole diff on record is muted and inert;
  one whose lines no diff has lands on the file and says `lines not in this
  diff`. A Remaining path opens its file the same way, and links to GitHub
  the same way when the cut hid it.
  Clicking a file entry scrolls the diff to that file; the current entry
  follows the diff's scroll (scroll-spy). The two slots (`#description`,
  `#tour`) let a host replace either section with its own content.
- **Right column** (`ReadingDiffView.vue`) — the producer's summary as a
  labelled lede block (`Summary · meat`, the sentence at a measure, the files'
  hairline under it), then one section per file: a sticky one-line header (collapse chevron,
  status, path — `old → new` for a rename —, counts or `binary`, the viewed
  checkbox) over diff2html's line-by-line rendering. Long lines scroll inside
  the file's code area; the wrap toggle folds them instead. The view exposes
  `scrollTo(path, fromLine, toLine)` — lights the rows the new-side line range
  covers (a left bar and a tint in `--pr-review-mark` over the row's own
  colour, one `box-shadow` pulse on arrival, held until the next jump), unfolds a folded
  file (measuring once the unfold has rendered) and scrolls so the first lit
  row sits 30 % down the column, never under the file's sticky header;
  resolves `false`, leaving the previous light alone, for a file or range the
  diff does not carry — and `scrollToFile(path)`.
- **Viewed** folds a file (header stays, body hidden) and dims its entry; the
  marks are one `Set` of paths the panel keeps for its lifetime, shared by both
  columns and across the producer tabs.

## Pieces

- `types.ts` — the input contract (`PrRef`, `ReadingDiff`, `PrDescriptionData`
  with its `TourStep` / `TourAnchor`, `PrReviewData`, `AbridgeControl` /
  `AbridgeState`) and the pure helpers (`prLinks` and `fileLink` — GitHub
  links from shape-verified values only, the latter one file at the head with
  its lines selected; `preferredDiff` — abridged first; `poweredByLabel`;
  `panelTitle`; the tooltip texts `poweredByExplanation` and
  `truncatedExplanation`).
- `files.ts` — the diff as files (`parseFiles`: path, status, counts, rename
  source, binary, and diff2html's rendering of that file alone; `filePaths`
  for the paths alone) and the pure geometry the view rests on
  (`currentFileAt` for the scroll-spy, `rowsInRange` for a line range).
- `tour.ts` — the Tour's pure half: `anchorLabel`, `staleAnchor` /
  `staleExplanation` (the anchor's sha against the reviewed head),
  `placementOf` (shown / full / beyond — the full diff was cut — / absent),
  `placementNote` (the note under a step's anchor), `stepTip` (the prose
  tooltip), `originNote`.
- `DescriptionBlock.vue` — the description section of the left column.
- `TourList.vue` — the Tour and the Remaining changes.
- `FileList.vue` — the left column: the two slots, then the files.
- `LabelTip.vue` — the one tooltip setting for the labels that explain
  themselves and the clamped text that cannot show itself whole (wrapping at a
  measure, below the label, collision-aware, a short delay; `disabled` keeps
  it quiet while the text fits).
- `ReadingDiffView.vue` — the right column; imports diff2html's stylesheet and
  layers the token overrides on it.
- `PrReviewPanel.vue` — the header, the two columns, the shared state.
- `prReview.test.ts` — the module's own tests, fixture-driven through props.
