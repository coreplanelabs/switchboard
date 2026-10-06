import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";

/** Operator-only bridge for the old resident route. It never sends a caller's
 * shell text: every command is the fixed Python probe below plus bounded JSON. */
const REMOTE = readFileSync(new URL("./residentArchiveRemote.py", import.meta.url), "utf8");
const MAX_COMMAND_CHARS = 64_000;
const MAX_OUTPUT_CHARS = 100_000;
const CHUNK_BYTES = 60 * 1024;
const BATCH_BYTES = 32 * 1024;
const BATCH_FILES = 128;
const BATCH_PATH_CHARS = 12 * 1024;
const PAGE_ENTRIES = 100;
const SHA = /^[a-f0-9]{64}$/;
const BOOT = /^[A-Za-z0-9-]{1,64}$/;
const SCRATCH = /^\/tmp\/resident-archive-[A-Za-z0-9_-]+\.jsonl$/;

export interface ResidentArchiveBinding {
  threadKey: string;
  ref: string;
  sha?: string;
  user: string;
  boundAt: string;
  evicted?: boolean;
  readonly?: boolean;
  githubDoorHost?: string;
}

export interface ResidentArchiveTransport {
  binding(): Promise<ResidentArchiveBinding>;
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }>;
}

type DirEntry = { type: "dir"; pathB64: string; mode: number };
type FileEntry = { type: "file"; pathB64: string; mode: number; size: number; sha256: string };
type LinkEntry = { type: "symlink"; pathB64: string; mode: number; targetB64: string };
export type ArchiveEntry = DirEntry | FileEntry | LinkEntry;
type RemoteReply = Record<string, unknown>;

export interface ResidentArchiveReceipt {
  protocolVersion: 1;
  threadKey: string;
  ref: string;
  sha: string;
  user: string;
  boundAt: string;
  bootId: string;
  root: string;
  manifestSha256: string;
  entryCount: number;
  fileCount: number;
  byteCount: number;
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function command(input: Record<string, unknown>): string {
  const body = `python3 -c ${quote(REMOTE)} ${quote(JSON.stringify(input))}`;
  if (body.length > MAX_COMMAND_CHARS) throw new Error("archive command exceeds old /exec limit");
  return body;
}

async function execJson(transport: ResidentArchiveTransport, input: Record<string, unknown>): Promise<RemoteReply> {
  const result = await transport.exec(command(input));
  if (result.truncated || result.stdout.length > MAX_OUTPUT_CHARS || result.stderr.length > MAX_OUTPUT_CHARS)
    throw new Error("resident archive response truncated");
  if (result.exitCode !== 0) throw new Error("resident archive command refused");
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as RemoteReply;
  } catch {
    throw new Error("resident archive response is not one JSON document");
  }
}

function identicalIdentity(reply: RemoteReply, bootId: string, root: string): void {
  if (reply.bootId !== bootId || !BOOT.test(bootId)) throw new Error("resident boot ID changed during archive");
  if (reply.root !== root || !isAbsolute(root)) throw new Error("resident binding path changed during archive");
}

