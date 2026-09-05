# Reference: permissions

The `permissions` block in `config.yaml`. Every key is independent; all but one are **open when absent**. Enforcement happens at run time against the *resolved* agent/repo — after directives, thread stickiness, and every config layer — so nothing here can be bypassed by choosing a different way to ask.

| Key | Shape | Default when absent | Fails closed? |
|---|---|---|---|
| `admins` | `[id, …]` | nobody is an admin | — |
| `agents.<name>` | `[id, …]` | anyone may run that agent | open |
| `repos.<owner/name>` | `[id, …]` | anyone allowed to run `coding` may use that repo's resident | open |
| `channelConfig` | `[id, …]` | anyone may `config set/clear channel` | open (**but an empty list ≠ absent — empty means admins only**) |
| `repoManagement` | `[id, …]` | **admins only** | **closed** — the one exception |
| `operators` | `[access:<sub>, …]` | no browser identity may write over `/api` | closed for writes (every identity gets `*:read` regardless) |
| `serviceTokens.<name>` | `[scope, …]` | that token has no scopes | closed |

IDs are platform-namespaced: `slack:U0123` (a user), `access:<sub>` (a Cloudflare Access browser identity's subject claim). `admins` bypasses every other key.

## `channelConfig` vs `repoManagement`: the trap

Both take a list of ids. They do **not** default the same way:

- `channelConfig` **absent** (from a `permissions` block you do write) → open to everyone. `channelConfig: []` → admins only. Writing the key at all, even empty, locks it. A config with **no `permissions` block at all** — one that uses only the native `grants` block — has no legacy rule to apply: `config set channel` is held only by whoever `grants` gives `config:write` (admins through `actions: all`).
- `repoManagement` is admins-only whether the key is **absent or empty** — there's no way to write it as "open to everyone," on purpose. `repo onboard`/`rebuild` bind real GitHub credentials and provision real, billable, always-on compute; a typo that leaves this open is a different order of mistake than a typo that leaves channel config open.

## Machine-surface scopes

`operators` and `serviceTokens` gate `/api/<group>.<verb>` and MCP tools — the same registry commands chat uses, reached without a Slack identity. A service token is scoped to **`/api/*` only**; it can never reach `/runs*`, `/residents*`, or `/costs*`, no matter what scopes it holds. MCP/HTTP ingress bearer tokens (for *starting* a run, as opposed to running a registry command) are a separate mechanism — `SWITCHBOARD_INGRESS_TOKENS`, not this block.

## See also

- [How-to: restrict who can do what](../how-to/restrict-who-can-do-what.md) — the narrative version, building up from open to locked down.
- [Explanation: execution and trust](../explanation/execution-and-trust.md) — why `repoManagement` in particular is treated differently from everything else here.
