---
title: What a container image installs is a manifest per image class, rendered into the committed Dockerfile and extended by an operator overlay that deploy images builds
status: proposed
date: 2026-09-10
pattern: Generated artifact (gen + check) over a declarative manifest; artifact promotion for the operator overlay
---

# What a container image installs is a manifest per image class, rendered into the committed Dockerfile and extended by an operator overlay that `deploy images` builds

**The ask.** Decide: adopt a declarative manifest per image class as the only way an image's installed contents change, rendered into the committed Dockerfile by `deploy init` and held by `deploy:check`; approve the candidate workstation set for the cold sandbox and the measurement gate that decides what of it ships; approve an operator overlay, valid in `registry` image mode only, built as a derived image by `deploy images` and never a Dockerfile edit. Owner: the maintainer. Needed before slice one of record 0026 asks the sandbox to run act, a browser or Python. Written for an engineer who knows the deploy pipeline and record 0027. The frame is assumed from the session that produced this record.

Success criteria: (1) adding a tool to every cold sandbox is one manifest line and one release, for this project and for an installation that deploys published images; (2) the committed Dockerfile equals what its manifest renders, on every PR, and the published image is never changed by an overlay; (3) the default set ships only what a measured cold-start budget admits; (4) a run's record says which image it ran on.

## TL;DR

Three hand-written Dockerfiles decide what every run can reach, and the cold sandbox lacks Python, a browser and build tools, three things the motivating investigation needed. The bet is that installed contents are configuration: a **manifest** per image class lists them, one renderer turns it into the committed Dockerfile under the gen-plus-check contract the rendered Worker configs already have, and an installation adds tools through an **overlay** manifest that `deploy images` builds into a derived image and pushes beside the published copy under a suffixed tag. The cost is a renderer, a derived-image step, and a default image several hundred megabytes larger whose cold start is measured before it ships. Decided: the manifest and its six entry kinds, the renderer, the overlay as a derived image in `registry` mode only, the candidate set and its gate. Open: the budget's number.

## Today at `bb36b9a`

