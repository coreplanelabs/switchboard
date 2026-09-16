---
title: A dashboard session is the person its email names; the link is identity, not authority
status: proposed
date: 2026-09-16
pattern: Identity resolved once in the adapter, never authority; a set-valued self; promotion by re-issue, never by copying a secret
---

# A dashboard session is the person its email names; the link is identity, not authority

**The ask.** Decide (the maintainer, before the first of three PRs opens): a dashboard session whose Access email names exactly one Slack user acts as that person wherever the system asks "is this me", and nowhere else. Written for an engineer who knows the actor model ([authorization.md](../reference/specs/authorization.md) items 1, 7, 9) and [record 0041](0041-the-settings-page-is-a-surface-over-the-registry-and-configures-the-shared-tiers.md), which left this as its open question. The maintainer decided it on 2026-09-16 ("yes access email should map to the slack user for the sense of 'me'") and asked for the surfaces it unlocks: an owner on every runs row and a "show mine" filter that includes the viewer's own private-channel and DM runs; an MCPs list that shows the full picture and who configured what where (own, org, channels you are in; every user's for an admin); and a safe way to promote a personal MCP server to the org.

Success criteria: (1) on the dashboard, `config set me`, `mcp add` for oneself and every "mine" read act on the Slack user the session's email names, and a session with no email or no match behaves exactly as today; (2) a browser session gains no grant it does not hold today, and the audit line names both identities when they differ; (3) `/runs` shows who started each run and, with "show mine", exactly the viewer's own runs, private channels and DMs included; (4) an admin sees every MCP tier with who added each server, and promotes a personal server to the org without the person's credential ever becoming the org's; (5) a non-admin sees their own, the org's and the channels they may read.

## TL;DR

