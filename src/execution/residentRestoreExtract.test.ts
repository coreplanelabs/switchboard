import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESTORE_MOUNT_ROOT,
  extractRestoreScript,
  restoreMountDir,
  unmountAllRestoresScript,
  unmountRestoreScript,
} from "./residentRestoreExtract.js";

describe("residentRestoreExtract (item 61: the SDK's presigned restore MOUNTS the archive; the resident extracts it onto ext4)", () => {
  it("the staging mount is a sibling of the target, under /workspace (the SDK validates the dir), unique per attempt", () => {
    expect(restoreMountDir("/workspace/checkout", "ab12cd34")).toBe("/workspace/checkout.restore-ab12cd34");
    expect(restoreMountDir("/workspace/deps/.scratch-1/node_modules", "x")).toBe(
      "/workspace/deps/.scratch-1/node_modules.restore-x",
    );
    expect(RESTORE_MOUNT_ROOT).toBe("/var/backups/mounts");
  });

  it("extract script: unsquashfs from the downloaded archive when the image has it, else cp -a out of the mount; then unmount; the target appears LAST by rename", () => {
    const s = extractRestoreScript({
      mountDir: "/workspace/checkout.restore-a1",
      archivePath: "/var/backups/1111-2222.sqsh",
      targetDir: "/workspace/checkout",
    });
    expect(s).toContain("set -e");
    expect(s).toContain("command -v unsquashfs");
    expect(s).toContain("unsquashfs -n -no-xattrs -d '/workspace/checkout.extract-a1' '/var/backups/1111-2222.sqsh'");
    expect(s).toContain("cp -a '/workspace/checkout.restore-a1/.' '/workspace/checkout.extract-a1'/");
    expect(s).toContain("mv '/workspace/checkout.extract-a1' '/workspace/checkout'");
    // extraction → unmount → rename, in that order
    expect(s.indexOf("unsquashfs -n")).toBeLessThan(s.indexOf("fusermount3 -u"));
    expect(s.indexOf("fusermount3 -u")).toBeLessThan(s.indexOf("mv '/workspace/checkout.extract-a1'"));
    // the archive the SDK left behind goes too
    expect(s).toContain("rm -f '/var/backups/1111-2222.sqsh'");
  });

  it("unmount script for one staging mount: finds the overlay by mountpoint and its squashfuse lower via lowerdir=, unmounts both, removes the SDK's mount dir; tolerates an unmounted path", () => {
    const s = unmountRestoreScript("/workspace/checkout.restore-a1");
    expect(s).toContain("/proc/mounts");
    expect(s).toContain("lowerdir=");
    expect(s).toContain("fusermount3 -u");
    expect(s).toContain("umount -l");
    expect(s).toContain(RESTORE_MOUNT_ROOT);
  });

  it("unmount-all script for the clean steps: every fuse mount under /workspace and under the SDK's mount root, deepest first, then the leftovers", () => {
    const s = unmountAllRestoresScript();
    expect(s).toContain("/proc/mounts");
    expect(s).toMatch(/\^fuse/);
    expect(s).toMatch(/workspace/);
    expect(s).toMatch(/var\\\/backups\\\/mounts/);
    expect(s).toContain("sort -rn");
    expect(s).toContain(`rm -rf ${RESTORE_MOUNT_ROOT}/*`);
    expect(s).toContain("rm -f /var/backups/*.sqsh");
    // debris from an attempt that died mid-way: staging and extraction siblings
    expect(s).toContain("rm -rf /workspace/*.restore-* /workspace/*.extract-*");
  });

  it("cleanup never fails a finished extraction: every removal in the unmount script is best effort (the extract script runs it under set -e)", () => {
    const s = unmountRestoreScript("/workspace/checkout.restore-a1");
    for (const line of s.split("\n").filter((l) => /\brm(dir)? /.test(l))) expect(line).toMatch(/\|\| true/);
  });

  it("on a real filesystem without unsquashfs or mounts: the cp branch copies the tree out, the staging dir is gone, the target holds the files with their modes", () => {
    const root = mkdtempSync(join(tmpdir(), "restore-extract-"));
    try {
      const mount = join(root, "checkout.restore-t1");
      mkdirSync(join(mount, "src"), { recursive: true });
      writeFileSync(join(mount, "src", "a.txt"), "hello", { mode: 0o644 });
      writeFileSync(join(mount, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
      const target = join(root, "checkout");
      const script = extractRestoreScript({
        mountDir: mount,
        archivePath: join(root, "missing.sqsh"),
        targetDir: target,
      });
      // PATH without unsquashfs forces the cp branch; fusermount3/umount are absent or refuse → tolerated
      const r = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("extract: cp");
      expect(readFileSync(join(target, "src", "a.txt"), "utf8")).toBe("hello");
      expect(spawnSync("test", ["-x", join(target, "run.sh")]).status).toBe(0);
      expect(spawnSync("test", ["-e", mount]).status).not.toBe(0);
      expect(spawnSync("test", ["-e", join(root, "checkout.extract-t1")]).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