| Fact the design changes or depends on | Where |
|---|---|
| Three hand-written Dockerfiles: the bot's (out of scope here; no run reaches it), the cold sandbox's (`cloudflare/sandbox:0.12.9` plus git, curl, the GitHub CLI from its own apt source with a keyring, `docker.io`, `iptables`, a copied `docker` wrapper, pnpm 10.34.5) and the resident's (`cloudflare/sandbox:0.13.0-next.751.1` plus pnpm, yarn 1.22.22, `squashfs-tools`, seventeen unprivileged users, root locked, eight `ENV` defaults for test runners) | `deploy/cloudflare-sandbox/Dockerfile`, `deploy/cloudflare-resident/Dockerfile` |
| The base ships Ubuntu 22.04, Node, Bun, git, curl, wget, jq, zip, procps; no Python (a `-python` variant adds Python with numpy, pandas, matplotlib, ipython); no browser. Ubuntu 22.04's `chromium-browser` deb is a stub that installs a snap, which a container cannot run | Sandbox SDK Dockerfile reference (documents 0.7.0); Ubuntu jammy package index |
| `check:image` runs `docker build --quiet` per Worker directory on every PR on a bare checkout (no install, no render); the publish job and wrangler build the same tracked Dockerfile; `imagePins` parses all three Dockerfiles and fails a floating package-manager version or `FROM` tag (it knows npm, pnpm, yarn and `corepack prepare`, not pip); `check:sandbox-pair` holds the base tag to the SDK version | `deploy/*/package.json` `check:image`, `.github/workflows/ci.yml`, `src/deploy/imagePins.ts:40,106-134`, `scripts/check-sandbox-pair.mjs` |
| Every `wrangler.jsonc` is rendered from a template by `deploy init` from the profile in force, is gitignored, and `deploy init --check` reports a hand edit as `stale`; `deploy all` re-renders on the deploying host, and the build stamp marks a dirty tree `<sha>-dirty`, which the sandbox live gate never treats as live | `src/deploy/wranglerTemplate.ts:32-37`, `src/core/commands/deploy.ts:320-346`, `.gitignore`, `deploy/bin/build-stamp.mjs`, release-and-deploy spec items 16–17 |
| The cold sandbox image was 320 MB before the Docker engine and 492 MB after; size was measured with `docker image inspect`, since `check:image` prints only the image id | the Docker-engine change, 2026-09-09; `deploy/cloudflare-sandbox/package.json` |
| Cloudflare caps an image at the instance's disk (20 GB) and account image storage at 50 GB; cold starts "can often be in the 1–3 second range, but this is dependent on image size", from the managed registry only | Containers limits and architecture pages; record 0027 |
| Record 0027 (accepted): the release publishes the three images to GitHub's registry; a `registry`-mode installation runs `deploy images` where Docker is (its CI), a planner that yields per image `{ source, target, present }` and copies only what is absent: `docker pull` from GitHub, `docker tag` to the bare name, `wrangler containers push`; the plan probes the account registry with `registryHas(listing, name, version)`, a tag lookup on the name's row, and fails closed naming `deploy images`; the profile's `images` is the string `build` or `registry`; `build` (this project's production) has wrangler build the tracked Dockerfile at deploy | record 0027; release-and-deploy spec items 24–25 and `src/deploy/imagesHost.ts` on its branch |
| Anything installed at run time is gone when the container sleeps after 5 idle minutes; a sandbox rollout replaces every instance in one wave, killing in-flight containers; the resident sleeps after 20 idle minutes and wakes with a restore | `src/execution/sandboxKeepalive.ts:28`, `deploy/cloudflare-sandbox/wrangler.template.jsonc`, execution spec items 1 and 6, `deploy/cloudflare-resident/worker.ts:311` |
| Nothing measures a cold sandbox's start. `dispatch.workspace.attach` wraps only the executor's construction on this tier; the container is created on the thread's first `/exec`, so the bot-side `exec.exec` span of a thread's first command is the only span that brackets the cold start today, and the Worker's own `sandbox.exec` span starts at the attempt that answered, after the "container is starting" retry. The sandbox `/healthz` reports the build commit and nothing about the image | `src/execution/factory.ts:387-427`, `deploy/cloudflare-sandbox/worker.ts:249-260`, `src/execution/cloudflareSandbox.ts:166` |
| The resident's snapshot stamp is `{ref, sha, lockfileHash}` and its deps store keys on the lockfile hash alone, both image-agnostic; a `node_modules` tree is adopted whatever image built it | `deploy/cloudflare-resident/worker.ts:1004-1007` |

## The shape

A **manifest** is a committed file per image class, `deploy/<worker>/image.manifest.json`, with six kinds of entry: `from` (the base image and tag, one entry), `aptSources` (a third-party apt repository: name, keyring URL and sha256, source line), `apt` (package names), `npm` (globals, exact versions), `pip` (packages, exact versions), `binaries` (name, URL, sha256, install path) and `files` (copied from the Worker directory, with a mode). The **renderer** (`src/deploy/imageManifest.ts`) turns a manifest into the Dockerfile: the `FROM`, one apt layer that adds the sources and installs the packages and drops the lists, the checksummed binary downloads, the copies, the npm and pip layers, then the class's **tail**, which the renderer owns as code because it is not "what is installed": for the sandbox the `COMMAND_TIMEOUT_MS` backstop, the git identity and credential helper, the Node-version assertion; for the resident the runner `ENV` defaults, the user pool, the locked root. Today's sandbox Dockerfile is about half installs and half tail; the manifest is thin at first and grows with the default set, and its value is the operator surface, not its size.

The rendered Dockerfile is **committed**, the first rendered file in this repository that is: `check:image`, the publish job and wrangler all read it from disk on checkouts that never ran `deploy init`. `deploy init` renders it beside the gitignored Worker configs and `deploy:check` fails on a hand edit exactly as it does for them; the render depends on the manifest alone, never on the profile, so a deploying host renders the same bytes the tree holds and the build stamp stays clean. `imagePins` keeps its two rules on the rendered output; the renderer adds the exactness rule for pip and the checksum rule for binaries, which `imagePins` does not know.

