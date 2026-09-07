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

You need Node 22 or newer (`.nvmrc` pins it) and an API key for at least one
model provider.

```bash
git clone https://github.com/coreplanelabs/switchboard.git
cd switchboard
npm install
cp config/config.example.yaml config/config.yaml
cp .env.example .env            # set ANTHROPIC_API_KEY (or another provider's key)
npx tsx src/cli.ts ask "what can you do?"
```

That last command runs the whole pipeline with the terminal as the channel, so
you can work on almost everything without a Slack workspace. The tutorial
[Run it locally](docs/tutorials/run-it-locally.md) goes further.

The dashboard is its own package: `cd web && npm install`. The docs site too:
`cd docs && npm install`.

## The three checks

Every pull request must pass all of these; CI runs them.

```bash
npm run typecheck && npm test                 # the bot
cd web && npm run typecheck && npm test       # the dashboard
npm run docs:check && npm --prefix docs run build   # the docs
```

`npm test` is fast (a few seconds) and is the proof layer: a behavior without a
test is a behavior we do not know we have.

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
  title and the squash commit: `feat(slack): …`, `fix(runner): …`,
  `docs: …`, `refactor: …`, `chore: …`. A breaking change carries `!` after the
  type. Release notes and version bumps are generated from these.
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
| understand the architecture | [README.md](README.md), then [docs/explanation/](docs/explanation/) |
| know the rules a change must keep | [AGENTS.md](AGENTS.md) |
| find what a feature is supposed to do | the feature's spec, linked from its docs page |
| add a channel, provider, executor, or agent | [Add a provider or an agent](docs/how-to/add-a-provider-or-agent.md) |
| run the dashboard against fixtures | `npx tsx scripts/web-preview.ts` |
| see why something is the way it is | `docs/decisions/` |
