# Contributing to Switchboard

Thanks for helping. This page is the short version of how work gets done here;
the docs tree explains the system itself.

## Before you start

- **Bugs and small fixes**: open a pull request directly. An issue first is
  welcome but not required.
- **Anything that changes behavior, configuration, or a public surface**: open
  an issue or a Discussions thread first and say what you want to change and
  why. It saves everyone the round trip of a PR that cannot land.
- **Security problems**: never in a public issue. See [SECURITY.md](SECURITY.md).

Contributions are accepted under the project's [Apache License 2.0](LICENSE);
its section 5 makes anything you intentionally submit part of the Work under
the same terms. There is no separate agreement to sign.

Be kind. The [code of conduct](CODE_OF_CONDUCT.md) applies everywhere the
project happens.

## Setting up

You need Node 24 (`.nvmrc` pins it; 22 or newer runs) and an API key for at
least one model provider.

```bash
git clone https://github.com/coreplanelabs/switchboard.git
cd switchboard
npm ci
npm run cli -- init --organization <your GitHub org> --anthropic-key <your key>
npm run cli -- ask "what can you do?"
```

`init` writes the two gitignored files the tree deliberately lacks — `.env` (mode 600, your key on its line) and `config/config.yaml` (every optional block off) — from their checked-in examples; `init --help` lists the flags for another provider, Slack and the GitHub App, and the manual path (`cp config/config.example.yaml config/config.yaml`, `cp .env.example .env`, edit) still works. The process loads `.env` from the directory you run it in (a variable your shell exports wins). That last command runs the whole pipeline with the terminal as the channel, so
you can work on almost everything without a Slack workspace. The tutorial
[Run it locally](docs/tutorials/run-it-locally.md) goes further.

