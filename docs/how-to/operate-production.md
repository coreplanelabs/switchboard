# Operate production

Deploy outside a release, change the config, read the span log, or probe the model proxy without breaking a run in flight.

**You need:**

- The operator directory `init --cloudflare … --zone …` wrote ([Deploy](deploy.md)), or `SWITCHBOARD_DEPLOY_PROFILE` naming the profile.
- `CLOUDFLARE_API_TOKEN` for the profile's account; no `CLOUDFLARE_ACCOUNT_ID` in the shell.
- For `deploy restart`, the span log and the model-proxy probe, an ingress bearer whose subject holds `deploy:write` or `trace:read`.

Run the commands below from the operator directory with the released CLI version you operate. If the profile is elsewhere, name it with `SWITCHBOARD_DEPLOY_PROFILE`.

## Read what is running

```bash
npx --yes @coreplane/switchboard@<version> deploy plan --affected
```

Nothing runs: it prints which Workers are stale, why, and each preflight. `GET /healthz` on the bot is public: `build.commit`, `inFlight`, `draining`, `startedAt`.

## Deploy outside a release

```bash
npx --yes @coreplane/switchboard@<version> deploy all --affected
```

`deploy all` is the only runner: memory, bot, resident, sandbox, never the four by hand. A refusing preflight is retried every 60 s (`--wait-max` minutes), then the deploy fails by name — it never rolls over what refused; re-run it once it clears (`gh run rerun RUN_ID --failed` for a CI job). In-flight bot runs never refuse: they hand off to the next container. `--force` bypasses the preflight. A newer release cut while an older run's re-run is pending supersedes it — cancel the older run; if it runs anyway, `deploy all` refuses a Worker whose live `/healthz` commit already contains the commit being deployed (`refused: … this release is superseded — re-run nothing, the newer release carries it`), and only `--force` / `SWITCHBOARD_DEPLOY_FORCE=1` deploys over it, as a deliberate rollback.

| Preflight | Refuses while |
|---|---|
| bot | the container is mid-rollout |
| resident | `RESIDENT_DRAIN_TOKEN` drains the fleet, fences registered reattach, and checks actual run ownership before upload; an executing or unverified owner refuses, while a terminal registration stays protected. The post-deploy readiness gate uses `RESIDENT_READ_TOKEN`. |

## Hold one release for a scoped deploy

When a selected Worker has a protected owner, set the repository variable `SWITCHBOARD_RELEASE_DEPLOY_SKIP_TAG` to the pending exact tag (for example, `v1.284.0`) before merging its release PR. The release and images still publish; only that tag's automatic `affected` deploy is skipped. Confirm the tag and image jobs succeeded and the automatic deploy job was skipped, then remove the variable so it cannot affect a later release.

With `main` still at the release commit, dispatch the existing production workflow with only the safe targets:

```bash
gh workflow run deploy-production.yml --ref main -f targets=memory,bot -f copy-images=never
```

`copy-images=never` skips the blanket registry warm-up; `deploy all` still copies any missing image for the selected Workers. Check the run's head is that release commit, its frozen plan selects only memory and bot, and its live receipt shows the bot on the exact commit. The memory step has no container live gate; read its `/healthz` build and run a separate functional check. A protected resident remains for a later deployment after its owner and fence are reconciled. Do not rerun the skipped `affected` deployment while that protection remains.

## Roll back the bot image

Run the prior release's full bot deploy from the operator directory. Pin the released CLI; `--force` is the deliberate override for the supersede guard.

```bash
npx --yes <package>@<prior-version> deploy all --only bot --force
```

This deploy updates the existing container application; no application deletion is part of rollback. Success requires all three facts: the application version advanced, its target is the prior release's image, and `/healthz.build.commit` is the prior package's exact commit. A retained target or a different/short commit fails the bot step by name.

`deploy images` only copies registry inventory. A Worker-version rollback with `wrangler rollback` changes only the Worker deployment, and `deploy restart` restarts the image selected by the container application's current target. None of those operations is a container-image rollback, alone or in combination; after them a newer application target remains newer.

## Change the config without a release

```bash
npx --yes @coreplane/switchboard@<version> deploy config     # from the profile's configSource, or --source <path|github://…|op://…>
npx --yes @coreplane/switchboard@<version> deploy restart    # the running container keeps the config it started with
```

`deploy config` refuses an unreadable source, an invalid config, or a missing `MEMORY_TOKEN`. Secrets are the same two steps: [Rotate a secret](rotate-a-secret.md).

