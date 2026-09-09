# Migration notes

What an operator changes when a major version breaks something: one section per release, newest first, headed by the bare version (`## 2.0.0`). Each section is written in the pull requests that break — a title with `!` after its type — and the `title` check refuses such a PR until the section for the release it will cut exists; the first breaking PR of a cycle creates it, each later one adds its lines ([the rule](../../CONTRIBUTING.md#the-pr-title-is-the-changelog-line)). The changelog's **⚠ BREAKING CHANGES** entry says what broke; the section here says what to do about it.

A section says, in this order: what no longer works as it did, what replaces it, and the smallest edit that gets an installation from one to the other — a config key to rename, a command to re-run, a secret to add. Nothing else: history and reasons live in the changelog and the [decision records](../explanation/design-decisions.md).

## 1.0.0

The `permissions` block and the per-token `scopes` list are gone; `grants` and `restrict` are the whole authorization configuration.

- A `config.yaml` that still carries `permissions:` is refused at startup with the mapping from each old key to its `grants` / `restrict` form — [The retired `permissions` block](authorization.md#the-retired-permissions-block) is the same table. Rewrite the block by that table, then restart.
- A token's `scopes` in `SWITCHBOARD_INGRESS_TOKENS` is tolerated with a startup warning and grants nothing; move each action into `grants.http:<subject>.actions` and `grants.mcp:<subject>.actions` ([Ingress tokens are credentials, not grants](authorization.md#ingress-tokens-are-credentials-not-grants)).
- Channel config editing is closed by default now: grant `config:write` to whoever edited channel config before.
