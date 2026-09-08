# Reference: authorization

Two blocks in `config.yaml` decide who may do what. `grants` says what each actor **holds**; `restrict` says what is **closed unless granted**. Everything else is open to whoever can reach the bot. One policy table (`authorize(actor, action, resource)`) reads the grants on every surface — Slack, CLI, HTTP, MCP, schedules — so nothing here can be bypassed by choosing a different way to ask. Enforcement is at run time against the *resolved* agent or repo, after directives, thread stickiness, and every config layer.

## `grants`

```yaml
grants:
  slack:U0123ADMIN:                 # an admin, spelled out
    actions: all
    channels: all
    repos: all
  slack:U0456DEV:
    actions: [agent:run:coding, repo:write]
    repos: [acme/payments]
  access:svc:ops-bot:               # an Access service token, by its common_name
    actions: [runs:read, runs:write, friction:read]
    channels: all
  http:ci:                          # an ingress token's subject over /ingress …
    actions: [dispatch, runs:read]
    channels: [http:ops]
  mcp:ci:                           # … and the same subject over MCP
    actions: [dispatch, runs:read]
    channels: [mcp:ops]
```

Keyed by platform-namespaced actor id. Three axes, each a list of names or the explicit word `all`; an **absent axis is the empty set**. `all` is never a default.

| Axis | Names | Decides |
|---|---|---|
| `actions` | `<group>:read` / `<group>:write` / `<group>:exec` for every command group (`runs`, `friction`, `repo`, `config`, `memory`, `mcp`, `schedule`, `deploy`, `help`), `agent:run:<name>`, `dispatch`, `deploy:write` | which commands and agents the actor may run |
| `channels` | channel ids (`slack:C…`, `http:<name>`, `mcp:<name>`) | whose runs the actor may read beyond the public ones |
| `repos` | `owner/name` slugs (case-insensitive) | which restricted repos the actor may use |

### Baselines — what an id holds listed or not

| Actor id | Baseline | A `grants` entry … |
|---|---|---|
| `slack:U…` (a Slack user) | the open chat commands (`help`/`config`/`repo`/`friction`/`memory`/`mcp`/`schedule` reads, `memory:write`, `mcp:write`) plus `agent:run:<name>` for every agent not under `restrict.agents` | **adds** to the baseline |
| `access:<sub>` (an Access browser session) | every group's `read` | **adds** to the baseline |
| `access:svc:<common_name>` (an Access service token) | nothing | is **exactly** what it holds |
| `http:<subject>` / `mcp:<subject>` (an ingress token) | nothing | is **exactly** what it holds |
| `schedule:<name>` (a cron firing) | what the schedule registry declares for it | **replaces** the declaration |
| `cli:local` | everything | — (the local operator is always an admin) |

Never a baseline, held only by a grant (or `all`): `config:write` (`config set/clear/instructions channel`, channel-tier MCP servers), `repo:write` (`repo onboard/offboard/reconfigure/rebuild`, `friction propose`, forgetting shared memories, org-tier MCP servers), every `runs:*` action, every `*:exec`, `dispatch`, `deploy:write`, `trace:read` (the bot's span log, `GET /admin/trace/log`). **No entry with `actions: all` means nobody is an admin** — the fail-closed default; `adminsHint` (the "ask …" in a 🚫 reply) names whoever holds it.

### Validation

The load fails, naming the entry and field, on an unknown id prefix (`slack:`, `http:`, `mcp:`, `access:`, `schedule:` are the vocabulary), a misspelled `all`, an unknown axis, or a block that is not a mapping. Nothing is ever widened to recover from a typo.

## `restrict`

```yaml
restrict:
  agents: [coding, ship]            # run only for actors granted agent:run:<name> (or `all`)
  repos: [acme/payments]            # used only by actors whose `repos` axis names it (or `all`)
```

Both lists are optional and independent. An agent or repo **not** listed is open to everyone who can reach the bot; a listed one is closed to everyone whose grants do not cover it — admins pass through `all`. Restricting never takes a grant away from anyone, and granting never restricts anyone else: the lock and the key are separate keys, so a config reads exactly as it is enforced.

- `restrict.agents` must name registered agents (`general`, `research`, `review`, `coding`, `ship`); an unknown name fails the load rather than restricting nothing silently.
- `restrict.repos` must be `owner/name` slugs; comparison is case-insensitive on both sides.
- Agent restriction is enforced in `dispatch()` against the resolved agent, so `agent:coding` in a message or `config set me --agent coding` cannot bypass it; a refused user gets the run of the agent they may use, with a reply naming who to ask. `config show` lists the restricted agents unavailable to the caller.
- Repo restriction is enforced before an executor is created (a coding run against a resident) and before a GitHub write (`github_issue_create`); the refusal names the repo.

## Ingress tokens are credentials, not grants

`SWITCHBOARD_INGRESS_TOKENS` is `{ "<token>": { "subject": "<name>", "channel"?: "<name>" } }`. A token **identifies** — it resolves to the actor `http:<subject>` over `/ingress` and `mcp:<subject>` over MCP — and what that actor may do is its `grants` entry and nothing else. Starting a run (`POST /ingress`, the MCP `dispatch` tool) needs the `dispatch` action; running a registry command as text or as an MCP tool needs that command's action. A token whose subject has no `grants` entry can do nothing. `channel` is where the token's dispatches are recorded (`http:<channel>`), not a right: to *read* a channel's runs, name it under `channels`. The retired `scopes` key is tolerated with a startup warning naming the subject and grants nothing.

## The retired `permissions` block

A config that still carries `permissions:` is refused at load with this mapping. Each old key becomes a grant, a restriction, or both:

| Was | Is |
|---|---|
| `admins: [id…]` | `grants.<id>: { actions: all, channels: all, repos: all }` |
| `agents.<name>: [id…]` | `restrict.agents: [<name>]` + `grants.<id>.actions: [agent:run:<name>]` |
| `repos.<owner/name>: [id…]` | `restrict.repos: [<owner/name>]` + `grants.<id>.repos: [<owner/name>]` |
| `channelConfig: [id…]` (or absent = everyone) | `grants.<id>.actions: [config:write]` — **closed by default now**; grant it to whoever should edit channel config |
| `repoManagement: [id…]` | `grants.<id>.actions: [repo:write, friction:write]` |
| `operators: [access:<sub>…]` | `grants.access:<sub>: { actions: [<group>:read, <group>:write, …], channels: all }` |
| `serviceTokens.<cn>: [action…]` | `grants.access:svc:<cn>: { actions: [action…] }` |
| token `scopes: [action…]` | `grants.http:<subject>.actions` and `grants.mcp:<subject>.actions` |

## See also

- [How-to: restrict who can do what](../how-to/restrict-who-can-do-what.md) — the narrative version, building up from open to locked down.
- [Explanation: execution and trust](../explanation/execution-and-trust.md) — why `repo:write` in particular is never a baseline.
- [Spec: authorization](https://github.com/coreplanelabs/switchboard/blob/main/features/authorization.md) — the policy table, the actor model, and the proofs.