## Read the bot's span log

For an invalid dependency view on a retained resident, the admin-only `POST /debug` operation `inspect-dependencies` takes `resource` and an `input` containing the exact `threadKey`, `ref` and forty-character `head`. It checks the original terminal owner and fence on the existing running container. It returns `result.kind` as `ready`, `invalid` or `unknown`; an invalid result names a fixed reason and, where applicable, the package and executable. A completed observation also includes the retained owner identity. It never wakes, reattaches, installs or repairs the workspace. Unknown ownership, active processes, changed heads or incomplete output remain unknown. Use the failure to scope an owner-preserving repair; an inspection is not a repair receipt.

The bot keeps every span end in a ring (20 000 lines or 8 MiB) that empties with the container, so read before you deploy.

```bash
# the last 50 GitHub calls; `span` is a name or a family, `limit` 500 by default and 5 000 at most, `since` epoch ms
curl -sS -H "authorization: Bearer $SWITCHBOARD_INGRESS_TOKEN" \
  "$SWITCHBOARD_BASE_URL/admin/trace/log?span=github&limit=50"
# everything one run did, from its run_meta.traceId
curl -sS -H "authorization: Bearer $SWITCHBOARD_INGRESS_TOKEN" \
  "$SWITCHBOARD_BASE_URL/admin/trace/log?traceId=<32 hex>&limit=5000"
```

For a slow `/runs/abandon`, search the memory Worker's logs for `[runs/abandon] <runId>`.
It records the number of log pin updates and their total time. Each
`[range-pins]` start names a log object's Cloudflare ID, without printing
the conversation key or transcript. A missing completion in that request's trace
identifies a stalled RPC; `slow` and `failed` lines include its elapsed time.

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

## Bring existing residents onto the pool-user generation fence

A resident created before durable pool-user spends has no generation ledger. The newer Worker refuses another thread or operation on that resident with `pool-generation-unknown` until its container is confirmed destroyed and a fresh generation is recorded. A Worker deploy or a `warm` status alone does not do this. Keep its existing work held while the ledger is unknown.

After the containing release is verified live, an authorized operator handles each repository separately. Read `/debug info` and the fleet's active runs first: `inFlight` and `runsInFlight` must be zero, no refresh or restore may be in progress, and the resident must be settled (`warm` or `degraded`). Use the admin `recreate-container` operation above only in that idle window. A `409` or uncertain destroy leaves the repository held; do not retry through another credential or bypass the refusal. Its `202` response confirms the checked destroy and starts restoration, but does not prove restoration completed.

Poll `/debug info` until `state` is `warm`, `lastRestore.at` is later than the response's `restoreStartedAt`, `imageReport` is `current`, `recreateAdmissionHeld` is false, and `poolUsersSpent` is a number. Independently confirm the expected image and a fresh physical placement, with the previous disk and processes gone. Record these facts for **each** resident before admitting new work there. A missing ledger, stale image, active run, failed restore, or uncertain placement keeps only that repository held; a successful check on one resident does not clear the others.

`poolUsersSpent` counts historical UID claims on this VM, not active work. The read-scoped resident status also lists `poolUserSpends` as `{user, owner}` rows, where owners begin with `thread:` or `op:`. A detached thread may reclaim its own UID after a clean disk inspection; a different thread or a new disposable operation cannot. When all UIDs are spent, the next attach or operation may recycle the VM itself only if it is warm, current, undrained, and has no other active work or live binding. The checked destroy keeps snapshots and restores before that request proceeds. A `pool-recycle-required` refusal means the idle proof did not pass; inspect the live rows and use the operator procedure above once the resident is idle. Never clear the spend ledger by hand.

Before a resident Worker upload, `deploy all` drains new runs and the preflight asks the live Worker to fence registered reattach. Under that fence it reads executing runs separately from protected terminal workspaces. An active or unknown owner, missing fence, or provisioning resident refuses the upload. A refusal releases only the reattach fence; the drain remains until the runner lifts it or it expires. A Worker that predates `/deploy-fence` refuses safely, so its first upgrade needs a separately reviewed bootstrap procedure. After an upload that passes preflight, `deploy all` reads the named Containers application before and after the upload. An unchanged version and image, no printed container change, and current reports for every resident complete a Worker-only step without cycling containers. A changed application uses the guarded image reconcile. An unreadable pre-upload application refuses the upload; an unreadable post-upload application or an older pending image report leaves it partial and the fleet held.

