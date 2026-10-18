import { AwsClient } from "aws4fetch";
import { BackupExpiredError, BackupNotFoundError, ErrorCode } from "@cloudflare/sandbox/errors";
import { z } from "zod";
import { nativeOperatorScopeRefSchema } from "../../src/execution/nativeScope.js";

export const RESTORE_RECEIPT_BYTES = 1024;
export const archiveCapabilitySchema = z
  .object({ version: z.literal(1), boot: z.string().uuid(), archiveRestores: z.literal(1) })
  .strict();
export const RESTORE_METADATA_BYTES = 64 * 1024;
const uuid = z.string().uuid();
const target = z
  .string()
  .max(256)
  .refine(
    (value) =>
      value === "/workspace/mirror" ||
      value === "/workspace/checkout" ||
      (value.startsWith("/workspace/deps/.scratch-") &&
        uuid.safeParse(value.slice("/workspace/deps/.scratch-".length)).success),
  );
const byteCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const etag = z.string().regex(/^[a-f0-9]{32}(?:-[1-9][0-9]*)?$/i);
export const restoreDescriptorSchema = z
  .object({
    version: z.literal(1),
    backupId: uuid,
    target,
    sizeBytes: byteCount,
    etag,
  })
  .strict();
export const restoreIdentitySchema = restoreDescriptorSchema
  .extend({
    ref: nativeOperatorScopeRefSchema,
    attempt: uuid,
  })
  .strict();
export const restoreReceiptSchema = z
  .object({
    identity: restoreIdentitySchema,
    outcome: z.enum(["committed", "aborted"]),
    cleanup: z.literal("complete"),
    reason: z
      .enum(["download-failed", "archive-invalid", "target-occupied", "cancelled", "disk-full", "source-changed"])
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.outcome === "aborted") === (value.reason !== undefined) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= RESTORE_RECEIPT_BYTES,
  );
export type RestoreDescriptor = z.infer<typeof restoreDescriptorSchema>;
export type RestoreIdentity = z.infer<typeof restoreIdentitySchema>;
export type RestoreReceipt = z.infer<typeof restoreReceiptSchema>;

export function sameRestoreIdentity(a: RestoreIdentity, b: RestoreIdentity): boolean {
  return JSON.stringify(restoreIdentitySchema.parse(a)) === JSON.stringify(restoreIdentitySchema.parse(b));
}
export function restorePrivateDirectory(attempt: string, scope: string): string {
  return `/workspace/.native-restore-${uuid.parse(scope)}-${uuid.parse(attempt)}`;
}
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export const workspaceMutationPathsSchema = z
  .array(
    z
      .string()
      .max(512)
      .refine(
        (value) =>
          value === "/workspace" ||
          (value.startsWith("/workspace/") &&
            value.split("/").every((part, index) => index === 0 || (part !== "" && part !== "." && part !== "..")) &&
            Array.from(value).every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)),
      ),
  )
  .min(1)
  .max(16);

interface ArchiveObject {
  size: number;
  etag: string;
  json?(): Promise<unknown>;
  body?: ReadableStream<Uint8Array>;
}
export interface RestoreArchiveBucket {
  get(key: string, options?: { onlyIf: { etagMatches: string } }): Promise<ArchiveObject | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
}
export interface RestoreArchiveEnvironment {
  BACKUP_BUCKET: RestoreArchiveBucket;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
  BACKUP_BUCKET_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}
export interface PreparedRestoreArchive {
  descriptor: RestoreDescriptor;
  transfer: { kind: "presigned"; url: string } | { kind: "binding" };
}

