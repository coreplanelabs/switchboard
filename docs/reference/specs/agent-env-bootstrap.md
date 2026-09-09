# Agent env bootstrap: downstream UAT creds into the agent's execution environment

When the switchboard agent works on a **downstream service**, its execution environment — the shell where its `bash` tool runs (resident/sandbox/local-dev) — needs that service's environment variables so the real toolchain works: running the service's tests, generating code against it, deploying to that service's **UAT**. This tool materializes those env vars from 1Password via a **read-only service account scoped to a UAT vault**, so the agent can obtain a downstream service's **UAT** creds — never its prod — without spending agent turns on environment setup.

**This is NOT** OpenSwitchboard's own Cloudflare-Worker secret provisioning ([release-and-deploy.md](release-and-deploy.md) item 18 — that path writes to OpenSwitchboard's Workers via `wrangler secret put`). Here the write side **materializes env vars into the execution environment**: `--apply` writes a `chmod 600` dotenv file the toolchain sources, and the in-process integration hook returns the same `NAME→value` map for merging into a sandbox's env.

Switchboard itself runs in prod, which is fine — the safety is not where switchboard runs, it is that the service account is **read-only and UAT-vault-scoped**, so the only creds reachable are downstream **UAT** creds. The env-name allowlist (`["uat"]`) is defense-in-depth on top of that operational guard.

