# Agent env bootstrap: downstream UAT creds into the agent's execution environment

When the switchboard agent works on a **downstream service**, its execution environment — the shell where its `bash` tool runs (resident/sandbox/local-dev) — needs that service's environment variables so the real toolchain works: running the service's tests, generating code against it, deploying to that service's **UAT**. This tool materializes those env vars from 1Password via a **read-only service account scoped to a UAT vault**, so the agent can obtain a downstream service's **UAT** creds — never its prod (GitHub #72, Matanya requirements 2+3: local env setup so no agent tokens are wasted on env setup, and a 1Password service account that sets env vars from the vault).

**This is NOT** switchboard's own Cloudflare-Worker secret provisioning (that was the separate, closed PR #77, which wrote to switchboard's Workers via `wrangler secret put`). Here the write side **materializes env vars into the execution environment**: `--apply` writes a `chmod 600` dotenv file the toolchain sources, and the in-process integration hook returns the same `NAME→value` map for merging into a sandbox's env.

Switchboard itself runs in prod, which is fine — the safety is not where switchboard runs, it is that the service account is **read-only and UAT-vault-scoped**, so the only creds reachable are downstream **UAT** creds. The env-name allowlist (`["uat"]`) is defense-in-depth on top of that operational guard.

- **Code**: `src/agentEnv/bootstrap.ts` (dependency-injected core: `stripJsonc` + `parseManifest` JSONC parsing, `parseOpRef`, `ALLOWED_ENVS` + `assertAllowedEnv` allowlist, `buildPlan`, `renderPlan`, `renderEnvFile`, `runBootstrap`, the `buildAgentEnv` integration hook, `parseArgs` — `OpReader`/`EnvSink`/`log` injected, no real `op` ever runs). `src/agentEnv/bootstrapCli.ts` (thin CLI: real `op read`, real chmod-600 file sink, argv/exit/usage). `deploy/agent-env.jsonc` (operator-filled manifest template with `REPLACE-ME` placeholders). `deploy/agent-env-bootstrap.sh` + the `agent-env-bootstrap` npm script.
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
- **The real guard is operational.** The `OP_SERVICE_ACCOUNT_TOKEN` the operator exports MUST belong to a 1Password service account that is **read-only** and **scoped to the UAT vault only**. Then the agent can only ever resolve UAT creds regardless of the manifest. The allowlist is defense-in-depth on top of this.
- **Read-only tool.** The tool only ever READS from 1Password and WRITES the env file. It never writes to 1Password and never touches prod.
- **Values never leak.** Resolved values travel `op read` → the chmod-600 file contents / the returned env map only. They are never logged and never placed in argv (the token is read by `op` from the environment; refs — not values — are the only args).

## Setup: creating the 1Password service account (one-time, org-admin)

> **Product gap — human-gated.** This tool cannot self-provision its own 1Password
> credential. A 1Password **Business owner/admin** must create the service account
> once; the agent can never do this itself. Until it exists, the tool runs dry-run
> only (it fails closed on `--apply` when `OP_SERVICE_ACCOUNT_TOKEN` is unset).

**Prerequisites**
- Owner/admin on the 1Password **Business** account (service accounts are a Business feature).
- The name of the single **UAT vault** that holds the downstream service's creds — the vault your `op://<vault>/…` refs point at. The service account is scoped to *only* that vault.

**Route A — Web console (recommended; unambiguous scoping)**
1. Sign in to `https://<team>.1password.com` as owner/admin.
2. Sidebar → **Developer** (may sit under **Integrations** or **Settings → Developer**).
3. **Service Accounts → Create Service Account**.
4. Name it `switchboard-agent-uat-ro`.
5. **Vault access (critical):** add **only the one UAT vault**, permission **Read / View items** only. Do **not** select "All vaults" and do **not** grant write/manage.
6. Optional: set an expiration (e.g. 90 days).
7. Create, then **copy the `ops_…` token** — it is shown **once**. Store it in 1Password.

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

- **Dry-run is the default** (no `--apply`): prints the plan — env-var NAMES + their `op://vault/item/field` refs — resolving nothing, writing nothing, never a value.
- **`--apply`** resolves each ref and writes ONE `chmod 600` env file (default `.agent-env/<service>.<env>.env`, gitignored). Fails closed if `OP_SERVICE_ACCOUNT_TOKEN` is unset or a ref won't resolve. The file is `export NAME='value'` lines (shell-quoted), sourced with `set -a; . <file>; set +a`.

Operator flow:

```bash
# 1) fill deploy/agent-env.jsonc with real op:// refs for the service
# 2) export a READ-ONLY, UAT-vault-scoped service-account token
export OP_SERVICE_ACCOUNT_TOKEN=ops_...
# 3) see the plan (nothing read/written)
deploy/agent-env-bootstrap.sh --env uat --service <name>
# 4) materialize into the agent's env
deploy/agent-env-bootstrap.sh --env uat --service <name> --apply
# 5) the toolchain sources it
set -a; . .agent-env/<name>.uat.env; set +a
```

## Integration hook + the open decision

`buildAgentEnv({ manifest, env, service, opReader, processEnv })` is the clean seam: it returns the resolved `NAME→value` map for a service's UAT env, enforcing the allowlist and the fail-closed token check, and writing no file. It is the direct analogue of `githubEnvs()` in `src/execution/factory.ts`, which today returns `{ GH_TOKEN }` for injection into a sandbox's `envs` (E2B `envs`, Cloudflare Sandbox `x-env-*` headers).

**Open integration decision for the owner (deliberately NOT wired into the deployed executor in v1):** where downstream UAT env should enter a run. Two mechanisms, both supported by this tool:

