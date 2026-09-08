/** Extracting an R2 restore onto the resident's own disk (features/resident-repos.md
 *  item 61, #614), kept pure and dependency-free so it is unit-testable from
 *  src/ and imported by the resident Worker — the tested code IS the shipped
 *  code.
 *
 *  Background (2026-09-08): in presigned mode the Sandbox SDK's restore does
 *  not extract the archive, it MOUNTS it — squashfuse on the `.sqsh` under
 *  `/var/backups/mounts/<id>_<ts>_<rand>/lower`, then fuse-overlayfs at the
 *  handle's `dir` with a writable upper next to it — and leaves the `.sqsh` in
 *  `/var/backups`. (Extraction with `unsquashfs` is the SDK's LOCAL-DEV path.)
 *  The first day of presigned mode showed what a mount point does to code that
 *  expects a directory on one ext4 filesystem: `rm -rf /workspace/mirror` →
 *  "Device or resource busy" (nominal looped `degraded` on its wake path),
 *  `chown -R` → a copy-up of every inode (timed out at 300 s), `du -x` → the
 *  mirror and checkout measured as ~1 MiB, and every hardlink or rename
 *  between the checkout and the deps store crossed devices.
 *
 *  So the resident restores INTO A STAGING MOUNT (a sibling of the target,
 *  still under /workspace where the SDK allows it), extracts from it onto the
 *  real disk — `unsquashfs` straight from the downloaded `.sqsh` when the image
 *  has squashfs-tools (the Dockerfile installs it), `cp -a` out of the mount
 *  while an older image lacks it — unmounts the staging mount and its lower,
 *  removes the archive, and only then renames the extracted tree into place.
 *  After a wake the disk looks exactly as it did before presigned mode. Every
 *  clean step first unmounts whatever a previous incarnation left behind. */

import { shellQuote } from "./shellQuote.js";

/** Where the SDK keeps a mounted restore's lower/upper/work dirs. */
export const RESTORE_MOUNT_ROOT = "/var/backups/mounts";

/** The staging mount for restoring `targetDir`: a sibling, unique per attempt.
 *  Must stay under /workspace (or the SDK's other allowed roots) because the
 *  SDK validates the handle's `dir`. */
export function restoreMountDir(targetDir: string, attempt: string): string {
  return `${targetDir}.restore-${attempt}`;
}

/** Unmount ONE staging mount and what hangs off it, as root, tolerating a
 *  path that is not (or no longer) mounted: the fuse-overlayfs at `mountDir`
 *  first, then the squashfuse lower named in its `lowerdir=` option, then the
 *  SDK's `<id>_<ts>_<rand>` dir that held lower/upper/work. `fusermount3 -u`
 *  is the FUSE way; `umount -l` the fallback for a busy mount. */
export function unmountRestoreScript(mountDir: string): string {
  const m = shellQuote(mountDir);
  return [
    `_m=${m}`,
    // The overlay's lowerdir (a squashfuse mountpoint), read before the overlay goes.
    `_low=$(awk -v m="$_m" '$2==m {print $4}' /proc/mounts 2>/dev/null | tr ',' '\\n' | sed -n 's/^lowerdir=//p')`,
    `if awk -v m="$_m" '$2==m {f=1} END {exit !f}' /proc/mounts 2>/dev/null; then fusermount3 -u "$_m" 2>/dev/null || umount -l "$_m" 2>/dev/null || true; fi`,
    // Word-splitting on $_low is deliberate: the SDK mounts ONE lower per
    // restore and its paths carry no spaces or colons; a multi-lower overlay
    // would need `:`-splitting here.
    `for _l in $_low; do`,
    `  if awk -v m="$_l" '$2==m {f=1} END {exit !f}' /proc/mounts 2>/dev/null; then fusermount3 -u "$_l" 2>/dev/null || umount -l "$_l" 2>/dev/null || true; fi`,
    // The removals are best effort: after a LAZY unmount a still-open file
    // can keep the dir alive for a moment, and this script also runs under
    // `set -e` inside extractRestoreScript — a successful extraction must
    // never be failed by its cleanup. The unmount-all clean step reclaims
    // whatever is left.
    `  case "$_l" in ${RESTORE_MOUNT_ROOT}/*) rm -rf "$(dirname "$_l")" 2>/dev/null || true ;; esac`,
    `done`,
    `rmdir "$_m" 2>/dev/null || rm -rf "$_m" 2>/dev/null || true`,
  ].join("\n");
}

/** Turn a mounted restore into a plain directory tree, as root:
 *   1. extract — `unsquashfs` from the `.sqsh` the SDK downloaded when the
 *      image has it (multi-threaded, no FUSE in the read path; `-no-xattrs`
 *      because squashfs xattrs are not worth a failed restore), else `cp -a`
 *      out of the mount (ownership and modes preserved either way — the
 *      archive was taken from a worker1-owned tree, so no chown follows);
 *   2. unmount the staging mount and its lower, remove the archive;
 *   3. rename the extracted tree to the target — the target appears LAST, so
 *      a failure anywhere above leaves no half-populated target.
 *  Prints `extract: unsquashfs` or `extract: cp` so the log says which. */
export function extractRestoreScript(input: { mountDir: string; archivePath: string; targetDir: string }): string {
  const attempt = input.mountDir.slice(input.mountDir.lastIndexOf(".restore-") + ".restore-".length);
  const tmp = shellQuote(`${input.targetDir}.extract-${attempt}`);
  const archive = shellQuote(input.archivePath);
  const target = shellQuote(input.targetDir);
  return [
    `set -e`,
    `rm -rf ${tmp}`,
    `if command -v unsquashfs >/dev/null 2>&1 && test -f ${archive}; then`,
    `  unsquashfs -n -no-xattrs -d ${tmp} ${archive} >/dev/null`,
    `  echo "extract: unsquashfs"`,
    `else`,
    `  mkdir ${tmp}`,
    `  cp -a ${shellQuote(`${input.mountDir}/.`)} ${tmp}/`,
    `  echo "extract: cp"`,
    `fi`,
    unmountRestoreScript(input.mountDir),
    `rm -f ${archive}`,
    `rm -rf ${target}`,
    `mv ${tmp} ${target}`,
  ].join("\n");
}

/** For the clean steps (`clean-before-restore`, provisioning's
 *  `clean-workspace`): unmount every fuse mount a previous incarnation left
 *  under /workspace or under the SDK's mount root — deepest first, so an
 *  overlay goes before the lower it sits on — then remove the SDK's mount dirs,
 *  any `.sqsh` still on disk, and the staging (`*.restore-*`) and extraction
 *  (`*.extract-*`) siblings an attempt that died mid-way left beside the
 *  mirror or checkout (a multi-GiB partial tree on a disk-budgeted resident).
 *  Idempotent; nothing to do is exit 0. */
export function unmountAllRestoresScript(): string {
  return [
    `awk '($3 ~ /^fuse/) && ($2 ~ /^\\/workspace\\// || $2 ~ /^${RESTORE_MOUNT_ROOT.replace(/\//g, "\\/")}\\//) {print length($2), $2}' /proc/mounts 2>/dev/null | sort -rn | cut -d' ' -f2- | while read -r _m; do fusermount3 -u "$_m" 2>/dev/null || umount -l "$_m" 2>/dev/null || true; done`,
    `rm -rf ${RESTORE_MOUNT_ROOT}/* 2>/dev/null || true`,
    `rm -f /var/backups/*.sqsh 2>/dev/null || true`,
    `rm -rf /workspace/*.restore-* /workspace/*.extract-* 2>/dev/null || true`,
    `true`,
  ].join("\n");
}
