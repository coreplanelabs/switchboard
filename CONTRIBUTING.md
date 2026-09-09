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
npx tsx src/cli.ts init --organization <your GitHub org> --anthropic-key <your key>
npx tsx src/cli.ts ask "what can you do?"
```

`init` writes the two gitignored files the tree deliberately lacks — `.env` (mode 600, your key on its line) and `config/config.yaml` (every optional block off) — from their checked-in examples; `init --help` lists the flags for another provider, Slack and the GitHub App, and the manual path (`cp config/config.example.yaml config/config.yaml`, `cp .env.example .env`, edit) still works. The process loads `.env` from the directory you run it in (a variable your shell exports wins). That last command runs the whole pipeline with the terminal as the channel, so
you can work on almost everything without a Slack workspace. The tutorial
[Run it locally](docs/tutorials/run-it-locally.md) goes further.

The repository is one npm workspace: the bot at the root, the dashboard in
`web/`, the docs site in `docs/`, and the five Workers under `deploy/`. One
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
(`npm run docs:gen`); never edit between the generated markers by hand.

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
- Use [conventional commits](https://www.conventionalcommits.org) for the PR
  title: `feat(slack): …`, `fix(runner): …`, `docs: …`, `refactor: …`,
  `chore: …`. A breaking change carries `!` after the type. The title is the
  squash commit's subject and a changelog line, so the `title` check requires
  the grammar on every PR; the allowed types are the ones
  `release-please-config.json` maps to changelog sections. Try a title locally
  with `npm run check:pr-title -- "feat(slack): …"`. A revert is
  `revert: <the original title>` (retitle what GitHub's Revert button opens).
- Fill in the template: two sentences a stranger can read, what and why, how
  you proved it. Visual changes include before/after screenshots.
- Rewrite the branch before review so each commit is a reviewable unit; a
  trail of "fix review comment" commits is squashed before merge.
- A maintainer reviews every PR. Address every comment, or say why not, and
  resolve the thread. Re-request review when the branch is ready again.

## Releases

Maintainers cut releases from `main` with release-please: merged conventional
commits accumulate into a release PR, and merging it tags the version, writes
the changelog, publishes the release, and deploys production from CI — only the
Workers the release actually changed, which the release PR lists in a comment
before anyone merges it (every PR's `deploy targets` check shows the same for
its own diff). Until 1.0, a minor version may change configuration keys or
command syntax; the changelog calls out every such change with a migration note.

## Where things live

| You want to… | Look at |
|---|---|
| understand the architecture | [How a request flows](docs/explanation/how-a-request-flows.md), then the rest of [docs/explanation/](docs/explanation/) |
| know the rules a change must keep | [AGENTS.md](AGENTS.md) |
| find what a feature is supposed to do | the feature's spec, linked from its docs page |
| add a provider or an agent | [Add a model provider](docs/how-to/add-a-provider.md), [Add an agent](docs/how-to/add-an-agent.md) |
| run the dashboard against fixtures | `npx tsx scripts/web-preview.ts` |
| see why something is the way it is | `docs/decisions/` |
