# Operate production

## A/B testing thread replies

Compare the configured fast model with Jev using a stable split of threads.
Only the selected model runs. The existing durable records hold latency,
usage, estimated cost, decisions and failures for each arm.
Newly inserted measured receipts also emit reply telemetry to the existing
Analytics Engine dataset, including decisions that stay silent. The telemetry
report can read a multi-day observation without keeping a local client open.
[Configuration and report commands](../reference/specs/load-harness.md#short-production-ab-run)
cover a short trial and rollback. Review a few messages from each arm as well
as the numbers; response rate alone does not measure correctness.

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

This deploy updates the existing container application; no application deletion is part of rollback. With a CLI containing the current gate, success requires the selected release image, a running singleton on the direct application's version, and ready non-draining `/healthz.build.commit` equal to the prior package's full commit. Version numbers need not increase. The runner reads the raw application list used by Wrangler deploy, rather than the dashboard-backed CLI list. It refuses before Worker upload when the selected registry image matches that list but differs from the direct application's image, even with `--force`: Wrangler would omit the required image change. Different native versions alone do not block a fresh image. The direct application, singleton version and exact health still decide completion. A pinned older CLI retains its older implementation and does not acquire this fix. A retained target or a different/short commit fails the bot step by name.

When deployment credentials live in CI, dispatch the same runner from `main` with the pinned package and only the bot selected:

```bash
gh workflow run deploy-production.yml --ref main -f cli=package -f version=<prior-version> -f targets=bot -f force=true -f copy-images=never
```

Confirm the run selects the exact prior CLI and only the bot, then verify the same application and health receipts. Package mode skips the checkout's candidate and ingress smoke scripts: a green deployment is not functional acceptance. Follow it with a read-only request through an authorized ingress client and require a completed agent answer.

Before cutover, inspect unfinished effects and protected workspace ownership against the prior runtime; unknown compatibility blocks replay. Afterward, verify the memory build and resident ownership/fences remain unchanged. The state database and protected resident workspaces retain their current state; a runtime rollback does not establish that newer durable obligations can be replayed by older code.

`deploy images` only copies registry inventory. A Worker-version rollback with `wrangler rollback` changes only the Worker deployment, and `deploy restart` restarts the image selected by the container application's current target. None of those operations is a container-image rollback, alone or in combination; after them a newer application target remains newer.

## Consumer-owned configuration

New state-backed images choose `base-<full-build-commit>` from the protected build artifact inside the image. Worker desired-image variables and health display overrides do not choose that slot. Legacy images retain their existing `base` document throughout a rollout; a missing or foreign new slot refuses instead of falling back.

The publishing CLI stages the target slot before image activation. It freezes the input-source document and native application pair, preserves full input witnesses privately, and compares source and target versions in the same existing store transaction. A changed source or unknown conditional acknowledgement stops the operation. An unknown prior consumer or unproved cold application absence refuses rather than inventing bootstrap authority.

Direct config updates and restarts require the publishing parser to match the consumer actually serving its owned slot and the native application/running-container target. Final readback must prove the exact loaded slot and that the input source did not change during activation. Keep one configuration writer through cutover; independent image and config services are not atomic. A retained snapshot, matching bytes or a restart does not authorize restoration or prove original-write attribution.

## Change the config without a release

```bash
npx --yes @coreplane/switchboard@<version> deploy config     # from the profile's configSource, or --source <path|github://…|op://…>
npx --yes @coreplane/switchboard@<version> deploy restart    # the running container keeps the config it started with
```

`deploy config` refuses an unreadable source, an invalid config, or a missing `MEMORY_TOKEN`. It requires this CLI's exact parser identity to match the running consumer's installed owned-slot receipt and native application/container target. It reads that slot and publishes conditionally against the frozen version; a successor setting survives. Legacy consumers and missing or foreign owned slots refuse direct publication. A malformed acknowledgement or lost response leaves the write unknown. Read the actual owned document and application target before another operation; the runner never retries or restores config automatically.

For a release, the driver freezes a proven current source/native pair or an original input witness still bound to the unchanged native target before uploads. It stages the publishing image's own slot, comparing both source and target versions in one store transaction. Legacy `base` stays untouched, so an old-binary restart continues reading its prior document. CLI validation alone does not establish serving acceptance: after activation, verify the exact installed target slot and re-read the source. A late source write leaves cutover incomplete for the sole configuration writer to reconcile.

Before uploads or direct slot publication, the runner stores full source, prior target and candidate request witnesses in a private, immutable `deploy-base-<UUID>` document on the existing state Worker. It prints the key before send and requires a positive acknowledgement plus exact readback. A fresh client can recover the inputs after CLI exit; the snapshot grants no restoration authority. The combined snapshot must fit the state Worker's 256 KiB document limit or the operation refuses before uploads. Snapshots remain retained for the recovery owner; the runner neither replaces nor deletes them. Full candidate source, timestamp and bytes distinguish an identical-YAML successor; even a full match alone cannot attribute an unknown write to its original sender.

Cold state-backed bootstrap remains unsupported: an absent target slot at version zero permits conditional creation only after the input source and native target are proven. A readable legacy document or a missing-slot 503 carrying the image's own identity does not supply that proof. Unknown prior consumers, file/environment source observations and unproved native application absence refuse before uploads or writes. Deploying Memory first does not establish Bot bootstrap eligibility. Empty or non-Bot selections publish no config; file-mode profiles without a state Worker retain their existing path. A printed plan is a source-derived target hint, not proof of a loaded consumer slot.

Secrets are the same two steps: [Rotate a secret](rotate-a-secret.md).

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

- Checkout deploys run from CI, which refuses any ref but `main`: `gh workflow run deploy-production.yml --ref main -f targets=affected` (also `-f targets=bot,resident`; `-f force=true` bypasses the preflights).
- The profile and config live in a private repository named by the variable `SWITCHBOARD_DEPLOY_PROFILE`, read with an App token minted as `CONFIG_REPO_TOKEN`.
- CI holds `CLOUDFLARE_DEPLOY_TOKEN`, `RESIDENT_READ_TOKEN`, `RESIDENT_DRAIN_TOKEN` (drain, deploy fence, and undrain; a normal resident upload requires it) and `SANDBOX_TOKEN`; the docs deploy uses `CLOUDFLARE_API_TOKEN`.

## Configure bounded deployment smoke

Enable `SMOKE_INGRESS_ENABLED=true` only after explicitly authorizing a disposable smoke scope. The reusable workflow and manual dispatch both accept `smoke=true`. Required smoke refuses missing setup and package mode before upload. Disabled smoke says acceptance was skipped. Upload success and Worker readiness remain separate receipts.

Provision a dedicated bearer in `SWITCHBOARD_INGRESS_TOKENS` pinned to channel `smoke`, subject `smoke`, without an email binding. Its `http:smoke` grants need `dispatch`, `agent:run:general`, `agent:run:explore`, `agent:run:review`, and repository write access limited to the disposable smoke repository. Its `mcp:smoke` grants need `runs:read` for `http:smoke` only. Do not grant `all`, merge, deployment, retained customer repositories or real-user threads. Set that channel's `boundary.maxMinutes: 7`; select its normal configured models and provider limits. The runner never creates credentials or grants.

Create a small fixture repository and a dedicated open PR there outside the runner. Give `SMOKE.md` the single line `smoke fixture`. Configure repository secret `SMOKE_INGRESS_TOKEN`, variable `SMOKE_INGRESS_ORIGIN` (bare HTTPS bot origin) and variable `SMOKE_INGRESS_CONFIG`:

```json
{
  "disposable": true,
  "channel": "smoke",
  "subject": "smoke",
  "repo": "your-org/disposable-smoke",
  "workspace": { "path": "SMOKE.md", "answer": "smoke fixture" },
  "review": { "number": 1, "head": "0123456789abcdef0123456789abcdef01234567" },
  "maxObservedUsd": 1
}
```

Replace the example PR/head with the fixture's exact current head. Reviews publish to that PR, so this is write-capable setup. Keep the fixture small enough for a short review; maintain it explicitly, without automatic reset/cleanup.

`npm run smoke:ingress -- <full-deploy-plan.json> <receipt.json> --check` validates configuration without network or model calls. Execution requires a fresh `SMOKE_INGRESS_THREAD` prefix; CI supplies its run/retry prefix. Keep receipts outside the checkout. `SMOKE_EXPECTED_COMMIT` requires a selected bot's exact release commit; a scoped deployment that leaves the bot unchanged records the bot's actual served commit instead. The adapter's immediate response supplies its own serving build. The runner saves that run ID before polling its original final facts; it never resubmits a lost request.

Three runs cover the shared capability families: ordinary answer; workspace read; exact-head review publication. Each request uses the existing minimum run budget: currently four minutes for General/Explore and seven for Review. HTTP deadlines are one minute longer; MCP reads are bounded to thirty seconds. `maxObservedUsd` stops subsequent runs after priced run cost is observed; it is not a hard spending cap on the current call and excludes infrastructure and Door cost. Unknown cost or effects stop acceptance. Retain the receipt and inspect the original run before any authorized retry; the runner never cancels, cleans up or rolls back.

The JSON artifact records `capabilityOutcome`, passed/failed/incomplete/skipped scenarios, original run/actor/thread, served commit and exact review artifact. Its separate `productAcceptance` stays `incomplete` while the private route is unproven. The workflow reports upload/readiness separately. The private question → Fix it → draft-PR path remains a live gap because its attested Slack DM boundary is unavailable through HTTP/MCP. It needs a separately authorized disposable DM procedure and original unit/draft artifact receipts. Scripted CI, route probes and these three capability checks cannot prove it.

A failed initial policy checkpoint can report a bounded `/runs/state` failure
stage: `promotion-preflight`, `state-rpc`, or `acknowledgment`. The server binds
that diagnostic to the exact request bytes; a missing, malformed or foreign
diagnostic leaves the generic HTTP failure. Preserve the original uncertain
request. Neither the stage nor HTTP500 proves whether the mutation committed,
and neither permits replay. The original exception remains in the private
`state.fetch` trace for a qualified cause comparison. An archived-record refusal
and a state-write failure are separate observations until their original facts
are correlated.

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

## Confirm an MCP command

Connect through the existing browser-approved personal flow. The connection acts within your current user permissions and its configured delegated scope. A read-only token cannot borrow your admin rights.

When Switchboard holds an action, open its authenticated browser link and review the full action and target. Confirm there, then let a supporting client retry with the saved state. On older clients, call `approval_resume` with the displayed id. `approval_cancel` or the browser's Cancel button declines it. A confirmation boolean in a tool call has no authority.

The default confirmation class is `write`. A permitted `boundary.confirm: destructive` scope allows authorized routine writes without repeated clicks; destructive actions still need confirmation. CLI operator and named schedule scopes retain their existing standing authority through the same gate. Unsupported surfaces refuse before effects.

An expired, cancelled or consumed id cannot execute again. If a result was lost, inspect the original run history before asking for a new action. A deployed build and a finished request alone do not prove its effect.

For rollout, deploy the state Worker approval routes before the bot. The routes extend the existing confirmation table and keep older saved rows readable. Missing support refuses before an action runs.