- **Code**: `src/agentEnv/bootstrap.ts` (dependency-injected core: `stripJsonc` + `parseManifest` JSONC parsing, `parseOpRef`, `ALLOWED_ENVS` + `assertAllowedEnv` allowlist, `buildPlan`, `renderPlan`, `renderEnvFile`, `runBootstrap`, the `buildAgentEnv` integration hook — `OpReader`/`EnvSink`/`log` injected, no real `op` ever runs). `src/agentEnv/host.ts` (the host half: real `op read`, real chmod-600 file sink, manifest + path defaults) behind the registry command `env bootstrap` (`src/core/commands/env.ts`, CLI only — [command-registry.md](command-registry.md) item 20; the option grammar, exit codes and usage are the registry's). `deploy/agent-env.jsonc` (operator-filled manifest template with `REPLACE-ME` placeholders). `deploy/agent-env-bootstrap.sh` + the `agent-env-bootstrap` npm script.
- **Tests**: `src/agentEnv/bootstrap.test.ts`.

## The manifest

`deploy/agent-env.jsonc` (JSONC — comments allowed; the parser is string-aware so the `//` inside every `op://` ref is never mistaken for a comment). Shape:

```jsonc
{
  "uat": {
    "<downstream-service>": {
      "ENV_VAR_NAME": "op://<vault>/<item>/<field>"
    }
  }
}
```

Keyed **env-first, then service-first**, so a section reads as "the UAT creds for `<service>`". `--service <name>` selects which service's block to materialize. The template ships only a `uat` section with `REPLACE-ME-*` placeholders and no `prod` section — there is intentionally no prod path.

## Safety posture

- **UAT-only allowlist.** `assertAllowedEnv` refuses any env not in `ALLOWED_ENVS` (`["uat"]`) — prod, an alias, a typo — and it runs inside `buildPlan`, so it blocks even a *dry-run* of a non-uat env, before anything is read or written.
- **The real guard is operational.** The `OP_SERVICE_ACCOUNT_TOKEN` the operator exports MUST belong to a vault service account that is **read-only** and **scoped to the UAT vault only**. Then the agent can only ever resolve UAT creds regardless of the manifest. The allowlist is defense-in-depth on top of this.
- **Read-only tool.** The tool only ever READS from the vault and WRITES the env file. It never writes to the vault and never touches prod.
- **Values never leak.** Resolved values travel `op read` → the chmod-600 file contents / the returned env map only. They are never logged and never placed in argv (the token is read by `op` from the environment; refs — not values — are the only args).

## Setup: creating the vault service account (one-time, org-admin)

> **Product gap — human-gated.** This tool cannot self-provision its own vault
> credential. A secrets-manager **Business owner/admin** must create the service account
> once; the agent can never do this itself. Until it exists, the tool runs dry-run
> only (it fails closed on `--apply` when `OP_SERVICE_ACCOUNT_TOKEN` is unset).

**Prerequisites**
- Owner/admin on the secrets manager's **Business** account (service accounts are a Business feature).
- The name of the single **UAT vault** that holds the downstream service's creds — the vault the manifest's refs point at. The service account is scoped to *only* that vault.

**Route A — Web console (recommended; unambiguous scoping)**
1. Sign in to the secrets manager's web console as owner/admin.
2. Sidebar → **Developer** (may sit under **Integrations** or **Settings → Developer**).
3. **Service Accounts → Create Service Account**.
4. Name it `switchboard-agent-uat-ro`.
5. **Vault access (critical):** add **only the one UAT vault**, permission **Read / View items** only. Do **not** select "All vaults" and do **not** grant write/manage.
6. Optional: set an expiration (e.g. 90 days).
7. Create, then **copy the `ops_…` token** — it is shown **once**. Store it in the vault.

**Route B — CLI (`op` v2+, signed in as owner/admin)**

```bash
op service-account create "switchboard-agent-uat-ro" \
  --expires-in 90d \
  --vault "<UAT-vault-name>:read_items"
```

`read_items` = read-only; do **not** add `write_items`. Prints the `ops_…` token once. (Confirm the flag grammar for your version with `op service-account create --help`.)

**Verify (fresh shell, not the admin session)**

```bash
export OP_SERVICE_ACCOUNT_TOKEN=ops_...
op vault list          # must list ONLY the UAT vault
op read "op://<UAT-vault>/<item>/<field>"                        # read works
op item create --vault "<UAT-vault>" --title t --category login  # must FAIL (proves read-only)
```

The **read-only + single-UAT-vault scope is the real safety guard**; the `["uat"]` allowlist is defense-in-depth on top of it.

## Dry-run and apply

- **Dry-run is the default** (no `--apply`): prints the plan — env-var NAMES + their vault refs — resolving nothing, writing nothing, never a value.
- **`--apply`** resolves each ref and writes ONE `chmod 600` env file (default `.agent-env/<service>.<env>.env`, gitignored). Fails closed if `OP_SERVICE_ACCOUNT_TOKEN` is unset or a ref won't resolve. The file is `export NAME='value'` lines (shell-quoted), sourced with `set -a; . <file>; set +a`.

Operator flow:

```bash
# 1) fill deploy/agent-env.jsonc with the service's real vault refs
# 2) export a READ-ONLY, UAT-vault-scoped service-account token
export OP_SERVICE_ACCOUNT_TOKEN=ops_...
# 3) see the plan (nothing read/written)
deploy/agent-env-bootstrap.sh --env uat --service <name>          # = npx tsx src/cli.ts env bootstrap --env uat --service <name> (needs no config/config.yaml)
# 4) materialize into the agent's env
deploy/agent-env-bootstrap.sh --env uat --service <name> --apply
# 5) the toolchain sources it
set -a; . .agent-env/<name>.uat.env; set +a
```

## Integration hook + the open decision

`buildAgentEnv({ manifest, env, service, opReader, processEnv })` is the clean seam: it returns the resolved `NAME→value` map for a service's UAT env, enforcing the allowlist and the fail-closed token check, and writing no file. It is the direct analogue of `githubEnvs()` in `src/execution/factory.ts`, which today returns `{ GH_TOKEN }` for injection into a sandbox's `envs` (E2B `envs`, the Cloudflare Sandbox request body's `env`).

**Open integration decision for the owner (deliberately NOT wired into the deployed executor in v1):** where downstream UAT env should enter a run. Two mechanisms, both supported by this tool:

1. **Baked into the repo's toolchain-setup step**: run `--apply` once during the resident warm-up / a repo's setup, and have the toolchain source the chmod-600 file. Simple, no code change to the executor; the file lives on the execution host.
2. **In-process injection via `buildAgentEnv`**: call it from `factory.ts` alongside `githubEnvs()` and merge the result into the sandbox `envs`. Cleaner (no on-disk file), but adds an `op read` dependency and latency to executor provisioning, and needs a policy for *which service* a run targets (the dispatcher already resolves `ctx.repo`, which could map to a service).

The decision (mechanism, where the service name comes from, whether the resident host has `op` + the token) is the owner's; v1 ships the standalone tool + the hook + this doc so either can be wired later behind a flag. Nothing here runs in the deployed bot/resident yet.

## Validation criteria

| Criterion | Evidence |
|-----------|----------|
| JSONC parse is string-aware: a vault ref (with its `//`) survives line/block comments + trailing commas | `[unit]` `src/agentEnv/bootstrap.test.ts::stripJsonc::preserves … (with its //) inside string values`, `::strips line comments outside strings but not the … inside them`, `::strips block comments and trailing commas` |
| Manifest parses to env→service→NAME→ref; malformed JSON / non-string ref / non-object service throw clearly | `[unit]` `::parseManifest::parses a JSONC manifest with comments into env -> service -> NAME -> ref`, `::throws on malformed JSON`, `::throws when a ref is not a string`, `::throws when a service is not an object` |
| A vault ref parses to vault/item/field (trailing path folded into field); malformed refs rejected | `[unit]` `::parseOpRef::splits vault/item/field`, `::folds a trailing section path into field`, `::rejects a non-op ref and a too-short ref` |
| Env-name allowlist: `uat` allowed; prod / aliases / typos refused | `[unit]` `::assertAllowedEnv — UAT-only allowlist::permits uat`, `::refuses prod`, `::refuses any non-allowlisted env or alias (staging, production, uat-alias)` (RED-verified: neutering the allowlist fails these) |
| Plan reads only the selected env+service section; unknown service / missing env section throw | `[unit]` `::buildPlan::builds one entry per var for the selected env+service, only from that section`, `::refuses a non-uat env (allowlist enforced in the plan, before any resolve)`, `::throws on an unknown service`, `::throws when the env section is missing entirely` |
| Env file is sourceable `export NAME='value'` (shell-quoted, single quotes survive) with a do-not-commit header | `[unit]` `::renderEnvFile::emits \`export NAME='value'\` lines that survive sourcing`, `::carries a do-not-commit header naming the env+service` |
| Dry-run (default): prints NAMES + refs, never a value; resolver + sink not called | `[unit]` `::runBootstrap — dry-run::prints NAMES + refs, and calls neither the resolver nor the sink` |
| Apply: resolves each var once, writes the file exactly once at mode 600, returns the env map | `[unit]` `::runBootstrap — apply::resolves each var once and writes the env file exactly once, mode 600` |
| Apply never logs a resolved value | `[unit]` `::runBootstrap — apply::NEVER logs a resolved value on apply` (RED-verified: logging a value fails this) |
| Apply fails closed when `OP_SERVICE_ACCOUNT_TOKEN` is unset — before any resolve or write | `[unit]` `::runBootstrap — apply::fails closed when OP_SERVICE_ACCOUNT_TOKEN is unset — before any resolve or write` |
| Apply refuses a non-uat env before resolving or writing | `[unit]` `::runBootstrap — apply::refuses apply for a non-uat env before resolving or writing` |
| Integration hook returns the resolved UAT env map; enforces allowlist + fail-closed token | `[unit]` `::buildAgentEnv — integration hook::returns the resolved downstream UAT env map for injection into the sandbox env`, `::enforces the UAT-only allowlist`, `::fails closed with no service-account token` |
| `env bootstrap`: `--env`/`--service` required, dry-run default, `--apply`/`--out`/`--manifest` reach the host half (manifest default), unknown options are usage errors; the output is plan lines + names/refs and never a value; anything the host half throws is `unavailable`; CLI-only | `[unit]` `src/core/commands/env.test.ts::*` |
| CLI end-to-end (dry-run prints plan; prod refused; apply with a real read-only UAT token writes the 600 file the toolchain sources) | `[gap]` a full live apply needs the operator's read-only, UAT-vault-scoped service account + real refs (human-gated: an org-admin creates the account per *Setup* above; then one dry-run + apply round). |
| Integration into the deployed resident/executor | `[gap]` intentionally not wired in v1; the owner's integration decision (see above). |