The repository is one npm workspace: the bot at the root, the dashboard in
`web/`, the docs site in `docs/`, the five Workers under `deploy/`, and the
published CLI package in `packages/switchboard/` (what `npx @coreplane/switchboard`
runs — the same `src/cli.ts`, bundled; operators install it, contributors clone;
inside the checkout that `npx` spelling reaches this workspace, not the registry,
and until `npm run build -w packages/switchboard` has run its bin says so —
`npm run cli` is the checkout's spelling). One
`npm ci` installs all of them from the single lockfile; run a package's script
with `npm run <script> -w <path>` (for example `npm test -w web`).

## The one check

Every pull request must pass `npm run verify`; CI runs exactly that, split by
area for speed, and nothing else.

```bash
npm run verify        # everything CI runs, in one command
npm run verify:root   # the bot: typecheck, tests, skills, licenses, docs tables, dist
npm run verify -w web # one package's own checks
npm run fix           # regenerate what can be regenerated (docs tables, vendored skills)
```

`npm test` is fast (a few seconds) and is the proof layer: a behavior without a
test is a behavior we do not know we have. The Docker images — the bot's, the
resident's and the sandbox's — have their own check, `npm run check:image`
(one CI leg per image), which needs Docker locally.

To drive the whole pipeline without a Slack workspace, the CLI's `ask` sends a
message through the same dispatcher a channel would:

```bash
npm run cli -- ask "agent:review <PR url>"   # a review run, end to end, from the terminal
npm run cli -- <group> <verb> --help          # any registry command
```

## Running tests

One vitest entry at the root covers every package (the bot, `web/`, and the
Workers' plain-Node tests), so run from the root and filter — the loop while
you work is the tests your change reaches, not the suite:

```bash
npx vitest run --changed origin/main   # only the files whose imports reach what you changed
npx vitest run liveView                # one file, by any fragment of its path
npx vitest run -t "404s the page"      # one test, by name
npx vitest run --project web           # one package: bot | web | worker-bot | worker-resident
npx vitest run -u                      # update snapshots — deliberately
npm test                               # everything, all cores (~4 s)
npm test -w deploy/cloudflare-memory   # the one exception: runs inside workerd on vitest 4
```

CI runs the same suite as shards, one job each; `npm test -- --shard=2/4`
reproduces a shard locally.

## How changes are made

**Tests first.** Write the failing test that describes the behavior, then make
it pass. When you fix a bug, the test that reproduces it lands in the same
commit as the fix.

**Specs and docs move with the code.** Switchboard keeps a written behavioral
contract for each feature and a documentation tree organized by
[Diataxis](https://diataxis.fr). A pull request that changes what a user,
operator, or dashboard viewer sees updates the matching spec and the matching
docs page in the same PR. Reference tables are generated from the code
(`npm run docs:gen`); never edit between the generated markers by hand. The
dashboard's screenshots are generated the same way: a change under `web/` that
alters what a surface looks like needs `npm run screenshots:gen` (once:
`npx playwright-core install chromium`) and the regenerated PNGs committed —
`npm run screenshots:check` and its unit-test twin fail otherwise, naming the
file that changed.

**Diagrams share one visual system.** Every diagram is a ```mermaid fence; the
site draws it in its own palette and GitHub in its defaults, so a fence carries
structure and words only. `flowchart LR` for a path across the system (a
request, a release, the deploy order), `flowchart TB` for a stack (layers,
planes, a topology, a staged loop) — never `TD`, `RL` or `BT`. Shapes say what
a thing is: `["…"]` a component or process, `{"…"}` the dispatcher, `[["…"]]` a
Worker, `[("…")]` where state lives (a Durable Object, a disk), `(["…"])` a
system or person outside the tree (GitHub, Slack, a user), `{{"…"}}` a human
gate, and a `subgraph` a seam or a plane, titled `Name — what it is`. Every
node and edge label is quoted; a list inside one reads `a · b · c`; a line
breaks with `<br/>` and carries no other HTML and no `#`. Edge labels name what
crosses — `message`, `runs`, `complete`, `bash · read · write`, `reply`,
`bearer`, `git push`, `App token` — and a dashed edge is something the system
does not do itself. No `style`, `classDef`, `linkStyle` or `%%` line: the theme
owns the colours (`docs/.vitepress/theme/product.css`). The four seams and the
deploy order are drawn in more than one place, so they are generated regions
(`npm run docs:gen`) from `docs/.vitepress/theme/seams.mjs` and
`src/deploy/plan.ts` — edit the source, never a copy. `src/docs/diagrams.test.ts`
holds all of this over the tree and parses every fence; the records under
`docs/decisions/` and `docs/plans/` are immutable and exempt.

**Respect the invariants.** [AGENTS.md](AGENTS.md) lists the rules the
architecture depends on: the core never imports a platform SDK, every boundary
is an interface with more than one implementation, permission checks run
against the resolved agent, ids are platform-namespaced, tools reach the host
only through an executor. A change that needs to break one of these needs a
design discussion first, not a PR.

**Write down decisions.** If your change settles a question about how the
system is put together, add or update a record under `docs/decisions/` so the
reason survives the code.

**Comments are for the reader who only has this repository.** A comment
explains why the code is the way it is, in terms a stranger can check against
the code. It does not point at private trackers, name people or companies, or
retell an incident. The changelog and the decision records carry provenance.

## Pull requests

- Keep a PR to one coherent change. Stacked PRs are fine for a series.
- Title the PR as the changelog line it becomes:
  `type(scope): what a reader can now do or expect` — the rule, the vocabulary
  and the examples are the [next section](#the-pr-title-is-the-changelog-line).
- Fill in the template: two sentences a stranger can read, what and why, how
  you proved it. Visual changes include before/after screenshots.
- Rewrite the branch before review so each commit is a reviewable unit; a
  trail of "fix review comment" commits is squashed before merge.
- A maintainer reviews every PR. Address every comment, or say why not, and
  resolve the thread. Re-request review when the branch is ready again.

## The PR title is the changelog line

The squash commit on `main` carries the PR title and nothing else — the body
stays on the PR — and release-please writes the changelog and the release
notes from those subjects, one line per PR, with the PR link appended. So the
title is not a label for reviewers; it is the one line an operator reads to
learn what changed. Write it as that line, in
[Conventional Commits](https://www.conventionalcommits.org) form:

```
type(scope): what a reader can now do or expect
```

- **`type`** decides the version bump and where the line lands. `feat`
  (minor), `fix` (patch), `perf`, `revert` and `docs` appear in the release
  notes under Features, Bug fixes, Performance, Reverts and Documentation, and
  `refactor` under Refactoring; `chore`, `ci`, `build`, `style` and `test` are
  hidden — in the history, not in the notes. `release-please-config.json` is
  the list.
- **`scope`** says which part of the product, in the name the docs use: one of
  the Scope column of the [code map's Areas](docs/reference/code-map.md#areas)
  — `dispatcher`, `core`, `config`, `commands`, `cli`, `init`, `setup`,
  `authz`, `runs`, `tracing`, `costs`, `slack`, `http`, `mcp`, `agents`,
  `review`, `coding`, `ship`, `research`, `general`, `providers`, `resident`,
  `sandbox`, `memory`, `skills`, `tools`, `web`, `workers`, `deploy`, `docs`,
  `process`, `release` (`deps` and `main` are Dependabot's and
  release-please's). A tree-wide change has no scope. A plan, a project phase
  or a file's name is not a scope (`oss`, `readme`, `site`, `visuals` are
  `process` or `docs`): the reader does not know them.
- **The description** is what changed for someone running or reading the
  product, present tense, in the docs' words. No internal names (a plan, a
  phase, "PR 3 of 6"), no issue numbers (release-please appends the PR link),
  no trailing period. One change per title: a title that needs "and" twice is
  two PRs.
- **A breaking change** is `!` after the type — the only way to declare one,
  since a squash commit with no body has no `BREAKING CHANGE:` footer — plus
  its note in [Migration notes](docs/reference/migrations.md), under the
  section for the release it cuts: `## <major + 1>.0.0` from `package.json`'s
  version. The first breaking PR of a cycle creates the section; each later one
  adds its lines to it. The check asks only that the section exists — the lines
  are yours to add, in the same PR: what no longer works, what replaces it,
  and the smallest edit that gets an installation across. The note lives in
  the tree, not in the PR body, because the body never reaches the reader:
  release-please regenerates the release PR on every push and builds the notes
  from titles alone.
- **Until the public launch, no title carries `!`.** The 1.x line moves by
  minors: `release-please-config.json` pins the next version (`release-as`),
  the check refuses a `!` while the pin is set, and a change an installation
  must act on ships as a minor with its section under the pinned version in
  the migration notes. A test keeps the pin from falling behind the released
  version (the release PR itself carries the two equal); after the release it
  names is cut, the pin is moved to the next minor or removed.

The `title` check enforces all of it on every PR — grammar, type list, scope
list, the migration section behind a `!` — and gives the same verdict locally:
`npm run check:pr-title -- "feat(slack): …"`. A revert is
`revert: <the original title>` (retitle what GitHub's Revert button opens).

From the changelog, three lines that do the job:

- `feat(cli): switchboard init — the one-command installer`
- `feat(review): the review agent reads the touched specs and files a contradiction as a finding`
- `fix(deploy): fly.toml is an inert path for the deploy selection — its deletion no longer rolls the whole fleet`

And three that made the reader work, with the line they should have been:

| As merged | The problem | As it should read |
|---|---|---|
| `refactor(core): the dispatcher's run stage leaves as named functions (pipeline split, PR 5 of 6)` | "PR 5 of 6" is sequencing nobody outside the series can follow, and the area has a name of its own | `refactor(dispatcher): the run stage is named functions under src/core/dispatch/` |
| `fix(resident): the attach's ref-exists shortcut names its invariant, and a cat-file failure is its own step error — the #NNN review fixes` | two changes, and an issue number standing in for the reason | `fix(resident): a cat-file failure during attach is reported as that step's error, not as a checkout failure` |
| `fix: the review follow-ups from the Phase 7–9 PRs — effort levels from the ladder, a mermaid draw epoch, an escaped licence, a real workflow warning` | no scope, a phase name, four unrelated fixes under one line | four PRs, each its own line — e.g. `fix(docs): a mermaid diagram redraws when the site's theme changes` |

## Releases

Maintainers cut releases from `main` with release-please: merged conventional
commits accumulate into a release PR, and merging it tags the version, writes
the changelog, publishes the release, and deploys production from CI — only the
Workers the release actually changed, which the release PR lists in a comment
before anyone merges it (every PR's `deploy targets` check shows the same for
its own diff). After the public launch a change an installation must act on is
a major version: its title carries `!`, and
[Migration notes](docs/reference/migrations.md) carries its section, written in
the PR that broke it. Before the launch the same change is a minor under the
pinned version, with the same section.

## Where things live

| You want to… | Look at |
|---|---|
| understand the architecture | [How a request flows](docs/explanation/how-a-request-flows.md), then the rest of [docs/explanation/](docs/explanation/) |
| know the rules a change must keep | [AGENTS.md](AGENTS.md) |
| find what a feature is supposed to do | the feature's spec, linked from its docs page |
| add a provider or an agent | [Add a model provider](docs/how-to/add-a-provider.md), [Add an agent](docs/how-to/add-an-agent.md) |
| run the dashboard against fixtures | `npx tsx scripts/web-preview.ts` |
| see why something is the way it is | `docs/decisions/` |
