# Changelog

## [1.205.0](https://github.com/coreplanelabs/switchboard/compare/v1.204.0...v1.205.0) (2026-09-12)


### Features

* **agents:** the explore preset runs a two-hour read-only investigation in a cold sandbox, a budget: directive narrows any run's wall clock, and the ship pipeline's wall clock is the ship preset's declared budget ([#971](https://github.com/coreplanelabs/switchboard/issues/971)) ([26ed659](https://github.com/coreplanelabs/switchboard/commit/26ed6594553f80ff131f0a6941bb483603c6d31e))
* **config:** a scope can cap what any run in it may have — minutes, identity and machine class intersect across the layers, a budget above the cap is clipped and an identity or class above it is refused before any executor exists ([#967](https://github.com/coreplanelabs/switchboard/issues/967)) ([cf536c4](https://github.com/coreplanelabs/switchboard/commit/cf536c40e8bf670fbafa1ac4d2fa1f0b7de28faa))
* **core:** the delivery page, its JSON twin and delivery report serve a per-repository snapshot of GitHub's facts refreshed on an interval and show its age; ?fresh=1 and --fresh read GitHub now ([#972](https://github.com/coreplanelabs/switchboard/issues/972)) ([d03c0eb](https://github.com/coreplanelabs/switchboard/commit/d03c0eb2b02d69d4240868229437ffa887eb84c8))
* **web:** the review panel is a Files changed view — a file explorer beside the diff, inline or side by side, the PR's description on its own tab, the Tour gone ([#970](https://github.com/coreplanelabs/switchboard/issues/970)) ([b8ac001](https://github.com/coreplanelabs/switchboard/commit/b8ac001e8f1197dae87eca5a1c4535b0fccdff55))

## [1.204.0](https://github.com/coreplanelabs/switchboard/compare/v1.203.0...v1.204.0) (2026-09-12)


### Features

* **agents:** every preset declares the machine class its runs are provisioned on — none, blank, repo-cold or repo-resident — and only repo-resident consults the resident registry ([#964](https://github.com/coreplanelabs/switchboard/issues/964)) ([f1650bb](https://github.com/coreplanelabs/switchboard/commit/f1650bb1fc6d5c10bd4e494fb978ca37e468789b))
* **coding:** the pi spike driver — the five coding tasks on pi's RPC harness, every tool call previewed against the policy, pi's events mapped to the run stream, a dry run on the scripted provider ([#965](https://github.com/coreplanelabs/switchboard/issues/965)) ([9c909ed](https://github.com/coreplanelabs/switchboard/commit/9c909ed14ae90e7a290df76b2a0fee0f6b8d6bc8))


### Documentation

* **ship:** the orchestration program absorbs record 0026 slice one and spawn/await as five units, and the plan runner holds plan:merge for plan branches ([#957](https://github.com/coreplanelabs/switchboard/issues/957)) ([2202d0d](https://github.com/coreplanelabs/switchboard/commit/2202d0d48dc4747a2eca0c50bfb7773b0c4d25bc))

## [1.203.0](https://github.com/coreplanelabs/switchboard/compare/v1.202.1...v1.203.0) (2026-09-11)


### Features

* **core:** the delivery page and command — issue-to-merge time, first-pass CI, review rounds and the no-human-edit share, read from the run history and the pull requests' own facts ([#947](https://github.com/coreplanelabs/switchboard/issues/947)) ([39db1c9](https://github.com/coreplanelabs/switchboard/commit/39db1c968309628e50430f6fd9d0ef47dc93275a))
* **resident:** every refresh cycle is a Workflow instance — the alarm chain, the watchdog's re-arm and `alarm-missed` are gone, the worktree sweep and the disk gauge are instance steps, and `refresh-now` creates this bucket's instance ([#951](https://github.com/coreplanelabs/switchboard/issues/951)) ([9a95dd5](https://github.com/coreplanelabs/switchboard/commit/9a95dd5f320c009cfebc92a784c87bfc17a8d05a))
* **ship:** a coding child hands back deviations, follow-ups and unproven criteria as data — recorded on the run and posted to the unit's board issue ([#952](https://github.com/coreplanelabs/switchboard/issues/952)) ([16ebf14](https://github.com/coreplanelabs/switchboard/commit/16ebf141093afd87235ebb8e8b5a6bf01267c2d9))


### Bug fixes

* **resident:** the refresh instance counts its cycle in flight only past the entry gates — the idle park, the image-stale restart and the disk-full recycle fire on the Workflow path as they do on the alarm path ([#953](https://github.com/coreplanelabs/switchboard/issues/953)) ([f743c78](https://github.com/coreplanelabs/switchboard/commit/f743c78717234244c1534a46d40a040dfd8e8da1))
* **resident:** the rows the retired alarm chain armed are deleted before a resident's first event — the SDK skips a due row whose callback is gone without deleting it and re-arms for its past time at once, a hot alarm loop ([#955](https://github.com/coreplanelabs/switchboard/issues/955)) ([f42a9c6](https://github.com/coreplanelabs/switchboard/commit/f42a9c6c5da7a9fb52fc56e261a2efd92b7a10d0))

## [1.202.1](https://github.com/coreplanelabs/switchboard/compare/v1.202.0...v1.202.1) (2026-09-11)


### Bug fixes

* **deploy:** the package's bin is a committed entry that hands the process to the bundle — npm links it in the checkout too, and an unbuilt workspace says what to run instead of `sh: switchboard: command not found` ([#949](https://github.com/coreplanelabs/switchboard/issues/949)) ([41ba0b1](https://github.com/coreplanelabs/switchboard/commit/41ba0b1e155ecd1ba1aaa781fb5312eb91ec2a24))

## [1.202.0](https://github.com/coreplanelabs/switchboard/compare/v1.201.0...v1.202.0) (2026-09-11)


### Features

* **docs:** every page of the docs site gets a social card, drawn at build time from the page's own title ([#942](https://github.com/coreplanelabs/switchboard/issues/942)) ([56040ca](https://github.com/coreplanelabs/switchboard/commit/56040ca02ce5643c70eec871e6f16e69a1de9953))
* **ship:** a coding child is handed the unit's contract — its plan section, the spec rows it names, the agent rules and the guard names — and the review child checks the diff against the same block ([#945](https://github.com/coreplanelabs/switchboard/issues/945)) ([80806d1](https://github.com/coreplanelabs/switchboard/commit/80806d184dac6d870b804573093918a819121fc1))


### Bug fixes

* **resident:** a restore the runtime replacement interrupts is degraded and retried, never down — the deploy that rolls a container mid-restore no longer strands the resident until a rebuild ([#939](https://github.com/coreplanelabs/switchboard/issues/939)) ([8f6ae3d](https://github.com/coreplanelabs/switchboard/commit/8f6ae3dd7177bea20bcb572f09b429ba615047b2))


### Documentation

* **docs:** Get started tells a stranger what Switchboard is, then gets to a Slack bot in two parts — production moves to the Deploy how-to ([#948](https://github.com/coreplanelabs/switchboard/issues/948)) ([fedf02a](https://github.com/coreplanelabs/switchboard/commit/fedf02a8a752338aa90f8f4316c1fd9933a5a120))
* **docs:** the product is Switchboard and its site is switchboard.space — every copy follows project.json, and the facts check now catches a retired product domain ([#941](https://github.com/coreplanelabs/switchboard/issues/941)) ([0b7a9c7](https://github.com/coreplanelabs/switchboard/commit/0b7a9c703c7bee28edd16598ca50048f3bce7c50))
* **docs:** the site stays at openswitchboard.dev until the zone can move — the docs fact reverts, the name does not ([#946](https://github.com/coreplanelabs/switchboard/issues/946)) ([f5497ae](https://github.com/coreplanelabs/switchboard/commit/f5497aefd3b9c3ac9b8b5b66031254631e04b6d5))


### Refactoring

* **resident:** the refresh instance lives in its own module — the Workflow entrypoint, the cron's instance creation and the existence probe leave worker.ts, which re-exports the class the binding names ([#943](https://github.com/coreplanelabs/switchboard/issues/943)) ([03a2b2e](https://github.com/coreplanelabs/switchboard/commit/03a2b2ef6bd74339745095a6e8b133acb55eeaa0))

## [1.201.0](https://github.com/coreplanelabs/switchboard/compare/v1.200.0...v1.201.0) (2026-09-11)


### Features

* **web:** the dashboard wears the docs site's visual system — Instrument Sans and JetBrains Mono, neutral greys, an inverted-neutral action colour, in both modes ([#935](https://github.com/coreplanelabs/switchboard/issues/935)) ([f3d9b5b](https://github.com/coreplanelabs/switchboard/commit/f3d9b5b998ee5d295a80d1b6e728d72cf294b53a))


### Documentation

* name the exact test-file extensions the test guard reads ([#938](https://github.com/coreplanelabs/switchboard/issues/938)) ([fd7ad0c](https://github.com/coreplanelabs/switchboard/commit/fd7ad0cb25dbddae04aa9e3189597caa2740c3a5))

## [1.200.0](https://github.com/coreplanelabs/switchboard/compare/v1.19.3...v1.200.0) (2026-09-11)


### Features

* **resident:** the mirror mutex is a durable lease judged against the incarnation, and every engine step is an idempotent method a cycle can call twice ([#917](https://github.com/coreplanelabs/switchboard/issues/917)) ([4ee0c66](https://github.com/coreplanelabs/switchboard/commit/4ee0c66e4f03bb93dbf9aaf2a26f73221f1b9287))
* **resident:** the refresh cycle runs as a cron-created Workflow instance behind a per-resident lifecycle flag, with the Workflows binding, its two cost meters and the instance's root span ([#920](https://github.com/coreplanelabs/switchboard/issues/920)) ([cd9e4e9](https://github.com/coreplanelabs/switchboard/commit/cd9e4e97cb8271a63fd639d3dc96cdfffc49a837))
* **review:** a removed or narrowed test is a review finding unless its spec changes in the same PR — the test guard behind specs:coverage ([#929](https://github.com/coreplanelabs/switchboard/issues/929)) ([b2158dc](https://github.com/coreplanelabs/switchboard/commit/b2158dccdc296bfcf0f15dffa3dddee83deb4797))


### Bug fixes

* **process:** keep PR title checkout settings in sync ([#927](https://github.com/coreplanelabs/switchboard/issues/927)) ([511b5b2](https://github.com/coreplanelabs/switchboard/commit/511b5b2b9aa384de866a9710807a8eeea4d5780b))
* **process:** run each CI workflow through one orchestrator ([#924](https://github.com/coreplanelabs/switchboard/issues/924)) ([9c1263e](https://github.com/coreplanelabs/switchboard/commit/9c1263e778e532a93b9c50f4a148d01dffdfc869))


### Documentation

* **core:** record 0029 is accepted — the retry policy counts six attempts and instance ids use the platform's alphabet, corrected before the flip ([#916](https://github.com/coreplanelabs/switchboard/issues/916)) ([7049f67](https://github.com/coreplanelabs/switchboard/commit/7049f679c4f39e3c01774eb758b453f9242fd1e6))
* **core:** record 0031 — the coordinator runs a plan, a child is handed a contract and hands back a deviation, and a test cannot be narrowed without its spec; the program plan gains U16 to U19 and defers U6 and U14 ([#930](https://github.com/coreplanelabs/switchboard/issues/930)) ([dfb0ddb](https://github.com/coreplanelabs/switchboard/commit/dfb0ddb56464a833b9beaf9bc4ee39f98ecc69cd))
* **docs:** the site wears the Polylane visual system — Instrument Sans and JetBrains Mono, neutral greys, an inverted-neutral action colour, in both modes ([#928](https://github.com/coreplanelabs/switchboard/issues/928)) ([65ca6e3](https://github.com/coreplanelabs/switchboard/commit/65ca6e3f911c241f6e409883e7b793b8ad4a23dc))
* **process:** the open-source readiness plan is implemented ([#926](https://github.com/coreplanelabs/switchboard/issues/926)) ([aba6500](https://github.com/coreplanelabs/switchboard/commit/aba650024fd41f25410924466e3093c6f705946c))
* **process:** the orchestration program's U0 is superseded by trunk — units land on main behind the lifecycle flag, and the 1.2 branch, its release PR and its ruleset are retired ([#921](https://github.com/coreplanelabs/switchboard/issues/921)) ([7dbb4cf](https://github.com/coreplanelabs/switchboard/commit/7dbb4cffce1a4deca1f8b16d3637823355265096))
* **providers:** OpenRouter as a documented example — the commented config block, the how-to paragraph and a test that the block loads and builds ([#915](https://github.com/coreplanelabs/switchboard/issues/915)) ([bf1c863](https://github.com/coreplanelabs/switchboard/commit/bf1c863266d5e94795d3b455af54f0584f51dfc2))

## [1.19.3](https://github.com/coreplanelabs/switchboard/compare/v1.19.2...v1.19.3) (2026-09-10)


### Bug fixes

* **docs:** the docs site answers /favicon.ico with the mark — three PNG frames of the SVG, named in the head beside it ([#913](https://github.com/coreplanelabs/switchboard/issues/913)) ([53c2cbc](https://github.com/coreplanelabs/switchboard/commit/53c2cbccb331c1750982afdd88882c2ffba566ef))

## [1.19.2](https://github.com/coreplanelabs/switchboard/compare/v1.19.1...v1.19.2) (2026-09-10)


### Bug fixes

* **release:** the npm publish turns provenance off by name — trusted publishing generates it by default, and npm takes it from GitHub-hosted runners alone ([#904](https://github.com/coreplanelabs/switchboard/issues/904)) ([9071b12](https://github.com/coreplanelabs/switchboard/commit/9071b12f6e313690395507bf3c7c37828e768c47))

## [1.19.1](https://github.com/coreplanelabs/switchboard/compare/v1.19.0...v1.19.1) (2026-09-10)


### Bug fixes

* **release:** the npm publish carries no provenance — npm accepts it from GitHub-hosted runners alone, and CI runs on Namespace ([#903](https://github.com/coreplanelabs/switchboard/issues/903)) ([fe8425a](https://github.com/coreplanelabs/switchboard/commit/fe8425a092861dfbf81e9f4db0dba7a440f0d276))
* **release:** the release token carries the workflows permission — the tag a release creates needs it since the history collapse ([#901](https://github.com/coreplanelabs/switchboard/issues/901)) ([9d65382](https://github.com/coreplanelabs/switchboard/commit/9d65382605bb55d704177384cc4cc609a1b93411))

## [1.19.0](https://github.com/coreplanelabs/switchboard/compare/v1.18.2...v1.19.0) (2026-09-10)


### Features

* **agents:** agents are data — general, coding, review, research, ship — with budgets, not hardcoded models ([729266c](https://github.com/coreplanelabs/switchboard/commit/729266c3c90a6bbccca21775c27ba25b4ac59364))
* **channels:** Slack over Socket Mode, HTTP ingress, MCP ingress and the CLI — transports, not orchestrators ([c888b37](https://github.com/coreplanelabs/switchboard/commit/c888b372b9488720333039e08e6a451f611a4464))
* **cli:** the published package — @coreplane/switchboard bundles the CLI and the deploy inputs it runs ([3cdb00c](https://github.com/coreplanelabs/switchboard/commit/3cdb00cbb70332bc55401bf0f04c8a7d819860b7))
* **core:** the core contract — channels, providers, executors and agents as seams, one dispatcher ([ed50aef](https://github.com/coreplanelabs/switchboard/commit/ed50aef7b6686efea172a6585e9b9353020d118c))
* **deploy:** the Workers, the deployment profile and the deploy CLI — Cloudflare is the one supported target ([25d60ea](https://github.com/coreplanelabs/switchboard/commit/25d60eaff8407d3a07a19032e6ff3e3a2791de94))
* **execution:** local, E2B, Cloudflare sandbox and resident executors — tools never touch the host ([28bcbec](https://github.com/coreplanelabs/switchboard/commit/28bcbecd75dd05c2cfdc20aa83c8cab8e116567b))
* **load:** the load harness — peak concurrency from the run store, synthetic threads against a resident or the console ([d00abed](https://github.com/coreplanelabs/switchboard/commit/d00abedaed6456f45fe167c0de6d041d75676f0b))
* **providers:** Anthropic and OpenAI-compatible model providers behind one seam ([9dd2140](https://github.com/coreplanelabs/switchboard/commit/9dd21404c70769bcdd36df045f7aeb26f6de31c5))
* **tools:** GitHub over the App credential, web fetch and search, external MCP servers, vendored skills ([767d927](https://github.com/coreplanelabs/switchboard/commit/767d9275d960a5ba7f493ee2ab5dbb28ab0adc0f))
* **web:** the dashboard — run pages, the runs index, residents, costs and schedules, served from the bot's seed ([87f2e87](https://github.com/coreplanelabs/switchboard/commit/87f2e87cb7c18e176f7ef92cf366dd4e7963b6cf))


### Documentation

* **decisions:** twenty-eight architecture decision records and the plans that became them ([e2c90d0](https://github.com/coreplanelabs/switchboard/commit/e2c90d0a6cff18a135fe9a043f0e255b2f34c74b))
* **specs:** the behavioral contract — one spec per feature, every criterion bound to the test that proves it ([a8751e7](https://github.com/coreplanelabs/switchboard/commit/a8751e721e9fb7965b04083074b50813e4310b0a))
* the site and the guides — tutorials, how-tos, explanation and generated reference, in Diataxis voice ([cc8ce6b](https://github.com/coreplanelabs/switchboard/commit/cc8ce6b112d6174c90cabd4675b2d0b7119e02e7))

## [1.18.2](https://github.com/coreplanelabs/switchboard/compare/v1.18.1...v1.18.2) (2026-09-10)


### Bug fixes

* **cli:** the package ships the repository README — the npm page reads the same as GitHub ([#895](https://github.com/coreplanelabs/switchboard/issues/895)) ([c281d44](https://github.com/coreplanelabs/switchboard/commit/c281d44c78e96433c35f7bbf0ec9423585376c21))

## [1.18.1](https://github.com/coreplanelabs/switchboard/compare/v1.18.0...v1.18.1) (2026-09-10)


### Bug fixes

* **init:** the package README says what init does now — writes to ~/.switchboard, no mkdir, every command from anywhere ([#888](https://github.com/coreplanelabs/switchboard/issues/888)) ([58d02b2](https://github.com/coreplanelabs/switchboard/commit/58d02b2297da81119293ff0ecdd6984ad8e8c22a))
* **release:** the published bot image carries its build identity — the live gate can hold on a registry-mode deploy ([#890](https://github.com/coreplanelabs/switchboard/issues/890)) ([ecc607b](https://github.com/coreplanelabs/switchboard/commit/ecc607bb99322caac0d750715b175f036c969979))
* **web:** ReplyBlock drops the unused at prop — nothing read it since the facts bar ([#892](https://github.com/coreplanelabs/switchboard/issues/892)) ([ad0f414](https://github.com/coreplanelabs/switchboard/commit/ad0f414ef279c2e4dc973e59eba1f0f88d65e4b0))


### Documentation

* **core:** the orchestration program plan drops the npm next dist-tag — the default-branch publish switch decides, so a 1.2xx release never publishes the package ([#894](https://github.com/coreplanelabs/switchboard/issues/894)) ([0a030fc](https://github.com/coreplanelabs/switchboard/commit/0a030fcb5aaf8d7b11a5b470287ee93f427d6c2a))

## [1.18.0](https://github.com/coreplanelabs/switchboard/compare/v1.17.0...v1.18.0) (2026-09-10)


### Features

* **docs:** the OpenSwitchboard mark — three planes, one message routed to two lanes — in the docs header, the favicon, the dashboard and the README ([#885](https://github.com/coreplanelabs/switchboard/issues/885)) ([665b622](https://github.com/coreplanelabs/switchboard/commit/665b622fb0c83b1a4c7320fb995a91de7deec6e1))
* **init:** the installation lives in ~/.switchboard — no mkdir before init, and every command finds it from anywhere ([#882](https://github.com/coreplanelabs/switchboard/issues/882)) ([9ea1624](https://github.com/coreplanelabs/switchboard/commit/9ea1624ba79f1820a7d4b69cc8ff5780f0055e8c))
* **web:** the run page reads in three seconds — facts bar under the header, the Reply first on a finished run, the request folded to three lines ([#880](https://github.com/coreplanelabs/switchboard/issues/880)) ([c85eec1](https://github.com/coreplanelabs/switchboard/commit/c85eec1f1855de14a05ceb45a616634ef78f29ee))


### Documentation

* **docs:** the Slack thread, captured — a real review run in the README as a recording and three stills ([#883](https://github.com/coreplanelabs/switchboard/issues/883)) ([cd2b78c](https://github.com/coreplanelabs/switchboard/commit/cd2b78ca1c4a1b846386f60abb98631a06916f16))

## [1.17.0](https://github.com/coreplanelabs/switchboard/compare/v1.16.0...v1.17.0) (2026-09-10)


### Features

* **commands:** the process says which build it runs — `status show` on every surface, and the About block names it ([#878](https://github.com/coreplanelabs/switchboard/issues/878)) ([af9c754](https://github.com/coreplanelabs/switchboard/commit/af9c754927a5fed5fdf4665d35a73a73cdf6dc56))

## [1.16.0](https://github.com/coreplanelabs/switchboard/compare/v1.15.0...v1.16.0) (2026-09-10)


### Features

* **authz:** a grant for everyone on a surface — access:* and slack:* entries union with a person's own ([#873](https://github.com/coreplanelabs/switchboard/issues/873)) ([4b46c57](https://github.com/coreplanelabs/switchboard/commit/4b46c57166e7ec715cf48983bce30ceeb2d10a74))


### Bug fixes

* **web:** each time bucket has its own color, and every timestamp ends on one right edge ([#874](https://github.com/coreplanelabs/switchboard/issues/874)) ([62be6d0](https://github.com/coreplanelabs/switchboard/commit/62be6d00e15db9a136dc41d15362a742380b2ba1))
* **web:** the Tour holds still and jumps clearly — no hover growth, a persistent highlight, and a truncated diff says so instead of "not in this diff" ([#871](https://github.com/coreplanelabs/switchboard/issues/871)) ([2af293f](https://github.com/coreplanelabs/switchboard/commit/2af293fae967738ea66e5d433dbf9234151d5032))

## [1.15.0](https://github.com/coreplanelabs/switchboard/compare/v1.14.0...v1.15.0) (2026-09-10)


### Features

* **core:** every secret is a Secret — one getter, value revealed only at the boundary, a lint that forbids raw env reads ([#856](https://github.com/coreplanelabs/switchboard/issues/856)) ([ce0deff](https://github.com/coreplanelabs/switchboard/commit/ce0deff5ff2859ece5d4d26cac7aef71da9048a1))
* **review:** a review run records the PR's description as data — the TL;DR and the Tour's steps with their anchors, submitted by the coding run or parsed from the body ([#857](https://github.com/coreplanelabs/switchboard/issues/857)) ([a2e2245](https://github.com/coreplanelabs/switchboard/commit/a2e2245e02f8d05f079118c899c9cd4362164981))
* **review:** abridged reading diffs on demand — meat runs on the bot host over the PR's complete diff, never inside an execution container ([#860](https://github.com/coreplanelabs/switchboard/issues/860)) ([9ca57bb](https://github.com/coreplanelabs/switchboard/commit/9ca57bb7a326c9c06d760bbc2efac91b316b136a))
* **web:** the reading-diff panel opens on the PR's description and its Tour — each step jumps to the lines it names, and Abridge with meat asks for the reading diff ([#861](https://github.com/coreplanelabs/switchboard/issues/861)) ([33cb5ce](https://github.com/coreplanelabs/switchboard/commit/33cb5ce57192290ffcf9efa48ab1fba59efec3e2))
* **web:** the run page reads as one structure — a legible timeline, one vocabulary, links on the branch, the request folded ([#858](https://github.com/coreplanelabs/switchboard/issues/858)) ([a3a3f2a](https://github.com/coreplanelabs/switchboard/commit/a3a3f2ae8a6188d7ba7fee38cf6d7156bf33c916))


### Bug fixes

* **cli:** the first run behaves — a failed ask exits 1, dry-run always previews, help and logs read clean ([#853](https://github.com/coreplanelabs/switchboard/issues/853)) ([2e3eac7](https://github.com/coreplanelabs/switchboard/commit/2e3eac70dd3cd107fc70c174d5b79689a5162976))
* **review:** the review reads the whole merge-base diff, and a digest that covers less than the PR refuses the verdict ([#854](https://github.com/coreplanelabs/switchboard/issues/854)) ([1ea622c](https://github.com/coreplanelabs/switchboard/commit/1ea622c0bc870ba4c55d2b069888adb42b7bfb76))
* **web:** the abridge poller stops on a repeated cursor, ignores frames after dispose, and retries without a fresh model call ([#862](https://github.com/coreplanelabs/switchboard/issues/862)) ([9266073](https://github.com/coreplanelabs/switchboard/commit/926607313cc4d8815305b6a061fb2f603724053d))
* **web:** the reading-diff panel renders as a diff — gutter and inline prefixes, a file list beside the hunks, the PR's title on top, both themes ([#855](https://github.com/coreplanelabs/switchboard/issues/855)) ([823364b](https://github.com/coreplanelabs/switchboard/commit/823364bb99eab04e15320f5780cd9afde293e079))


### Refactoring

* **runs:** run readers take span-schema records only ([#846](https://github.com/coreplanelabs/switchboard/issues/846)) ([9a6cc74](https://github.com/coreplanelabs/switchboard/commit/9a6cc74002daee7d90d70ecf5076854aea2373ac))

## [1.14.0](https://github.com/coreplanelabs/switchboard/compare/v1.13.0...v1.14.0) (2026-09-10)


### ⚠ BREAKING CHANGES

* **core:** retired configuration shapes are unknown keys, not mapped refusals ([#842](https://github.com/coreplanelabs/switchboard/issues/842))

### Features

* **cli:** switchboard start runs the bot from the package — Slack from your laptop with no Docker ([#847](https://github.com/coreplanelabs/switchboard/issues/847)) ([713bc34](https://github.com/coreplanelabs/switchboard/commit/713bc3461ef746644aa1f18466daa5952bbbf03d))
* **deploy:** `deploy all` copies the release's images into the account registry itself, over HTTPS — the operator's deploy is one command and needs no Docker ([#818](https://github.com/coreplanelabs/switchboard/issues/818)) ([a6f0fcd](https://github.com/coreplanelabs/switchboard/commit/a6f0fcd437921a7582c755a546209b9d59a2d9a5))


### Bug fixes

* **process:** check:lockfile catches a root record that drifted from package.json, and the Phase 7–9 review follow-ups close ([#849](https://github.com/coreplanelabs/switchboard/issues/849)) ([af4e286](https://github.com/coreplanelabs/switchboard/commit/af4e2868ea7152267338fbc95ed9594672284467))
* **process:** the release pin may equal the manifest — the release PR carries both at the pinned version ([#850](https://github.com/coreplanelabs/switchboard/issues/850)) ([4f15507](https://github.com/coreplanelabs/switchboard/commit/4f155070c209f0b6eebb9e1e0bfc023e7e4db9b3))


### Documentation

* **agents:** record 0026 is accepted — the capability-profile design is the baseline for slice one, filed against release 1.13.0 ([#815](https://github.com/coreplanelabs/switchboard/issues/815)) ([cf01774](https://github.com/coreplanelabs/switchboard/commit/cf0177403794835ef16327a689a63d90bcc138bf))
* **core:** record 0029 — Durable Objects are the store and never the scheduler, Cloudflare Workflows schedules the resident lifecycle and later ship, and the agent loop stays in a container ([#812](https://github.com/coreplanelabs/switchboard/issues/812)) ([44548be](https://github.com/coreplanelabs/switchboard/commit/44548be93ee20fb4134847cfe98836b3b0cc9e84))
* **core:** the orchestration program plan — record 0029 as one ledger on the v1.2 board and the 1.2 line: residents on Workflows, the ship coordinator, the harness track, the inherited follow-ups ([#820](https://github.com/coreplanelabs/switchboard/issues/820)) ([ac931c7](https://github.com/coreplanelabs/switchboard/commit/ac931c7d7b1bbb139e46d64232537ec0d844dfc3))
* **core:** the orchestration program plan names the 1.2 line's branch v1.2, matching the board and the public name ([#841](https://github.com/coreplanelabs/switchboard/issues/841)) ([1ab8703](https://github.com/coreplanelabs/switchboard/commit/1ab8703b1cc6a11f3211d769e14cacd140596c5d))
* **core:** the orchestration program plan's U2 and U6 test scenarios count six attempts, matching R6 ([#838](https://github.com/coreplanelabs/switchboard/issues/838)) ([7f768f3](https://github.com/coreplanelabs/switchboard/commit/7f768f31ca2b998a87d2ba822806cb22021ee8dc))
* **docs:** README and Get started say what the commands do, and every diagram shares one visual system ([#816](https://github.com/coreplanelabs/switchboard/issues/816)) ([da1cb68](https://github.com/coreplanelabs/switchboard/commit/da1cb68f87803e1bae39498fbb1ec8b51f2a5ce7))
* **docs:** the explanation pages say the same in half the words ([#840](https://github.com/coreplanelabs/switchboard/issues/840)) ([d5605c0](https://github.com/coreplanelabs/switchboard/commit/d5605c0cae86bd7ff666bc51bf75afffb41917b6))
* **docs:** the landing hero image is eager and single-source, the residents frame fits its rows ([#844](https://github.com/coreplanelabs/switchboard/issues/844)) ([315ea50](https://github.com/coreplanelabs/switchboard/commit/315ea5005170f127f1a1b692bbb8a4733461e77b))
* **docs:** the landing page redesigned — one grotesk, large pictures, statements instead of paragraphs ([#843](https://github.com/coreplanelabs/switchboard/issues/843)) ([6c39f68](https://github.com/coreplanelabs/switchboard/commit/6c39f68280ac199c7886b1efb7b8a222ba80aa50))
* the guides lead with the npm package and say half as much ([#839](https://github.com/coreplanelabs/switchboard/issues/839)) ([f48f7bc](https://github.com/coreplanelabs/switchboard/commit/f48f7bccc00936af0f0c34912f0772d0d12d3177))


### Refactoring

* **core:** retired configuration shapes are unknown keys, not mapped refusals ([#842](https://github.com/coreplanelabs/switchboard/issues/842)) ([17c9821](https://github.com/coreplanelabs/switchboard/commit/17c9821907ff7185e81ddeaa3a0408be6d06068e))

## [1.13.0](https://github.com/coreplanelabs/switchboard/compare/v1.12.0...v1.13.0) (2026-09-10)


### Features

* **deploy:** an operator's repository deploys production from CI by calling the reusable deploy workflow ([#811](https://github.com/coreplanelabs/switchboard/issues/811)) ([87fb6a8](https://github.com/coreplanelabs/switchboard/commit/87fb6a887370ac18221bc29b9511c8215638a2a9))
* **deploy:** deploy from any directory with the published CLI — the Worker directories are materialised from the package, no checkout needed ([#804](https://github.com/coreplanelabs/switchboard/issues/804)) ([4eca6e4](https://github.com/coreplanelabs/switchboard/commit/4eca6e4f3810dc9fb642f2f7442e159b4522e20e))
* **deploy:** the release publishes three images, `deploy images` copies them into the account registry, and a profile deploys them instead of building ([#807](https://github.com/coreplanelabs/switchboard/issues/807)) ([6a76d0e](https://github.com/coreplanelabs/switchboard/commit/6a76d0e01516293533922ce107bc72f8d6b37126))


### Documentation

* **agents:** record 0026 keeps RBAC on the preset and caps the axes with admission boundaries that intersect per scope ([#801](https://github.com/coreplanelabs/switchboard/issues/801)) ([a47c6bc](https://github.com/coreplanelabs/switchboard/commit/a47c6bc46d888702de6061d3598e86015ae2e295))
* **agents:** record 0026 names the seams its boundaries extend — the policy table keeps one question, the config layers gain an intersecting setting, the authorize stage gains a gate ([#803](https://github.com/coreplanelabs/switchboard/issues/803)) ([01ab8e7](https://github.com/coreplanelabs/switchboard/commit/01ab8e73a2b4f778f6e9bba1bb981a0def673fac))
* **agents:** record 0026 orders the trace as resolve then gate and drops the last "admission" wording ([#805](https://github.com/coreplanelabs/switchboard/issues/805)) ([ebd7f51](https://github.com/coreplanelabs/switchboard/commit/ebd7f51df8274aa251003888193a3ade673e462c))
* **agents:** record 0026 takes its acceptance-read edits — bundles defined, the budget directive named and never sticky, the sticky-label decision stated ([#808](https://github.com/coreplanelabs/switchboard/issues/808)) ([bb36b9a](https://github.com/coreplanelabs/switchboard/commit/bb36b9a36d2054fc0fcc07f1728f56a2abe121a6))
* **deploy:** record 0028 — what a container image installs is a manifest per image class, rendered into the committed Dockerfile and extended by a registry-mode overlay that deploy images builds ([#810](https://github.com/coreplanelabs/switchboard/issues/810)) ([d71f815](https://github.com/coreplanelabs/switchboard/commit/d71f81523e1c362ce67e1b94765a83291d83492c))

## [1.12.0](https://github.com/coreplanelabs/switchboard/compare/v1.11.0...v1.12.0) (2026-09-09)


### Features

* **cli:** the CLI as an npm package, published on release once the owner turns it on ([#794](https://github.com/coreplanelabs/switchboard/issues/794)) ([ec170a3](https://github.com/coreplanelabs/switchboard/commit/ec170a3a26c43948e1731c1895a3caebf3c7a180))
* **docs:** OpenSwitchboard is the product name; the docs site is the project's website, not a Worker ([#795](https://github.com/coreplanelabs/switchboard/issues/795)) ([08f0b59](https://github.com/coreplanelabs/switchboard/commit/08f0b595167e7b89ba2fd46d8686afedcef5999a))
* **sandbox:** the cold sandbox image ships a Docker engine — a lazy daemon start behind the docker command ([#797](https://github.com/coreplanelabs/switchboard/issues/797)) ([ed39624](https://github.com/coreplanelabs/switchboard/commit/ed396241b75361d9183f3e8ce559d71670c12535))
* **sandbox:** the cold sandbox runs on standard-4 — 4 vCPU and 12 GiB so one thread can typecheck a large monorepo ([#796](https://github.com/coreplanelabs/switchboard/issues/796)) ([9b61e18](https://github.com/coreplanelabs/switchboard/commit/9b61e18a1ab3efca7879afae92e80ae078708949))
* **sandbox:** the read-scoped sandbox token also reads Actions and checks — CI runs, logs and the cache list without any write ([#798](https://github.com/coreplanelabs/switchboard/issues/798)) ([c1a4f52](https://github.com/coreplanelabs/switchboard/commit/c1a4f52e43d3858216233245888b6d5c9a97d107))


### Documentation

* **agents:** record 0026 — a run is a capability profile over three axes, named agents become presets, and a routing stage picks the profile ([#800](https://github.com/coreplanelabs/switchboard/issues/800)) ([a5d8f69](https://github.com/coreplanelabs/switchboard/commit/a5d8f696ca4a014361ef90649bca3243d72bead2))
* **process:** the PR title is the changelog line — the scope vocabulary is the code map's Areas, a breaking title needs its migration note ([#793](https://github.com/coreplanelabs/switchboard/issues/793)) ([f242497](https://github.com/coreplanelabs/switchboard/commit/f242497b808e7bad35a4b2951dad5fec3ac480bc))


### Refactoring

* **core:** Phase 6 closes — the settle stage, the naming and YAGNI passes, the parked nits, record 0025 ([#790](https://github.com/coreplanelabs/switchboard/issues/790)) ([f32cea7](https://github.com/coreplanelabs/switchboard/commit/f32cea75f562acc0c45ac05fe3c3cd052f93b123))

## [1.11.0](https://github.com/coreplanelabs/switchboard/compare/v1.10.0...v1.11.0) (2026-09-09)


### Features

* **cli:** switchboard init — the one-command installer ([#774](https://github.com/coreplanelabs/switchboard/issues/774)) ([233fdcb](https://github.com/coreplanelabs/switchboard/commit/233fdcbc7b1104e825e097ab14c074ade4d7efb5))


### Bug fixes

* **config:** the --efforts option describes the ladder's levels from the ladder, not a hand-typed three ([#777](https://github.com/coreplanelabs/switchboard/issues/777)) ([dd1c0ed](https://github.com/coreplanelabs/switchboard/commit/dd1c0edb1e6192f91e4b9c0d3049004b02712bf8))


### Documentation

* **docs-site:** the docs site is public — an installation that gates it uses its own Access application ([#789](https://github.com/coreplanelabs/switchboard/issues/789)) ([b67f36d](https://github.com/coreplanelabs/switchboard/commit/b67f36dd2b6acf219961c66bb76668dffa94381d))
* **readme:** badges, and the repository's description and topics become project facts ([#779](https://github.com/coreplanelabs/switchboard/issues/779)) ([1924972](https://github.com/coreplanelabs/switchboard/commit/1924972261afbfc77116e28ae0c36ea267a5eabe))
* **visuals:** render the dashboard's screenshots from the fixture preview and pin their inputs ([#771](https://github.com/coreplanelabs/switchboard/issues/771)) ([d994b51](https://github.com/coreplanelabs/switchboard/commit/d994b515c5911be30d8e1636c4ebd5cf1239f73b))
* **visuals:** the screenshot manifest pins its own module, viewport and clock; the landing's picture list is data ([#775](https://github.com/coreplanelabs/switchboard/issues/775)) ([ba4055d](https://github.com/coreplanelabs/switchboard/commit/ba4055db1386576e23d2df9bc6ae113f29116f6f))


### Refactoring

* **channels:** slack.ts and config.ts give up the concerns that stand apart (Phase 6 tidyings) ([#782](https://github.com/coreplanelabs/switchboard/issues/782)) ([ffc743f](https://github.com/coreplanelabs/switchboard/commit/ffc743f164d3751c71d2e9d4446afbf45761e1fb))
* **core:** the agent:ship fork leaves dispatch() as dispatch/ship.ts (pipeline split, PR 6 of 6) ([#784](https://github.com/coreplanelabs/switchboard/issues/784)) ([dab2646](https://github.com/coreplanelabs/switchboard/commit/dab26464838f71f5b372de70d5844017f2135ed7))
* **core:** the dispatcher's admission stage leaves as named functions (pipeline split, PR 2 of 6) ([#772](https://github.com/coreplanelabs/switchboard/issues/772)) ([e8b6715](https://github.com/coreplanelabs/switchboard/commit/e8b6715ba89535d24ac138f2065e5f453c17249a))
* **core:** the dispatcher's provision stage leaves as named functions (pipeline split, PR 4 of 6) ([#778](https://github.com/coreplanelabs/switchboard/issues/778)) ([0af3248](https://github.com/coreplanelabs/switchboard/commit/0af3248ddb9b180ddc16a86f761a49b86a519fde))
* **core:** the dispatcher's resolve and authorize stages leave as named functions (pipeline split, PR 3 of 6) ([#776](https://github.com/coreplanelabs/switchboard/issues/776)) ([93ddfed](https://github.com/coreplanelabs/switchboard/commit/93ddfedd7fb3c1f43c60df95fdb17e9aa9282942))
* **core:** the dispatcher's run stage leaves as named functions (pipeline split, PR 5 of 6) ([#780](https://github.com/coreplanelabs/switchboard/issues/780)) ([87bc6b2](https://github.com/coreplanelabs/switchboard/commit/87bc6b25e4d4bc6ac96a7b0f61c6ea947f732323))
* **core:** the run registry's parts leave as sibling modules (Tidy First) ([#785](https://github.com/coreplanelabs/switchboard/issues/785)) ([2340c28](https://github.com/coreplanelabs/switchboard/commit/2340c28c00908b5fedd2760d5f4d681c61c0cc6f))
* **core:** the ship pipeline's stages leave as files under src/core/ship/ (Phase 6) ([#783](https://github.com/coreplanelabs/switchboard/issues/783)) ([231d29e](https://github.com/coreplanelabs/switchboard/commit/231d29e7e35916a09528ce10eefb44210e16e290))

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