An **overlay** is a manifest of the same shape, named by an installation's profile, and it exists because `registry` mode has no checkout: a `build`-mode installation is a checkout and edits the manifest itself, so an overlay is valid in `registry` mode only, and `deploy plan` refuses `build` plus an overlay by name, pointing at this record. The profile's `images` widens from the string record 0027 ships to `string | { mode, base?, overlay? }`, the string a shorthand for `{ mode }`, so nothing already written changes. `deploy images` builds the overlay as a derived image and pushes it under the same image name with a suffixed tag, `<version>-<overlay hash>`; `deploy init` renders the Worker's `image` to that tag, and one pure `overlayHash(manifest)` shared by `deploy images`, `deploy init` and `deploy plan` is the only source of the suffix; the plan's probe is `registryHas(listing, name, "<version>-<hash>")`, another tag on the same row. Where the **base** comes from is a separate knob: `published` (the copy from GitHub, the default) or `built` (the tracked Dockerfile built locally in `deploy images` and pushed as `<version>`, refused unless the tree is clean at the release commit, so `<version>` keeps one meaning). `deploy images`'s planner gains a third source beside the pull, `derive`, ordered after its base and executed through the same host seam and skipped when its target tag is present, so the command keeps its contract: make the registry hold every image the rendered configs reference, idempotently.

The closest known shape is an image generated from a declared package closure, as Nix or Bazel do: the declaration is the source, the Dockerfile an artifact. The one way this differs: the artifact is committed and checked, because three consumers read it from disk on bare checkouts.

The candidate default set for the cold sandbox is the workstation an investigation expects and the base lacks: `python3`, `python3-pip`, `python3-venv`, `build-essential`, `ripgrep`, `sqlite3`, `dnsutils`, `imagemagick`, Google Chrome stable from Google's apt source (an `aptSources` entry; Ubuntu's own `chromium` cannot be installed in a container), and the `act` binary by checksum; plus everything the Dockerfile installs today. Guessed at 600 to 900 MB on top of 492 MB, with Chrome and its libraries 300 to 400 MB of it and build-essential about 200 MB; measured, not assumed, before any of it ships.

## One trace

The case most likely to be wrong: a `registry`-mode installation adds a tool, and the cold sandbox tier must start containers from the derived image on the critical path of every cold run.

1. The operator adds `{ "apt": ["poppler-utils"] }` to the overlay manifest their profile names and pushes.
2. Their CI runs `deploy images` (Docker present). It lists the account registry, finds `switchboard-sandbox` with tag `1.13.0` present and tag `1.13.0-7f3a1c` absent (`overlayHash`: sha256 of the canonicalized manifest, first six hex digits).
3. `deploy images` renders a two-line Dockerfile in a temporary directory, `FROM switchboard-sandbox:1.13.0`, and the overlay's apt layer. The base must be in the runner's daemon: when the copy ran in this invocation it already is; when the base is present in the registry but the runner is fresh, the derive step re-runs the base's own source locally without pushing (pull from GitHub and retag for `published`, build the tracked Dockerfile for `built`), so no login to the account registry is ever needed and the bytes are the copy's. It builds, tags `switchboard-sandbox:1.13.0-7f3a1c` (the bare name wrangler namespaces under the account), pushes with `wrangler containers push`, lists again and refuses unless the tag appears.
4. `deploy init` renders the sandbox Worker's `image` as the suffixed tag and a Worker var `IMAGE_TAG` with the same value (a new field on the template view and a `vars` block the sandbox template does not have today); `deploy plan` probes the registry for the tag and fails closed if it is missing, naming `deploy images`, as record 0027 does for the copy.
5. The sandbox Worker deploys; the rollout replaces instances in one wave, killing in-flight cold sandboxes as any image change does today.
6. A cold run starts. The container pulls `1.13.0-7f3a1c` from the managed registry, cached and pre-fetched. The first `/exec` answer carries `coldStartMs`, the Worker's own timing of the SDK's first exec including its "container is starting" retry (the measurement instrument this record adds); the sandbox `/healthz` reports `image: "1.13.0-7f3a1c"` beside the build commit.
7. The run's shell has `pdftotext`. The card and the record carry `image: switchboard-sandbox:1.13.0-7f3a1c`.
8. A later `deploy images` for the same version and overlay lists, finds both tags, and does nothing. A changed overlay is a new hash and a new tag; the old tag stays until the operator deletes it, as record 0027 says of versions. The hash covers the manifest, not the base: a derived tag goes stale only if the operator deletes and re-copies the version's base, which the copy's idempotence otherwise never does.

