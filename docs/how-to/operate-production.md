# Operate production

Deploy outside a release, change the config, read the span log, or probe the model proxy without breaking a run in flight.

**You need:**

- The operator directory `init --cloudflare … --zone …` wrote ([Deploy](deploy.md)), or `SWITCHBOARD_DEPLOY_PROFILE` naming the profile.
- `CLOUDFLARE_API_TOKEN` for the profile's account; no `CLOUDFLARE_ACCOUNT_ID` in the shell.
- For `deploy restart`, the span log and the model-proxy probe, an ingress bearer whose subject holds `deploy:write` or `trace:read`.

## Read what is running

```bash
npx @coreplane/switchboard deploy plan --affected
```

Nothing runs: it prints which Workers are stale, why, and each preflight. `GET /healthz` on the bot is public: `build.commit`, `inFlight`, `draining`, `startedAt`.

## Deploy outside a release

```bash
npx @coreplane/switchboard deploy all --affected
```

`deploy all` is the only runner: memory, bot, resident, sandbox, never the four by hand. A refusing preflight is retried every 60 s (`--wait-max` minutes), then the deploy fails by name — it never rolls over what refused; re-run it once the runs finish (`gh run rerun RUN_ID --failed` for a CI job). `--force` bypasses the preflight and kills the runs in flight that no resume recovers. A newer release cut while an older run's re-run is pending supersedes it — cancel the older run; if it runs anyway, `deploy all` refuses a Worker whose live `/healthz` commit already contains the commit being deployed (`refused: … this release is superseded — re-run nothing, the newer release carries it`), and only `--force` / `SWITCHBOARD_DEPLOY_FORCE=1` deploys over it, as a deliberate rollback.

| Preflight | Refuses while |
|---|---|
| bot | the bot has runs in flight, or the container is mid-rollout |
| resident | any resident has work in flight (needs `RESIDENT_READ_TOKEN`); with `RESIDENT_DRAIN_TOKEN` the step first drains the fleet — new runs wait at their attach, the runs in flight finish — and waits up to 60 min for them instead of 30 min for a quiet minute |

## Change the config without a release

```bash
npx @coreplane/switchboard deploy config     # from the profile's configSource, or --source <path|github://…|op://…>
npx @coreplane/switchboard deploy restart    # the running container keeps the config it started with
```

`deploy config` refuses an unreadable source, an invalid config, or a missing `MEMORY_TOKEN`. Secrets are the same two steps: [Rotate a secret](rotate-a-secret.md).

## Read the bot's span log

The bot keeps every span end in a ring (20 000 lines or 8 MiB) that empties with the container, so read before you deploy.

```bash
# the last 50 GitHub calls; `span` is a name or a family, `limit` 500 by default and 5 000 at most, `since` epoch ms
curl -sS -H "authorization: Bearer $SWITCHBOARD_INGRESS_TOKEN" \
  "$SWITCHBOARD_BASE_URL/admin/trace/log?span=github&limit=50"
# everything one run did, from its run_meta.traceId
curl -sS -H "authorization: Bearer $SWITCHBOARD_INGRESS_TOKEN" \
  "$SWITCHBOARD_BASE_URL/admin/trace/log?traceId=<32 hex>&limit=5000"
```

## Probe the model proxy

The bot proxies model calls for its runs ([Model proxy](../reference/specs/model-proxy.md)): a run's bearer, presented as the API key on `POST /v1/messages` (Anthropic-shaped) or `POST /v1/chat/completions` (OpenAI-shaped), buys a call pinned to that run's model and caps, metered on its run page. To prove the path against a real run, mint a probe bearer for one that is live — it spends the run's own turns and dies with it — then make one small call.

```bash
# a live run's id: the card's Live run link, or `runs list`
curl -sS -X POST -H "authorization: Bearer $SWITCHBOARD_INGRESS_TOKEN" -H 'content-type: application/json' \
  -d '{"runId":"<run id>"}' "$SWITCHBOARD_BASE_URL/admin/model-proxy/bearer"
# → 201 {"ok":true,"bearer":"sbr_<run id>.…","expiresAt":…,"model":"anthropic/…","path":"/v1/messages","turns":{"used":3,"max":60}}
curl -sS -N -X POST -H "x-api-key: $BEARER" -H 'content-type: application/json' \
  -d '{"model":"ignored","max_tokens":1,"stream":true,"messages":[{"role":"user","content":"Say OK."}]}' \
  "$SWITCHBOARD_BASE_URL/v1/messages"
# → the provider's event stream; the run page shows one more model turn with its token counts
```

`401` without the header, `403 revoked` once the run has ended, `403 turn_budget_exhausted` past the run's turn guard (six turns a minute over the preset's wall clock). The OpenAI shape takes the bearer as `authorization: Bearer …`. The bot's log carries `[model-proxy] run=… turn=…` and never a body.

## Recover a resident whose container never answers

Every command against one resident fails after exactly 30 s, `/debug info` says `degraded` with `runtime-unreachable: …` and `runtimeUnreachable.count` climbs: the container's control port is not answering the SDK. The resident escalates on its own ([Resident repo environments](../reference/specs/resident-repos.md) item 64) — two short retries, a stop, a destroy and restore from the snapshot, then `down` and the watchdog's rebuild — about twenty minutes to `down`. To move faster, take rung 3 yourself:

```bash
H=(-H "authorization: Bearer $RESIDENT_ADMIN_TOKEN" -H 'content-type: application/json')
curl -sS "${H[@]}" -d '{"op":"info","resource":"repo:acme/api"}' "$RESIDENT_BASE_URL/debug" | jq '{state, reason, runtimeUnreachable, lastRestore}'
curl -sS "${H[@]}" -d '{"op":"recreate-container","resource":"repo:acme/api"}' "$RESIDENT_BASE_URL/debug"
# → 202 {"recreated":true,"restoreStartedAt":"…"}: the VM is destroyed, every snapshot kept, the restore starts
# poll info until state is warm and lastRestore.at is after restoreStartedAt — minutes, not the half-hour rebuild
```

`409 recreate-refused` names why (mid-flight: wait; `down`: rebuild). If the recreated container does not answer either, `POST /rebuild {"resource":…}` reprovisions from the code host on a fresh container. The reset of last resort is `POST /offboard` then `POST /onboard` with the same body the repository was onboarded with: the only path that destroys the VM and forgets every stored fact, the SDK's included. `stop-container` is not a recovery here — it sends a SIGTERM a wedged runtime ignores.

## For this installation

The project's own production, not Switchboard:

- Deploys run from CI, which refuses any ref but `main`: `gh workflow run deploy-production.yml --ref main -f targets=affected` (also `-f targets=bot,resident`; `-f force=true` bypasses the preflights).
- The profile and config live in a private repository named by the variable `SWITCHBOARD_DEPLOY_PROFILE`, read with an App token minted as `CONFIG_REPO_TOKEN`.
- CI holds `CLOUDFLARE_DEPLOY_TOKEN`, `RESIDENT_READ_TOKEN`, `RESIDENT_DRAIN_TOKEN` (drain and undrain only; the resident step drains the fleet with it; without it the step waits for a quiet minute and says so) and `SANDBOX_TOKEN`; the docs deploy uses `CLOUDFLARE_API_TOKEN`.

## Next

- [Deploy](deploy.md)
- [Rotate a secret](rotate-a-secret.md)
- [Release and deploy](../reference/specs/release-and-deploy.md), [Tracing](../reference/specs/tracing.md)
