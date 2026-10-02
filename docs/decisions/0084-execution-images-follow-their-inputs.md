---
title: Execution images follow their build inputs across Worker releases
status: accepted
date: 2026-10-01
pattern: Content-addressed deployment artifact
---

# Execution images follow their build inputs across Worker releases

## Context

The resident and sandbox Dockerfiles contain their toolchains. Their Workers change more often than those images. A release still publishes all three GHCR images at its release version, and the bot image must change with each commit because it embeds the build identity. Previously, `registry` mode copied every selected image into the Cloudflare account under the release version. That gave an unchanged execution image a new reference, so a Worker script update also caused a multi-minute container rollout. A copied image takes minutes even when the registry can reuse some blobs.

## Decision

Keep GHCR release tags and attestations. In each account registry, keep the bot image at the release tag. Tag resident and sandbox images by a SHA-256 hash of the Dockerfile, every local `COPY` input, and `.dockerignore` when present. The first deploy of an input set copies the published release image to that tag and verifies its manifest digest. Later releases with the same inputs reference the existing tag and copy nothing. The tag is never overwritten by the ordinary deploy path.

If an input is missing or the Dockerfile uses a source the input reader cannot classify, use the release tag and the ordinary copy and rollout. This errs toward an extra rollout. A changed Dockerfile, copied file or container configuration still deploys through Wrangler's normal rollout. When only Worker code changes and the image reference and container configuration stay the same, Wrangler deploys the Worker without a container rollout. The existing live gates still require the new Worker commit; the sandbox gate also checks the application and running instances and completes an `echo ok` probe.

This amends the account-registry tagging decision in records 0027 and 0030: the bot remains once per version, while execution images are once per set of build inputs. Their GHCR release publication and the registry-to-registry transfer remain as decided there.

## Consequences

- The first deployment of these tags still copies and rolls resident and sandbox images. Subsequent Worker-only releases avoid those copies and rollouts.
- An existing account registry tag must remain available while a Worker references it. Registry cleanup must retain running image digests and their tags.
- Identical build instructions can resolve changing external packages on separate build dates. Reusing the first copied image fixes the deployed bytes until a Dockerfile or copied input changes; each GHCR release image still has its own attestation.
- A live release must confirm that Wrangler reports no container change and that the sandbox gate passes. Timings from the first qualifying release are the speed receipt.

## Alternatives

- Rebuild and recopy every image at every release: preserves release-number symmetry but spends minutes on the same execution toolchain.
- Reuse the prior release's tag: fails after multiple Worker-only releases and cannot safely infer which older tag the account still holds.
- Suppress every rollout with `--containers-rollout=none`: would hide a real container configuration change. The unchanged reference lets Wrangler decide from the effective configuration.