The property the trace proves: an operator changes what every cold sandbox has installed without a checkout, a Dockerfile or Docker anywhere but their CI, the published image and its attestation are untouched, and the run says which image it ran on.

## The difficulty map

Ranked by risk of being wrong.

1. Size against cold start on the tier that starts a container per cold run, with no baseline measured today. Section "The default set and its budget."
2. The overlay as a derived image: a build inside `deploy images`, one shared hash, the tag on `/healthz`, provenance honesty. Section "The overlay."
3. The renderer as a faithful gen-plus-check with a committed output and a code-owned tail. Section "The renderer."
4. Apt is unpinned by design; what a rebuild changes must be visible. Inside "The renderer."
5. Moving both Dockerfiles onto the renderer and keeping `imagePins`, `check:sandbox-pair` and `check:image` green. Most work, least risk; the plan owns it.

## The default set and its budget

The constraint: the cold sandbox tier starts a container per cold run and per thread that fell off its resident, each pulling the image from the managed registry, and Cloudflare says cold start depends on image size without saying how. The Docker change grew the image 54 percent and nobody measured the effect, because nothing times a cold start on this tier: the attach span wraps object construction, and the container is created on the first command.

The design: the default set ships behind a measurement with a baseline, and the measurement has an instrument. The sandbox Worker times the SDK's first exec on a fresh thread, retry included, and returns it as `coldStartMs` on that `/exec` answer and as an attribute on its span; today its span starts at the attempt that answered, so the retry a cold container costs is exactly what it misses. A fresh thread key is a cold container by construction. The measurement is `coldStartMs` over twenty fresh threads, p50 and p95, at three images: today's 492 MB, plus Python and build tools, plus Chrome. The baseline at 492 MB is measured first, before any manifest change, so the trade has a starting number. The budget is decided from those numbers, written into the spec row, and the candidate set is trimmed until it fits; what is approved here is the candidate and the gate, not a final list.

Invariants: every PR that changes a manifest records the rendered image's size (`check:image` gains a `docker image inspect` line; today it prints only the id) and the apt package list it resolved; the spec names the cold-start budget as a number with the measurement that set it; a manifest change that crosses the budget is refused at review. An overlay is outside the budget: it is the installation's own trade, and its size shows on the same `deploy images` output.

Failure mode: the measurement shows Chrome alone breaks the budget. Then Chrome is the first overlay entry this project documents, installed where a deployment wants it, and the default stays at Python, build tools, ripgrep, sqlite, dnsutils, imagemagick and act.

## The overlay

The constraint comes from record 0027: a `registry`-mode installation has no checkout and no Docker where `deploy all` runs, so "edit the Dockerfile" is not available to it, and the published image must stay the attested artifact the release produced. Docker exists in one place for such an installation, the CI runner where `deploy images` copies images. A `build`-mode installation has the opposite shape, a checkout wrangler builds from, and anything a profile rendered into the tracked Dockerfile would dirty the tree at deploy and fail the sandbox live gate; so an overlay is a `registry`-mode feature only, and a checkout changes the manifest.

