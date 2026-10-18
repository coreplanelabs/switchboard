import { describe, expect, it } from "vitest";
import {
  executeRestoreArchive,
  RestoreArchiveUnconfirmedError,
  openRestoreArchiveBody,
  pathsOverlap,
  prepareRestoreArchive,
  restoreIdentitySchema,
  restoreReceiptSchema,
} from "./restoreArchive.js";

const backupId = "44444444-4444-4444-8444-444444444444";
const attempt = "55555555-5555-4555-8555-555555555555";
const etag = "a".repeat(32);
const now = Date.parse("2026-10-17T20:00:00.000Z");
const descriptor = { version: 1 as const, backupId, target: "/workspace/mirror", sizeBytes: 3, etag };
const identity = {
  ...descriptor,
  attempt,
  ref: {
    version: 1 as const,
    kind: "operation" as const,
    id: "33333333-3333-4333-8333-333333333333",
    boot: "11111111-1111-4111-8111-111111111111",
    owner: { opOwner: "op:archive" },
  },
};
function fixture() {
  const data = { id: backupId, sizeBytes: 3, createdAt: "2026-10-17T19:00:00.000Z", ttl: 7200 };
  let metadata: typeof data | null = data;
  let head: { size: number; etag: string } | null = { size: 3, etag };
  let conditional = "";
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    BACKUP_BUCKET: {
      get: async (key: string, options?: { onlyIf: { etagMatches: string } }) => {
        if (key.endsWith("/meta.json")) return metadata && { size: 180, etag, json: async () => metadata };
        conditional = options?.onlyIf.etagMatches ?? "";
        return (
          head && {
            ...head,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
              },
            }),
          }
        );
      },
      head: async () => head,
    },
  };
  return {
    env,
    data,
    setMetadata: (value: typeof data | null) => {
      metadata = value;
    },
    setHead: (value: typeof head) => {
      head = value;
    },
    conditional: () => conditional,
  };
}