function number(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid ${name}`);
  return Number(value);
}

function encodedBytes(value: unknown, name: string, allowEmpty = false): Buffer {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error(`invalid ${name}`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`noncanonical ${name}`);
  return bytes;
}

function pathOf(entry: ArchiveEntry): Buffer {
  const bytes = encodedBytes(entry.pathB64, "archive path");
  if (bytes[0] === 47 || bytes.includes(0)) throw new Error("unsafe archive path");
  const segments = bytes.toString("binary").split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) throw new Error("unsafe archive path");
  return bytes;
}

function stableEntry(entry: ArchiveEntry): string {
  return JSON.stringify(Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))) + "\n";
}

function validateEntries(entries: ArchiveEntry[]): { manifestSha256: string; fileCount: number; byteCount: number } {
  const hash = createHash("sha256");
  let prior: Buffer | null = null;
  let fileCount = 0;
  let byteCount = 0;
  const types = new Map<string, ArchiveEntry["type"]>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !["dir", "file", "symlink"].includes(entry.type))
      throw new Error("invalid archive entry");
    const path = pathOf(entry);
    if (prior && Buffer.compare(prior, path) >= 0) throw new Error("duplicate or unordered archive path");
    prior = path;
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) throw new Error("invalid archive mode");
    if (entry.type === "file") {
      number(entry.size, "file size");
      if (!SHA.test(entry.sha256)) throw new Error("invalid file hash");
      byteCount += entry.size;
      fileCount += 1;
    } else if (entry.type === "symlink") {
      encodedBytes(entry.targetB64, "symlink target");
    }
    const parts = path.toString("binary").split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = Buffer.from(parts.slice(0, i).join("/"), "binary").toString("base64");
      if (types.get(parent) !== "dir") throw new Error("unsafe archive parent path");
    }
    types.set(entry.pathB64, entry.type);
    hash.update(stableEntry(entry));
  }
  return { manifestSha256: hash.digest("hex"), fileCount, byteCount };
}

function checkBinding(
  binding: ResidentArchiveBinding,
  expected: {
    threadKey: string;
    expectedRef: string;
    expectedSha: string;
  },
): void {
  if (
    binding.threadKey !== expected.threadKey ||
    binding.ref !== expected.expectedRef ||
    binding.sha !== expected.expectedSha ||
    !binding.user ||
    !binding.boundAt ||
    binding.evicted
  )
    throw new Error("resident binding does not match the requested tree");
}

function sameBinding(a: ResidentArchiveBinding, b: ResidentArchiveBinding): void {
  for (const key of ["threadKey", "ref", "sha", "user", "boundAt", "evicted", "readonly", "githubDoorHost"] as const) {
    if (a[key] !== b[key]) throw new Error("resident binding changed during archive");
  }
}

async function writeBlob(path: string, bytes: Buffer): Promise<void> {
  const output = await open(path, "wx", 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
  } finally {
    await output.close();
  }
}

/** Capture only the currently bound tree. A receipt is written last and is
 * absent on every refusal. External ingress/workflow freeze is a separate gate. */
export async function captureResidentArchive(input: {
  transport: ResidentArchiveTransport;
  threadKey: string;
  expectedRef: string;
  expectedSha: string;
  archiveDir: string;
}): Promise<ResidentArchiveReceipt> {
  if (!/^[a-f0-9]{40}$/.test(input.expectedSha)) throw new Error("expected SHA must be full length");
  const before = await input.transport.binding();
  checkBinding(before, input);
  await mkdir(input.archiveDir, { mode: 0o700 }); // refuses an existing archive
  await mkdir(join(input.archiveDir, "blobs"), { mode: 0o700 });
  const began = await execJson(input.transport, { op: "begin" });
  if (
    began.op !== "begin" ||
    typeof began.bootId !== "string" ||
    !BOOT.test(began.bootId) ||
    typeof began.root !== "string" ||
    !isAbsolute(began.root) ||
    typeof began.scratch !== "string" ||
    !SCRATCH.test(began.scratch) ||
    typeof began.manifestSha256 !== "string" ||
    !SHA.test(began.manifestSha256)
  )
    throw new Error("invalid resident archive start receipt");
  const bootId = began.bootId;
  const root = began.root;
  let cleanupAttempted = false;
  const cleanupScratch = async (): Promise<void> => {
    cleanupAttempted = true;
    const current = await input.transport.binding();
    sameBinding(before, current);
    const cleaned = await execJson(input.transport, { op: "cleanup", scratch: began.scratch, bootId, root });
    identicalIdentity(cleaned, bootId, root);
    if (cleaned.op !== "cleanup") throw new Error("resident manifest scratch cleanup failed");
  };
  try {
    const count = number(began.count, "manifest count");
    const sourceBytes = number(began.byteCount, "source bytes");
    if (count > 200_000 || sourceBytes > 8 * 1024 * 1024 * 1024) throw new Error("archive exceeds capture budget");
    const entries: ArchiveEntry[] = [];
    for (let start = 0, limit = PAGE_ENTRIES; start < count;) {
      const requested = Math.min(limit, count - start);
      let page: RemoteReply;
      try {
        page = await execJson(input.transport, { op: "page", scratch: began.scratch, start, limit: requested });
      } catch (error) {
        if (requested === 1) throw error;
        limit = Math.max(1, Math.floor(requested / 2));
        continue;
      }
      identicalIdentity(page, bootId, root);
      if (
        page.op !== "page" ||
        page.start !== start ||
        !Array.isArray(page.entries) ||
        page.entries.length !== requested
      )
        throw new Error("missing or duplicate manifest page");
      entries.push(...(page.entries as ArchiveEntry[]));
      start += requested;
    }
    const checked = validateEntries(entries);
    if (checked.manifestSha256 !== began.manifestSha256 || checked.byteCount !== sourceBytes)
      throw new Error("resident source manifest changed during paging");
    await writeFile(join(input.archiveDir, "manifest.json"), JSON.stringify({ entries }), { flag: "wx", mode: 0o600 });
    const files = entries.flatMap((entry, index) => (entry.type === "file" ? [{ index, entry }] : []));
    for (let cursor = 0; cursor < files.length;) {
      const current = files[cursor]!;
      if (current.entry.size > BATCH_BYTES || current.entry.pathB64.length > BATCH_PATH_CHARS) {
        const { index, entry } = current;
        const output = await open(join(input.archiveDir, "blobs", String(index)), "wx", 0o600);
        const hash = createHash("sha256");
        try {
          for (let offset = 0; offset < entry.size; offset += CHUNK_BYTES) {
            const length = Math.min(CHUNK_BYTES, entry.size - offset);
            const chunk = await execJson(input.transport, {
              op: "chunk",
              pathB64: entry.pathB64,
              offset,
              length,
              size: entry.size,
            });
            identicalIdentity(chunk, bootId, root);
            if (
              chunk.op !== "chunk" ||
              chunk.pathB64 !== entry.pathB64 ||
              chunk.offset !== offset ||
              chunk.length !== length ||
              chunk.size !== entry.size ||
              typeof chunk.sha256 !== "string" ||
              !SHA.test(chunk.sha256)
            )
              throw new Error("missing or duplicate archive chunk");
            const bytes = encodedBytes(chunk.data, "chunk bytes");
            if (bytes.length !== length || digest(bytes) !== chunk.sha256)
              throw new Error("archive chunk byte/hash mismatch");
            await output.write(bytes, 0, bytes.length, offset);
            hash.update(bytes);
          }
          if (hash.digest("hex") !== entry.sha256) throw new Error("source file hash changed during capture");
          await output.sync();
        } finally {
          await output.close();
        }
        cursor++;
        continue;
      }
      const batch: typeof files = [];
      let batchBytes = 0;
      let pathChars = 0;
      while (cursor < files.length && batch.length < BATCH_FILES) {
        const next = files[cursor]!;
        if (
          next.entry.size > BATCH_BYTES ||
          next.entry.pathB64.length > BATCH_PATH_CHARS ||
          batchBytes + next.entry.size > BATCH_BYTES ||
          pathChars + next.entry.pathB64.length > BATCH_PATH_CHARS
        )
          break;
        batch.push(next);
        batchBytes += next.entry.size;
        pathChars += next.entry.pathB64.length;
        cursor++;
      }
      const answer = await execJson(input.transport, {
        op: "batch",
        files: batch.map(({ entry }) => ({ pathB64: entry.pathB64, size: entry.size })),
      });
      identicalIdentity(answer, bootId, root);
      if (answer.op !== "batch" || !Array.isArray(answer.files) || answer.files.length !== batch.length)
        throw new Error("missing or duplicate archive batch");
      for (const [position, { index, entry }] of batch.entries()) {
        const reply = answer.files[position] as RemoteReply;
        if (
          !reply ||
          reply.pathB64 !== entry.pathB64 ||
          reply.size !== entry.size ||
          typeof reply.sha256 !== "string" ||
          !SHA.test(reply.sha256)
        )
          throw new Error("missing or duplicate archive batch file");
        const bytes = encodedBytes(reply.data, "batch bytes", true);
        if (bytes.length !== entry.size || digest(bytes) !== reply.sha256 || reply.sha256 !== entry.sha256)
          throw new Error("archive batch byte/hash mismatch");
        await writeBlob(join(input.archiveDir, "blobs", String(index)), bytes);
      }
    }
    const verified = await execJson(input.transport, { op: "verify" });
    identicalIdentity(verified, bootId, root);
    if (
      verified.op !== "verify" ||
      verified.manifestSha256 !== began.manifestSha256 ||
      verified.count !== count ||
      verified.byteCount !== sourceBytes
    )
      throw new Error("resident source changed during capture");
    await cleanupScratch();
    const receipt: ResidentArchiveReceipt = {
      protocolVersion: 1,
      threadKey: before.threadKey,
      ref: before.ref,
      sha: before.sha!,
      user: before.user,
      boundAt: before.boundAt,
      bootId,
      root,
      manifestSha256: checked.manifestSha256,
      entryCount: count,
      fileCount: checked.fileCount,
      byteCount: checked.byteCount,
    };
    await writeFile(join(input.archiveDir, "receipt.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    return receipt;
  } catch (error) {
    if (!cleanupAttempted) {
      try {
        await cleanupScratch();
      } catch {
        // Keep the capture refusal; cleanup has no authority if identity moved.
      }
    }
    throw error;
  }
}

function restoredPath(root: string, path: Buffer): Buffer {
  return Buffer.concat([Buffer.from(root), Buffer.from("/"), path]);
}

async function copyVerifiedBlob(sourcePath: string, outputPath: Buffer, expected: FileEntry): Promise<void> {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const sourceInfo = await source.stat();
    if (!sourceInfo.isFile() || sourceInfo.size !== expected.size)
      throw new Error("archive blob size or type mismatch");
    const target = await open(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const hash = createHash("sha256");
      let total = 0;
      const buffer = Buffer.alloc(1024 * 1024);
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, total);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        await target.write(buffer, 0, bytesRead, total);
        total += bytesRead;
        if (total > expected.size) throw new Error("archive blob size mismatch");
      }
      if (total !== expected.size || hash.digest("hex") !== expected.sha256)
        throw new Error("archive blob byte/hash mismatch");
      await target.chmod(expected.mode);
      await target.sync();
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

async function readArchiveJson(path: string, maxBytes: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("invalid archive metadata file");
    const bytes = await file.readFile("utf8");
    try {
      return JSON.parse(bytes) as unknown;
    } catch {
      throw new Error("invalid archive metadata JSON");
    }
  } finally {
    await file.close();
  }
}

/** Validate the old format before reporting its recorded identity. These are
 * receipt fields, not a new owner claim or proof that the source was frozen. */
function archiveReceipt(value: unknown): ResidentArchiveReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid archive receipt");
  const receipt = value as Record<string, unknown>;
  if (
    receipt.protocolVersion !== 1 ||
    typeof receipt.threadKey !== "string" ||
    !receipt.threadKey ||
    typeof receipt.ref !== "string" ||
    !receipt.ref ||
    typeof receipt.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(receipt.sha) ||
    typeof receipt.user !== "string" ||
    !receipt.user ||
    typeof receipt.boundAt !== "string" ||
    !receipt.boundAt ||
    typeof receipt.bootId !== "string" ||
    !BOOT.test(receipt.bootId) ||
    typeof receipt.root !== "string" ||
    !isAbsolute(receipt.root) ||
    typeof receipt.manifestSha256 !== "string" ||
    !SHA.test(receipt.manifestSha256) ||
    [receipt.entryCount, receipt.fileCount, receipt.byteCount].some(
      (count) => !Number.isSafeInteger(count) || Number(count) < 0,
    )
  )
    throw new Error("invalid archive receipt");
  return {
    protocolVersion: 1,
    threadKey: receipt.threadKey,
    ref: receipt.ref,
    sha: receipt.sha,
    user: receipt.user,
    boundAt: receipt.boundAt,
    bootId: receipt.bootId,
    root: receipt.root,
    manifestSha256: receipt.manifestSha256,
    entryCount: number(receipt.entryCount, "entry count"),
    fileCount: number(receipt.fileCount, "file count"),
    byteCount: number(receipt.byteCount, "byte count"),
  };
}

/** Offline and credential-free: a sealed archive is restored to a new path,
 * then independently scanned with Node to compare every entry and byte. */
export async function restoreResidentArchive(input: {
  archiveDir: string;
  restoreDir: string;
}): Promise<ResidentArchiveReceipt> {
  const archiveInfo = await lstat(input.archiveDir);
  const blobsInfo = await lstat(join(input.archiveDir, "blobs"));
  if (!archiveInfo.isDirectory() || !blobsInfo.isDirectory()) throw new Error("invalid archive directory");
  const receipt = archiveReceipt(await readArchiveJson(join(input.archiveDir, "receipt.json"), 16 * 1024));
  const manifest = (await readArchiveJson(join(input.archiveDir, "manifest.json"), 64 * 1024 * 1024)) as {
    entries: ArchiveEntry[];
  };
  if (!Array.isArray(manifest.entries)) throw new Error("invalid archive manifest");
  const entries = manifest.entries;
  const checked = validateEntries(entries); // safety before creating the restore directory
  if (
    checked.manifestSha256 !== receipt.manifestSha256 ||
    checked.fileCount !== receipt.fileCount ||
    checked.byteCount !== receipt.byteCount ||
    entries.length !== receipt.entryCount
  )
    throw new Error("archive manifest receipt mismatch");
  const blobNames = await readdir(join(input.archiveDir, "blobs"));
  const expectedNames = entries.flatMap((entry, index) => (entry.type === "file" ? [String(index)] : []));
  if (blobNames.sort().join("\n") !== expectedNames.sort().join("\n")) throw new Error("missing or extra archive blob");
  await mkdir(input.restoreDir, { mode: 0o700 }); // refuses reuse and symlink targets
  const dirs: Array<{ path: Buffer; mode: number }> = [];
  const links: Array<{ path: Buffer; target: Buffer }> = [];
  for (const [index, entry] of entries.entries()) {
    const path = restoredPath(input.restoreDir, pathOf(entry));
    if (entry.type === "dir") {
      await mkdir(path, { mode: 0o700 });
      dirs.push({ path, mode: entry.mode });
    } else if (entry.type === "file") {
      await copyVerifiedBlob(join(input.archiveDir, "blobs", String(index)), path, entry);
    } else {
      links.push({ path, target: encodedBytes(entry.targetB64, "symlink target") });
    }
  }
  for (const link of links) await symlink(link.target, link.path);
  for (const dir of dirs.reverse()) await chmod(dir.path, dir.mode);
  const actual = await scanRestoredTree(input.restoreDir);
  const roundTrip = validateEntries(actual);
  if (roundTrip.manifestSha256 !== receipt.manifestSha256 || roundTrip.byteCount !== receipt.byteCount)
    throw new Error("restored tree manifest mismatch");
  return receipt;
}

async function scanRestoredTree(root: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const walk = async (relative: Buffer): Promise<void> => {
    const directory = relative.length ? restoredPath(root, relative) : Buffer.from(root);
    const names = (await readdir(directory, { encoding: "buffer" })) as Buffer[];
    names.sort(Buffer.compare);
    for (const name of names) {
      const path = relative.length ? Buffer.concat([relative, Buffer.from("/"), name]) : name;
      const full = restoredPath(root, path);
      let file;
      try {
        file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
        const target = (await readlink(full, { encoding: "buffer" })) as Buffer;
        const linkInfo = await lstat(full);
        if (!linkInfo.isSymbolicLink()) throw new Error("restored symlink changed during scan", { cause: error });
        entries.push({
          type: "symlink",
          pathB64: path.toString("base64"),
          mode: linkInfo.mode & 0o7777,
          targetB64: target.toString("base64"),
        });
        continue;
      }
      try {
        const info = await file.stat();
        const base = { pathB64: path.toString("base64"), mode: info.mode & 0o7777 };
        if (info.isDirectory()) {
          entries.push({ ...base, type: "dir" });
          await walk(path);
        } else if (info.isFile()) {
          const hash = createHash("sha256");
          const buffer = Buffer.alloc(1024 * 1024);
          let offset = 0;
          while (true) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
          entries.push({ ...base, type: "file", size: info.size, sha256: hash.digest("hex") });
        } else {
          throw new Error("unsupported restored entry type");
        }
      } finally {
        await file.close();
      }
    }
  };
  await walk(Buffer.alloc(0));
  entries.sort((a, b) => Buffer.compare(pathOf(a), pathOf(b)));
  return entries;
}
