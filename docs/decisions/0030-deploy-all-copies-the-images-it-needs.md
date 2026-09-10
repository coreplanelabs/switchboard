---
title: deploy all copies the images it needs into the account registry itself, over HTTPS, and the operator's whole deploy is one command
status: accepted
date: 2026-09-10
pattern: Artifact promotion, folded into the one deploy command
---

# `deploy all` copies the images it needs into the account registry itself, over HTTPS, and the operator's whole deploy is one command

## Context

Record 0027 decided that an installation deploying published images copies them once per version into its own Cloudflare account registry, never pulling from outside Cloudflare at runtime. It also decided how: a separate command, `deploy images`, running `docker pull`, `docker tag` and `wrangler containers push` where Docker is — a CI runner — with `deploy plan` and `deploy all` failing closed in `registry` mode when a planned Worker's copy was absent, naming that command. The reasoning was explicit: the copy needed a container daemon, `deploy all` should not, so the copy had to be a step of its own with its own failure mode.

That premise fell. A spike against a throwaway account moved an image from GitHub Container Registry into `registry.cloudflare.com/<account>/…` over plain HTTPS: a push+pull credential minted from the Cloudflare API token (`POST /accounts/<account>/containers/registries/registry.cloudflare.com/credentials`, used as HTTP Basic), the source's manifest and blobs by digest with an anonymous pull token, chunked uploads where every part but the last is at least 5 MiB, the manifest pushed under its source media type, digests identical on both sides. No daemon, no wrangler push. The one requirement it surfaced is on the token: the credentials endpoint answers 403 to a token without **Containers Edit**.

With the copy needing only Node and the token, the product owner decided the operator's deploy is one command — the published CLI's `deploy all`, from any directory — and nothing in it needs Docker. Two steps that must run in order, where the second refuses without the first, is a process an operator has to know; one command that does what it needs is a product.

## Decision

`deploy all` performs the copy itself. In `registry` mode, after the plan and before anything deploys, it copies each planned Worker's image that the account registry lacks at the CLI's version — the same planner `deploy images` uses (which images, which present, which to copy), narrowed to the planned Workers — then reads the registry back and rebuilds the plan on that listing, so the runner receives a plan whose every image is present and no Worker whose container cannot start ever rolls. `deploy all --dry-run` computes the plan and says what it would copy, copying and deploying nothing.

`deploy plan` reports and never refuses: its `Images:` line counts the present images and says `deploy all` copies the rest (`2 of 3 present; deploy all copies the rest`), naming each image `present` or `missing`. It stays read-only.

`deploy images` stays as the explicit sub-step — pre-warming a registry before a deploy window, or a CI job that wants the copy on its own — and the reusable deploy workflow keeps calling it before the plan as a convenience; `deploy all` would do the same copy without it.

The copy is a registry-to-registry transfer inside the CLI over the OCI distribution API, the way crane and skopeo work: the credential minted once per account from `CLOUDFLARE_API_TOKEN` for 45 minutes with push and pull; the `linux/amd64` manifest selected from the source's index (attestation manifests skipped); each blob checked by `HEAD` and, when absent, streamed from the source into chunked `PATCH` parts of 64 MiB — every part but the last at least 5 MiB, the registry's rule — with its sha256 computed as the bytes pass and compared before the commit; one retry per part; the manifest pushed byte-identical under the source's media type and its digest read back. One part's bytes are in memory at a time, never a whole layer.

The token contract is stated where the token is made: the Cloudflare API token an operator deploys with needs Containers Edit, and a 403 from the credentials endpoint is refused by that name before anything moves.

**What this amends in record 0027.** Exactly the mechanics, not the decision. 0027's decision — copy once per version into the account registry, reference the copy, never pull at runtime — stands and this record depends on it. Three sentences of 0027 no longer describe the code: the copy is not `docker pull` / `docker tag` / `wrangler containers push` and does not run "where Docker is"; `deploy plan` and `deploy all` do not fail closed naming `deploy images`; and the rejected alternative "Have `deploy all` copy the images itself — it would make `deploy all` need Docker" is now the decision, because the reason it was rejected is gone. 0027 is not superseded as a whole: a reader of its Context, its Decision's first and last paragraphs and its Pattern reads what is still true, and `decisions:check` asks a superseded record to name one replacement for everything it said, which this record is not. So 0027 keeps `status: accepted` unedited, and this record names the sentences it amends.

## Consequences

- The operator's deploy needs Node and a Cloudflare API token with Containers Edit, wherever it runs — a laptop, any CI. Docker appears nowhere in the operator path; it remains a requirement of `build` mode only, which is this project's own production and any checkout that builds its Dockerfiles.
- `deploy all` in `registry` mode reads the account registry twice when it copies (the plan, then the proof) and once when it does not; `deploy images` before it costs one more read and makes `deploy all`'s copy a no-op. The reusable workflow keeps that shape.
- A copy is a network transfer measured in minutes for the largest image; the credential's 45 minutes bound it. A part that fails is retried once, then the copy stops naming the part — the same failure surface as before, now inside `deploy all` and before any Worker rolls.
- The copy's correctness rests on digests, not on a listing: each blob is committed only when its streamed sha256 equals the manifest's, and the manifest is verified by the digest the registry reports. The listing read back is the plan's input, not the proof of the bytes.
- `deploy all` selecting only Workers whose images are present (or without a container) copies nothing and mints no credential, so a `--only memory` deploy from a token without Containers Edit still works.

## Alternatives rejected

- **Keep the two-step contract and only drop Docker from `deploy images`.** Removes the daemon but leaves the operator two commands in a fixed order with a refusal between them; the owner's decision is one command.
- **Supersede record 0027 as a whole.** Most of it is still the reasoning behind the code — why the account registry, why not Docker Hub, why not a direct pull — and a superseded record reads as retired. Amending three named sentences keeps that reasoning live and says exactly what changed.
- **Mint the registry credential through wrangler (`wrangler containers registries credentials`).** The same API call, one process spawn further away, in the bot Worker's directory that must be materialised and installed first; the CLI calls the API directly with the token wrangler would have used.
- **Cross-repository blob mounts.** The spike showed the account registry accepts and ignores `mount=`; blobs re-upload regardless, so the copy never asks for one.
- **A monolithic `PUT` of each blob.** Works for small blobs; a gigabyte layer over one request has no retry granularity and no bounded memory. Chunked parts give both, at the cost of respecting the 5 MiB rule.

## Pattern

Artifact promotion, folded into the deploy: the release builds and attests an artifact once; the deploy command promotes exactly that artifact into the store it deploys from — checking presence, moving what is missing, verifying digests — as the first step of deploying, rather than as a separate process the operator is asked to run.
