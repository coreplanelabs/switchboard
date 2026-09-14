---
title: Run artifacts move by reference through one private R2 bucket — containers and the bot's Worker move the bytes over URLs the bot signs, in both directions, and the run record keeps the key
status: proposed
date: 2026-09-14
pattern: Presigned-URL upload (a browser writing to S3 while the app server only signs), applied to both directions of a run, with the run record as catalogue and access list
---

# Run artifacts move by reference through one private R2 bucket — containers and the bot's Worker move the bytes over URLs the bot signs, in both directions, and the run record keeps the key

**The ask.** Decide (the owner, before the next attachment work starts): adopt an **artifact store** on Cloudflare R2 as the transport for every file a run receives or produces, in place of base64 inside the Workers' JSON, keeping the inline path only for deployments with no bucket. Written for an engineer who knows the channel and executor seams and has not read the `attach_file` pull requests. The frame is the owner's words: "we should be able to attach large files like 1 GB", "for upload and return", "we use Cloudflare".

Success criteria the decision is judged against:

1. A coding run attaches a 1 GB file to its Slack thread intact, and the bot process and the Durable Objects hold no more of it than they hold of a 1 KB file.
2. A person drops a 300 MB video on a thread, as a new request or mid-run, and the run finds it as a file in its workspace so `ffmpeg` can read it.
3. Every artifact a run produced or received is on the run page for as long as the bucket keeps it, whatever Slack does with its copy.
4. No bot credential ever enters a container, and the bucket is never public.
5. A deployment without a bucket behaves exactly as today.

## TL;DR

An attached file rides today as base64 through the Workers' JSON and the bot's memory, which is why the cap is 10 MiB and why the resident silently cut a 12 MB file at 1.7 MB until this week's fix; an inbound video is dropped with its name. The bet is that the bot should sign and catalogue but never carry: the container PUTs a produced file to R2 and POSTs it to Slack's one-shot upload URL itself, the bot's own Worker streams an inbound Slack file into R2, and the container pulls it into `attachments/` before the turn that carries it. The ceiling becomes Slack's 1 GB. It costs a bucket and a bucket-scoped S3 token as bot secrets, a signer dependency, one Worker route, a staging step and a proxy route. Open: the per-thread budget and the retention window.

## Today at `abc0796b`

The delta from what a veteran expects, each with its proof; the full survey is in the appendix.

1. **No file ever reaches a workspace.** Inbound Slack files become model content or are dropped: images up to 5 MiB, ten per message; PDFs and text up to 10 MiB; a video or a zip is skipped and named to the model (`src/channels/slack/attachments.ts:12-13,128,194-198`). The adapter downloads inline files before `dispatch()` runs (`src/channels/slack.ts:343,392-395`); the run id is minted later, in provisioning, after admission (`src/core/dispatch/provision.ts:325,355`). A file dropped on a live thread is a follow-up merged into a turn, with no provisioning step (`src/core/dispatch/admission.ts:92-93`).
2. **Outbound bytes cross two JSON hops.** `attach_file` reads through `Executor.readBytes`: the Worker answers base64 over `/read`, the bot decodes into memory, then `files.uploadV2` with a Buffer (`src/execution/binaryRead.ts:14`, `src/channels/slack.ts:495-504`). The cap is 10 MiB, and the resident reads in 1 MiB chunks because the sandbox SDK cuts one command's stdout near 2.3 MB.
3. **The bot is small and the DO smaller.** The bot container is `instance_type: "basic"` (1 GiB, one instance; `deploy/cloudflare/wrangler.template.jsonc:50-51`); the resident's Durable Object is a 128 MB isolate, the reason its snapshot transfers already moved to presigned R2 URLs (`deploy/cloudflare-resident/wrangler.template.jsonc:101-108`).
4. **R2 and presigning exist, but not for the bot.** The resident holds an R2 S3 token scoped to its cache bucket only (`deploy/secrets.manifest.json:67-77`); nothing in `src/` signs SigV4.
5. **The run page cannot show a picture from elsewhere.** Its CSP is `img-src 'self' data:` (`src/channels/webShell.ts:19`), the timeline has no artifact item, and live runs are viewed by token while finished runs authorize per actor (`src/channels/liveView.ts:203-208,262-263`).