### Capture a retained resident tree for a reviewed rehearsal

`npm run resident:archive` is a source-checkout operator harness for the **old** resident `/exec` route. It does not attach, detach, drain, deploy, or change a registration. Run it first on an isolated disposable resident with a verified Worker build and Container image. Its `capture` mode still calls `/exec`, which updates `lastAttachAt` and requires a valid Git Door run bearer for a writable binding. A separate reviewed ingress and Workflow freeze must allow only this maintenance caller during capture, then close it and prove zero admitted operations before any Worker upload. The harness does not establish that freeze or a Container image identity.

Set `RESIDENT_READ_TOKEN`, `RESIDENT_OPERATOR_TOKEN`, and, for a writable Git Door binding, `GH_HOST` and `GH_ENTERPRISE_TOKEN` in the operator process. No credential is accepted as a command argument. Use the exact binding fields from the read-scoped `threads` view:

```bash
npm run resident:archive -- capture --url https://resident.example.com/ --resource repo:example/project --thread-key mcp:default:disposable --ref codex/disposable --sha <40-character-commit> --user worker2 --bound-at <binding-timestamp> --build <40-character-worker-commit> --out /secure/new-archive
npm run resident:archive -- restore --archive /secure/new-archive --out /secure/new-restore
```

The output archive directory must not exist. Capture records `.git`, tracked, untracked and ignored files, empty directories, modes and symlink targets through bounded `/exec` responses (60 KiB raw chunks, below the old route's 100,000-character output cap). It writes `receipt.json` **last**, after exact binding and VM boot ID readbacks and a second full source manifest. A partial directory without that receipt is not an archive. The offline `restore` command needs no network or credentials; it refuses an unsafe path, missing or extra blob, or any changed byte and compares a fresh scan of the reconstructed tree with the source manifest. The result is evidence for the currently bound tree only; the historical run's owner/fence, production ingress coverage, and live first-install safety require separate receipts.

## For this installation

The project's own production, not Switchboard:

- Deploys run from CI, which refuses any ref but `main`: `gh workflow run deploy-production.yml --ref main -f targets=affected` (also `-f targets=bot,resident`; `-f force=true` bypasses the preflights).
- The profile and config live in a private repository named by the variable `SWITCHBOARD_DEPLOY_PROFILE`, read with an App token minted as `CONFIG_REPO_TOKEN`.
- CI holds `CLOUDFLARE_DEPLOY_TOKEN`, `RESIDENT_READ_TOKEN`, `RESIDENT_DRAIN_TOKEN` (drain, deploy fence, and undrain; a normal resident upload requires it) and `SANDBOX_TOKEN`; the docs deploy uses `CLOUDFLARE_API_TOKEN`.

## Findings work after a pull request merges

A findings run can finish after its pull request merges or closes. Switchboard
names that terminal state in its short report; verbose output also lists the
run's recorded commit, missing results and follow-up guidance. It does not
restart findings on that pull request. A local commit or attempted push alone
does not prove that the fixes reached the merge. Carry any
remaining fixes into an authorized follow-up pull request from the current base.
An open pull request still requires every findings result and an independently
verified exact head before review resumes.

## Next

- [Deploy](deploy.md)
- [Rotate a secret](rotate-a-secret.md)
- [Release and deploy](../reference/specs/release-and-deploy.md), [Tracing](../reference/specs/tracing.md)

## Inspect a live run's credential boundary

An operator with `credentials:exec` and visibility of the run can use `credentials inspect <run-id> --backend resident --repo owner/repo --ref branch --head <40-character-sha>` through the service's existing command interface. Select the actual backend (`resident` or `sandbox`) and exact live checkout first. The command never starts a run, mints a credential, or publishes a branch. The resident Worker validates the count receipt before transport and compares the process against its recorded launch identity. Older live runs without that identity remain incomplete. A standalone CLI process has no live harness registry and returns an incomplete inspection.

The result contains counts and booleans only. `completed: true` means the bounded observation finished with a stable process and checkout; check `appTokenMatches` separately. `completed: false` or `unknownCount > 0` leaves the evidence incomplete. The probe reads both process environments, known credential-file locations, and Git helper configuration. It never executes a helper. The current cold executor refuses in the trusted bot before any remote command because its root model could replace the inspector. Unknown helper configuration on a supported runtime also leaves the inspection incomplete. These counts do not prove whole-container absence, helper execution, revoked-bearer refusal, or publication. Keep those receipts separate.
