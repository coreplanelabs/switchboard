# 1Password env-fill

An operator can populate a deploy environment's Worker secrets from 1Password with one command, safely and repeatably, without over-exposing secrets to the wrong environment (GitHub [#72](https://github.com/coreplanelabs/switchboard/issues/72), "Area 6"). A config file maps, per environment and per Worker, each required secret NAME to a 1Password secret reference (`op://<vault>/<item>/<field>`); the tool resolves those refs with a **read-only service account** and pipes each value into `wrangler secret put <NAME>` for the chosen Worker. **UAT is the only environment that runs by default; prod is hard-guarded** — the tool refuses `--env prod` unless the loud `--i-understand-prod` override is also passed. The default is a **dry-run** that prints exactly what would be set (secret NAMES + their `op://` references — never resolved values).

- **Code**: `src/deploy/opEnvFill.ts` (pure, dep-injected: JSONC parsing, `op://` ref parsing, env selection + prod guard in `buildPlan`, plan rendering, `runFill`, `parseArgs`); `src/deploy/opEnvFillCli.ts` (thin CLI wiring the real `op read` + `wrangler` implementations, config load, exit codes); `deploy/op-env.jsonc` (the operator-filled config template); `deploy/op-env-fill.sh` and the root `op-env-fill` npm script (entry points).
- **Tests**: `src/deploy/opEnvFill.test.ts`.

## The operator's responsibility

The tooling ships; the 1Password side is owner-provided:

1. **A read-only, UAT-scoped service-account token.** Create a 1Password service account scoped **read-only** to the **UAT vault only**, and export its token as `OP_SERVICE_ACCOUNT_TOKEN` before `--apply`. The tool only ever *reads* from 1Password and *writes* to the selected Worker's secrets — it never needs (and must not be given) a token that can write 1Password or read prod.
2. **The vault refs.** Fill in `deploy/op-env.jsonc`: replace every `REPLACE-ME-*` placeholder with the real `op://<vault>/<item>/<field>` for each secret. The tool never hard-codes vault contents. Per [AGENTS.md](../AGENTS.md) invariant 5, the resident holds its **own** GitHub App credentials — a second credential domain — so the resident's `GITHUB_APP_*` refs point at a **separate** 1Password item from the bot's.

The authoritative secret-name lists are each Worker's `secrets.txt` (`deploy/cloudflare/secrets.txt`, `deploy/cloudflare-resident/secrets.txt`); the config's per-target sections mirror them.

## Behavior

1. **Config format + isolation.** `deploy/op-env.jsonc` is JSONC (comments allowed) shaped `{ <env>: { <target>: { <SECRET_NAME>: "op://<vault>/<item>/<field>" } } }`. Environments are separate top-level sections (`uat`, `prod`), and a run only ever reads `config[env][target]` — so a `--env uat` run can never read a `prod` ref. Targets are `bot` (→ `deploy/cloudflare`) and `resident` (→ `deploy/cloudflare-resident`). JSONC comment-stripping is **string-aware**: it strips `//` line comments, block comments, and trailing commas without touching the `//` inside every `op://` reference.
2. **Explicit env + target selection.** `--env <name>` is required; `--target bot|resident|both` is required (repeatable). No target defaults on, so a run never touches a Worker the operator didn't name.
3. **Prod hard-guard.** `--env prod` is refused with a loud error unless `--i-understand-prod` is ALSO passed. This fires in `buildPlan`, so it guards dry-run and apply alike — even *viewing* the prod plan requires the override. Default behavior only ever touches UAT.
4. **Dry-run by default.** With no `--apply`, the tool prints the plan — env, target, Worker dir, and each secret NAME with its `op://<vault>/<item>/<field>` reference — and exits without reading 1Password or calling wrangler. `op://` references are pointers, not values; no field value is ever resolved in dry-run.
5. **Apply.** With `--apply`, the tool requires `OP_SERVICE_ACCOUNT_TOKEN` (fails closed with a clear error if unset, before touching anything), then for each secret resolves the ref via `op read` and runs `wrangler secret put <NAME>` in the target Worker's directory with the value piped on **stdin** — so the value never appears in argv, process listings, or logs. A ref that doesn't resolve fails the run.
6. **Never echoes a value.** Resolved secret values travel only from `op read` to wrangler's stdin. The plan, the per-secret progress lines, and error messages contain names and `op://` references only.

## Read-only posture

The service account is scoped **read-only to the UAT vault only** (owner-configured in 1Password). The tool's only capabilities are: read `op://` refs from 1Password, and write secrets to the selected Cloudflare Worker via wrangler. It never writes to 1Password and never reads outside the environment section named on the command line.

## Validation criteria

| Criterion | Evidence |
|-----------|----------|
| JSONC stripping preserves `op://` inside strings; strips line/block comments + trailing commas | `[unit]` `src/deploy/opEnvFill.test.ts::stripJsonc::preserves op:// (with its //) inside string values`, `::strips line comments outside strings but not the op:// inside them`, `::strips block comments and trailing commas` |
| Config parses (with comments); rejects malformed JSON + non-string refs | `[unit]` `::parseConfig::parses a JSONC config with comments`, `::throws on malformed JSON`, `::throws when a ref is not a string` |
| `op://` refs parse to vault/item/field; malformed refs rejected | `[unit]` `::parseOpRef::splits vault/item/field`, `::folds a trailing section path into field`, `::rejects a non-op ref and a too-short ref` |
| CLI parsing: env + repeatable/`both` target, dry-run default, prod override flag; requires env+target; rejects unknowns | `[unit]` `::parseArgs::parses --env, repeated --target, and defaults to dry-run`, `::--target both expands to both targets`, `::--apply and --i-understand-prod set their flags`, `::requires --env and --target`, `::rejects unknown targets and unknown args` |
| Prod hard-guard: prod without override → refuses; with override → proceeds | `[unit]` `::buildPlan — prod hard-guard + env isolation::refuses prod without the override`, `::proceeds to prod only with the override` |
| Env isolation: a UAT run reads only UAT refs, never prod | `[unit]` `::buildPlan — prod hard-guard + env isolation::a uat run only reads uat refs, never prod` |
| Unknown environment rejected | `[unit]` `::buildPlan — prod hard-guard + env isolation::throws on an unknown environment` |
| Dry-run prints NAMES/refs, resolves nothing, calls neither op-read nor wrangler | `[unit]` `::runFill — dry-run::prints names + refs, and calls neither op-read nor wrangler` |
| Apply resolves + sets each secret once, value only on stdin, correct per-target Worker dir, never logs the value | `[unit]` `::runFill — apply::resolves + sets each secret once, value only on stdin, and never logs the value` |
| Missing `OP_SERVICE_ACCOUNT_TOKEN` fails closed — no op-read, no wrangler | `[unit]` `::runFill — apply::fails closed when OP_SERVICE_ACCOUNT_TOKEN is missing — no op-read, no wrangler` |
| Prod apply still refused without override, before any op-read | `[unit]` `::runFill — apply::prod apply is still refused without the override, before any op-read` |
| End-to-end: real `op read` + `wrangler` fill of the UAT Workers from a read-only UAT-scoped token | `[gap]` — needs an owner-provisioned read-only UAT service account + filled `deploy/op-env.jsonc`; run `deploy/op-env-fill.sh --env uat --target both --apply` and confirm each `wrangler secret put` succeeds. No `op`/service account available in the build environment. |