## The shape

An **artifact** is a file a run received or produced, named by a **key** in one private R2 bucket. The **store** is a seam in the bot (`ArtifactStore`: presign PUT, presign GET, head, copy-from-URL) with two implementations, R2 and in-memory. Three parties move bytes and none is the bot process: the **container** PUTs and pulls with `curl` as the **thread user** (the per-thread Unix account a run's commands execute as, `worker2` to `worker17` on the resident); the **bot's Worker** (`deploy/cloudflare/worker.ts`, which already fronts the bot and holds its secrets) streams an inbound Slack download into R2 through an R2 binding; **Slack** takes its own copy of a produced file through its external-upload API so the picture renders inline. The bot signs URLs, completes uploads, and writes one `artifact` event per file to the **run record**, key and size only. The record is also the access list: the run page fetches an artifact through an authenticated same-origin proxy that serves only keys the run's events name.

The closest known shape is a browser uploading to S3 with a presigned URL while the application server only signs and records; the one difference is that both ends are ours, so the same store bridges the inbound direction and the record is where both directions meet.

## One trace: a 312 MB video dropped on a live run, a 3 MB contact sheet back

1. A coding run is mid-flight on an onboarded repo when the person replies in the thread with `clip.mp4` (312,441,600 bytes, `video/mp4`) and "what happens in this clip?". The adapter classifies it **staged**: not an image or document the model can see inline, under Slack's 1 GB. No byte moves; the follow-up carries `{ name, size, type, url_private }`.
2. Admission attaches the follow-up to the live run as a text reply would. Before merging the turn, the run loop asks the store to copy: the bot calls its Worker's `POST /artifacts/copy { url, size, key }` with the internal bearer, key `threads/slack-CX-1.0/in/1789365838.340499/clip.mp4`; the Worker fetches `url_private` with the Slack token from its own env and pipes the body into `env.ARTIFACTS.put(key, body)` as a `FixedLengthStream(312441600)`. Nothing is held in the bot.
3. The bot writes `artifact { direction: "in", key, name, size, contentType }` on the run.
4. The run loop runs one executor command as the thread user: `mkdir -p attachments && curl -fsS -o attachments/clip.mp4 "<presigned GET>"`, the URL minted now with a 10-minute window in which the request must start (the signature is checked at request start, not for the transfer's duration), the command under the 20-minute budget; on the resident it also appends `attachments/` to `.git/info/exclude`. At 20 MB/s the pull takes 16 s.
5. The turn gains one line the model reads: `Attached files are in ./attachments/: clip.mp4 (312 MB, video/mp4)`. The model runs `ffmpeg -i attachments/clip.mp4 -vf fps=1/10 frames_%03d.png` and tiles them into `sheet.png` (3,145,728 bytes).
6. The model calls `attach_file sheet.png`. The tool measures the file with `stat -c %s` through `exec`, asks the store for a presigned PUT on `runs/<runId>/out/sheet.png`, and asks the channel for an **upload ticket**: Slack's `files.getUploadURLExternal(filename, length)` answers `upload_url` and `file_id`.
7. The tool runs, as the thread user, `curl -fsS -T sheet.png "<presigned PUT>"` then `curl -fsS --data-binary @sheet.png "<upload_url>"`. Neither URL carries a credential: the PUT is a signature over one key, the upload URL is Slack's one-shot ticket for one file id.
8. The bot `HEAD`s the key: 3,145,728 bytes, the size the tool stated. It writes `artifact { direction: "out", … }` now, because the durable copy exists, then calls `files.completeUploadExternal({ files: [{ id, title }], channel_id, thread_ts, initial_comment })` and the picture renders inline. If the bot dies between the two, the record has the artifact and Slack discards an orphan.
9. Months later Slack's copy is hidden by the workspace's plan. The run page still lists `sheet.png` and loads it from `/runs/<id>/artifacts/<key>` on the bot, which checks the key is in the run's events, authorizes the viewer, mints a signed GET for that request and streams the object.

The property this proves: no run artifact is ever held whole by the bot process or a Durable Object, no bot credential leaves the bot and its Worker, a refused or workspace-less request never pays for a copy, and the file exists in our bucket after the channel forgets it.

## The difficulty map

1. **Staging inbound files: the copy after admission, the pull before the turn, for new runs and follow-ups** — [Staging](#staging-a-received-file-into-the-workspace). Most likely to be wrong, and the most work.
2. **The outbound hand-off: the container holds two URLs and the bot completes on evidence** — [Delivery](#delivering-a-produced-file).
3. **Signing, secrets and keeping the bucket private while the run page shows pictures** — [Signing and privacy](#signing-and-privacy).

## Staging a received file into the workspace

The constraint is order and ownership. A Slack file arrives with the message; whether a run exists, whether it has a workspace and whether the request is admitted are decided later; and only the bot side holds the Slack token that `url_private` requires. Today the adapter downloads inline files before any of that is known, which is fine for 5 MiB and impossible for 1 GB.

The design classifies early, copies late and pulls just in time. **Classify** in the adapter, metadata only: each Slack file is `inline` (today's images and documents, unchanged), `staged` (anything else under Slack's 1 GB, and any image or document over its inline cap) or `skipped` (over the ceiling, or the secret denylist). A staged file travels as `{ name, size, type, url_private }` on `IncomingMessage` and `DispatchFollowUp` beside `images`, and through the durable inbox as the same small reference, so its byte cap never applies.

**Copy** after admission and authorization, when the dispatcher knows the target: a new run (between run creation and provisioning), a live run's follow-up (before the turn is merged), or a preset with no workspace (`general`, `research`, `conductor`), in which case nothing is copied and the turn says "this agent has no workspace for `clip.mp4`; ask `agent:coding`". The bot calls `POST /artifacts/copy` on its own Worker, which fetches `url_private` with the Slack token it already holds and pipes the body into the `ARTIFACTS` binding as a fixed-length stream; Workers stream bodies without buffering and a pipe costs no CPU time, so a 1 GB copy is a wall-clock wait on Slack's egress, whose rate is unmeasured and is the first probe. The key is `threads/<threadKey>/in/<messageTs>/<basename>`, all of which exist when the file arrives; `<basename>` is the Slack filename reduced to a safe basename with no separators or `..`.

**Pull** before the turn that carries the file: one executor command per staged file, `mkdir -p attachments && curl -fsS -o attachments/<basename> "<presigned GET>"`, the URL minted at that moment, the command under the 20-minute budget, so a 1 GB pull needs 0.9 MB/s. On the resident the same command appends `attachments/` to `.git/info/exclude`; the cleanliness check that decides whether a released worktree is kept is `git status --porcelain`, which honours it (`src/execution/residentCleanliness.ts:45`). The turn's text gains one line per file naming its path and size, injected after the pull so a failure is named with its reason.

Invariants: a staged file is on disk in the workspace before the turn that carries it, or that turn names the file and the reason; no copy happens before admission and authorization succeed; a preset without a workspace copies nothing; the staged total per message is at most `artifacts.inbound.maxBytesPerMessage` (2 GiB, revisable) and ten files; the Slack token appears in no executor command; a presigned GET is minted at pull time and names one key.

Failure modes. Slack answers an HTML login page at 200 for an unauthorized `url_private` (detected by content type, as today): skipped and named. The Worker copy fails or the stream ends short: no object exists under the key, the file is skipped with the reason. The pull fails or exceeds its budget: the turn says so, and the model can ask the tool for a fresh URL and `curl` it itself, never retried blind. The resident's refresh `git clean -fdx` runs on the default checkout only, never a thread worktree, so `attachments/` persists until the sweep releases the binding, and a pull in flight is an `/exec` the sweep counts, so a release cannot remove the tree under it.

The alternative this beat: a `download_attachment` tool the model calls when it wants. It saves the staging step, but the person's intent is known when they drop a file on a request, and a model that has to ask spends a turn and sometimes forgets.

## Delivering a produced file

The constraint is trust and ordering. Slack renders a picture inline only from its own storage, so the bytes must reach Slack; the run page needs a copy that outlives Slack; the bot must not carry the file. Slack's external-upload API is built for the first: `files.getUploadURLExternal(filename, length)` answers a single-use `upload_url` and a `file_id`, the bytes go to that URL as a raw POST, and nothing is visible until `files.completeUploadExternal` names the channel and thread (scope `files:write`, already required).

The design gives the container two URLs and the bot one veto. `attach_file` measures the file with `stat -c %s` through `exec`, asks the store for a presigned PUT on `runs/<runId>/out/<basename>` and the channel for an upload ticket (`ChannelIO.uploadTicket?(name, size) → { url, complete(lead) }`), and runs two `curl` commands as the thread user: `-T` to R2, `--data-binary @` to Slack. The bot `HEAD`s the key and requires the size it was told; on a match it writes the `artifact` event, then calls `complete`. A mismatch or a missing object is the tool's string error, nothing is completed, and Slack discards the orphan.

What the container may do with the URLs: PUT any bytes to one key for ten minutes, and POST any bytes to one Slack file id. The first is the run's own artifact slot, not a credential over the bucket. The second could put a different file into the thread, which the model can already do with its final message; the `HEAD` check ties the completed size to the R2 copy.

Invariants: `complete` is called at most once per ticket and only after `HEAD` confirms the size; a ticket never completed is never visible in Slack; the `artifact` event is written before `complete` and carries no bytes; a channel without `uploadTicket` (HTTP, MCP, the CLI harness) takes the store-only path, the R2 copy plus a line with the run-page link, and with no store the inline `attachFile` up to 10 MiB as today.

Failure modes: the R2 PUT fails and the tool says so; the Slack POST fails, the R2 copy stays and is named; `complete` answers `file_not_found` because the POST never landed and the tool reports Slack's words; a file over 1 GB is refused by name before any URL is minted.

The alternative this beat: the bot streams R2 → Slack itself. The bot is a 1 GiB `basic` container with one instance serving every run, and the container already has the bytes and `curl`; Slack's upload URL is designed to be handed to the party that has the file.

## Signing and privacy

The constraint is that the bot is a container, not a Worker, so it cannot hold an R2 binding; it signs S3 requests with an API token, and that token is a secret with a blast radius. The design takes `aws4fetch` as a direct dependency (MIT, about 300 lines, already in the lockfile as the sandbox SDK's signer for the same job), creates one bucket `switchboard-artifacts` with an R2 API token scoped Object Read & Write to that bucket only, and provisions the token to the bot as `ARTIFACTS_R2_ACCESS_KEY_ID` / `ARTIFACTS_R2_SECRET_ACCESS_KEY` through the three-file secret contract (`deploy/secrets.manifest.json`, the Worker's `Env` and `FORWARDED_OPTIONAL`), read only through `processSecrets`. The bot's Worker gets the same bucket as an `ARTIFACTS` binding for the inbound copy. Account id and bucket name are config, `artifacts: { r2: { accountId, bucket } }`, documented in `config/config.example.yaml` and validated like `memory`.

Privacy is short TTLs, one route and one probe. Presigned PUT and GET URLs admit a request for 10 minutes and name one key. The run page never receives an R2 URL: it links `/runs/<id>/artifacts/<key>`, a route on the bot's web surface that serves a key only if the run's `artifact` events name it, authorizes a finished run's viewer as its reader and a live run's viewer by the live token, mints a signed GET for that request and streams the object through, so the CSP stays `img-src 'self' data:` and the bucket stays private. At startup the bot probes an unsigned GET on a known key and reports `artifacts: { bucket, private }` on `/healthz`, so a bucket made public in the dashboard is a visible fact. A leaked presigned URL exposes one object for ten minutes; a leaked token exposes the artifacts bucket, never the resident cache, never a repository.

Invariants: the bucket has no public access and no custom domain, and `/healthz` says so; every URL the bot mints for a container admits requests for at most 10 minutes; the proxy serves only keys in the run's own events; the record stores keys, never URLs.

## Why not X

**Why not have the container POST straight to Slack's upload URL and skip R2?** It fixes the ceiling alone. It leaves nothing when Slack's plan hides or deletes the file, gives the run page nothing to show, and the return direction needs a store regardless.

**Why not stream inbound through the bot, in bounded parts?** Memory would be bounded, but a 1 GB copy is a minute of TLS and pipe work on a `basic` instance's quarter vCPU while it serves every Slack event. The Worker in front of the bot streams for free and already holds the Slack token.

**Why not route every container transfer through the bot's Worker with a bot-issued single-key token, and keep S3 credentials out of the bot entirely?** It would remove one secret. It puts the Worker in the byte path of every PUT and GET, doubling the one untested premise of this design (a Worker streaming a gigabyte), and it replaces a signature scheme R2 already checks with one we write. Presigned R2 URLs from these very containers are proven at gigabyte scale by the resident's snapshot restores, so the S3 token buys the known path, scoped to one bucket.

**Why not let the model `curl` from Slack directly?** `url_private` needs the bot token in the request; the token would be in a command line and in the SDK's exec logs.

## Boundaries

The store is optional per deployment: no `artifacts:` section means today's behavior, including the 10 MiB inline `attach_file` and skipped videos. The seam has two implementations from the first unit, R2 and in-memory, so tests never need a bucket. Retention is the bucket's lifecycle rule: 30 days plus abort of incomplete multipart uploads after one day, revisable; at R2's list prices a 312 MB video kept 30 days is about half a cent of storage and R2 charges no egress. Other channels implement `uploadTicket` or fall back to the run-page link. Not in scope: transforming media, virus scanning, per-user quotas, and any change to what the model sees inline; a staged image is a file in `attachments/`, not a picture in context.

## What would change our mind

The Worker copy failing to stream a 1 GB `url_private` body into the R2 binding within the Worker's limits: tested with a 1 GB file against the deployed Worker before any code depends on it, which also measures Slack's egress rate; if it fails, the copy falls back to the bot in 8 MiB multipart parts and the inbound "why not" above is retracted. Slack's one-shot upload URL rejecting a raw `curl` POST: tested with a real ticket in the first outbound unit. Slack refusing `length` above a plan limit: a 900 MB probe on this workspace. Reversibility: the seam and the events stay; removing the bucket returns every deployment to the inline path with no migration, because artifacts are transient by contract.

## Rollout

Eight units on `main`, each active only when `artifacts:` is configured, in this order: the store seam with both implementations and the secret and config contract; the `artifact` event, timeline item and proxy route; outbound delivery; the Worker copy route with the 1 GB probe as its receipt; classification and staging for new runs and follow-ups; the CLI and HTTP fallbacks; specs and live receipts; lifecycle rules and the operator how-to. Each invariant above becomes a `file::describe::it` row or an agent procedure in the spec its unit touches; the execution ledger is the plan's job.

## Open questions

| Question | Owner | Resolved by | Needed before |
|---|---|---|---|
| Per-thread staging budget beyond the 2 GiB per message, or let retention bound it? | the owner | one line in `artifacts.inbound` | staging |
| Retention 30 days, or per deployment in config applied by `deploy`? | the owner | the lifecycle rule's home | the last unit |
| Inline-render images from the proxy on the run page, or list them as downloads first? | the owner (UI check-in rule) | a screenshot pair | the run-page unit |

## Sources

- The `attach_file` tool, the screenshot destination rule, and the resident's chunked byte read: the `tools`, `agents` and `resident` entries of releases 1.210.0 and 1.212.0 in the [changelog](../../CHANGELOG.md).
- Slack: [`files.getUploadURLExternal`](https://docs.slack.dev/reference/methods/files.getUploadURLExternal), [`files.completeUploadExternal`](https://docs.slack.dev/reference/methods/files.completeUploadExternal), [files up to 1 GB](https://slack.com/help/articles/201330736-Add-files-to-Slack). R2: [limits](https://developers.cloudflare.com/r2/platform/limits/) (single PUT 4.995 GiB), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) (1 second to 7 days), [pricing](https://developers.cloudflare.com/r2/pricing/) ($0.015 per GB-month, free egress).
- Prior art: the resident's presigned snapshot transfers ([resident-repos.md item 61](../reference/specs/resident-repos.md)).

## Appendix: the survey at `abc0796b`

| Fact | Proof |
|---|---|
| Inline image caps: four types, 5 MiB each, ten per message, 20 / 24 MiB per thread; documents 10 MiB, ten, 20 / 32 MiB | `src/channels/slack/attachments.ts:11-17,128-133` |
| A non-image, non-document file is skipped and named; nothing is downloaded | `src/channels/slack/attachments.ts:194-198,221,268-271` |
| The download uses the bot token against `url_private_download ?? url_private`; an HTML 200 is detected as unauthorized | `src/channels/slack/attachments.ts:190,226-245` |
| Downloads happen in the adapter before `dispatch()`; the run id is minted in provisioning after admission | `src/channels/slack.ts:343,392-395`; `src/core/dispatch/provision.ts:325,355`; `src/core/dispatcher.ts:389,605` |
| A file on a live thread is a follow-up merged into a turn; the durable inbox drops inline attachments over its byte cap | `src/core/dispatch/admission.ts:92-93`; `src/core/threadAdmission.ts:221-222`; `src/core/runLedger/inboxMessage.ts:40-52` |
| `MAX_READ_BYTES` 10 MiB, `READ_CHUNK_BYTES` 1,048,575; `/read` answers `{ encoding, content, size }` | `src/execution/binaryRead.ts:14,52-53,66-72` |
| `SlackIO.attachFile` uploads a Buffer with `files.uploadV2`; the SDK buffers a Stream whole | `src/channels/slack.ts:495-504`; `@slack/web-api` 8.1.1 `dist/file-upload.js:33,161` |
| Bot `basic` (1 GiB), one instance; sandbox `standard-4`; resident 4 vCPU / 12 GiB / 20 GB | `deploy/cloudflare/wrangler.template.jsonc:50-51`; `deploy/cloudflare-sandbox/wrangler.template.jsonc:33,39`; `deploy/cloudflare-resident/wrangler.template.jsonc:84` |
| The DO isolate is 128 MB and is why snapshots went presigned | `deploy/cloudflare-resident/wrangler.template.jsonc:101-108` |
| R2 secrets exist only for the resident, scoped to its cache bucket | `deploy/secrets.manifest.json:67-77` |
| A bot secret is three files held equal by a test; secrets are read only through `processSecrets` | `deploy/secrets.manifest.json:2`; `deploy/cloudflare/worker.ts:64-93,97-118`; `src/secrets.ts:11-16,127` |
| A config section: `AppConfig`, `CONFIG_KEYS`, a validator, the example | `src/config.ts:104-158`; `src/config/validate.ts:33-58,255`; `config/config.example.yaml:215-240` |
| No SigV4 in `src/`; `aws4fetch@1.0.20` (MIT, allowlisted) is transitive via the sandbox SDK and `unstorage` | `package-lock.json:10348-10352`; `scripts/licenses-check.mjs:30` |
| `curl` is in all three images; no egress restriction on containers; command budgets 5 min default, 20 min max | `deploy/cloudflare-sandbox/Dockerfile:39`; `Dockerfile:61`; `deploy/cloudflare-resident/Dockerfile:2`; `src/execution/bashTimeout.ts:7,15` |
| The resident's `git clean -fdx` runs on the default checkout only; thread worktrees are separate clones; `withThreadBusy` is an in-flight counter the sweep consults; cleanliness is `git status --porcelain` on a full clone | `src/execution/residentRefresh.ts:104-107`; `deploy/cloudflare-resident/worker.ts:406,2183,4394-4400,5117-5125,5550-5557`; `src/execution/residentCleanliness.ts:45,60` |
| `files:write` is already a required scope | `src/channels/slackCatchUpStatus.ts:26` |
| No artifact-like run event besides `review_artifact`; records cap events at 64 KiB in 1.5 MiB | `src/core/runEvents.ts`; `src/core/runRecord.ts:612-614` |
| The run page CSP is `img-src 'self' data:`; no timeline artifact item; finished runs authorize per actor, live runs by token | `src/channels/webShell.ts:19`; `web/src/lib/runPageModel.ts:61-160`; `src/channels/liveView.ts:203-208,262-263` |
