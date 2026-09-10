# Migration notes

What an operator changes when a release breaks something: one section per such release, newest first, headed by the bare version (`## 1.14.0`). A breaking change is a title with `!` after its type, and the `title` check refuses such a PR until the section for the release it will cut exists; the first breaking PR of a cycle creates it, each later one adds its lines ([the rule](../../CONTRIBUTING.md#the-pr-title-is-the-changelog-line)). Which release that is comes from `release-please-config.json`: until the public launch every release bumps the minor (`versioning: always-bump-minor`), so the section is the next minor; after the launch the default strategy makes a `!` the next major. The changelog's **⚠ BREAKING CHANGES** entry says what broke; the section here says what to do about it.

A section says, in this order: what no longer works as it did, what replaces it, and the smallest edit that gets an installation from one to the other — a config key to rename, a command to re-run, a secret to add. Nothing else: history and reasons live in the changelog and the [decision records](../explanation/design-decisions.md).

## 1.14.0

- A `config.yaml` top-level key the document does not define — `permissions:` included — is an unknown key and fails the load by name; write who holds what as `grants` and what is closed as `restrict` ([authorization](authorization.md)).
- A token entry's `scopes` in `SWITCHBOARD_INGRESS_TOKENS` is ignored like any field other than `subject` and `channel`; the token holds exactly its `grants.http:<subject>` / `grants.mcp:<subject>` entry ([Ingress tokens are credentials, not grants](authorization.md#ingress-tokens-are-credentials-not-grants)).
- A `selfImprovement` field other than `repo`, `label`, `minRuns`, `top` fails the load by name; the friction ledger is `runHistory`.
