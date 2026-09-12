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
  components, `@vueuse/core` (the colour mode and an element's size),
  `@pierre/diffs` (the diff renderer and its parser), files inside this
  folder, and the app's generic `../../components/MarkdownText.vue` (the safe
  markdown renderer the description's prose goes through) — a lift takes that
  one file along. Nothing from `../../lib`, `../../pages`, `@core/*`, or
  anything runs-shaped — **runs are Switchboard-specific and stay outside**.
- **Adapters live with the host.** Switchboard's mapping from run events to
  `PrReviewData` is `web/src/lib/prReviewCollector.ts`, and its abridge
  control is `web/src/lib/reviewAbridge.ts` (the `/api/review.abridge` calls
  and the polling); another host writes its own against `types.ts` and
  changes nothing here.
- **Theming through tokens.** The chrome wears Nuxt UI's `--ui-*` tokens. The
  diff itself is @pierre/diffs' own rendering — its light and dark themes
  follow the app's colour mode (`useColorMode`), and nothing here restyles it.

## Shape

A header, a tab row and the tab's content, top to bottom; the host gives the
panel a box (Switchboard: a slideout nearly the viewport wide) and the panel
fills it, scrolling the content under the header and the tabs.

- **Header** — the PR's title (`data.description.title`, else `owner/repo#N`);
  one line of facts: the reference with the GitHub mark (linking to the PR),
  the head sha (linking to the commit), `against origin/<base>`, the producer
  label, `truncated` when the producer capped the diff — the two labels a
  reader cannot name carry a tooltip (`poweredByExplanation`,
  `truncatedExplanation`, through `LabelTip`); at the right, the actions:
  **View on GitHub** (a ghost button), then — while only the full diff exists
  and the host passed an `abridge` control — the one solid button, **Abridge
  with meat** (a tooltip says what it does and that it costs one model call),
  or the running note (spinner, "Abridging… usually 1–3 minutes"), or the
  failure (the reason, a Retry); once the abridged diff arrives in
  `readingDiffs` its tab takes the control's place. Last, for a `closable`
  host, a close control that emits `close`.
- **Tab row** — one tab per diff on record, **Files changed** for the full
  diff and **Reading diff** for the abridged one (the reader lands on the
  abridged one when a producer made it, `preferredDiff`), and **Description**
  when the host's description carries prose; with nothing to show, no row. At
  the row's right, while a diff tab is open and the panel is wide enough:
  **Inline** / **Side by side**, remembered per browser (`localStorage`,
  `switchboard:diffStyle`).
- **Files changed** (`FilesChanged.vue`) — two columns. Left, the file list:
  `N files` and the totals `+A −D` in its head, then one row per file — the
  language icon (`fileIcons.ts`, by file name then extension), the path cut
  in the middle when it runs past the budget (`ellipsizeMiddle`: the folder
  and the file name are what a reader recognises), the file's `+A −D`;
  clicking a row marks it current and scrolls its diff into view, the list
  staying put. Right, the diff column: the host's notes over the diff as
  muted lines (the abridged diff's summary; the cut's notice), then every
  file rendered by @pierre/diffs (`FileDiffs.vue`: one `diffs-container` per
  file carrying its path as `data-file`, the library's own header — change
  icon, path, counts — over its hunks, with the unmodified-lines expanders,
  the word-level emphasis and the syntax highlighting; a renderer that throws
  leaves the diff shown as it is in a plain block). Below 672px of the
  component's own width the list folds above the diff behind a
  `N files changed` row and the diff reads inline whatever the choice — two
  columns of code have no room.
- **Description** — the TL;DR and, under its own heading, the What & why, as
  markdown through `MarkdownText`; a muted note when the copy was read back
  from the PR body and came up short, or was cut before it was read
  (`descriptionNote`).
- **Empty states** — no diffs and no description: one sentence; a diff that
  parses to no files says so.

## Pieces

- `types.ts` — the input contract (`PrRef`, `ReadingDiff`,
  `PrDescriptionData`, `PrReviewData`, `AbridgeControl` / `AbridgeState`) and
  the pure helpers (`prLinks` — GitHub links from shape-verified values only;
  `preferredDiff` — abridged first; `poweredByLabel`; `panelTitle`; the
  tooltip texts `poweredByExplanation` and `truncatedExplanation`;
  `descriptionNote`).
- `diffsLibrary.ts` — the one on-demand load of @pierre/diffs, shared by the
  counts and the renderer.
- `files.ts` — the diff as files (`diffStats`: each file's path and counts and
  the totals, through the library's parser) and `ellipsizeMiddle`.
- `fileIcons.ts` — `languageFromPath`, `iconForLanguage`, `fileIcon`: the
  language icon beside a path; every icon name a literal, for the build's
  icon scan.
- `FileDiffs.vue` — the files through @pierre/diffs, inline or split, in the
  app's colour mode; re-rendered when the diff, the theme or the style
  changes.
- `FilesChanged.vue` — the two columns and their fold.
- `LabelTip.vue` — the one tooltip setting for the labels that explain
  themselves (wrapping at a measure, below the label, collision-aware, a
  short delay).
- `PrReviewPanel.vue` — the header, the tab row, the tabs' content, the
  Inline / Side by side choice.
- `prReview.test.ts` — the module's own tests, fixture-driven through props;
  the library's renderer is stubbed, its parser is real.
