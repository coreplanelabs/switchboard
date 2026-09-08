# Decision records

One file per decision that shaped Switchboard. A record explains the context the decision was made in, what was decided, what it costs, the alternatives that were rejected, and the named pattern it instantiates, so a reader can map the code to a concept they already know.

Records are written once. When a decision stops holding, write a new record and mark the old one `status: superseded` with `superseded_by:` pointing at the new file; never edit the body. `npm run decisions:check` holds that line against `origin/main`.

Frontmatter:

```yaml
---
title: Short imperative statement of the decision
status: proposed | accepted | implemented | superseded
date: YYYY-MM-DD           # when the record was written
pattern: The named pattern  # optional; shown in the generated index
superseded_by: 00NN-slug.md # only when status is superseded
---
```

Files are numbered `NNNN-slug.md`; the number is the record's stable id. The index at [`docs/explanation/design-decisions.md`](../explanation/design-decisions.md) is generated from this directory by `npm run docs:gen`.