Two identity systems meet on the dashboard and never touch: a run is requested as `slack:U…`, a browser is `access:<sub>`, and the one existing bridge (the costs page's "my runs") matches emails at read time, per report, one cached lookup per run-user. The bet is to resolve the link once, in the actor resolver, by a reverse Slack lookup on the Access email, and to make it **identity, not authority**: the actor keeps its own id and grants and gains a second **self** id that the `is-self` rule, the `me` tier and every "mine" filter key on. It costs one cached lookup per gate pass, a set-valued self in the predicate compiler, one self-serve policy row for `mcp:write`, and an audit line that names both identities. Decided: the resolver placement, identity-not-authority, fail-closed to today's behaviour without an email or a match, a store-level owner filter, an admin all-tiers MCP read with resolved names, and promotion by copying the entry and re-issuing a connect ticket, never the secret; the surfaces ship as three independent PRs. Open: channel membership for "channels you are in" (a known gap the same seam closes later), and whether the requester's email belongs on the run record.

## Today at `6387ceb1`

- A browser session resolves to `access:<sub>` with the read baseline and its own grants entry; the JWT hands us `sub` and `email`, and nothing reads an `email_verified` claim ([`src/channels/commandHttp.ts`](../../src/channels/commandHttp.ts) `accessActor`; [`src/channels/accessAuth.ts`](../../src/channels/accessAuth.ts) `verifyAccessJwt`). The `token` and `none` dashboard strategies produce the browser shape with no email at all ([access-gate.md](../reference/specs/access-gate.md), "Two identity shapes").
- `is-self` compiles to an exact match of the run's `userId` against the actor's principal id ([`src/core/authz/predicate.ts`](../../src/core/authz/predicate.ts), `case "is-self"`). A run's `userId` is `slack:U…`; a browser's is `access:<sub>`; the rule admits nothing for a browser, so the viewer's own private-channel and DM runs are invisible on `/runs` unless a grant names the channel.
- The forward lookup exists: `resolveUserEmail` reads `users.info` under the `users:read.email` scope, uncached, for the MCP connect ticket and the costs page ([`src/channels/slack/lookups.ts`](../../src/channels/slack/lookups.ts)). The reverse lookup, `users.lookupByEmail`, appears nowhere. Channel membership (`isMember`) answers `unknown` on both directories; `conversations.members` is the open gap ([authorization.md](../reference/specs/authorization.md) item 11), tracked as #516 in [record 0037](0037-a-linked-thread-is-quoted-not-joined.md).
- The run record and the index row already carry the requester's display name (`RunRecord.userName`, `RunView.userName`), resolved at dispatch and cached; the row renders it as "via Slack · alice". Neither carries an email. No list read takes an owner filter ([`src/core/runsService.ts`](../../src/core/runsService.ts) `ListRunsOptions`).
- `McpService.list` resolves exactly three tiers for one `(channel, actor)` pair, so it can only ever show the caller's own user tier; `Overrides.users` is an enumerable record. `addedBy` is the raw caller id. A sealed credential's key `<scopeKey>/<name>` is the AES-GCM additional data, so a credential cannot be renamed across tiers ([`src/mcp/registry.ts`](../../src/mcp/registry.ts) `mcpCredentialKey`; [`src/mcp/sealed.ts`](../../src/mcp/sealed.ts)). The chat baseline holds `mcp:write` and `memory:write`; the browser baseline holds every group's read and no write ([`src/core/authz/grants.ts`](../../src/core/authz/grants.ts) `CHAT_OPEN_ACTIONS`, `browserReadActions`).
- `grantsIn` already unions two things, an actor's entry and its surface entry, through a private `unionGrants`; the audit line records `caller.id` alone ([`src/core/commandRegistry.ts`](../../src/core/commandRegistry.ts), the `audit` call).

## The shape

The **link** is one new step in the dashboard gate, after the JWT is verified and before any handler runs: `linkedActor(identity)` asks a cached, single-flighted reverse lookup for the Slack user whose profile email equals the session's email (lower-cased, exact), and, when exactly one active human user answers, returns the same actor as today plus `self: [access:<sub>, slack:U…]` and `asUser: { id, name }`. No email, no match, a bot or deleted user, a lookup failure or timeout: the actor is exactly today's, `self` is `[access:<sub>]`, and every surface behaves as it does now. The actor's `id` and `grants` never change. Three places read `self` instead of the principal id: the `is-self` condition and its compiled `user-is` predicate (a set), the `me` branch of the config and MCP commands (which write and read the scope of the Slack self when there is one, and refuse as record 0041 says when there is not), and the "mine" filters. One new policy row lets a person add, connect and remove their own MCP servers from any surface, as chat already lets them by baseline: `mcp:write` on `command` for `actorKinds: ["user"]`, the tier still decided by the handler's data (org by `repo:write`, channel by `config:write`, `me` by `self`). The audit line carries `asUser` beside `callerId`, read from the caller's actor. The lookup is asynchronous, so the gate resolves the actor once, before it dispatches to a page or to `/api`, and the command adapter takes the resolved caller instead of resolving its own; the `user-in` predicate changes the compiler, the store's predicate serialization and the state Worker's SQL translation together, so the first PR ships a Worker deploy.

The closest known shape is GitHub's Slack account link: one account maps onto another for attribution and personal views, and what you may do stays your own account's permissions. Ours needs no consent step, because both systems already share the same authority on the email.

```mermaid
sequenceDiagram
  participant B as Browser (JWT: sub, email)
  participant G as Gate + linkedActor
  participant S as Slack users.lookupByEmail (cached)
  participant A as authorize / predicateFor
  participant R as RunStore
  B->>G: GET /runs?mine=1
  G->>S: email → U…? (miss: fetch; hit: cached 10 min; fail: unlinked)
  S-->>G: slack:U123 (active human)
  G->>A: actor { id: access:<sub>, grants: own, self: [access:<sub>, slack:U123] }
  A-->>G: predicate: member-of ∪ all-channels ∪ user-in(self)
  G->>R: list({ visibleTo: predicate, userIds: self })
  R-->>B: the viewer's runs, private and DM included
```

## One trace: a private-channel run, "show mine", a session that is and is not linked

1. Alice asks the coding agent in a private channel from Slack. The run is recorded with `userId: slack:U123`, `userName: alice`, `channelVisibility: private`.
2. Alice opens `/runs?mine=1` in the dashboard. Access verifies her JWT: `sub: a1…`, `email: alice@example.com`. The gate calls `linkedActor`.
3. The link asks the cache for `alice@example.com`; a miss calls `users.lookupByEmail` once, gets `U123` (not a bot, not deleted), caches it for ten minutes, and returns the actor `{ id: "access:a1…", grants: <Alice's Access grants>, self: ["access:a1…", "slack:U123"], asUser: { id: "slack:U123", name: "alice" } }`.
4. `readableRuns(actor)` compiles `runs:read` on `run`: `member-of` (her grants' channels, plus public), `all-channels` (no), `user-in(["access:a1…", "slack:U123"])`. The private run's `userId` is `slack:U123`: admitted by the third clause. A colleague's run in the same private channel is not admitted: Alice is not a member by grant and the channel is not public. Membership, the open gap, would admit it later; this record does not.
5. Two clauses, both at the store: the visibility predicate from step 4 decides what Alice *may* see, and the "mine" filter (`userIds: self`) narrows that to what she *asked* for; nothing is loaded to be dropped afterwards. The page lists Alice's runs across every channel she started them in, each row saying `alice`, the mine checkbox checked.
6. Alice's colleague Bob signs in through Access with an email Slack has never seen (a contractor with no Slack account). `linkedActor` gets no match: the actor is `{ id: "access:b2…", self: ["access:b2…"] }`. His `/runs?mine=1` lists nothing of Alice's and nothing of his (he has no runs); `/settings` shows him org and channel tiers and refuses `me` with the pointer to chat, exactly as today.
7. Alice's session, on `/settings/mcps`, adds `notion` for herself: the new self-serve row admits the command because her `self` names a chat identity, the `mcp.add` handler targets `user:slack:U123`, and the next run Alice requests from Slack sees `mcp__notion__*`. The audit line reads `callerId: access:a1…, asUser: slack:U123`. Bob's unlinked session is refused at the row, before the handler, exactly as today.
8. An attacker who controls a Slack account with `profile.email` set to `alice@example.com` gains nothing on the dashboard: the link runs from the Access email to Slack, never from Slack to Access, and Access's email is the IdP's. What the attacker could do is make Alice's dashboard session act on their Slack account's scope; that requires an admin of the Slack workspace to have let a member set a colleague's email, and Slack's own `users:read.email` data is what the costs page and the connect ticket already trust. The record accepts that trust, stated.

The property this proves: the link changes who the session *is* for the questions that ask about the person, and changes nothing about what the session *may do*.

## The difficulty map

1. **Identity, not authority.** The line between "self" and "grants", and the one row that keeps self-serve MCP working without a grant union. [The line](#the-line-identity-not-authority).
2. **What the email proves.** No claim says "verified"; two dashboard strategies carry none. [Trust in the email](#trust-in-the-email).
3. **Promotion without moving a secret.** The credential is bound to its tier by the cipher; a personal OAuth token must not become the org's. [Promote by re-issue](#promote-by-re-issue).
4. **"Channels you are in."** Membership is an open gap; the honest cut is the read right the index already asks. [The MCP list a person sees](#the-mcp-list-a-person-sees).
5. **(most work) The three surfaces.** Owner and "mine" on `/runs`, the all-tiers list with names, promote with its button. One paragraph each under [Rollout](#rollout).

## The line: identity, not authority

The constraint: the obvious implementation, "resolve the browser to the Slack actor", unions the chat baseline into the session. That baseline holds `mcp:write` and `memory:write`; a browser session holds neither today. Record 0041 refused a general mapping for exactly this reason, and it was right: an email match must not widen what a session may do.

The design: `Actor` gains `self: readonly string[]` (the principal id first, the linked Slack id second when there is one) and `asUser?: { id; name? }`. `grants` is untouched. The `is-self` condition passes when the resource's `userId` is in `self`; the `user-is` predicate becomes `user-in` over the same set. The config and MCP handlers resolve the `me` tier for an `access` caller as the Slack id in `self`, and refuse as record 0041 says when there is none. So a linked browser session has no browser-scoped user tier at all: its `me` *is* the Slack user's, and what it sets on the dashboard is what its runs read. Every other caller kind keeps `caller.id`. For the MCP service the whole actor id follows: `McpActor.id` is the Slack self for a linked session, so `addedBy` names the person and a connect ticket binds to their email as it does from chat. The `is-self` rows the set reaches are four, runs, a user's config scope and a user's memory scope for read and write, and all four mean the same thing, the person; the memory commands' own `me` keeps `caller.id`, so a linked browser's `memory list` shows the person's records and nothing else changes there. One policy row is added, `{ action: "mcp:write", resource: "command", actorKinds: ["user"], when: [ACTS_AS_PERSON] }`, the mirror of the `config:write` row that already lets a person write their own scope, under one new condition: **acts-as-person** holds when `self` names a chat identity (`slack:U…`), which is every chat actor and exactly the linked browser sessions, never an unlinked one. Which tier the write reaches stays the handler's question, as today (org needs `repo:write`, channel `config:write`). The audit entry gains `asUser`.

Invariants: `effectiveGrants(actor)` is identical before and after the link for every actor; an unlinked browser session passes no row it did not pass before this record; a linked session passes exactly one new row, the self-serve `mcp:write` on `command`, and no `has-grant` condition it did not pass unlinked; `self` never holds more than two ids; the conformance authorization matrix gains a "browser: linked" role whose column equals the unlinked browser's on every command except the three MCP self-serve writes, and the unlinked browser's column is unchanged. Entries a browser wrote under `users["access:<sub>"]` before record 0041 closed that write are read by no run today and stay so; the all-tiers list in PR 3 shows them for an admin to clear. Failure mode: the Slack workspace has two users with the same email (Slack forbids it; the lookup returns one); a deactivated user's email is reused (`deleted` users are skipped; the new holder is the person).

The alternative it beat: union the grants. It is one line (`unionGrants` exists) and it is wrong twice: it grants the browser two writes silently, and it makes the audit line ambiguous, since the caller id would then be the Slack id for an action a browser took.

## Trust in the email

The constraint: our gate verifies the JWT's signature, issuer, audience and times, and takes `email` as a string; it does not read an `email_verified` claim. The `token` and `none` strategies build a browser-shaped identity with no email.

The design: the link trusts the email because Access does: Cloudflare Access issues the claim from the login it fronted, every Access login method proves control of that mailbox or has the IdP assert it, and the same JWT is what already decides that the session may see `/runs` at all. We add nothing to the claim check and state the dependency in the spec. Without an email, or when the email matches no active human Slack user, the session is unlinked and behaves as today. The lookup is `users.lookupByEmail` under the `users:read.email` scope the bot already requires, behind the `NameLookupClient` seam beside `users.info`, cached for ten minutes per email (a hit and a miss alike), single-flighted, and bounded at 1.5 seconds like the channel directory; a failure or timeout is "unlinked" for that request, never an error page. Cost: one lookup per distinct email per ten minutes per process, whatever a page fans out into (the HTML, its SSE stream and every `/api` call pass the gate and hit the cache); a dashboard with fifty active viewers costs at most five lookups a minute. The Slack facts this rests on are Slack's, not the repo's: `users.lookupByEmail` is a Tier 3 method (fifty or more calls a minute) under the `users:read.email` scope the bot already requires; a workspace holds one account per email; and a member's own email change is confirmed by a link mailed to the new address. The Access fact is Cloudflare's: the one-time PIN method mails the code to the address, and an IdP login carries the IdP's email.

**What the match rests on, and the two ways it could name the wrong person.** Slack's `profile.email` is set by the workspace's SSO provider where one is configured, and where it is not, a member changes their own address only by confirming a link mailed to the new address, so a Slack account cannot carry a colleague's email without control of that colleague's mailbox, and whoever controls the mailbox also passes Access. That is the same trust the connect ticket and the costs page place in the email today. The residual cases: a deactivated Slack user's address reassigned to a new hire links the new person to the old account's *historical* runs and personal MCP tier only if Slack reactivates the same account for them (a new account gets a new id and nothing follows); `deleted` users never link. And a workspace where an admin sets members' emails by hand can, by that same power, already read anything in the workspace; the link adds nothing to what such an admin holds.

Invariants: a session without an email never links; a `deleted` or `is_bot` user never links; the link never runs Slack to Access; the cache is per process and never persisted. Failure mode: the Slack socket is down at boot, so `lookupByEmail` is undefined for the first requests; they are unlinked and say so nowhere, which is today's behaviour, and the next request after the socket is up links.

## Promote by re-issue

The constraint: a personal server's credential is sealed under `user:slack:U123/<name>` as the cipher's additional data, so it cannot be renamed to `org/<name>`, and it should not be: a person's OAuth token or pasted bearer is theirs, and an org server's calls would otherwise run as that person for everyone.

The design: `mcp promote <name> --from <slack:U…>` (org rights: the same `mcp:write` on `config-scope { org }` that `mcp add --scope org` asks) copies the entry, `url`, `auth`, and `agents` widened only if the admin passes `--agents`, into the org tier under the same name, records `addedBy` as the admin and `promotedFrom` as the person, and, for `bearer` and `oauth`, mints a fresh org connect ticket exactly as `mcp add --scope org` would, so the org's credential is entered or signed in by the admin. `auth: none` promotes and connects at once. The personal entry stays and the existing resolution marks it shadowed by the org tier (`shadowedBy: "org"`, the winning scope key), so the person's runs switch to the org server on their next run and the person may `mcp remove` theirs. A name the org already holds refuses, the mirror of `add`'s higher-tier check.

The ticket is bound to the admin the way every connect ticket is bound: by the email of the actor who minted it. Today that email is resolved from a Slack id only, so a ticket minted from the dashboard binds to the first Access identity that opens it, a shipped gap this record closes: PR 3 binds a ticket minted from the dashboard to the session's own email, linked or not, and a linked session's `McpActor.id` is the Slack self, so `addedBy` names the person as it does from chat.

Invariants: no sealed credential is ever read, unsealed or written by promote; the org entry's `state` is `awaiting_credential` until the ticket completes; in chat a promote is an inline run like `add` (the inline-run set gains `promote`), and on every surface the audit line records it. Failure mode: the admin never completes the ticket, so the org server sits `awaiting_credential` and the person's shadowed server still works for them; `mcp show` says so.

The alternative it beat: unseal and reseal the personal credential under the org key. It works cryptographically and it is the wrong thing to do with someone's token.

## The MCP list a person sees

The constraint: "channels you are in" is membership, and `isMember` answers `unknown` until `conversations.members` lands behind the seam (#516).

The design: `mcp list` gains `--all` for an actor with org rights: every tier in the overrides document and the static config (org, every channel, every user), each row with `addedBy` resolved to a display name through the cached user-name lookup the runs index already uses. For everyone else, `mcp list` keeps its shape and the MCPs tab lists, beside org and own, the channel tiers of every channel whose scope the viewer may read, the same per-channel `config:read` question `config overrides` asks: a grant, or a public channel. That is a superset of "channels you are in" for public channels and a subset for private ones, and it is the honest cut until membership exists. The `me` tier of the list is the linked Slack user's.

Invariants: a non-admin never sees another person's user tier; `--all` needs the org right; names come from the same lookup, so a user without a resolvable name shows the id. Failure mode: a private channel the viewer is in but holds no grant for is missing from their list; the row for it appears once #516 lands, with no change here.

## Why not X

**Why not make the browser actor the Slack user, id and grants and all?** Two writes leak into every linked session, and the audit line can no longer say a browser did it. The line above.

**Why not store the email on the run record and match at read time, as costs does?** It answers "mine" for runs only, per report and per run-user, and answers nothing for `me` on the config and MCP tiers. The link in the resolver answers every question once.

**Why not a consent step, "link your Slack account"?** Access and Slack already agree on the email through the IdP; a consent screen would add a store and a flow to confirm what both systems already assert. If an installation ever fronts the dashboard with an IdP whose emails Slack does not hold, sessions are unlinked and the page says where personal settings live.

**Why not resolve membership now and list exactly "channels you are in"?** That is #516, priced in record 0037 as one cached `conversations.members` call per channel; it is the same seam and lands independently. Blocking the MCP list on it buys nothing the read-right cut does not already give for public channels.

## Boundaries

The link does not touch grants, `restrict`, or the policy table beyond the one self-serve row. It does not add an email to the run record (open question below). It does not resolve membership. It does not let a non-admin promote, and it never moves a secret. The `token` and `none` dashboard strategies stay unlinked. Chat, CLI, HTTP ingress and MCP ingress callers are unchanged: `self` is `[id]` for all of them.

## What would change our mind

The design assumes the dashboard's Access login and the Slack workspace agree on a person's email. The bot serves one Slack workspace (one Slack app, one client answers the lookup), and the one production deployment fronts both with the organization's own email domain, but that is an assumption until PR 1's first live login: the audit line says linked or unlinked, and a week of them is the evidence. If workspaces in practice hold emails that differ from the IdP's (aliases, plus-addressing), the link misses and the page falls back to today. If a customer runs the `token` strategy and wants `me`, the answer is a configured actor-to-user map in `dashboard.token`, a one-key addition, not a redesign. Everything here is reversible: remove the link step and every surface reads as today.

## Rollout

Three independent PRs, each with its spec rows. **PR 1, the link:** `self`/`asUser` on `Actor`, `linkedActor` in the gate with the cached reverse lookup and the adapter taking the resolved caller, `user-in` through the compiler, the store serialization and the state Worker's SQL (a Worker deploy), the self-serve `mcp:write` row, the `me` resolution in the config and MCP handlers (the 0041 refusal kept for unlinked sessions; `McpActor.id` the Slack self), the audit field, the "browser: linked" conformance role; the Settings page's `me` tier appears for linked sessions. **PR 2, runs:** the owner column reads the name the row already carries, `?mine=1` on `/runs` and `--mine` on `runs list` as a store-level `userIds` filter, and the viewer's own private and DM runs admitted through `user-in`. **PR 3, MCPs:** `mcp list --all` with resolved names, the per-channel read-right list for everyone else, `mcp promote` by re-issue, and the Promote button on user-tier rows for admins.

## Open questions

| Question | Owner | Resolves it | Needed before |
|---|---|---|---|
| Should the run record carry the requester's email, so the owner column can show it beside the name? | the maintainer | whether an email on every persisted record is wanted (it is personal data the record does not hold today); the name ships without it | PR 2 |
| Does "channels you are in" wait for #516 or does the read-right cut stand? | the maintainer | #516 landing; nothing here changes when it does | never for these PRs |

## Validation criteria

| Criterion | Proof |
|---|---|
| A session with an email that names one active human Slack user resolves with `self` of two ids and `asUser`; no email, no match, a bot, a deleted user, a failure or a timeout resolve to today's actor; `grants` are identical in every case | `[gap]` `src/channels/commandHttp.test.ts` (PR 1) |
| `is-self` and `user-in` admit a run whose `userId` is any id in `self`; a linked browser sees its own private and DM runs and no one else's | `[gap]` `src/core/authz/predicate.test.ts`, `src/channels/liveView.test.ts` (PR 1, PR 2) |
| The conformance authorization matrix's "browser: linked" column equals "browser: unlisted" on every command but the three MCP self-serve writes; "browser: unlisted" is unchanged from before the record | `[gap]` `src/core/commandConformance.test.ts` (PR 1) |
| `config set me` and `mcp add` from a linked session write the Slack self's scope; from an unlinked session they are refused as record 0041 says; the audit line carries `asUser` | `[gap]` `src/core/commands/config.test.ts`, `src/core/commands/mcp.test.ts` (PR 1) |
| `?mine=1` and `--mine` filter at the store by `self`; the row shows the requester's name | `[gap]` `src/core/runsService.test.ts`, `web/src/pages/runsIndex.test.ts` (PR 2) |
| `mcp list --all` needs the org right and lists every tier with resolved names; a non-admin's list is org, own and readable channels; `mcp promote` copies the entry, mints a ticket, never reads a credential, refuses a name the org holds | `[gap]` `src/mcp/service.test.ts`, `src/core/commands/mcp.test.ts` (PR 3) |
| Human-gated: on the deployed dashboard, the maintainer sees their own DM run under "show mine", adds a personal MCP server from `/settings/mcps` (its `addedBy` their Slack id), promotes it to the org with a fresh connect link bound to their email, and the audit line names both identities | receipt on PR 3 |

## Sources

- [Record 0041](0041-the-settings-page-is-a-surface-over-the-registry-and-configures-the-shared-tiers.md), the open question and the "setting that lies" constraint.
- [authorization.md](../reference/specs/authorization.md) items 1, 7, 9, 11; [access-gate.md](../reference/specs/access-gate.md) item 1; [mcp-tools.md](../reference/specs/mcp-tools.md) items 13 to 15; [costs.md](../reference/specs/costs.md) item 10.
- [Record 0037](0037-a-linked-thread-is-quoted-not-joined.md), the membership pricing and #516.