The design: the overlay is a manifest the profile names inside `images: { mode: "registry", base?, overlay }`; `deploy images` builds a derived image `FROM` the local base, tags it under the same name with the `<version>-<hash>` suffix, and pushes it with the code path the copy already uses; `deploy init` renders the Worker's `image` and an `IMAGE_TAG` var to that tag; `deploy plan` probes for the tag with the existing lookup and refuses `build` plus an overlay by name. One pure `overlayHash(manifest)`, canonical JSON (sorted keys, no whitespace), sha256, first six hex digits, with tests, is the only source of the suffix for all three commands. The derived image carries no attestation: the release attests the published base, and the hash in the tag is a content identity for the manifest, not a build attestation; a `built` base carries none either, which is one reason it is refused off a clean release-commit tree. Only the sandbox and resident classes take an overlay.

Invariants: `deploy images` is idempotent over version and overlay hash; a plan whose overlay tag is absent fails closed naming `deploy images`; an overlay never changes the tracked Dockerfile, the published image or its tag; the same renderer produces the overlay's layer and the default layer, so an entry means the same thing in both; `/healthz` and the run record name the tag.

Failure modes: the overlay names an apt package that does not exist, and `deploy images` fails at build with apt's own error before anything deploys; the operator deletes the derived tag, and the next plan refuses with the message a missing copy gets; a resident under an overlay adopts a deps-store tree built on the un-overlaid image (the store keys on the lockfile hash alone), and a native module compiled against different system libraries fails at load. The last is the real resident risk, and the reason the overlay reaches the resident only after its deps store keys on the image tag as well as the lockfile.

The alternative it beats: a raw two-line Dockerfile in the operator's CI. It is what `deploy images` renders internally, and an operator could write it by hand. The manifest wins on three counts: its entries are validated (exact versions, checksums, known sources) where a Dockerfile line is not; an operator cannot override the tail (the timeout backstop, the users, the runner defaults) by accident; and an overlay entry is the same vocabulary as the default set, so a tool proven in one installation moves into the default by copying a line.

## The renderer

The constraint: the Dockerfiles carry things that are not "what is installed" (the sandbox's timeout backstop and Node assertion, the git identity, the resident's runner defaults, users and locked root, and the comments that explain each), and three consumers read the Dockerfile from a bare checkout, so the render must be committed and profile-independent.

The design: the renderer owns a fixed tail per class as code; the comments move into the renderer's source, and the generated header sends a reader there. The manifest expresses installs and copies through the six kinds. Apt entries are unpinned by design: Ubuntu's archive does not serve old versions, every build re-resolves (wrangler rebuilds on every deploy, `check:image` on every PR, the publish job on every release), and pinning would need snapshot mirrors. Drift is made visible instead of prevented: the size and package-list lines `check:image` gains show what a rebuild changed. npm and pip entries carry exact versions; binaries carry a sha256 the rendered `RUN` verifies; apt sources carry the keyring's sha256.

Invariants: `deploy:check` fails when the committed Dockerfile differs from the render; `imagePins` passes on the rendered output with no rule change; `check:image` builds the rendered Dockerfile from the same context as today; the existing Dockerfile-text tests (`sandboxDocker.test.ts`, `imagePins.test.ts`) run against the render and keep asserting the apt layer drops its lists in the same `RUN` and the wrapper is copied with its mode.

Failure mode: a base image bump changes what apt resolves and a rebuild picks up a different Chrome. That is today's behavior for every apt package, now visible on the package-list line.

## Why not X

**Why not just edit the Dockerfile? It is one file per image.** Two of the three drifted once (`pnpm@latest` moved a major, caught by provisioning failures and only then by a test), and a `registry`-mode installation has no Dockerfile to edit and no Docker where it deploys.

**Why not a raw `FROM` Dockerfile overlay in the operator's CI?** It works and it is what the renderer produces internally; the manifest adds validation, protects the tail, and keeps one vocabulary between an overlay and the default. Answered in full in "The overlay."

**Why not Cloudflare's `-python` base variant?** Its pins (numpy, pandas, matplotlib, ipython) are not ours, it has no browser, and it leaves operators where they are today.

**Why not install at run time?** Gone after five idle minutes; minutes per run; network on the critical path. It stays the answer for a tool used once.

**Why not one image for both classes?** The resident's tail (user pool, runner defaults, no `gh`) is deliberately different, and the resident pays size on every wake from its 20-minute sleep as well as in storage. Two manifests, one renderer.

