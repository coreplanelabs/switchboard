# Reference

**"What's the exact syntax / value / default?"** Reference is the map, not the journey: austere, complete, and structured like the thing it describes. It states what is, and nothing else — no teaching, no opinions, no steps.

The mechanical parts of these pages (every command, every flag, every `/api` route) are **generated from the code** by `npm run docs:gen` and checked in CI, so they cannot drift from what actually ships. Regions marked `<!-- generated:… -->` are written by the generator — edit the code, not the table.

- [Slack commands](slack-commands.md) — every directive and command, by category.
- [CLI](cli.md) — command form, every group, exit codes.
- [Configuration](configuration.md) — every `config.yaml` block, what it does, its off-state.
- [Authorization](authorization.md) — the `grants` and `restrict` blocks: every axis, every baseline, what fails closed.
- [Dashboard routes](dashboard-routes.md) — every route, its auth, what it shows.
- [Code map](code-map.md) — every module, what it owns, and the rule a change there must keep.
- [Specs](specs/README.md) — the behavioral contract: one file per feature, every criterion bound to the test or procedure that proves it.