1. **Baked into the repo's toolchain-setup step** (requirement 2, "tune and bake into the repo"): run `--apply` once during the resident warm-up / a repo's setup, and have the toolchain source the chmod-600 file. Simple, no code change to the executor; the file lives on the execution host.
2. **In-process injection via `buildAgentEnv`**: call it from `factory.ts` alongside `githubEnvs()` and merge the result into the sandbox `envs`. Cleaner (no on-disk file), but adds an `op read` dependency and latency to executor provisioning, and needs a policy for *which service* a run targets (the dispatcher already resolves `ctx.repo`, which could map to a service).

The decision (mechanism, where the service name comes from, whether the resident host has `op` + the token) is the owner's; v1 ships the standalone tool + the hook + this doc so either can be wired later behind a flag. Nothing here runs in the deployed bot/resident yet.

## Validation criteria

| Criterion | Evidence |
|-----------|----------|
| JSONC parse is string-aware: `op://` (with its `//`) survives line/block comments + trailing commas | `[unit]` `src/agentEnv/bootstrap.test.ts::stripJsonc::preserves op:// (with its //) inside string values`, `::strips line comments outside strings but not the op:// inside them`, `::strips block comments and trailing commas` |
| Manifest parses to env→service→NAME→ref; malformed JSON / non-string ref / non-object service throw clearly | `[unit]` `::parseManifest::parses a JSONC manifest with comments into env -> service -> NAME -> ref`, `::throws on malformed JSON`, `::throws when a ref is not a string`, `::throws when a service is not an object` |
| `op://` ref parses to vault/item/field (trailing path folded into field); malformed refs rejected | `[unit]` `::parseOpRef::splits vault/item/field`, `::folds a trailing section path into field`, `::rejects a non-op ref and a too-short ref` |
| Env-name allowlist: `uat` allowed; prod / aliases / typos refused | `[unit]` `::assertAllowedEnv — UAT-only allowlist::permits uat`, `::refuses prod`, `::refuses any non-allowlisted env or alias (staging, production, uat-alias)` (RED-verified: neutering the allowlist fails these) |
| Plan reads only the selected env+service section; unknown service / missing env section throw | `[unit]` `::buildPlan::builds one entry per var for the selected env+service, only from that section`, `::refuses a non-uat env (allowlist enforced in the plan, before any resolve)`, `::throws on an unknown service`, `::throws when the env section is missing entirely` |
| Env file is sourceable `export NAME='value'` (shell-quoted, single quotes survive) with a do-not-commit header | `[unit]` `::renderEnvFile::emits \`export NAME='value'\` lines that survive sourcing`, `::carries a do-not-commit header naming the env+service` |
| Dry-run (default): prints NAMES + refs, never a value; resolver + sink not called | `[unit]` `::runBootstrap — dry-run::prints NAMES + refs, and calls neither the resolver nor the sink` |
| Apply: resolves each var once, writes the file exactly once at mode 600, returns the env map | `[unit]` `::runBootstrap — apply::resolves each var once and writes the env file exactly once, mode 600` |
| Apply never logs a resolved value | `[unit]` `::runBootstrap — apply::NEVER logs a resolved value on apply` (RED-verified: logging a value fails this) |
| Apply fails closed when `OP_SERVICE_ACCOUNT_TOKEN` is unset — before any resolve or write | `[unit]` `::runBootstrap — apply::fails closed when OP_SERVICE_ACCOUNT_TOKEN is unset — before any resolve or write` |
| Apply refuses a non-uat env before resolving or writing | `[unit]` `::runBootstrap — apply::refuses apply for a non-uat env before resolving or writing` |
| Integration hook returns the resolved UAT env map; enforces allowlist + fail-closed token | `[unit]` `::buildAgentEnv — integration hook::returns the resolved downstream UAT env map for injection into the sandbox env`, `::enforces the UAT-only allowlist`, `::fails closed with no service-account token` |
| CLI arg parsing: `--env`/`--service` required, dry-run default, `--apply`/`--out`/`--manifest`, unknown args rejected | `[unit]` `::parseArgs::parses --env, --service and defaults to dry-run`, `::--apply sets the apply flag; --out and --manifest override paths`, `::requires --env and --service`, `::rejects unknown args` |
| CLI end-to-end (dry-run prints plan; prod refused; apply with a real read-only UAT token writes the 600 file the toolchain sources) | `[gap]` — dry-run + prod-refusal + missing-token fail-closed verified via the CLI locally; a full live apply needs the operator's read-only, UAT-vault-scoped service account + real refs. |
| Integration into the deployed resident/executor | `[gap]` — intentionally not wired in v1; the owner's integration decision (see above). |

## Validation status & product gap

**Validated now (on `main`, CI green):** JSONC/manifest parsing, `op://` ref parsing, the env-name allowlist (UAT-only, fail-closed before any read/write), env-var **name** validation, dry-run reads/writes nothing, apply writes exactly one mode-600 file and never logs a value, fail-closed on missing `OP_SERVICE_ACCOUNT_TOKEN`, the shell-quoted dotenv surviving adversarial values, and the atomic 600 write. Receipts: `src/agentEnv/bootstrap.test.ts` + CI.

**Human-gated gap (not yet validated live):**
1. **Live `--apply` against a real service account** — requires a 1Password Business **owner/admin** to create the read-only, UAT-vault-scoped service account (see *Setup* above). This is an org-admin action the agent cannot self-serve; until then only dry-run + fail-closed paths are exercised.
2. **Executor integration** — `buildAgentEnv` is a ready seam but is intentionally not wired into the deployed executor in v1 (see *Integration hook + the open decision*). Wiring it (and choosing mechanism 1 vs 2) is a follow-up.

Validating (1) is a one-time setup plus a single dry-run/apply round once the service account exists.