## Boundaries of the design

Not in scope: per-repository tools on a resident (the onboard table's install and build commands stay the way a repository gets its toolchain); the bot's image; which registry the release publishes to (record 0027). Compatibility: `build` mode without an overlay renders exactly today's Dockerfiles plus the default set; a deployment without an overlay sees one image per version as before.

## What would change our mind

| Assumption | Cheapest test | When |
|---|---|---|
| Cold start scales gently enough with image size that a workstation image fits a budget worth having | the three-size measurement, baseline first | before the default set merges |
| `wrangler containers push` accepts a locally built derived image tagged under the bare name the same way it accepts the retagged copy | one push of a two-line derived image in a test account | before the overlay ships |
| Google's apt source installs Chrome with its libraries on the base without a display server | one `check:image` build with the entry | slice two |
| Unchanged manifests rebuild to the same apt packages often enough that the package-list line is quiet | the line itself, over the first month | continuously |

Reversibility: the renderer can be abandoned by keeping its last output as the Dockerfile; an overlay is one profile field and one extra tag.

## Rollout

Slice one: the renderer, both manifests expressing today's Dockerfiles (identical modulo comment lines, which move into the renderer), `deploy:check` covering the committed render, `imagePins` and `sandboxDocker` tests running on it, the size and package-list lines on `check:image`. Slice two: `coldStartMs` on the Worker, the baseline and three-size measurement, then the default set trimmed to the budget, with the spec row. Slice three: the `images` object form with `base` and `overlay`, the `derive` and `build` sources in `deploy images`, `overlayHash`, the `IMAGE_TAG` var on `/healthz` and the record, and the plan's refusal of `build` plus overlay, after record 0027's PR C has landed the reusable deploy workflow it rides in; the resident takes an overlay only after its deps store keys on the image tag. Each slice through the review loop; the release-and-deploy and execution specs change in the same PRs.

## Open questions

| Question | Owner | Resolves it | Before |
|---|---|---|---|
| The cold-start budget's number | maintainer | the baseline and three-size measurement | slice two |

## Validation criteria

| Criterion | Proof |
|---|---|
| The committed Dockerfiles equal the render of their manifests; a hand edit fails `deploy:check`; the render does not read the profile | `[gap]` slice one: `src/deploy/imageManifest.test.ts`, `deploy init --check` |
| `imagePins` holds its two rules on the rendered output; the renderer refuses a non-exact npm or pip version, a binary or apt source without a sha256 | `[gap]` slice one: `src/deploy/imagePins.test.ts`, `imageManifest.test.ts` |
| `check:image` prints the image size and the apt package list | `[gap]` slice one: an `[agent]` row on a PR's CI log |
| `coldStartMs` on a fresh thread's first `/exec` answer includes the container-starting retry; cold start p50 and p95 at three image sizes, twenty fresh threads each, baseline first | `[gap]` slice two: `deploy/cloudflare-sandbox/worker.test.ts`; human-gated: the measurement PR's receipts |
| `overlayHash` is one pure function used by three commands; `deploy images` re-runs a missing base's source locally, builds from it, pushes and re-finds the suffixed tag; the plan fails closed without the tag and refuses `build` plus overlay by name; the string profile form still parses as `{ mode }`; `/healthz` and the run record name the tag | `[gap]` slice three: `src/deploy/images.test.ts`, `deploy/cloudflare-sandbox/worker.test.ts`, an `[agent]` row against a test account |

## Sources

- [0027](0027-images-copied-into-the-account-registry.md), [0021](0021-records-are-immutable-specs-are-checked.md), [0023](0023-one-production-target.md).
- Specs: [release-and-deploy](../reference/specs/release-and-deploy.md) items 16, 17, 20, 21, 24, 25; [execution](../reference/specs/execution.md) items 1, 6, 16, 17.
- The Docker-engine change's size measurement (320 to 492 MB) and the live probes of the production sandbox, 2026-09-09.
- Cloudflare Containers limits and architecture pages; the Sandbox SDK Dockerfile reference; the Ubuntu jammy package index for `chromium-browser`.
