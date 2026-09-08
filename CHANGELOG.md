# Changelog

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
