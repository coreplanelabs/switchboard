# Resident container image: the @cloudflare/sandbox base (Ubuntu 22.04; already
# ships git, curl, jq, Node 24, npm, bun, cloudflared) plus GitHub tooling and
# a pool of unprivileged users.
# The tag MUST match the @cloudflare/sandbox version in package.json exactly
# (no 'latest' tag exists on the @next line) — bump both together.
FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1

# Git identity only. The engine never uses the gh CLI (ops run git directly,
# tokens are minted via the GitHub REST API in the Worker/DO, and per-attach
# credentials use a repo-local `store` helper), so gh is deliberately NOT
# installed here — matching the resident system prompts and the tests that pin
# that claim. No system credential.helper is configured; each worktree sets its
# own per-attach helper.
RUN git config --system user.name "switchboard-resident" \
  && git config --system user.email "switchboard-resident@users.noreply.github.com"

# The container is ONE vCPU (wrangler.jsonc). Node test runners size their
# worker pools from the CPU count the kernel reports — the HOST's, not the
# cgroup's — so an unconfigured `vitest`/`jest` run forks a dozen workers onto
# one core and thrashes (seen live: a resident pinned at 100% CPU, 2.2 GiB).
# These defaults inherit into every thread's `su … -c` shell (su without `-`
# keeps the environment) and are the runners' documented env knobs; a repo's
# own config or CLI flags still win. CI=1 makes runners non-interactive (no
# watch mode, no TTY progress spinners in captured output). The heap cap keeps
# one runaway process from taking the whole 4 GiB from its neighbours.
ENV CI=1 \
    VITEST_MAX_WORKERS=1 VITEST_MAX_THREADS=1 VITEST_MAX_FORKS=1 VITEST_MIN_THREADS=1 VITEST_MIN_FORKS=1 \
    UV_THREADPOOL_SIZE=2 \
    NODE_OPTIONS=--max-old-space-size=1536

# pnpm + yarn: the base ships Node 24 + npm + bun but neither pnpm nor yarn, so a
# repo whose onboard table is detected as pnpm or yarn (resident-repos item 52 —
# every manager `detectCommands` can emit must exist here, or the table fails
# deterministically at provision) couldn't be provisioned (install → build).
# corepack is NOT on this base's PATH (unlike the older sandbox base), so both
# come from npm at build time. yarn here is classic (1.x); a Yarn Berry repo
# bootstraps through it via the `yarnPath` release it commits under
# `.yarn/releases`.
#
# EXACT versions, enforced by src/deploy/imagePins.test.ts. This line once read
# `pnpm@latest yarn@latest`, which made the pnpm major a property of the last
# image build: one rebuild moved it 10 -> 11 unannounced, and pnpm 11 no
# longer reads `package.json`'s `pnpm` field (overrides,
# patchedDependencies, onlyBuiltDependencies), so a repo keeping its settings
# there fails `--frozen-lockfile` with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
# pnpm is pinned to the 10 line ON PURPOSE: 10.x reads that field, and pnpm
# >=10 self-manages `packageManager`, so a repo pinning 11/12 still gets its
# own version — the pin is a floor, not a ceiling. Which means the version
# baked here is NOT necessarily the one that runs: a repo with a
# `packageManager` field downloads that version on first install (a repo
# pinning pnpm@10.10.0 gets exactly that), so provisioning needs the registry,
# not just the image. The grep asserts the pin took, so a resolution surprise
# fails the build instead of a provision.
RUN npm install -g pnpm@10.34.5 yarn@1.22.22 \
  && pnpm --version | grep -qx '10\.34\.5' \
  && yarn --version | grep -qx '1\.22\.22'

# squashfs-tools (`unsquashfs`): the SDK's presigned restore does not extract
# an archive, it MOUNTS it (squashfuse + fuse-overlayfs at the handle's dir)
# and leaves the `.sqsh` under /var/backups — resident-repos item 61. The
# resident extracts the archive onto its ext4 disk instead (the SDK's own
# local-dev method) so the mirror, the checkout and the deps store stay one
# filesystem: `rm -rf` works, hardlink views work, `du -x` is right. The
# Worker falls back to `cp -a` out of the mount while an older image lacks it.
# The build asserts the binary with the probe the extract script uses at run
# time (`command -v`): `unsquashfs -version` exits 1 on squashfs-tools 4.5 (this
# base) when no filesystem is named, and failed the 1.2.0 image build that way.
RUN apt-get update \
  && apt-get install -y --no-install-recommends squashfs-tools \
  && rm -rf /var/lib/apt/lists/* \
  && command -v unsquashfs >/dev/null

# Agent commands never run as root (repo code runs unprivileged, one user per
# thread — features/resident-repos.md). The SDK's exec has no user/uid option
# (verified against 0.13.0-next.751.1), so the container server itself runs as
# root and per-command demotion is done with `su -s /bin/bash workerN -c ...`
# (verified live: exec via su lands at uid 200N). Provision a pool of
# unprivileged users — one per resident cap slot — and shut the escalation
# paths back up:
#   - sudo: not installed in the base image; purge defensively in case a later
#     base bump adds it.
#   - su back to root: root's password is locked, so workerN -> root fails.
# `su` itself must stay (it is the demotion mechanism, used only by root).
RUN set -eux; \
    for i in $(seq 1 17); do useradd -m -u "$((2000 + i))" -s /bin/bash "worker$i"; chmod 700 "/home/worker$i"; done; \
    if dpkg -s sudo >/dev/null 2>&1; then apt-get remove -y --purge sudo; fi; \
    passwd -l root
