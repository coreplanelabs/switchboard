import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { captureResidentArchive, restoreResidentArchive, type ResidentArchiveTransport } from "./residentArchive.js";

const roots: string[] = [];
const scratchFiles: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(scratchFiles.splice(0).map((path) => rm(path, { force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "resident-archive-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, ".git"), { recursive: true });
  await writeFile(join(source, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  await writeFile(join(source, ".gitignore"), "ignored.bin\n");
  await writeFile(join(source, "tracked.txt"), "tracked\n");
  await writeFile(join(source, "untracked.txt"), "untracked\n");
  await writeFile(join(source, "ignored.bin"), Buffer.from([0, 255, 13, 10]));
  await writeFile(join(source, "odd name ü.txt"), "odd\n");
  await writeFile(join(source, "tool.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(source, "tool.sh"), 0o755);
  await symlink("tracked.txt", join(source, "link"));
  await mkdir(join(source, "empty"));
  const binding = {
    threadKey: "mcp:default:disposable-archive-test",
    ref: "codex/disposable-archive-test",
    sha: "a".repeat(40),
    user: "worker2",
    boundAt: "2026-10-02T00:00:00.000Z",
    evicted: false,
    readonly: false,
  };
  const transport: ResidentArchiveTransport = {
    async binding() {
      return { ...binding };
    },
    async exec(command) {
      const result = spawnSync("bash", ["-c", command], {
        cwd: source,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, RESIDENT_ARCHIVE_TEST_BOOT_ID: "disposable-test-boot" },
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? 1,
        truncated: (result.stdout?.length ?? 0) > 100_000 || (result.stderr?.length ?? 0) > 100_000,
      };
    },
  };
  return { root, source, binding, transport };
}

describe("resident archive harness", () => {
  it("batches many small and empty files while chunking a large file", async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        writeFile(join(f.source, `small-${String(index).padStart(3, "0")}`), index % 8 === 0 ? "" : "small bytes"),
      ),
    );
    await Promise.all(
      Array.from({ length: 64 }, (_, index) => mkdir(join(f.source, `dir-${String(index).padStart(3, "0")}`))),
    );
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        symlink("tracked.txt", join(f.source, `link-${String(index).padStart(3, "0")}`)),
      ),
    );
    await writeFile(join(f.source, "large-extra.bin"), Buffer.alloc(140 * 1024, 0x5a));
    let batches = 0;
    let chunks = 0;
    let pages = 0;
    const transport: ResidentArchiveTransport = {
      binding: f.transport.binding,
      async exec(command) {
        const reply = await f.transport.exec(command);
        if (reply.stdout.includes('"op":"batch"')) batches++;
        if (reply.stdout.includes('"op":"chunk"')) chunks++;
        if (reply.stdout.includes('"op":"page"')) pages++;
        return reply;
      },
    };
    const archiveDir = join(f.root, "many-archive");
    const receipt = await captureResidentArchive({
      transport,
      threadKey: f.binding.threadKey,
      expectedRef: f.binding.ref,
      expectedSha: f.binding.sha,
      archiveDir,
    });
    expect(receipt.fileCount).toBeGreaterThan(256);
    expect(batches).toBeGreaterThan(0);
    expect(batches + chunks).toBeLessThan(12);
    expect(chunks).toBe(3);
    expect(pages).toBeGreaterThan(1);
    const restoreDir = join(f.root, "many-restored");
    await restoreResidentArchive({ archiveDir, restoreDir });
    expect(await readFile(join(restoreDir, "small-001"), "utf8")).toBe("small bytes");
    expect(await readFile(join(restoreDir, "small-000"))).toHaveLength(0);
  }, 120_000);

  it("pages long symlink metadata within the response cap", async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        symlink("x".repeat(700), join(f.source, `long-link-${String(index).padStart(3, "0")}`)),
      ),
    );
    let pageAttempts = 0;
    const transport: ResidentArchiveTransport = {
      binding: f.transport.binding,
      async exec(command) {
        if (command.includes('"op":"page"')) pageAttempts++;
        return f.transport.exec(command);
      },
    };
    const archiveDir = join(f.root, "long-links-archive");
    const receipt = await captureResidentArchive({
      transport,
      threadKey: f.binding.threadKey,
      expectedRef: f.binding.ref,
      expectedSha: f.binding.sha,
      archiveDir,
    });
    expect(pageAttempts).toBeGreaterThan(Math.ceil(receipt.entryCount / 100));
    await restoreResidentArchive({ archiveDir, restoreDir: join(f.root, "long-links-restored") });
  });

  it("cleans scratch after a failed transfer without sealing", async () => {
    for (const failedOp of ["page", "chunk", "verify"] as const) {
      const f = await fixture();
      await writeFile(join(f.source, "large-failure.bin"), Buffer.alloc(140 * 1024, 0x62));
      let scratch = "";
      let failed = false;
      let cleanups = 0;
      const transport: ResidentArchiveTransport = {
        binding: f.transport.binding,
        async exec(command) {
          const reply = await f.transport.exec(command);
          if (reply.stdout.includes('"op":"begin"')) {
            scratch = (JSON.parse(reply.stdout) as { scratch: string }).scratch;
            scratchFiles.push(scratch);
          }
          if (reply.stdout.includes('"op":"cleanup"')) cleanups++;
          if ((!failed || failedOp === "page") && reply.stdout.includes(`"op":"${failedOp}"`)) {
            failed = true;
            return { ...reply, exitCode: 1, stdout: "" };
          }
          return reply;
        },
      };
      const archiveDir = join(f.root, `failed-${failedOp}`);
      await expect(
        captureResidentArchive({
          transport,
          threadKey: f.binding.threadKey,
          expectedRef: f.binding.ref,
          expectedSha: f.binding.sha,
          archiveDir,
        }),
      ).rejects.toThrow(/command refused/i);
      expect(failed).toBe(true);
      expect(cleanups).toBe(1);
      await expect(stat(scratch)).rejects.toThrow();
      await expect(readFile(join(archiveDir, "receipt.json"))).rejects.toThrow();
    }
  });

  it("keeps the original refusal when cleanup fails", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "large-failure.bin"), Buffer.alloc(140 * 1024, 0x62));
    let failed = false;
    let cleanups = 0;
    const transport: ResidentArchiveTransport = {
      binding: f.transport.binding,
      async exec(command) {
        const reply = await f.transport.exec(command);
        if (reply.stdout.includes('"op":"begin"'))
          scratchFiles.push((JSON.parse(reply.stdout) as { scratch: string }).scratch);
        if (reply.stdout.includes('"op":"cleanup"')) {
          cleanups++;
          return { ...reply, exitCode: 1, stdout: "" };
        }
        if (!failed && reply.stdout.includes('"op":"chunk"')) {
          failed = true;
          return { ...reply, truncated: true };
        }
        return reply;
      },
    };
    const archiveDir = join(f.root, "failed-cleanup");
    await expect(
      captureResidentArchive({
        transport,
        threadKey: f.binding.threadKey,
        expectedRef: f.binding.ref,
        expectedSha: f.binding.sha,
        archiveDir,
      }),
    ).rejects.toThrow(/truncated/i);
    expect(cleanups).toBe(1);
    await expect(readFile(join(archiveDir, "receipt.json"))).rejects.toThrow();
  });

  it("refuses a successful capture when scratch cleanup fails", async () => {
    const f = await fixture();
    let cleanups = 0;
    const transport: ResidentArchiveTransport = {
      binding: f.transport.binding,
      async exec(command) {
        const reply = await f.transport.exec(command);
        if (reply.stdout.includes('"op":"begin"'))
          scratchFiles.push((JSON.parse(reply.stdout) as { scratch: string }).scratch);
        if (reply.stdout.includes('"op":"cleanup"')) {
          cleanups++;
          return { ...reply, exitCode: 1, stdout: "" };
        }
        return reply;
      },
    };
    const archiveDir = join(f.root, "cleanup-refused");
    await expect(
      captureResidentArchive({
        transport,
        threadKey: f.binding.threadKey,
        expectedRef: f.binding.ref,
        expectedSha: f.binding.sha,
        archiveDir,
      }),
    ).rejects.toThrow(/command refused/i);
    expect(cleanups).toBe(1);
    await expect(readFile(join(archiveDir, "receipt.json"))).rejects.toThrow();
  });

  it("skips scratch cleanup after a binding change", async () => {
    const f = await fixture();
    let reads = 0;
    let scratch = "";
    let cleanups = 0;
    const transport: ResidentArchiveTransport = {
      async binding() {
        return { ...f.binding, user: ++reads === 1 ? f.binding.user : "other-user" };
      },
      async exec(command) {
        const reply = await f.transport.exec(command);
        if (reply.stdout.includes('"op":"begin"')) {
          scratch = (JSON.parse(reply.stdout) as { scratch: string }).scratch;
          scratchFiles.push(scratch);
        }
        if (reply.stdout.includes('"op":"cleanup"')) cleanups++;
        if (reply.stdout.includes('"op":"page"')) return { ...reply, exitCode: 1, stdout: "" };
        return reply;
      },
    };
    await expect(
      captureResidentArchive({
        transport,
        threadKey: f.binding.threadKey,
        expectedRef: f.binding.ref,
        expectedSha: f.binding.sha,
        archiveDir: join(f.root, "binding-changed"),
      }),
    ).rejects.toThrow(/command refused/i);
    expect(cleanups).toBe(0);
    expect((await stat(scratch)).isFile()).toBe(true);
  });

  it("captures every private entry and independently restores bytes, modes, symlinks and empty directories", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "large.bin"), Buffer.alloc(10 * 1024 * 1024 + 1, 0xa7));
    const archiveDir = join(f.root, "archive");
    const receipt = await captureResidentArchive({
      transport: f.transport,
      threadKey: f.binding.threadKey,
      expectedRef: f.binding.ref,
      expectedSha: f.binding.sha,
      archiveDir,
    });
    expect(receipt.fileCount).toBeGreaterThanOrEqual(8);
    expect(receipt.byteCount).toBeGreaterThan(10 * 1024 * 1024);
    const restoreDir = join(f.root, "restored");
    await restoreResidentArchive({ archiveDir, restoreDir });
    expect(await readFile(join(restoreDir, "ignored.bin"))).toEqual(Buffer.from([0, 255, 13, 10]));
    expect(await readFile(join(restoreDir, "odd name ü.txt"), "utf8")).toBe("odd\n");
    expect(await readFile(join(restoreDir, "large.bin"))).toEqual(await readFile(join(f.source, "large.bin")));
    expect((await stat(join(restoreDir, "tool.sh"))).mode & 0o777).toBe(0o755);
    expect(await readdir(join(restoreDir, "empty"))).toEqual([]);
  }, 120_000);

  it("refuses a truncated or missing chunk without sealing the archive", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "large-failure.bin"), Buffer.alloc(140 * 1024, 0x62));
    const archiveDir = join(f.root, "archive");
    let changed = false;
    const transport: ResidentArchiveTransport = {
      binding: f.transport.binding,
      async exec(command) {
        const answer = await f.transport.exec(command);
        if (!changed && answer.stdout.includes('"op":"chunk"')) {
          changed = true;
          return { ...answer, truncated: true };
        }
        return answer;
      },
    };
    await expect(
      captureResidentArchive({
        transport,
        threadKey: f.binding.threadKey,
        expectedRef: f.binding.ref,
        expectedSha: f.binding.sha,
        archiveDir,
      }),
    ).rejects.toThrow(/truncat/i);
    await expect(readFile(join(archiveDir, "receipt.json"))).rejects.toThrow();
  });

  it("refuses a duplicate chunk offset and a missing byte", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "two-chunks.bin"), Buffer.alloc(140 * 1024, 0x42));
    for (const failure of ["duplicate", "missing"] as const) {
      let chunks = 0;
      const archiveDir = join(f.root, failure);
      const transport: ResidentArchiveTransport = {
        binding: f.transport.binding,
        async exec(command) {
          const answer = await f.transport.exec(command);
          if (answer.exitCode !== 0 || !answer.stdout.includes('"op":"chunk"')) return answer;
          const chunk = JSON.parse(answer.stdout) as Record<string, unknown>;
          if (chunk.pathB64 !== Buffer.from("two-chunks.bin").toString("base64")) return answer;
          chunks++;
          if (chunks !== 2) return answer;
          return {
            ...answer,
            stdout: JSON.stringify(
              failure === "duplicate" ? { ...chunk, offset: 0 } : { ...chunk, data: String(chunk.data).slice(0, -4) },
            ),
          };
        },
      };
      await expect(
        captureResidentArchive({
          transport,
          threadKey: f.binding.threadKey,
          expectedRef: f.binding.ref,
          expectedSha: f.binding.sha,
          archiveDir,
        }),
      ).rejects.toThrow(/chunk|byte|hash/i);
      await expect(readFile(join(archiveDir, "receipt.json"))).rejects.toThrow();
    }
  });

  it("refuses a changed boot ID or binding before sealing", async () => {
    const f = await fixture();
    const archiveDir = join(f.root, "archive");
    let calls = 0;
    const transport: ResidentArchiveTransport = {
      binding: f.transport.binding,
      async exec(command) {
        const answer = await f.transport.exec(command);
        if (++calls > 2 && answer.exitCode === 0) {
          const doc = JSON.parse(answer.stdout) as Record<string, unknown>;
          return { ...answer, stdout: JSON.stringify({ ...doc, bootId: "changed-boot" }) };
        }
        return answer;
      },
    };
    await expect(
      captureResidentArchive({
        transport,
        threadKey: f.binding.threadKey,
        expectedRef: f.binding.ref,
        expectedSha: f.binding.sha,
        archiveDir,
      }),
    ).rejects.toThrow(/boot/i);
    await expect(readFile(join(archiveDir, "receipt.json"))).rejects.toThrow();
  });

  it("refuses a changed binding even when the remote bytes are stable", async () => {
    const f = await fixture();
    const archiveDir = join(f.root, "archive");
    let reads = 0;
    const transport: ResidentArchiveTransport = {
      async binding() {
        reads++;
        return { ...f.binding, user: reads === 1 ? f.binding.user : "worker3" };
      },
      exec: f.transport.exec,
    };
    await expect(
      captureResidentArchive({
        transport,
        threadKey: f.binding.threadKey,
        expectedRef: f.binding.ref,
        expectedSha: f.binding.sha,
        archiveDir,
      }),
    ).rejects.toThrow(/binding/i);
    await expect(readFile(join(archiveDir, "receipt.json"))).rejects.toThrow();
  });

  it("rejects a changed archive byte during offline restore", async () => {
    const f = await fixture();
    const archiveDir = join(f.root, "archive");
    await captureResidentArchive({
      transport: f.transport,
      threadKey: f.binding.threadKey,
      expectedRef: f.binding.ref,
      expectedSha: f.binding.sha,
      archiveDir,
    });
    const blobNames = await readdir(join(archiveDir, "blobs"));
    const first = join(archiveDir, "blobs", blobNames[0]);
    await writeFile(first, "corrupt");
    await expect(restoreResidentArchive({ archiveDir, restoreDir: join(f.root, "restored") })).rejects.toThrow(
      /hash|size|byte/i,
    );
  });

  it("rejects an incomplete or malformed legacy receipt before writing a restore", async () => {
    const f = await fixture();
    const archiveDir = join(f.root, "archive");
    const receipt = await captureResidentArchive({
      transport: f.transport,
      threadKey: f.binding.threadKey,
      expectedRef: f.binding.ref,
      expectedSha: f.binding.sha,
      archiveDir,
    });
    const { user: _user, ...missingUser } = receipt;
    const malformed = [
      missingUser,
      { ...receipt, protocolVersion: 2 },
      { ...receipt, threadKey: null },
      { ...receipt, ref: "" },
      { ...receipt, sha: "main" },
      { ...receipt, boundAt: 1 },
      { ...receipt, bootId: "" },
      { ...receipt, root: "relative/path" },
      { ...receipt, manifestSha256: "short" },
      { ...receipt, entryCount: -1 },
      { ...receipt, fileCount: 1.5 },
      { ...receipt, byteCount: "0" },
      null,
    ];
    for (const [index, value] of malformed.entries()) {
      await writeFile(join(archiveDir, "receipt.json"), JSON.stringify(value));
      const restoreDir = join(f.root, `malformed-${index}`);
      await expect(restoreResidentArchive({ archiveDir, restoreDir })).rejects.toThrow(/invalid archive receipt/i);
      await expect(stat(restoreDir)).rejects.toThrow();
    }
    await writeFile(join(archiveDir, "receipt.json"), JSON.stringify(receipt));
    const restored = await restoreResidentArchive({ archiveDir, restoreDir: join(f.root, "legacy-restored") });
    expect(restored).toEqual(receipt);
    expect(await readFile(join(f.root, "legacy-restored", "ignored.bin"))).toEqual(Buffer.from([0, 255, 13, 10]));
  });

  it("rejects an unsafe or duplicate archive path before writing a restore", async () => {
    const f = await fixture();
    const archiveDir = join(f.root, "archive");
    await captureResidentArchive({
      transport: f.transport,
      threadKey: f.binding.threadKey,
      expectedRef: f.binding.ref,
      expectedSha: f.binding.sha,
      archiveDir,
    });
    const manifestPath = join(archiveDir, "manifest.json");
    const original = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: Array<{ pathB64: string }> };
    const unsafe = structuredClone(original);
    unsafe.entries[0].pathB64 = Buffer.from("../escape").toString("base64");
    await writeFile(manifestPath, JSON.stringify(unsafe));
    await expect(restoreResidentArchive({ archiveDir, restoreDir: join(f.root, "unsafe-restore") })).rejects.toThrow(
      /unsafe archive path/i,
    );
    const duplicate = structuredClone(original);
    duplicate.entries[1].pathB64 = duplicate.entries[0].pathB64;
    await writeFile(manifestPath, JSON.stringify(duplicate));
    await expect(restoreResidentArchive({ archiveDir, restoreDir: join(f.root, "duplicate-restore") })).rejects.toThrow(
      /duplicate|unordered/i,
    );
  });
});
