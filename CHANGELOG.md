# Changelog

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