describe("UUID-owned restore archive preparation", () => {
  it("pins the selected archive and target through the binding without reading its body", async () => {
    const h = fixture();
    expect(await prepareRestoreArchive(h.env, backupId, "/workspace/mirror", now, now + 600000, 60000)).toEqual({
      descriptor,
      transfer: { kind: "binding" },
    });
    expect(h.conditional()).toBe("");
    const body = await openRestoreArchiveBody(h.env.BACKUP_BUCKET, descriptor);
    expect([...new Uint8Array(await new Response(body).arrayBuffer())]).toEqual([1, 2, 3]);
    expect(h.conditional()).toBe(etag);
  });
  it("signs only the selected object with its ETag condition and caller deadline", async () => {
    const h = fixture();
    const prepared = await prepareRestoreArchive(
      {
        ...h.env,
        BACKUP_BUCKET_NAME: "backups",
        R2_ACCESS_KEY_ID: "fixture-access",
        R2_SECRET_ACCESS_KEY: "fixture-secret",
      },
      backupId,
      "/workspace/mirror",
      now,
      now + 600000,
      60000,
    );
    expect(prepared.descriptor).toEqual(descriptor);
    expect(prepared.transfer.kind).toBe("presigned");
    if (prepared.transfer.kind !== "presigned") throw new Error("missing signed transfer");
    const url = new URL(prepared.transfer.url);
    expect(url.origin + url.pathname).toBe(
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com/backups/backups/${backupId}/data.sqsh`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("if-match");
    expect(JSON.stringify(prepared.descriptor)).not.toContain("fixture-secret");
  });
  it.each(["metadata", "archive"] as const)("keeps a missing %s refusal before native submission", async (missing) => {
    const h = fixture();
    if (missing === "metadata") h.setMetadata(null);
    else h.setHead(null);
    await expect(
      prepareRestoreArchive(h.env, backupId, "/workspace/mirror", now, now + 600000, 60000),
    ).rejects.toMatchObject({ name: "BackupNotFoundError", backupId });
  });
  it("refuses an expired original backup before transfer preparation", async () => {
    const h = fixture();
    h.setMetadata({ ...h.data, ttl: 1 });
    await expect(
      prepareRestoreArchive(h.env, backupId, "/workspace/mirror", now, now + 600000, 60000),
    ).rejects.toMatchObject({ name: "BackupExpiredError", backupId });
  });
  it("refuses metadata and conditional-body identity changes", async () => {
    const h = fixture();
    h.setMetadata({ ...h.data, id: attempt });
    await expect(prepareRestoreArchive(h.env, backupId, "/workspace/mirror", now, now + 600000, 60000)).rejects.toThrow(
      "backup metadata identity changed",
    );
    h.setMetadata(h.data);
    h.setHead({ size: 4, etag });
    await expect(prepareRestoreArchive(h.env, backupId, "/workspace/mirror", now, now + 600000, 60000)).rejects.toThrow(
      "backup archive size changed",
    );
    h.setHead({ size: 3, etag: "b".repeat(32) });
    await expect(openRestoreArchiveBody(h.env.BACKUP_BUCKET, descriptor)).rejects.toThrow(
      "original backup archive is unavailable",
    );
  });
  it("permits only fixed parents and a full UUID dependency target", () => {
    expect(restoreIdentitySchema.parse({ ...identity, target: `/workspace/deps/.scratch-${attempt}` }).target).toBe(
      `/workspace/deps/.scratch-${attempt}`,
    );
    for (const target of [
      "/workspace/neighbor/tree",
      "/workspace/deps/.scratch-short",
      "/workspace/../etc",
      "/workspace/mirror/child",
    ])
      expect(restoreIdentitySchema.safeParse({ ...identity, target }).success).toBe(false);
  });
  it("accepts a bounded original cleanup receipt and refuses extra authority", () => {
    const receipt = { identity, outcome: "committed", cleanup: "complete" };
    expect(restoreReceiptSchema.parse(receipt)).toEqual(receipt);
    for (const value of [
      { ...receipt, cleanup: "unknown" },
      { ...receipt, url: "private" },
      { ...receipt, outcome: "aborted" },
    ])
      expect(restoreReceiptSchema.safeParse(value).success).toBe(false);
    expect(restoreReceiptSchema.parse({ ...receipt, outcome: "aborted", reason: "cancelled" }).outcome).toBe("aborted");
  });
  it("protects both target ancestry and exact names without matching a neighboring prefix", () => {
    expect([
      pathsOverlap("/workspace", "/workspace/mirror"),
      pathsOverlap("/workspace/mirror/.git", "/workspace/mirror"),
      pathsOverlap("/workspace/mirror", "/workspace/mirror"),
      pathsOverlap("/workspace/mirror-neighbor", "/workspace/mirror"),
    ]).toEqual([true, true, true, false]);
  });
});

describe("UUID archive execution", () => {
  function nativeFixture(
    options: {
      lostAppend?: boolean;
      lostRun?: boolean;
      uncertainInstall?: boolean;
      badReceipt?: boolean;
      transferFailure?: boolean;
    } = {},
  ) {
    const calls: Record<string, unknown>[] = [];
    const receipts: unknown[] = [];
    let saved: any = { identity, phase: "receiving", receivedBytes: 0 };
    const native = {
      request: async (value: Record<string, unknown>) => {
        calls.push(value);
        const answer = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "", exitCode: 0, timedOut: false });
        switch (value.mode) {
          case "archive-prepare":
            return answer(saved);
          case "archive-read":
            return answer(saved);
          case "archive-append": {
            const size = atob(String(value.data)).length;
            saved = {
              ...saved,
              receivedBytes: Number(value.offset) + size,
              append: { id: value.appendId, offset: value.offset, size, hash: value.hash },
            };
            if (options.lostAppend) throw new Error("append reply lost");
            return answer(saved);
          }
          case "archive-run":
            if (options.uncertainInstall) {
              saved = { ...saved, phase: "installing" };
              throw new Error("install receipt lost");
            }
            if (options.transferFailure) throw new Error("transfer failed");
            saved = {
              ...saved,
              phase: "done",
              receipt: {
                identity: options.badReceipt ? { ...identity, backupId: attempt } : identity,
                outcome: "committed",
                cleanup: "complete",
              },
            };
            if (options.lostRun) throw new Error("run reply lost");
            return answer(saved);
          case "kill-attempt":
            return answer({ ref: identity.ref, attempt: identity.attempt, closed: false, populated: false });
          case "archive-clean":
            if (saved.phase === "installing") throw new Error("installation is unknown");
            if (saved.phase !== "done")
              saved = {
                ...saved,
                phase: "done",
                receipt: { identity, outcome: "aborted", cleanup: "complete", reason: "cancelled" },
              };
            return answer(saved);
          default:
            throw new Error("unexpected mode");
        }
      },
    };
    const env = fixture().env;
    const execute = async (transfer: "binding" | "presigned" = "binding") =>
      executeRestoreArchive({
        identity,
        prepared: {
          descriptor,
          transfer:
            transfer === "binding"
              ? { kind: "binding" }
              : { kind: "presigned", url: "https://archive.example.test/object?secret=fixture" },
        },
        bucket: env.BACKUP_BUCKET,
        native,
        now: () => now,
        deadline: now + 600000,
        controlMs: 2000,
        finish: async (receipt) => {
          receipts.push(receipt);
        },
      });
    return { calls, receipts, execute };
  }
  it("streams the binding through one original attempt and retains its cleanup receipt", async () => {
    const h = nativeFixture();
    expect(await h.execute()).toEqual({ identity, outcome: "committed", cleanup: "complete" });
    expect(h.calls.map((call) => call.mode)).toEqual(["archive-prepare", "archive-append", "archive-run"]);
    expect(atob(String(h.calls[1]!.data))).toBe("\x01\x02\x03");
    expect(h.receipts).toEqual([{ identity, outcome: "committed", cleanup: "complete" }]);
    expect(h.calls.map((call) => ({ ref: call.ref, attempt: call.attempt }))).toEqual(
      Array(3).fill({ ref: identity.ref, attempt: identity.attempt }),
    );
  });
  it("reads a lost append acknowledgment without repeating the chunk", async () => {
    const h = nativeFixture({ lostAppend: true });
    await expect(h.execute()).resolves.toMatchObject({ outcome: "committed" });
    expect(h.calls.map((call) => call.mode)).toEqual([
      "archive-prepare",
      "archive-append",
      "archive-read",
      "archive-run",
    ]);
  });
  it("reads a lost install acknowledgment without repeating extraction", async () => {
    const h = nativeFixture({ lostRun: true });
    await expect(h.execute("presigned")).resolves.toMatchObject({ outcome: "committed" });
    expect(h.calls.map((call) => call.mode)).toEqual(["archive-prepare", "archive-run", "archive-read"]);
    expect(h.receipts).toHaveLength(1);
  });
  it("settles a stopped transfer only from the original completed cleanup", async () => {
    const h = nativeFixture({ transferFailure: true });
    await expect(h.execute()).resolves.toMatchObject({ outcome: "aborted", reason: "cancelled" });
    expect(h.calls.map((call) => call.mode)).toEqual([
      "archive-prepare",
      "archive-append",
      "archive-run",
      "archive-read",
      "kill-attempt",
      "archive-clean",
    ]);
    expect(h.receipts).toHaveLength(1);
  });
  it.each([{ uncertainInstall: true }, { badReceipt: true }])(
    "keeps an uncertain installation or foreign receipt held: %j",
    async (options) => {
      const h = nativeFixture(options);
      await expect(h.execute()).rejects.toBeInstanceOf(RestoreArchiveUnconfirmedError);
      expect(h.receipts).toEqual([]);
      expect(h.calls.filter((call) => call.mode === "archive-run")).toHaveLength(1);
      expect(h.calls.filter((call) => call.mode === "kill-attempt")).toHaveLength(1);
    },
  );
});
