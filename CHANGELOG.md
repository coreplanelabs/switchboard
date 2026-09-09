# Changelog

## [1.10.0](https://github.com/coreplanelabs/switchboard/compare/v1.9.0...v1.10.0) (2026-09-09)


### Features

* **review:** the review agent reads the touched specs and files a contradiction as a finding ([#763](https://github.com/coreplanelabs/switchboard/issues/763)) ([57e55a7](https://github.com/coreplanelabs/switchboard/commit/57e55a773dfc8e9f23409f3674b82e3add6832d2))


### Bug fixes

* the review follow-ups from the Phase 7–9 PRs — effort levels from the ladder, a mermaid draw epoch, an escaped licence, a real workflow warning ([#767](https://github.com/coreplanelabs/switchboard/issues/767)) ([08e1280](https://github.com/coreplanelabs/switchboard/commit/08e12805b77a49b94a286a23c0f2c3d9d4bbc8e3))

## [1.9.0](https://github.com/coreplanelabs/switchboard/compare/v1.8.0...v1.9.0) (2026-09-09)


### Features

* **dispatcher:** why a run went to a cold sandbox is on its stream — a cold_sandbox run note beside the card's fallback text ([#758](https://github.com/coreplanelabs/switchboard/issues/758)) ([ec99e90](https://github.com/coreplanelabs/switchboard/commit/ec99e90bfa162d02b14500ae71454df3b25a4b4f))


### Bug fixes

* **resident:** an attach whose ref is gone checks out the expected commit detached instead of refusing — a review of a merged PR stays on the resident ([#757](https://github.com/coreplanelabs/switchboard/issues/757)) ([436ce9f](https://github.com/coreplanelabs/switchboard/commit/436ce9f17b8ea839a91da41d6ab83a245dc83d4f))
* **resident:** the attach's ref-exists shortcut names its invariant, and a cat-file failure is its own step error — the [#757](https://github.com/coreplanelabs/switchboard/issues/757) review fixes ([#759](https://github.com/coreplanelabs/switchboard/issues/759)) ([0d5d547](https://github.com/coreplanelabs/switchboard/commit/0d5d54735b9fec3dfd48fcd96a4c7d9b27c63cd8))
* **tracing:** the queued numbers ride on the request root from its start, so the run page's "queued … before we saw it" caption can render ([#755](https://github.com/coreplanelabs/switchboard/issues/755)) ([9f0b9ed](https://github.com/coreplanelabs/switchboard/commit/9f0b9ed11121dac03d8669a76e2b54e68d2ae725))

## [1.8.0](https://github.com/coreplanelabs/switchboard/compare/v1.7.0...v1.8.0) (2026-09-09)


### Features

* **costs:** every Cloudflare meter a deployment is billed on, attributed by Worker script, with the group's share of the whole account ([#736](https://github.com/coreplanelabs/switchboard/issues/736)) ([3048c10](https://github.com/coreplanelabs/switchboard/commit/3048c108acd35e5927b0f6f96b9a795918ecbe0b))


### Bug fixes

* **deploy:** fly.toml is an inert path for the deploy selection, as the spec already says — its deletion no longer rolls the whole fleet ([#738](https://github.com/coreplanelabs/switchboard/issues/738)) ([7bf5853](https://github.com/coreplanelabs/switchboard/commit/7bf5853109ca7976169db1563a04ad5b295e69df))

## [1.7.0](https://github.com/coreplanelabs/switchboard/compare/v1.6.0...v1.7.0) (2026-09-09)


### Features

* **cli:** load .env at startup, a Worker secret is optional where its feature is, and one deploy entry point — the gaps the Get started tutorial surfaced ([#731](https://github.com/coreplanelabs/switchboard/issues/731)) ([e79aa9b](https://github.com/coreplanelabs/switchboard/commit/e79aa9b8aea7b49fdc4b4d9e65ed48c71d54f5c3))
* **dispatcher:** the run's stream is live from the reservation — the attach streams as it happens and the request is on the page before the workspace exists ([#732](https://github.com/coreplanelabs/switchboard/issues/732)) ([22afbe4](https://github.com/coreplanelabs/switchboard/commit/22afbe49c7aac5217f9bc111ac40456442312780))
* **resident:** the resident container moves to 4 vCPU / 12 GiB / 20 GB — sixteen threads no longer share one core ([#733](https://github.com/coreplanelabs/switchboard/issues/733)) ([346a3fe](https://github.com/coreplanelabs/switchboard/commit/346a3fec31c12e5c5f75b32e488ef36ab8622b34))


### Bug fixes

* **slack:** the status budget credits an interval once even when the clock steps back, and the terminal re-send cap has one home ([#724](https://github.com/coreplanelabs/switchboard/issues/724)) ([514dc65](https://github.com/coreplanelabs/switchboard/commit/514dc656942dfb239db7d563cb05514fcd309487))
* **tracing:** the bot's reads of the resident admin listing run under a root, so the Worker's /residents line adopts a trace ([#735](https://github.com/coreplanelabs/switchboard/issues/735)) ([0d4279e](https://github.com/coreplanelabs/switchboard/commit/0d4279e21fbb6f534dde3f4a94b4b1a28c28c1fe))


### Documentation

* **readme:** the front door — pitch, seams, what you need, quick start; everything else moves into the docs tree ([#727](https://github.com/coreplanelabs/switchboard/issues/727)) ([8c048da](https://github.com/coreplanelabs/switchboard/commit/8c048da71f1efc6f26d815124a77eb3df39e32c4))
* **site:** every tutorial, how-to and explanation page takes its Diataxis shape, and the nav reaches a running ask in three clicks ([#729](https://github.com/coreplanelabs/switchboard/issues/729)) ([4921547](https://github.com/coreplanelabs/switchboard/commit/4921547545345f131cd6d546a43e73a9e7063cb3))
* **site:** get started, set up accounts, deploy, security model and architecture pages, with the Slack app manifest ([#728](https://github.com/coreplanelabs/switchboard/issues/728)) ([1a9dda5](https://github.com/coreplanelabs/switchboard/commit/1a9dda543aa2f3433a721114a86962cdb779a4fd))
* **site:** the home page is a landing page, in a theme of its own, with diagrams drawn in its palette ([#730](https://github.com/coreplanelabs/switchboard/issues/730)) ([caaa932](https://github.com/coreplanelabs/switchboard/commit/caaa932ded87308e265bc308b4e4ddc364b14f11))

## [1.6.0](https://github.com/coreplanelabs/switchboard/compare/v1.5.0...v1.6.0) (2026-09-08)


### Features

* **coding:** every push to an existing PR re-evaluates and resubmits its description, whoever opened it ([#715](https://github.com/coreplanelabs/switchboard/issues/715)) ([b2b9855](https://github.com/coreplanelabs/switchboard/commit/b2b9855a0cc53886a275dbe9fd2ade18c49874bf))
* **coding:** the description turn — a run that pushed onto an open PR without resubmitting its description gets one bounded model turn asking for it ([#716](https://github.com/coreplanelabs/switchboard/issues/716)) ([00f0a10](https://github.com/coreplanelabs/switchboard/commit/00f0a1082850b419d773ab84cfc91f0bf5bf6716))
* **docs:** the docs site lives at openswitchboard.dev — a Worker may name its own zone, and the project's docs are public ([#720](https://github.com/coreplanelabs/switchboard/issues/720)) ([e3e615e](https://github.com/coreplanelabs/switchboard/commit/e3e615e039fd79a9b555121abe9fb41d95e48d13))


### Bug fixes

* **coding:** a description-less push onto a branch that already heads an open PR is reported as that PR updated, not "no PR was opened" ([#709](https://github.com/coreplanelabs/switchboard/issues/709)) ([2da3178](https://github.com/coreplanelabs/switchboard/commit/2da3178b383bee08d77425d8f4400f6aad268af8))
* **dispatcher:** the registry row is created at the reservation — the runs index never shows a labelless ledger row for a run this process is attaching ([#714](https://github.com/coreplanelabs/switchboard/issues/714)) ([8189738](https://github.com/coreplanelabs/switchboard/commit/8189738f3880c8362d8410ee76432a6dd2ec3ddf))
* **resident:** the live view reports runs apart from the refresh cycle (runsInFlight), and the deploy preflight judges busy on that ([#706](https://github.com/coreplanelabs/switchboard/issues/706)) ([fd91678](https://github.com/coreplanelabs/switchboard/commit/fd91678caf6ae9ab02f841c28b065714c2a0721e))
* **review:** a PR's head is read from its head branch's ref tip, not only from GitHub's pull-request object, which lags the ref after a force-push ([#721](https://github.com/coreplanelabs/switchboard/issues/721)) ([297331d](https://github.com/coreplanelabs/switchboard/commit/297331dfd70b23a864d0060840a371d060e55728))
* **run-ledger:** a generation never reclaims its own run, a fence gates the finish for good, and an interrupted pipeline's thread is told how to continue ([#717](https://github.com/coreplanelabs/switchboard/issues/717)) ([714958d](https://github.com/coreplanelabs/switchboard/commit/714958d720a372e89f9d6d64c0ae82160ff93d91))
* **runner:** an answer written alongside an update_status call is the answer when the forced extra turn is empty ([#701](https://github.com/coreplanelabs/switchboard/issues/701)) ([27ff46f](https://github.com/coreplanelabs/switchboard/commit/27ff46f4538355e3bfb4ddced7be248dee3d38c9))
* **slack:** card edits draw from one process-wide status budget on their own Web API client, so a rate-limited heartbeat never holds the reply ([#719](https://github.com/coreplanelabs/switchboard/issues/719)) ([9ed2a28](https://github.com/coreplanelabs/switchboard/commit/9ed2a284bfb690aface5a242a9eaff3e2d3cf6ff))


### Documentation

* **agents:** AGENTS.md reads as the contract, not an index — the area map moves into the code map ([#708](https://github.com/coreplanelabs/switchboard/issues/708)) ([490e861](https://github.com/coreplanelabs/switchboard/commit/490e861e672ae45d206e61a497a6aed30b7fa593))

## [1.5.0](https://github.com/coreplanelabs/switchboard/compare/v1.4.0...v1.5.0) (2026-09-08)


### Features

* **run-ledger:** a run is on the ledger from before its workspace attach — reserved attaching with its request, promoted at the claim, restarted from the request if its owner dies there ([#698](https://github.com/coreplanelabs/switchboard/issues/698)) ([ee2972e](https://github.com/coreplanelabs/switchboard/commit/ee2972e2be6a3620772db20e11341430b6b661c5))
* **tracing:** the resident's step vocabulary is one typed table shared by the Worker's runners and the run page's labels ([#691](https://github.com/coreplanelabs/switchboard/issues/691)) ([cc3161f](https://github.com/coreplanelabs/switchboard/commit/cc3161f28c2f6d7a9ac10341b8090bde883d0d35))


### Bug fixes

* **deploy:** the resident preflight holds a deploy only for runs in flight and a provisioning — a refresh or restore mid-cycle warns — and its step waits 30 min ([#692](https://github.com/coreplanelabs/switchboard/issues/692)) ([73add50](https://github.com/coreplanelabs/switchboard/commit/73add50acffa4b8eddaaa29549faf56cee614785))
* **tracing:** the coding post step's workspace probes and the ship pipeline's workspace releases carry their span ([#687](https://github.com/coreplanelabs/switchboard/issues/687)) ([0049d0c](https://github.com/coreplanelabs/switchboard/commit/0049d0ce011c66e1cde413f39af8b6a55c356fee))

## [1.4.0](https://github.com/coreplanelabs/switchboard/compare/v1.3.0...v1.4.0) (2026-09-08)


### Features

* **tracing:** a model turn carries its thinking and writing time — block boundaries from the provider, summed by the runner, printed on the turn row ([#685](https://github.com/coreplanelabs/switchboard/issues/685)) ([838dac2](https://github.com/coreplanelabs/switchboard/commit/838dac2deddfa56d663e4fcf27c6441c5f15cb8c))
* **web:** the run page's tail names the open span, and the setup spans fold under one Setup head ([#680](https://github.com/coreplanelabs/switchboard/issues/680)) ([928902f](https://github.com/coreplanelabs/switchboard/commit/928902f02373fa286623cadcfc8649a6c6c514fb))


### Bug fixes

* **resident:** a restore unmounts its squashfuse lower by backup id — fuse-overlayfs exposes no lowerdir=, so the lowers leaked ([#682](https://github.com/coreplanelabs/switchboard/issues/682)) ([28a03e6](https://github.com/coreplanelabs/switchboard/commit/28a03e6bf784c45075b588bc6dce6cba64192052))


### Documentation

* **decisions:** twenty-one architecture decision records, a records gate, and a generated index ([#679](https://github.com/coreplanelabs/switchboard/issues/679)) ([a25526b](https://github.com/coreplanelabs/switchboard/commit/a25526bf28c329f4e290db5e5f6828d791c339eb))
* **specs:** features/capabilities.md names its receipts issue like every other spec ([#683](https://github.com/coreplanelabs/switchboard/issues/683)) ([8263bf5](https://github.com/coreplanelabs/switchboard/commit/8263bf5a48d333e583f2d3b4cb80649561627239))

## [1.3.0](https://github.com/coreplanelabs/switchboard/compare/v1.2.0...v1.3.0) (2026-09-08)


### Features

* **tracing:** the bot keeps its own span log and serves it to a trace:read bearer — the container's stdout, readable by us and never from the outside ([#675](https://github.com/coreplanelabs/switchboard/issues/675)) ([421134b](https://github.com/coreplanelabs/switchboard/commit/421134b97c7849a1d91d4eb636cdfa1c2dcd44c4))


### Bug fixes

* **resident:** the image build asserts unsquashfs with command -v — unsquashfs -version exits 1 on squashfs-tools 4.5 and failed the 1.2.0 resident image ([#678](https://github.com/coreplanelabs/switchboard/issues/678)) ([7d256b1](https://github.com/coreplanelabs/switchboard/commit/7d256b11dacf8e16f0008f31d3fdd23f23b92a26))


### Documentation

* **plans:** the durable-runs plan record is implemented — Phases 0–5 merged and live-receipted 2026-09-08 ([#674](https://github.com/coreplanelabs/switchboard/issues/674)) ([0b63ac7](https://github.com/coreplanelabs/switchboard/commit/0b63ac7466b0c24f84f2d79006e3adea653cc912))

## [1.2.0](https://github.com/coreplanelabs/switchboard/compare/v1.1.0...v1.2.0) (2026-09-08)


### Features

* **capabilities:** one Capabilities value, computed once — surfaces hide what is off, null objects replace presence checks ([#665](https://github.com/coreplanelabs/switchboard/issues/665)) ([d473c6a](https://github.com/coreplanelabs/switchboard/commit/d473c6ae4238159bd6b2a60e80aa12127f356a1c))
* **dashboard:** nav and tabs follow the capabilities; dashboard auth is a strategy — access, token, or loopback-only none ([#663](https://github.com/coreplanelabs/switchboard/issues/663)) ([1da5b3f](https://github.com/coreplanelabs/switchboard/commit/1da5b3f8d18a211473eea18236e02dd82fb8969d))
* **run-ledger:** the durable inbox carries a follow-up's attachments when they fit the row, and says what it dropped when they do not ([#670](https://github.com/coreplanelabs/switchboard/issues/670)) ([1a41db5](https://github.com/coreplanelabs/switchboard/commit/1a41db53972a73289e21cec39d512f4553acab3d))
* **tracing:** every resident step the Worker names has a run-page label, guarded by a source scan, and the Scheduled panel shows a firing's trace id ([#672](https://github.com/coreplanelabs/switchboard/issues/672)) ([e58bf98](https://github.com/coreplanelabs/switchboard/commit/e58bf98762189bc4e2387ca6e61a5911ff55a26b))
* **tracing:** the resident's watchdog firing and refresh cycle and the state Worker's sweep are roots of their own, and the Slack card's total floors like every other surface ([#658](https://github.com/coreplanelabs/switchboard/issues/658)) ([e270222](https://github.com/coreplanelabs/switchboard/commit/e2702226751a77177fed1f0221ec95044841bd36))


### Bug fixes

* **deploy:** deploy secrets renders the Worker config and quotes wrangler's error; the Worker names the restart subject so a token rotation is one put and one restart ([#671](https://github.com/coreplanelabs/switchboard/issues/671)) ([8b56509](https://github.com/coreplanelabs/switchboard/commit/8b565090f05a3876bcf6c5688070149b6b2522a1))
* **live-view:** the tokenless stop is a write — it asks runs:write like runs.stop on the command surface ([#669](https://github.com/coreplanelabs/switchboard/issues/669)) ([9975312](https://github.com/coreplanelabs/switchboard/commit/99753122a0dbbb5b164acddb90aff0eccafb5533))
* **resident:** a presigned restore is a mount — extract it onto the disk, unmount, and unmount leftovers before every clean ([#660](https://github.com/coreplanelabs/switchboard/issues/660)) ([1025324](https://github.com/coreplanelabs/switchboard/commit/10253247150f45379d932fcbd49267311c15cf19))
* **tracing:** a Worker root that adopted the bot's trace prints as a root — the log sink no longer hides every sub-second adopted request ([#668](https://github.com/coreplanelabs/switchboard/issues/668)) ([a4732c2](https://github.com/coreplanelabs/switchboard/commit/a4732c28a9919ebcfb4e74cfdad933b995f4935b))
* **tracing:** the reading diff's execs, the review settle's head probe and move, and the workspace release carry their span to the executor ([#661](https://github.com/coreplanelabs/switchboard/issues/661)) ([15a85e9](https://github.com/coreplanelabs/switchboard/commit/15a85e9d77a41a397abce115782d9f5b786b056b))

## [1.1.0](https://github.com/coreplanelabs/switchboard/compare/v1.0.0...v1.1.0) (2026-09-08)


### Features

* **resident:** content-addressed snapshots — the checkout archive drops node_modules, each deps-store entry is archived once, a wake restores it ([#654](https://github.com/coreplanelabs/switchboard/issues/654)) ([52ee450](https://github.com/coreplanelabs/switchboard/commit/52ee450354a31094050508af3ce78f543b026e62))
* **tracing:** the resident admin client, the memory store's retrieve and the run store's put join the trace as http.client spans ([#655](https://github.com/coreplanelabs/switchboard/issues/655)) ([56dcab9](https://github.com/coreplanelabs/switchboard/commit/56dcab9310a38291cf50c041f04f54aba5156182))


### Bug fixes

* **dispatcher:** a resumed run's admission slot carries the row's original start — the steer ack says the run's elapsed time, not the resume's ([#656](https://github.com/coreplanelabs/switchboard/issues/656)) ([760abe5](https://github.com/coreplanelabs/switchboard/commit/760abe5295e48fd57eea7e71d10cc754623ed628))

## [1.0.0](https://github.com/coreplanelabs/switchboard/compare/v0.11.0...v1.0.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* **authz:** grants + restrict are the whole authorization config; the permissions and token-scopes translation retires ([#637](https://github.com/coreplanelabs/switchboard/issues/637))

### Features

* **authz:** grants + restrict are the whole authorization config; the permissions and token-scopes translation retires ([#637](https://github.com/coreplanelabs/switchboard/issues/637)) ([81f5007](https://github.com/coreplanelabs/switchboard/commit/81f5007f9f9e4f17d05fe1db9bf423a27ee4666c))
* **deploy:** the gate goes — runs in flight no longer refuse a rollout or a restart, and the release job stops waiting and re-dispatching ([#640](https://github.com/coreplanelabs/switchboard/issues/640)) ([d4a7bc7](https://github.com/coreplanelabs/switchboard/commit/d4a7bc7ecf031d471d631b9ac201b8d3e3a7ba65))
* **registry:** a run ends in two steps — finish (the agent stopped, a finished frame) and seal (the stream closed, the end frame); finish seals at once for now ([#635](https://github.com/coreplanelabs/switchboard/issues/635)) ([bf183c6](https://github.com/coreplanelabs/switchboard/commit/bf183c672215fab388bc73aa40f89dd769c0f5d7))
* **run-ledger:** the durable inbox — a steered follow-up survives the bot's death, and a boot-gap follow-up is steered into the resumed run ([#634](https://github.com/coreplanelabs/switchboard/issues/634)) ([4d1d9da](https://github.com/coreplanelabs/switchboard/commit/4d1d9daf62ce84cb5b05c25e3f98c3790c2b6cb8))
* **runs:** one registry on every read surface — /runs, the run page, friction and stop see the runs the ledger holds live under other generations ([#639](https://github.com/coreplanelabs/switchboard/issues/639)) ([36196d0](https://github.com/coreplanelabs/switchboard/commit/36196d06ff08f3bf89ae721cd7c5ffa4867ac5b4))
* **runs:** the seal moves to after the reply — records are written after the seal, and every surface says when the reply landed ([#638](https://github.com/coreplanelabs/switchboard/issues/638)) ([8c3e39a](https://github.com/coreplanelabs/switchboard/commit/8c3e39a30ee5dbf3d65d158b48088bfc09d8954c))
* **stream:** span records join the run stream — readers, the one Adapter, the display table, and a protected head so spans displace no content ([#641](https://github.com/coreplanelabs/switchboard/issues/641)) ([16d67b4](https://github.com/coreplanelabs/switchboard/commit/16d67b47cea39524b9f9e4c2efbd990d3a8eb7c5))
* **tracing:** every call the bot makes to one of its own Workers is an http.client span carrying the trace context — and to no one else ([#648](https://github.com/coreplanelabs/switchboard/issues/648)) ([a6ca033](https://github.com/coreplanelabs/switchboard/commit/a6ca033cd0a9e4c5e2c3f9c7890a3ab9ad9c1707))
* **tracing:** every GitHub call a tool makes is a github.rest span under the call, and a token mint a github.token_mint span — routes from a closed table, never the path ([#653](https://github.com/coreplanelabs/switchboard/issues/653)) ([ba81057](https://github.com/coreplanelabs/switchboard/commit/ba8105736a8c29a749269fbd9da88af10da1702d))
* **tracing:** one request, one root — the adapters start it at receipt, every awaited step of the dispatcher is a span, the card ticks from receipt with the setup step and the shape ([#643](https://github.com/coreplanelabs/switchboard/issues/643)) ([c5237ae](https://github.com/coreplanelabs/switchboard/commit/c5237ae514e03fcacd9ae8cb7f1f94fc959932d5))
* **tracing:** the bot's own work gets roots — the catch-up pass, the drain, every deploy step with its live gate as a child — and 39 direct clock reads go through the injected clock ([#646](https://github.com/coreplanelabs/switchboard/issues/646)) ([5902745](https://github.com/coreplanelabs/switchboard/commit/590274565fd5440e9512663fb3d8fba0674de5b0))
* **tracing:** the clock ratchet reaches zero — every production read of the wall clock goes through the one clock, the allowlist is empty, and the lint exemption is gone ([#650](https://github.com/coreplanelabs/switchboard/issues/650)) ([9dc922d](https://github.com/coreplanelabs/switchboard/commit/9dc922dd13501f7a4a1a830c309aa3777e9e114d))
* **tracing:** the friction analyzer reads one span set — durations from the normalized spans, the window as run time, the shape on a finished diagnosis ([#644](https://github.com/coreplanelabs/switchboard/issues/644)) ([8d89b72](https://github.com/coreplanelabs/switchboard/commit/8d89b72f8ed411bd9be9685f48f2772ffc198636))
* **tracing:** the resident's clone, install and mutex wait land on the run as spans under the attach, and an op's steps under run.command ([#645](https://github.com/coreplanelabs/switchboard/issues/645)) ([06bf117](https://github.com/coreplanelabs/switchboard/commit/06bf117567caba4a6580b621658596bd4c8ce8e4))
* **tracing:** the runner, the MCP bridge, the executor, the review settle and the ship pipeline emit spans, and the dispatcher roots every run ([#642](https://github.com/coreplanelabs/switchboard/issues/642)) ([85dbea1](https://github.com/coreplanelabs/switchboard/commit/85dbea1415840468cbfcfb8b686d053583dd6d22))
* **tracing:** the Workers join the bot's trace — the shim strips and mints, the state, resident and sandbox Workers root each authenticated request under the bot's trace id, and a fired schedule carries its own ([#649](https://github.com/coreplanelabs/switchboard/issues/649)) ([1887052](https://github.com/coreplanelabs/switchboard/commit/1887052ab772e7b4a4f4e4613f3ed86b4e54da07))
* **web:** the run page gets a timeline — the run's shape from its spans and stamps, live and on a record, closing to the header's total ([#647](https://github.com/coreplanelabs/switchboard/issues/647)) ([b58a88c](https://github.com/coreplanelabs/switchboard/commit/b58a88ccffb2a167d4ad8f329ea2c204305267a6))


### Documentation

* **plans:** the run-tracing plan record is implemented — PRs 0–10 merged 2026-09-08 ([#651](https://github.com/coreplanelabs/switchboard/issues/651)) ([c6c59da](https://github.com/coreplanelabs/switchboard/commit/c6c59da085aac2da95b5fb3db06d1edbd050a311))
* the milestone-1 comparison spec retires and the self-improvement tour joins the explanation tree ([#652](https://github.com/coreplanelabs/switchboard/issues/652)) ([7b81e49](https://github.com/coreplanelabs/switchboard/commit/7b81e49108ee42c985d87068856f6bba29572899))

## [0.11.0](https://github.com/coreplanelabs/switchboard/compare/v0.10.0...v0.11.0) (2026-09-08)


### Features

* **live-view:** the replay budget lives in the registry — the newest 2000 events within 1 MiB, and one replay_elided frame names what a viewer skipped ([#632](https://github.com/coreplanelabs/switchboard/issues/632)) ([85d91d0](https://github.com/coreplanelabs/switchboard/commit/85d91d0d6b9b223705bff1d4f3c2b76572b92c85))
* **run-ledger:** the drain hands resumable runs to the next generation instead of waiting, and a fence stops the run ([#631](https://github.com/coreplanelabs/switchboard/issues/631)) ([2e31885](https://github.com/coreplanelabs/switchboard/commit/2e318855ecd6b1bb231804c8da25ea33ee8062c0))
* **runs:** one duration definition on every surface — stamps threaded, readers tolerate span records ([#628](https://github.com/coreplanelabs/switchboard/issues/628)) ([27338dc](https://github.com/coreplanelabs/switchboard/commit/27338dc5e0efde3a2b23ddf9e7eb85bbeded4322))


### Bug fixes

* **resident:** an install that produces no node_modules is an empty deps-store entry when the commit has no lockfile ([#630](https://github.com/coreplanelabs/switchboard/issues/630)) ([8203d85](https://github.com/coreplanelabs/switchboard/commit/8203d85453aed69a701a72cb9d7a26b3107f8f17))

## [0.10.0](https://github.com/coreplanelabs/switchboard/compare/v0.9.0...v0.10.0) (2026-09-08)


### Features

* **run-ledger:** a killed run continues on the next generation — resumable rows handed to a launcher, the reclaim repeats every lease interval, the dispatcher resumes a run under its own id from its transcript ([#626](https://github.com/coreplanelabs/switchboard/issues/626)) ([96309c2](https://github.com/coreplanelabs/switchboard/commit/96309c241970eb4e8da219107c59ac67f44ebe8f))
* **run-ledger:** the pieces of a resume — the D4 settlement plan, the runner's re-entry from a transcript, registry create under an old id with replayed events, ledger adopt ([#622](https://github.com/coreplanelabs/switchboard/issues/622)) ([ee9f626](https://github.com/coreplanelabs/switchboard/commit/ee9f626f32a63b4152792aa6ae8c3af3bc448e46))
* **trace:** one measurement primitive — spans, sinks, the partition, the clock ratchet, one duration formatter and a span log ([#625](https://github.com/coreplanelabs/switchboard/issues/625)) ([eedb5ca](https://github.com/coreplanelabs/switchboard/commit/eedb5ca523e1faf0045379251778bb66572de628))

## [0.9.0](https://github.com/coreplanelabs/switchboard/compare/v0.8.0...v0.9.0) (2026-09-08)


### Features

* **config:** the runtime learns whose installation it is — organization from config, the bot's GitHub identity from GitHub, the docs URL from the profile ([#618](https://github.com/coreplanelabs/switchboard/issues/618)) ([d412f88](https://github.com/coreplanelabs/switchboard/commit/d412f88a736265a59804ffdeebc4289886c14c8d))
* **resident:** snapshot bytes travel container↔R2 over presigned URLs when the env allows — the Durable Object leaves the data path, fail-closed to local mode ([#617](https://github.com/coreplanelabs/switchboard/issues/617)) ([81a24f3](https://github.com/coreplanelabs/switchboard/commit/81a24f300361c8b0ff608508f5ec47a53b2dcb8b))


### Bug fixes

* **admin:** /admin/crash exits hard (137) — the bot is PID 1 and the kernel drops a SIGKILL init sends itself ([#619](https://github.com/coreplanelabs/switchboard/issues/619)) ([e12b450](https://github.com/coreplanelabs/switchboard/commit/e12b45069d29fe0e257bd5f6e08958000a488dcf))
* **resident:** resident text is made safe at the seams — write, exit and parse — so no card, reply, listing or record shows raw remote output ([#616](https://github.com/coreplanelabs/switchboard/issues/616)) ([c60cfba](https://github.com/coreplanelabs/switchboard/commit/c60cfbad910fe8ef6ce2d5eba0f8d0a60807c6fa))
* **tools:** a web page reaches the model in 40k-character windows with offset paging, and the runner caps every tool result at 120k characters ([#615](https://github.com/coreplanelabs/switchboard/issues/615)) ([#620](https://github.com/coreplanelabs/switchboard/issues/620)) ([0c38a2f](https://github.com/coreplanelabs/switchboard/commit/0c38a2f2616dd5588f6a36db63b3a92938c3b0e9))

## [0.8.0](https://github.com/coreplanelabs/switchboard/compare/v0.7.0...v0.8.0) (2026-09-08)


### Features

* **deploy:** the deploy workflow takes wait_max — a dispatch can shorten the preflight budget, so the busy retry can be rehearsed against a real busy bot ([#607](https://github.com/coreplanelabs/switchboard/issues/607)) ([528d49e](https://github.com/coreplanelabs/switchboard/commit/528d49e82255e86911b978c4ec3682b94b09d793))
* **deploy:** the installation's identity leaves the tree — profile and config in the infrastructure repo, rendered Worker configs generated ([#608](https://github.com/coreplanelabs/switchboard/issues/608)) ([705e8bc](https://github.com/coreplanelabs/switchboard/commit/705e8bcad42f541e67d45778b7c3b482a5b100e8))
* **run-ledger:** the next generation reclaims every run the last one left — closed with a record from the ledger before the Slack socket opens; seed record, /runs/live-events, /admin/crash, finish before release ([#610](https://github.com/coreplanelabs/switchboard/issues/610)) ([683ab12](https://github.com/coreplanelabs/switchboard/commit/683ab12a0702c2e2182ca954d69e0ae273338669))


### Bug fixes

* **execution:** the sandbox credential rides only in the request body — drop the x-env-* header channel ([#609](https://github.com/coreplanelabs/switchboard/issues/609)) ([5aeeb5e](https://github.com/coreplanelabs/switchboard/commit/5aeeb5eb2e1b9b8715599e7aafc7b3746677c39b))


### Documentation

* **plans:** run tracing plan — one measurement primitive, the timeline as a side effect ([#613](https://github.com/coreplanelabs/switchboard/issues/613)) ([9fc89c4](https://github.com/coreplanelabs/switchboard/commit/9fc89c4c3089003c21e077b359b9c16a87dc5915))

## [0.7.0](https://github.com/coreplanelabs/switchboard/compare/v0.6.1...v0.7.0) (2026-09-08)


### Features

* **config:** the bot reads its config from the state Worker; the image carries none ([#601](https://github.com/coreplanelabs/switchboard/issues/601)) ([384deb4](https://github.com/coreplanelabs/switchboard/commit/384deb4a0eff9fb64320e68010e5de555fa51e6c))
* **run-ledger:** the bot mirrors every run onto the ledger as it runs — claim, seed, step records before tools, events, state, finishing, finish ([#603](https://github.com/coreplanelabs/switchboard/issues/603)) ([684ba9a](https://github.com/coreplanelabs/switchboard/commit/684ba9a3c18179e98451754e658c8edf6c0e0439))


### Bug fixes

* **execution:** sandbox sends get a bot-side deadline (budget + 30 s); the card says running &lt;tool&gt;, not thinking ([#604](https://github.com/coreplanelabs/switchboard/issues/604)) ([2fe881b](https://github.com/coreplanelabs/switchboard/commit/2fe881b1eae567b283196b3294fd7883fd3b6e7c))
* **resident:** refresh thread credentials off the token's own expiry, not the file's age ([#528](https://github.com/coreplanelabs/switchboard/issues/528)) ([#605](https://github.com/coreplanelabs/switchboard/issues/605)) ([64b79c0](https://github.com/coreplanelabs/switchboard/commit/64b79c0b13b4b5af10f5198268ba1a9fdc248c11))

## [0.6.1](https://github.com/coreplanelabs/switchboard/compare/v0.6.0...v0.6.1) (2026-09-08)


### Bug fixes

* **ci:** the scorecard job grants the reads a private repository needs — issues, pull-requests, checks — so its GraphQL setup stops failing ([#600](https://github.com/coreplanelabs/switchboard/issues/600)) ([8265dd0](https://github.com/coreplanelabs/switchboard/commit/8265dd0d1c18f97a53d11f0486c2922dc79fed20))
* **deploy:** the memory Worker's RunTranscriptDO binding and v6 migration live in the wrangler template — [#592](https://github.com/coreplanelabs/switchboard/issues/592) edited the generated file after [#588](https://github.com/coreplanelabs/switchboard/issues/588) made it a render ([#595](https://github.com/coreplanelabs/switchboard/issues/595)) ([4557eb4](https://github.com/coreplanelabs/switchboard/commit/4557eb48aeacfa8fe0f9ccc7beb730eb0a79072a))
* **deploy:** the sandbox gate waits for the rollout wrangler printed — never live against the pre-deploy version ([#598](https://github.com/coreplanelabs/switchboard/issues/598)) ([fbf8d22](https://github.com/coreplanelabs/switchboard/commit/fbf8d22b5f4474ab2a74d3468ede2b9d64693f24))
* **execution:** the sandbox env map rides in the request body, not x-env-* headers — Workers Logs record headers ([#597](https://github.com/coreplanelabs/switchboard/issues/597)) ([2848d26](https://github.com/coreplanelabs/switchboard/commit/2848d2621e75a08aeab1873f20c763224706b9a2))

## [0.6.0](https://github.com/coreplanelabs/switchboard/compare/v0.5.0...v0.6.0) (2026-09-08)


### Features

* **deploy:** `deploy secrets` puts a Worker's secrets from the profile's source ([#593](https://github.com/coreplanelabs/switchboard/issues/593)) ([98cbb9e](https://github.com/coreplanelabs/switchboard/commit/98cbb9e1cd3344fe207dcf7c7863b9db1d012de8))
* **deploy:** render each Worker's wrangler.jsonc from a template and the deployment profile ([#588](https://github.com/coreplanelabs/switchboard/issues/588)) ([d76a38a](https://github.com/coreplanelabs/switchboard/commit/d76a38ad9d7063e6ed07c8cad552704750977716))
* **ledger:** the live-run ledger on the state Worker — lease with a fencing token, step records, an append route, a per-run transcript object, reclaim ([#592](https://github.com/coreplanelabs/switchboard/issues/592)) ([7166399](https://github.com/coreplanelabs/switchboard/commit/716639909d9b8debb987be6fceff45342c666c5b))


### Bug fixes

* **ci:** pr-title runs are queued, never cancelled — a release-please update fires synchronize and edited together, and the cancelled twin blocked the release PR ([#586](https://github.com/coreplanelabs/switchboard/issues/586)) ([dd2d32e](https://github.com/coreplanelabs/switchboard/commit/dd2d32ed4ea071d740b4564ef4c60b4ccb9def01))
* **ci:** the Worker legs are named for what they do (workers / verify deploy/&lt;dir&gt;), and a stalled npm-cache segment gives up after 1 min, not 10 ([#590](https://github.com/coreplanelabs/switchboard/issues/590)) ([2e0ccfa](https://github.com/coreplanelabs/switchboard/commit/2e0ccfa9d95bf3f9d1d8fe299fb283dde82d70f4))
* **deploy:** the memory Worker's template carries the ledger's RunTranscriptDO ([#596](https://github.com/coreplanelabs/switchboard/issues/596)) ([d945f33](https://github.com/coreplanelabs/switchboard/commit/d945f3389723cc1d35c51b9cf4014c5104996286))
* **resident:** restore progress is measured where the bytes land — the SDK's staging archive plus the target, not the target alone ([#591](https://github.com/coreplanelabs/switchboard/issues/591)) ([08c5232](https://github.com/coreplanelabs/switchboard/commit/08c52322db430c5762a8fa47b96a68f596cb72a8))


### Documentation

* **plans:** durable runs — a run outlives the bot container, so the deploy gate can go ([#585](https://github.com/coreplanelabs/switchboard/issues/585)) ([8657388](https://github.com/coreplanelabs/switchboard/commit/865738881e948b424168e3d59887ff1721ae0e1c))

## [0.5.0](https://github.com/coreplanelabs/switchboard/compare/v0.4.0...v0.5.0) (2026-09-08)


### Features

* **deploy:** a busy bot never needs a person — deploy all exits 75 (busy) when the preflight never clears, and the release workflow re-dispatches itself at the head of main ([#577](https://github.com/coreplanelabs/switchboard/issues/577)) ([a48cb84](https://github.com/coreplanelabs/switchboard/commit/a48cb84dd01931eec307a6d4d77e602fd30c70c5))
* **deploy:** a deployment profile names the installation, and deploy all places the config from it ([#579](https://github.com/coreplanelabs/switchboard/issues/579)) ([143e041](https://github.com/coreplanelabs/switchboard/commit/143e041a2c1883205133c2dce9d46161e11e1fc8))
* **deploy:** the sandbox step is live only when the Worker, the container rollout and an echo-ok probe agree ([#569](https://github.com/coreplanelabs/switchboard/issues/569)) ([#583](https://github.com/coreplanelabs/switchboard/issues/583)) ([f8f0128](https://github.com/coreplanelabs/switchboard/commit/f8f01282516c54733506a22775c8a40d269c0b4f))
* **load:** the load harness — concurrency baseline, resident/sandbox/e2e drivers, the Slack card path simulated at N, /healthz process metrics, purge-bindings ([#565](https://github.com/coreplanelabs/switchboard/issues/565)) ([af6da77](https://github.com/coreplanelabs/switchboard/commit/af6da779c277dd72bd57663a1c07b1f0f6220870))


### Bug fixes

* **release:** release-please acts as the coreplane-infra App, so the release PR's own CI runs without an 'Approve and run' click ([#584](https://github.com/coreplanelabs/switchboard/issues/584)) ([b430874](https://github.com/coreplanelabs/switchboard/commit/b430874a6831457e742b7d746c14acf8f2ae0598))
* **resident:** a restore is judged by the bytes still arriving, never abandoned to a clock — and a clean never races the last attempt's restore ([#576](https://github.com/coreplanelabs/switchboard/issues/576)) ([676b682](https://github.com/coreplanelabs/switchboard/commit/676b682924149db2d9ff381dfc886a4f8f33edc8))
* **resident:** a restore that goes down takes the container with it, and a rebuild never cleans over an earlier attempt's stream ([#581](https://github.com/coreplanelabs/switchboard/issues/581)) ([2570487](https://github.com/coreplanelabs/switchboard/commit/2570487fe6f2ed2ea1bc978c601542d5ceb33022))
* **resident:** classify a stopped-container spawn refusal as runtime-replaced ([#566](https://github.com/coreplanelabs/switchboard/issues/566)) ([#582](https://github.com/coreplanelabs/switchboard/issues/582)) ([47041cf](https://github.com/coreplanelabs/switchboard/commit/47041cf8e166ef4dbd6e38cc9fff66001a78ec75))
* **runner:** a turn's model stamp is the same provider/model ref run_meta carries — v0.4.0's bare id read as a model switch on every run ([#574](https://github.com/coreplanelabs/switchboard/issues/574)) ([ba1f97b](https://github.com/coreplanelabs/switchboard/commit/ba1f97b4a6ba15c6165d5fb3b98da8c1cfeba997))
* **sandbox:** a Worker/image rollout never reads as a dead or silent sandbox — never-empty error text, one-wave rollout ([#580](https://github.com/coreplanelabs/switchboard/issues/580)) ([8f58158](https://github.com/coreplanelabs/switchboard/commit/8f58158a086124fd9cd9b750690c5f275bc07471))
* **ship:** a foreign PR cited in new task text falls through even when its facts fetch fails ([#578](https://github.com/coreplanelabs/switchboard/issues/578)) ([6f6853f](https://github.com/coreplanelabs/switchboard/commit/6f6853fe55922a6b84b9505a8e1018db58e5d546))
* **ship:** a PR quoted as evidence in new task text no longer binds the entry checks ([#520](https://github.com/coreplanelabs/switchboard/issues/520)) ([44abddf](https://github.com/coreplanelabs/switchboard/commit/44abddff14b2d8e92ff2c6466200dc580cf9aa29))
* **web:** every thought head wears the model badge — the turn's stamp, else the model the run was on; a switched turn wears the ⇄ chip in its place ([#568](https://github.com/coreplanelabs/switchboard/issues/568)) ([ce7add6](https://github.com/coreplanelabs/switchboard/commit/ce7add6868927ec11db65af1395087b22f45fd21))


### Documentation

* **plans:** D13 — Switchboard is installed, not forked; Phase 3 rewritten around time-to-value ([#571](https://github.com/coreplanelabs/switchboard/issues/571)) ([44c261c](https://github.com/coreplanelabs/switchboard/commit/44c261c8b4304a1c631c74d22211913d7452121c))

## [0.4.0](https://github.com/coreplanelabs/switchboard/compare/v0.3.0...v0.4.0) (2026-09-07)


### Features

* **resident:** one content-addressed deps store per resident behind materializeDeps — no in-place installs, one install per lockfile key, parallel up to cores, /attach streams heartbeats ([#564](https://github.com/coreplanelabs/switchboard/issues/564)) ([cfe4a92](https://github.com/coreplanelabs/switchboard/commit/cfe4a9200c4a118bf6afb42cc299f80e2e9d660b))
* **web:** the pending-turn row names the model — every turn is stamped with its model and a switch stands out as a ⇄ chip ([#559](https://github.com/coreplanelabs/switchboard/issues/559)) ([69d5d71](https://github.com/coreplanelabs/switchboard/commit/69d5d717fddaa4f0c68d1e91e6e4806c8b49ed85))


### Bug fixes

* **resident:** a lockfile-diverged thread reconciles on top of the shared dep cache instead of installing from an empty tree ([#560](https://github.com/coreplanelabs/switchboard/issues/560)) ([d75e40c](https://github.com/coreplanelabs/switchboard/commit/d75e40c11775c5a80147dd0e4c9f52a2b7d05215))
* **sandbox:** the Worker speaks SDK 0.12.9 for real — nodejs_compat, credential via exec env, typed errors, installed-SDK guard ([#562](https://github.com/coreplanelabs/switchboard/issues/562)) ([8ce3f64](https://github.com/coreplanelabs/switchboard/commit/8ce3f64c85e469db28c0033c6e2243477622de46))


### Documentation

* **plans:** fifty concurrent runs — the capacity model, its measured baseline, and the sequence to prove it ([#558](https://github.com/coreplanelabs/switchboard/issues/558)) ([fc3cc49](https://github.com/coreplanelabs/switchboard/commit/fc3cc49693d54811e6e910993e161670c7ab841f))

## [0.3.0](https://github.com/coreplanelabs/switchboard/compare/v0.2.1...v0.3.0) (2026-09-07)


### Features

* **http:** async ingress mode — `"async": true` answers 202 with runId/runUrl/threadKey while the run continues in the background ([#530](https://github.com/coreplanelabs/switchboard/issues/530)) ([9dbdc97](https://github.com/coreplanelabs/switchboard/commit/9dbdc978e1a020486ae3c3f576fb6c7a92a9c1a8))
* **process:** AGENTS.md as the operating contract — 15 KiB, generated command table, project facts stated once ([#543](https://github.com/coreplanelabs/switchboard/issues/543)) ([5dd6a4f](https://github.com/coreplanelabs/switchboard/commit/5dd6a4ff291e59ee17c94d782697048a89117cb1))
* **sandbox:** the cold sandbox image and SDK move together to 0.12.9 — Node from the base, pnpm via npm, the NodeSource layer retired ([#546](https://github.com/coreplanelabs/switchboard/issues/546)) ([ae438d2](https://github.com/coreplanelabs/switchboard/commit/ae438d2776e9dd7bc6e4227346f3162bac0364d2))
* **web:** a steered follow-up is its own block in the run timeline, with the request's treatment ([#538](https://github.com/coreplanelabs/switchboard/issues/538)) ([7b67836](https://github.com/coreplanelabs/switchboard/commit/7b6783692ad63df24f56761c1e5bd6b89920a96b))
* **web:** every rendered duration is painted by one heat scale — slow reads warm, a timed-out command reads over budget ([#545](https://github.com/coreplanelabs/switchboard/issues/545)) ([33f1286](https://github.com/coreplanelabs/switchboard/commit/33f1286c31dbb7381d4e75b0901b9cbc73e230aa))


### Bug fixes

* **deploy:** the credential's capabilities are checked before any Worker deploys, the bot preflight keeps wrangler's words, and CI uses a dedicated deploy token ([#551](https://github.com/coreplanelabs/switchboard/issues/551)) ([ed69449](https://github.com/coreplanelabs/switchboard/commit/ed6944960ef0dabc9ea7e5db3ea45d49fc7199a4))
* **execution:** a full sandbox fleet is capacity, not a dead sandbox — name it, wait for a slot, never fail fast on it ([#541](https://github.com/coreplanelabs/switchboard/issues/541)) ([729c87d](https://github.com/coreplanelabs/switchboard/commit/729c87da917aeff8b672fd4432b467292f51f1f0))
* **sandbox:** a running exec never outlives the container's activity timeout — renew the clock every 60 s while it runs ([#540](https://github.com/coreplanelabs/switchboard/issues/540)) ([efe56dc](https://github.com/coreplanelabs/switchboard/commit/efe56dcfc1b0671d53362673e77910a1196fb40a))
* **web:** a silent model is a pending-turn row — ∿ pulse, model badge, rotating verb, elapsed — shaped like the other rows ([#554](https://github.com/coreplanelabs/switchboard/issues/554)) ([b505d5e](https://github.com/coreplanelabs/switchboard/commit/b505d5e2239b85d8ccc40ccf70f135c42b0ea3df))
* **web:** the run page draws in-progress work where it will end up — a running card ticks its own elapsed, a silent model is a provisional thinking head, one projected runner clock; the tail row is gone ([#549](https://github.com/coreplanelabs/switchboard/issues/549)) ([427f7d4](https://github.com/coreplanelabs/switchboard/commit/427f7d42348617587be9666e36e83ab85847effb))

## [0.2.1](https://github.com/coreplanelabs/switchboard/compare/v0.2.0...v0.2.1) (2026-09-07)


### Bug fixes

* **ci:** the release deploy writes its plan files outside the checkout — an untracked plan.json made deploy all refuse the tree as dirty ([#537](https://github.com/coreplanelabs/switchboard/issues/537)) ([721e3c3](https://github.com/coreplanelabs/switchboard/commit/721e3c3c0d7a8cf17c5e49e9f0087aa5365c2882))
* **execution:** a command never outlives its GitHub token or its run — per-command credential resolution, a 25-min reuse margin, and a bash budget clipped to the run's remaining wall clock ([#534](https://github.com/coreplanelabs/switchboard/issues/534)) ([6872fb0](https://github.com/coreplanelabs/switchboard/commit/6872fb052b019b4d011783b051b47ad42ef202e0))
* **resident:** a timed-out install resumes on the partial tree instead of the next cycle wiping it, and every cycle failure is logged ([#527](https://github.com/coreplanelabs/switchboard/issues/527)) ([12c9329](https://github.com/coreplanelabs/switchboard/commit/12c93296edeca6e3a39e522e84a755cad78630f0))

## [0.2.0](https://github.com/coreplanelabs/switchboard/compare/v0.1.0...v0.2.0) (2026-09-07)


### Features

* **admission:** every agent takes thread follow-ups mid-flight — review steers, ship steers through its child rounds ([#511](https://github.com/coreplanelabs/switchboard/issues/511)) ([3dd9332](https://github.com/coreplanelabs/switchboard/commit/3dd9332b88f252e9459c04f4a2623646ca24cd70))
* **deploy:** production deploys on the release from CI — only the Workers whose inputs changed, derived from the tree and shown on the release PR first ([#506](https://github.com/coreplanelabs/switchboard/issues/506)) ([cbf17b5](https://github.com/coreplanelabs/switchboard/commit/cbf17b56ec37539c43748d2ba77e9c10f3e4aad7))
* **resident:** disk is a measured, budgeted resource — sampled every cycle and attach, admitted under free − reserve, refused `disk-pressure` with the math ([#448](https://github.com/coreplanelabs/switchboard/issues/448)) ([#493](https://github.com/coreplanelabs/switchboard/issues/493)) ([a653cf6](https://github.com/coreplanelabs/switchboard/commit/a653cf6c09bdfbf3ecb97eb6c39d2ba4763a7aeb))
* **web:** the residents tab favicon is the fleet's worst tone — red over amber over green, grey when empty or unknown ([#521](https://github.com/coreplanelabs/switchboard/issues/521)) ([fc30280](https://github.com/coreplanelabs/switchboard/commit/fc302809092b50355aeffdcf9dc466c794fb68bd))


### Bug fixes

* **ci:** the release PR's deploy plan is posted from the push to main — its own pull_request runs sit at action_required ([#508](https://github.com/coreplanelabs/switchboard/issues/508)) ([3f7c507](https://github.com/coreplanelabs/switchboard/commit/3f7c507ca1cdd0427a0c074b249d1722d96d9801))
* **deploy:** --affected judges the one root lockfile per Worker by its workspace's closure, and lint config is inert ([#522](https://github.com/coreplanelabs/switchboard/issues/522)) ([7e30d27](https://github.com/coreplanelabs/switchboard/commit/7e30d278e80fe15917a90b632a096566b3dd5b0e))
* **deploy:** a workspace's lockfile closure follows installed peers and skips bundled deps; the bot's dev-dependency reason renders its path ([#526](https://github.com/coreplanelabs/switchboard/issues/526)) ([ff6eb3b](https://github.com/coreplanelabs/switchboard/commit/ff6eb3b0d1a5541334ffac508faaab77ace06506))
* **pr-post:** the pushed-branch tracker reads the full bash command, not the 200-char summary ([#495](https://github.com/coreplanelabs/switchboard/issues/495)) ([19cc41c](https://github.com/coreplanelabs/switchboard/commit/19cc41c2356e06ffb167765de89b5f019eb8c0ab))
* **resident:** a build-user step sweeps the last step's leftovers first, an abandoned wait kills its process, and install gets a 10-min budget ([#529](https://github.com/coreplanelabs/switchboard/issues/529)) ([d2e3713](https://github.com/coreplanelabs/switchboard/commit/d2e3713f0b9d6a02c904d70f5e6a736437984ec3))
* **review:** the review agent reads the code and never runs the project's tests — CI's verify gate does ([#523](https://github.com/coreplanelabs/switchboard/issues/523)) ([f4b4295](https://github.com/coreplanelabs/switchboard/commit/f4b4295dfdc579fc0f6d2f29f93cb93b3f7eb0a4))
* **sandbox:** the cold sandbox SDK pins the image it drives — 0.3.7, not ^0.12.9 — and check:sandbox-pair keeps every image/SDK pair equal ([#518](https://github.com/coreplanelabs/switchboard/issues/518)) ([003516f](https://github.com/coreplanelabs/switchboard/commit/003516fb889699a8f59b1e0e672df5d481129032))

## Changelog

Generated by release-please from conventional commits on `main`. Entries below
the first release header are written by the release pipeline; edit them only
through the release PR.

## Unreleased

Preparing the first public release. Until 1.0, a minor version may change
configuration keys or command syntax; every such change is called out here with
a migration note.
