# Restrict who can do what

Goal: lock down a real deployment. By default, a fresh `config.yaml` has no `permissions` block at all — **everything is open to everyone who can reach the bot.** That's fine for a solo dev box; it's not what you want once real teammates (and real GitHub write access) are involved.

Every key below is independent — set only the ones you need. All but one are **open when absent**; read the last section before you assume the rest are safe by default.

## Start here: admins

```yaml
permissions:
  admins: [slack:U0123ADMIN]
```

Admins bypass every restriction below. Everyone else is subject to whatever you set.

## Gate an agent

```yaml
permissions:
  agents:
    coding: [slack:U0456DEV]      # only these users (+ admins) may run `coding`
```

This is enforced **at run time, against the resolved agent** — after directives, thread stickiness, and every config layer have already been applied. There's no way around it by typing `agent:coding` if you're not on the list; you'll just get a run of the agent you were already allowed to use, with a reply naming who to ask. `config set me --agent coding` is always allowed to *set*, harmlessly, because the gate still applies when the run actually happens.

## Gate who can touch a repo's resident

```yaml
permissions:
  repos:
    acme/api: [slack:U0456DEV]    # listed → only these users (+ admins), everyone else refused BY NAME
```

A repo with no entry here is open to anyone already allowed to run the coding agent. A repo *with* an entry is closed to everyone not on it — including people who could otherwise run `coding` fine, just not against this repo.

## Gate channel-level config changes

```yaml
permissions:
  channelConfig: []    # empty list = admins only. Omit the key entirely = everyone.
```

Careful with the difference: **key absent** (from a `permissions` block you do write) → open; **key present but empty** → admins only. A config with no `permissions` block at all — native `grants` only — gives `config:write` to nobody but the actors whose `grants` entry carries it. This is the one place an empty list and a missing key mean opposite things — everywhere else, listing zero people isn't meaningfully different from not writing the key.

## The one gate that's locked by default: repoManagement

```yaml
permissions:
  repoManagement: []    # this is ALSO the default if you never write this key at all
```

`repo onboard/offboard/reconfigure/rebuild` provision always-on billable compute and bind GitHub credentials — real money and real repo access. Unlike every key above, **`repoManagement` fails closed**: if the key is absent from your config entirely, or present but empty, only admins can run these commands. `repo list` (read-only) stays open regardless. If you want a wider group able to onboard repos, you have to say so explicitly:

```yaml
permissions:
  repoManagement: [slack:U0456DEV, slack:U0789OPS]
```

## Gating the machine surfaces (HTTP/MCP)

Chat is gated by `admins`/`repoManagement` as above. The `/api/*` and MCP surfaces use two more keys:

```yaml
permissions:
  operators: [access:jane@acme.com]           # browser Access identities granted every *:write scope
  serviceTokens:
    ops-bot: [runs:read, runs:write, friction:read]   # a service token's exact scopes, nothing implied
```

Every signed-in Access identity gets `*:read` for free; only `operators` gets write. Service tokens get exactly the scopes listed and nothing more — an unlisted token has none.

## A realistic locked-down example

```yaml
permissions:
  admins: [slack:U0100FOUNDER]
  agents:
    coding: [slack:U0456DEV, slack:U0457DEV]
    ship: [slack:U0456DEV]
  channelConfig: [slack:U0456DEV]
  repos:
    acme/payments: [slack:U0456DEV]     # only this one repo is name-restricted
  repoManagement: [slack:U0456DEV]
```

Everything not mentioned (the `review`/`research`/`general` agents, every other repo) stays open — permissions are additive restrictions per key, not an all-or-nothing switch.

## See also

- [Reference: permissions](../reference/permissions.md) — every key, its default, and whether it fails open or closed.
- [Onboard a repo](onboard-a-repo.md) — the command surface `repoManagement` is gating.
