# How we work

Switchboard is built by the same kind of agents it runs. This page is the loop a change goes through, from the sentence that says what should be true to the release that makes it so, and why each step is where it is. The agent's half of the contract is [AGENTS.md](../../AGENTS.md); the human's half is [Contributing](../../CONTRIBUTING.md). Both describe this loop. Why records are immutable and specs are checked rather than trusted is [decision 0021](../decisions/0021-records-are-immutable-specs-are-checked.md).

## The loop

```mermaid
flowchart LR
  spec[Spec row<br/>criterion + proof] --> test[Failing test]
  test --> impl[Implementation<br/>to green]
  impl --> verify["npm run fix<br/>npm run verify"]
  verify --> pr[PR<br/>conventional title,<br/>body is a Tour]
  pr --> review[agent:review<br/>in the open]
  review -->|findings| impl
  review -->|LGTM| merge[Squash merge<br/>title = commit]
  merge --> release[release-please<br/>release PR]
  release --> deploy[CI deploys the<br/>affected Workers]
```

**1. The spec says what should be true.** Every behavior has a row in a feature spec under `docs/reference/specs/`: the criterion, and the proof that holds it — a named test (`file::describe::it`), a written procedure an agent runs against the live system, or an honest `[gap]`. A change starts by writing or editing that row. The spec is the contract, so a spec that describes code that no longer exists is a bug, and the same PR that changes the code changes the spec.

**2. A failing test, then the code.** The proof comes before the implementation. Unit tests are the default because they are the fastest proof that runs anywhere; a live procedure is the exception for what a unit test cannot reach (a Slack flow, a sandbox, a deploy).

**3. One gate, run locally first.** `npm run fix` regenerates every generated artifact and repairs formatting; `npm run verify` is the whole gate, the same scripts CI runs, split into parallel jobs. Nothing lives only in CI: a step that is not `npm ci` or `npm run <script>` fails a unit test over the workflow file itself. Generated things — the reference tables, the AGENTS.md command table, the vendored skills — each have a `gen` and a `check`, so they cannot drift from the code without failing the build.

**4. The PR is written for the reader.** Its title is a Conventional Commit, because that title becomes the squash commit on `main` and a changelog line; a required check refuses anything else. Its body opens with two sentences a stranger can act on, then a Tour: the change in reading order, each step explained before the code it points at, anchored at the pushed head. Decisions that are not obvious from the diff are written down in the body; the ones that shape the architecture become a record in the tree.

**5. Switchboard reviews it, in the open.** A maintainer posts the PR to the review agent (`agent:review`) in a Slack channel the maintainers watch. The agent reads the whole change in a warm checkout and posts one verdict with labelled findings — never an approval or a merge; it has no such rights. It also reads the specs the change touches — only those, listed by `npm run specs:coverage` — and files a contradiction between the diff and a spec as a finding at `minor` or above, so the same-PR rule from step 1 is enforced, not assumed: the spec is fixed in the PR or there is no `LGTM`. A finding at or above the agreed severity is addressed or declined with a reason on the thread; the branch is rewritten so each commit stays a reviewable unit; the review is re-requested at the new head. An `LGTM` verdict trips an auto-approve workflow so the human sees green, but a person presses merge.

**6. Merge is a squash whose subject is the title.** The body stays on the PR, where its links render; `main` reads as a changelog. Every required status is a job name in the workflow, and gate jobs stand in for fan-outs, so the matrix can change shape without touching the ruleset ([Configure the repository](../how-to/configure-the-repository.md)).

**7. Release and deploy are automatic and reviewable.** release-please keeps one release PR open with the accumulated changes; merging it tags the version, writes the changelog, and CI deploys only the Workers whose inputs changed since the commit each one serves. The release PR carries that plan as a comment before anyone merges it ([Ship a release](../how-to/ship-a-release.md)).

## Why this shape

- **Specs are the contract, tests are the proof, and the check binds them.** Prose that describes behavior drifts; a proof reference that must resolve to a real test title cannot. Renaming a test makes the build red until the spec follows.
- **Scripts, not YAML.** An agent can run `npm run verify` and get the same answer CI would. A rule that lives only in a workflow file is a rule an agent cannot check before pushing.
- **The review agent is a reviewer, not a gatekeeper.** It reads and reports. Authority stays with people, and the agent's own run page is the audit trail of what it looked at.
- **Generated over hand-maintained.** Anything derivable from the code is generated and checked. The reference tables, the command table, the vendored skills, the deploy plan — each is one `gen` away from correct and one `check` away from red.
- **Conventional titles are the release process.** The title check is the only place a human types the changelog; everything downstream is derived.

## Where the loop is enforced

| Step | Enforced by |
|---|---|
| Spec proofs resolve to real tests | `npm run specs:check` (in `check:consistency`) |
| A diff agrees with the specs it touches | the review agent's spec contradiction check, over `npm run specs:coverage` |
| CI runs only repository scripts | a unit test over the workflow files |
| Generated artifacts are current | `docs:check`, `agents:check`, `skills:check` |
| Records are never edited, only superseded | `decisions:check` |
| PR titles are conventional | the required `title` check (`npm run check:pr-title`) |
| Squash-only, title as commit | the repository's merge settings and the `main` ruleset ([Configure the repository](../how-to/configure-the-repository.md)) |
| Only the changed Workers deploy | `deploy plan --affected`, shown on every PR and on the release PR |

## Switchboard develops Switchboard

The rules in [AGENTS.md](../../AGENTS.md) are written in terms of the product's own agents, because they are who follows them:

- **`agent:review` reviews every PR.** Read-only, in a warm checkout, one verdict with labelled findings posted at the head it read; it never approves or merges. The auto-approve workflow trusts its `LGTM`; a reviewed-head guard refuses a verdict for a head it did not read.
- **`agent:coding` implements issues**, with the vendored skills under `skills/` as its house style, pushing a branch and submitting a typed description that Switchboard renders and opens as the PR.
- **`agent:ship` runs the loop end to end** — coding, review, fixes — to an `LGTM`, in one thread.
- **Run pages are the audit trail.** Every agent run has a page: what it read, ran and wrote, with timestamps, kept in run history.
- **`friction propose` files the process's own improvement issues**, from the recurring delay patterns in run history — proposals only, never PRs ([How Switchboard improves itself](how-switchboard-improves-itself.md)).