/** Read the pinned backup format through R2. No runtime or file effect is submitted here. */
export async function prepareRestoreArchive(
  env: RestoreArchiveEnvironment,
  backupId: string,
  targetPath: string,
  now: number,
  deadline: number,
  expiryBufferMs: number,
): Promise<PreparedRestoreArchive> {
  uuid.parse(backupId);
  target.parse(targetPath);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(deadline) ||
    deadline <= now ||
    !Number.isFinite(expiryBufferMs) ||
    expiryBufferMs < 0
  )
    throw new Error("restore deadline has ended");
  const timestamp = new Date(now).toISOString();
  const missing = () =>
    new BackupNotFoundError({
      code: ErrorCode.BACKUP_NOT_FOUND,
      httpStatus: 404,
      timestamp,
      message: "backup metadata or archive is absent",
      context: { backupId },
    });
  const metadata = await env.BACKUP_BUCKET.get(`backups/${backupId}/meta.json`);
  if (!metadata) throw missing();
  if (
    !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0 ||
    metadata.size > RESTORE_METADATA_BYTES ||
    !metadata.json
  )
    throw new Error("backup metadata is invalid");
  const parsed = z
    .object({
      id: uuid,
      sizeBytes: byteCount,
      createdAt: z.string().datetime({ offset: true }),
      ttl: z.number().finite().positive(),
    })
    .parse(await metadata.json());
  if (parsed.id !== backupId) throw new Error("backup metadata identity changed");
  if (now + expiryBufferMs > Date.parse(parsed.createdAt) + parsed.ttl * 1000)
    throw new BackupExpiredError({
      code: ErrorCode.BACKUP_EXPIRED,
      httpStatus: 400,
      timestamp,
      message: "backup has expired",
      context: { backupId },
    });
  const object = await env.BACKUP_BUCKET.head(`backups/${backupId}/data.sqsh`);
  if (!object) throw missing();
  const descriptor = restoreDescriptorSchema.parse({
    version: 1,
    backupId,
    target: targetPath,
    sizeBytes: object.size,
    etag: object.etag,
  });
  if (descriptor.sizeBytes !== parsed.sizeBytes) throw new Error("backup archive size changed");
  if (
    !env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
    !env.BACKUP_BUCKET_NAME?.trim() ||
    !env.R2_ACCESS_KEY_ID?.trim() ||
    !env.R2_SECRET_ACCESS_KEY?.trim()
  )
    return { descriptor, transfer: { kind: "binding" } };
  if (!env.BACKUP_BUCKET_ENDPOINT && !env.CLOUDFLARE_ACCOUNT_ID) throw new Error("backup account is absent");
  const endpoint = new URL(
    env.BACKUP_BUCKET_ENDPOINT ?? `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  );
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("backup endpoint is invalid");
  const url = new URL(`${endpoint.origin}/${encodeURIComponent(env.BACKUP_BUCKET_NAME)}/backups/${backupId}/data.sqsh`);
  url.searchParams.set("X-Amz-Expires", String(Math.ceil((deadline - now) / 1000)));
  const signer = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  const signed = await signer.sign(new Request(url, { headers: { "if-match": `"${descriptor.etag}"` } }), {
    aws: { signQuery: true, allHeaders: true, datetime: timestamp.replace(/[:-]|\.\d{3}/g, "") },
  });
  return { descriptor, transfer: { kind: "presigned", url: signed.url } };
}

/** The binding path stays streamed and conditional; the Worker never buffers the archive. */
export async function openRestoreArchiveBody(
  bucket: RestoreArchiveBucket,
  descriptor: RestoreDescriptor,
): Promise<ReadableStream<Uint8Array>> {
  const object = await bucket.get(`backups/${descriptor.backupId}/data.sqsh`, {
    onlyIf: { etagMatches: descriptor.etag },
  });
  if (!object?.body || object.size !== descriptor.sizeBytes || object.etag !== descriptor.etag)
    throw new Error("original backup archive is unavailable");
  return object.body;
}

export const restoreSnapshotSchema = z
  .object({
    identity: restoreIdentitySchema,
    phase: z.enum(["reserving", "receiving", "appending", "running", "installing", "cleaning", "done"]),
    receivedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    append: z
      .object({
        id: uuid,
        offset: z.number().int().nonnegative(),
        size: byteCount,
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    receipt: restoreReceiptSchema.optional(),
  })
  .strict()
  .refine((value) => (value.phase === "done") === (value.receipt !== undefined));

export class RestoreArchiveUnconfirmedError extends Error {}

interface ArchiveTransport {
  request(
    value: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated?: boolean }>;
}

export function archiveControlAnswer(output: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated?: boolean;
}): unknown {
  if (output.exitCode !== 0 || output.timedOut || output.truncated || output.stderr !== "")
    throw new Error("original archive control is unconfirmed");
  return JSON.parse(output.stdout);
}

/** Every effect is submitted once. An uncertain reply reads only its original UUID. */
export async function executeRestoreArchive(input: {
  identity: RestoreIdentity;
  prepared: PreparedRestoreArchive;
  bucket: RestoreArchiveBucket;
  native: ArchiveTransport;
  deadline: number;
  now(): number;
  controlMs: number;
  finish(receipt: RestoreReceipt): Promise<void>;
}): Promise<RestoreReceipt> {
  const identity = restoreIdentitySchema.parse(input.identity);
  const request = { ref: identity.ref, attempt: identity.attempt, identity };
  const snapshot = (value: unknown) => {
    const saved = restoreSnapshotSchema.parse(value);
    if (
      !sameRestoreIdentity(saved.identity, identity) ||
      (saved.receipt && !sameRestoreIdentity(saved.receipt.identity, identity))
    )
      throw new Error("original archive identity changed");
    return saved;
  };
  const read = async () =>
    snapshot(archiveControlAnswer(await input.native.request({ mode: "archive-read", ...request }, input.controlMs)));
  const call = async (mode: string, extra: Record<string, unknown> = {}, timeoutMs = input.controlMs) =>
    snapshot(archiveControlAnswer(await input.native.request({ mode, ...request, ...extra }, timeoutMs)));
  const finish = async (saved: z.infer<typeof restoreSnapshotSchema>) => {
    if (!saved.receipt) throw new Error("original archive cleanup receipt is absent");
    await input.finish(saved.receipt);
    return saved.receipt;
  };
  try {
    let saved;
    try {
      saved = await call("archive-prepare");
    } catch {
      saved = await read();
    }
    if (saved.receipt) return await finish(saved);
    if (saved.phase !== "receiving" || saved.receivedBytes !== 0)
      throw new Error("original archive preparation is unconfirmed");
    if (input.prepared.transfer.kind === "binding") {
      const reader = (await openRestoreArchiveBody(input.bucket, input.prepared.descriptor)).getReader();
      let offset = 0;
      try {
        for (;;) {
          if (input.now() >= input.deadline) throw new Error("archive transfer deadline has ended");
          let timer: ReturnType<typeof setTimeout> | undefined;
          const part = await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("archive transfer deadline has ended")),
                input.deadline - input.now(),
              );
            }),
          ]).finally(() => {
            if (timer !== undefined) clearTimeout(timer);
          });
          if (part.done) break;
          for (let start = 0; start < part.value.length; start += 65536) {
            if (input.now() >= input.deadline) throw new Error("archive transfer deadline has ended");
            const bytes = part.value.subarray(start, start + 65536);
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            const chunk = { appendId: crypto.randomUUID(), offset, hash, data: btoa(binary) };
            try {
              saved = await call("archive-append", chunk);
            } catch {
              saved = await read();
            }
            if (
              saved.phase !== "receiving" ||
              saved.receivedBytes !== offset + bytes.length ||
              saved.append?.id !== chunk.appendId ||
              saved.append.offset !== offset ||
              saved.append.size !== bytes.length ||
              saved.append.hash !== hash
            )
              throw new Error("original archive chunk is unconfirmed");
            offset += bytes.length;
          }
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (offset !== identity.sizeBytes) throw new Error("original archive byte count changed");
    }
    const timeout = input.deadline - input.now();
    if (timeout <= 0) throw new Error("archive restore deadline has ended");
    try {
      saved = await call(
        "archive-run",
        input.prepared.transfer.kind === "presigned" ? { url: input.prepared.transfer.url } : {},
        timeout,
      );
    } catch {
      saved = await read();
    }
    return await finish(saved);
  } catch (cause) {
    // Stop the original admitted cgroup, never discover a process by name.
    // The fixed cleanup verifies frozen/empty state before touching its data.
    try {
      const ended = z
        .object({
          ref: nativeOperatorScopeRefSchema,
          attempt: uuid,
          closed: z.literal(false),
          populated: z.literal(false),
        })
        .strict()
        .parse(archiveControlAnswer(await input.native.request({ mode: "kill-attempt", ...request }, input.controlMs)));
      if (JSON.stringify(ended.ref) !== JSON.stringify(identity.ref) || ended.attempt !== identity.attempt)
        throw new Error("original archive ending changed", { cause });
      let saved;
      try {
        saved = await call("archive-clean");
      } catch {
        saved = await read();
      }
      return await finish(saved);
    } catch (cleanup) {
      throw new RestoreArchiveUnconfirmedError("original archive result or cleanup is unconfirmed", {
        cause: new AggregateError([cause, cleanup]),
      });
    }
  }
}
