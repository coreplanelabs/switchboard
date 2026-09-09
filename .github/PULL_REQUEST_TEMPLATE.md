<!-- The title is the changelog line: `type(scope): what a reader can now do or
     expect` — a scope from the code map's Areas, no internal names or issue
     numbers (CONTRIBUTING.md → The PR title is the changelog line). -->

<!-- Two sentences a stranger can read: what this PR does and why it matters. -->

## What & why

<!-- The change and its motivation. Link the issue if there is one. -->

## Validation

<!-- How you proved it works. Name the tests you added or ran; for anything a
     test cannot prove, say what you did by hand and what you saw. -->

- [ ] `npm run typecheck && npm test` pass
- [ ] Behavior changes update the matching spec and docs page in this PR
- [ ] Visual changes include before/after screenshots

<!-- Breaking change (`!` in the title)? The note lives in the tree, not here:
     add the `## <next major>` section to docs/reference/migrations.md in this
     PR, then uncomment and point at it.

## Migration

See docs/reference/migrations.md → `## X.0.0`.
-->
