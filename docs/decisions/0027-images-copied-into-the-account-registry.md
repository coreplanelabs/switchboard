---
title: Published images are copied into each installation's Cloudflare registry once per version, never pulled at runtime
status: accepted
date: 2026-09-09
pattern: Artifact promotion
---

# Published images are copied into each installation's Cloudflare registry once per version, never pulled at runtime

## Context

Three container images run an installation: the bot, the resident and the sandbox. This project's own production builds them at deploy time — wrangler reads each Worker's Dockerfile, builds it where `deploy all` runs, and pushes the result into the account's Cloudflare registry. That shape needs a checkout and Docker on the deploying machine. An operator installing from the published package has neither, so their Workers must reference images somebody else built: the release publishes all three to GitHub Container Registry, with provenance and an SBOM.

Where a Worker's `image` may point is Cloudflare's rule, not ours. Containers pull from the Cloudflare managed registry, Docker Hub, Amazon ECR and Google Artifact Registry. GitHub Container Registry is not on the list, and a live attempt confirmed it: a Worker whose `image` was a public `ghcr.io/…` reference uploaded fine and then failed with `IMAGE_REGISTRY_NOT_CONFIGURED` at application creation. The same Worker pointed at the same image on Docker Hub created its application and served traffic after a rollout.

Two facts about external pulls decide the rest. Cloudflare does not cache an image pulled from Docker Hub: every container start fetches it again, and a Docker Hub pull is subject to Docker Hub's rate limits. The observed cold start for a small Docker Hub image was 14 s; the 1–3 s range in Cloudflare's documentation, and its global pre-fetch, apply to the managed registry only. The sandbox tier starts a container per thread and a cold one per run when no resident serves the repository — dozens of starts in a busy hour, each a full pull of a large image from a rate-limited registry, on the critical path of every run.

## Decision

The release publishes to GitHub Container Registry only — the bot's image as `ghcr.io/<owner>/<repo>`, the resident's and the sandbox's under that name plus `-resident` and `-sandbox`, all three at the release version.

An installation that deploys published images copies them, once per version, into its own Cloudflare account registry: `deploy images` reads what the registry holds, pulls each missing image from GitHub, tags it under its bare name and pushes it with `wrangler containers push`, then lists the registry again and refuses unless every copy appears. It runs where Docker is — a CI runner, and in the next step of this series the reusable deploy workflow — and is idempotent, so running it before every `deploy all` costs one registry read when nothing is new.

The Worker configs reference the copy. The deployment profile gains an image mode: `registry` renders each container's `image` as `registry.cloudflare.com/<account>/<name>:<version>`, `build` (the default when absent) renders the Dockerfile wrangler builds, as before. The version is the CLI's own, because a release publishes its images and its CLI under one number. In `registry` mode `deploy plan` and `deploy all` fail closed: a planned Worker whose image is not in the account registry is refused, naming the image and `deploy images`.

At runtime nothing pulls from outside Cloudflare. Every container start, cold sandboxes included, pulls from the managed registry — cached and pre-fetched, the path this project's own production has always relied on.

## Consequences

- An operator's deploy needs Docker in exactly one place, their CI, and only for the copy; `deploy all` builds nothing and can run anywhere wrangler runs.
- A release is three published images plus one npm package under one version; a fork publishes under its own owner without editing the workflow, and `check:project-facts` holds `project.json`'s `images` to the names the workflow derives.
- The account registry accumulates one copy of each image per version deployed. Cleanup is the operator's (`wrangler containers images delete`); nothing here removes an old version.
- This project's own production is unchanged: its profile stays in `build` mode, the release still builds the Dockerfiles with wrangler, and a failed image publish still does not block its deploy. Switching production to `registry` mode is a later decision, taken once the operator path is proven live.
- Two facts must agree for a copy to be pullable: the tag pushed must match the version the config references, which is why both come from the same `packageVersion()` and why the plan probes the registry before deploying rather than trusting that the copy happened.

## Alternatives rejected

- **Reference the GitHub Container Registry image directly.** Cloudflare refuses it: `IMAGE_REGISTRY_NOT_CONFIGURED`. Not a configuration gap on our side — the registry is not among the supported sources.
- **Publish to Docker Hub as well and reference it directly.** It works, and it was the plan for a day. Rejected on the spike's numbers: an uncached pull per container start (14 s cold for a tiny image, more for ours), Docker Hub's pull limits on the critical path of the sandbox tier, and a second publish target with its own credential and namespace to provision. The copy costs one pull per version per account instead of one per container start.
- **Build in the operator's CI, as our production does.** Needs a checkout of the repository at the release tag and a Docker build of three images on every deploy — the shape the npm package exists to remove — and loses the provenance chain from the published, attested image.
- **Have `deploy all` copy the images itself.** It would make `deploy all` need Docker, which is the requirement being removed; the copy is a separate, idempotent step with a separate failure mode (registry credentials, Docker) that is better refused on its own.

## Pattern

Artifact promotion: the release builds and attests an artifact once, and each environment promotes that exact artifact into the store it deploys from rather than rebuilding it or pulling it across a boundary at runtime. The account registry is the per-installation cache the platform is designed around; the copy is what fills it.
