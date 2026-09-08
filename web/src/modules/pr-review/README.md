# pr-review module

The UI for **reading a pull-request review**: the change as a reviewer reads it
(the full `git diff`, or an abridged "reading diff" from a model-backed
producer such as meat.dev), with links back to the PR. Feature contract:
[`features/reading-diff.md`](../../../../features/reading-diff.md) item 6.

## Boundary — deliberately liftable

This folder is a self-contained module intended to be abstracted out and
shared into another product later:

- **Props-only.** `PrReviewPanel` takes one `PrReviewData` object (see
  `types.ts`). Nothing here reads seeds, streams, stores, or routes.
- **No app imports.** Allowed dependencies: `vue`, Nuxt UI components,
  `diff2html`, and files inside this folder. Nothing from `../../lib`,
  `../../pages`, `@core/*`, or anything runs-shaped — **runs are
  Switchboard-specific and stay outside**.
- **Adapters live with the host.** Switchboard's mapping from run events to
  `PrReviewData` is `web/src/lib/prReviewCollector.ts`; another host writes its
  own adapter against `types.ts` and changes nothing here.

## Pieces

- `types.ts` — the input contract (`PrRef`, `ReadingDiff`, `PrReviewData`) and
  the pure helpers (`prLinks` — GitHub links from shape-verified values only;
  `preferredDiff` — abridged first; `poweredByLabel`).
- `ReadingDiffView.vue` — one diff via diff2html (line-by-line; the library
  escapes diff content, so the `v-html` renders its markup over escaped text),
  with producer badge, base ref, truncation badge, and the producer's summary.
- `PrReviewPanel.vue` — header links (PR, head commit, files-on-GitHub),
  producer tabs when both diffs exist (abridged preferred), empty state.
- `prReview.test.ts` — the module's own tests, fixture-driven through props.
