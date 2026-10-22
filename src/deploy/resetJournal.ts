import { createHash } from "node:crypto";
import { z } from "zod";
import { sealCredential, openCredential, type CredentialKey } from "../mcp/sealed.js";
import type { SealedCredential } from "../mcp/registry.js";
import { captureException } from "../core/runStateWriteDiagnostic.js";
import { systemClock } from "../core/trace/clock.js";
import type { ResetCloudflare } from "./resetCloudflare.js";

const envelope = z
  .object({ serverId: z.string(), keyId: z.string(), sealed: z.string(), updatedAt: z.number() })
  .strict();

interface ResetJournalWriteDiagnostic {
  account: string;
  bucket: string;
  keySha256: string;
  stage: "absence" | "put" | "readback";
  reason: "http" | "body-mismatch";
  httpStatus: number;
  requestId: string | null;
  writeOutcome: "unknown";
  reporting?: "failed";
  reportingError?: "TypeError" | "RangeError" | "SyntaxError" | "Error" | "non-error";
}

/** Safe facts also survive in the controller's held receipt if log delivery fails. */
export class ResetJournalWriteError extends Error {
  constructor(
    message: string,
    readonly diagnostic: ResetJournalWriteDiagnostic,
  ) {
    super(message, { cause: diagnostic });
    this.name = "ResetJournalWriteError";
  }
}

/** This private control bucket is outside the two application buckets being cleared. */
export class ResetJournal {
  readonly bucket: string;
  private readonly path: string;
  private readonly identity: string;
  private readonly markerId: string;
  constructor(
    private readonly native: ResetCloudflare,
    memoryScript: string,
    workers: string[],
    private readonly key: CredentialKey,
    private readonly now: () => number = systemClock,
  ) {
    this.bucket = `${memoryScript}-reset-journal`;
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(this.bucket)) throw new Error("reset journal bucket name is invalid");
    this.path = `/accounts/${native.account}/r2/buckets/${this.bucket}`;
    this.identity = JSON.stringify({ schema: 1, account: native.account, workers: [...workers].sort() });
    this.markerId = `installation-reset:${native.account}:journal:${this.bucket}`;
  }
  private objectPath(key: string) {
    if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.split("/").some((part) => !part || part === "." || part === ".."))
      throw new Error("reset journal key is invalid");
    return `${this.path}/objects/${key}`;
  }
  private async privateStorage() {
    const [managed, custom, lifecycle] = await Promise.all([
      this.native.request(`${this.path}/domains/managed`),
      this.native.request(`${this.path}/domains/custom`),
      this.native.request(`${this.path}/lifecycle`),
    ]);
    if (
      !z
        .object({ enabled: z.literal(false) })
        .passthrough()
        .safeParse(managed.result).success ||
      !z
        .object({ domains: z.array(z.unknown()).length(0) })
        .passthrough()
        .safeParse(custom.result).success
    )
      throw new Error("reset journal bucket must have no public endpoint");
    const rules = z
      .object({ rules: z.array(z.record(z.string(), z.unknown())) })
      .passthrough()
      .parse(lifecycle.result).rules;
    if (
      rules.some(
        (rule) =>
          rule.enabled !== false &&
          Object.keys(rule).some(
            (name) =>
              !["id", "enabled", "conditions", "abortMultipartUploadsTransition", "storageClassTransitions"].includes(
                name,
              ),
          ),
      )
    )
      throw new Error("reset journal bucket has an expiration or unrecognized lifecycle rule");
  }
  private async marker(text: string) {
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { ok: false as const, cause: captureException(error) };
    }
    const parsed = envelope.safeParse(input);
    if (!parsed.success || parsed.data.serverId !== this.markerId || parsed.data.keyId !== this.key.keyId)
      return { ok: false as const, cause: { name: "ResetJournalOwnerMismatch" } };
    return {
      ok: (await openCredential(this.key, parsed.data)) === this.identity,
      cause: { name: "ResetJournalOwnerMismatch" },
    };
  }
  async inspect(): Promise<{ bucket: string; status: "new" | "owned" }> {
    const found = await this.native.response(this.path);
    if (found.status === 404) return { bucket: this.bucket, status: "new" };
    if (!found.ok) throw new Error("reset journal bucket read is unverified");
    const metadata = z
      .object({ success: z.literal(true), result: z.object({ name: z.literal(this.bucket) }).passthrough() })
      .passthrough()
      .safeParse(await found.json());
    if (!metadata.success) throw new Error("reset journal bucket identity is unverified");
    await this.privateStorage();
    const response = await this.native.response(this.objectPath("owner.sealed.json"));
    if (!response.ok) throw new Error("existing reset journal bucket has no verified owner");
    const marker = await this.marker(await response.text());
    if (!marker.ok) throw new Error("existing reset journal bucket belongs to another owner", { cause: marker.cause });
    return { bucket: this.bucket, status: "owned" };
  }
  /** Creating an absent control bucket is the first apply mutation, before settings freeze. */
  async ensure(): Promise<void> {
    const found = await this.inspect();
    if (found.status === "owned") return;
    await this.native.request(`/accounts/${this.native.account}/r2/buckets`, "POST", { name: this.bucket });
    await this.privateStorage();
    await this.write("owner.sealed.json", await sealCredential(this.key, this.markerId, this.identity, this.now()));
    if ((await this.inspect()).status !== "owned") throw new Error("reset journal owner verification failed");
  }
  async read(key: string): Promise<string> {
    if ((await this.inspect()).status !== "owned") throw new Error("reset journal is absent");
    const response = await this.native.response(this.objectPath(key));
    if (!response.ok) throw new Error("reset journal record read is unverified");
    return response.text();
  }
  async list(run: string) {
    if (!/^[1-9][0-9]*$/.test(run)) throw new Error("reset receipt listing requires an exact workflow run ID");
    if ((await this.inspect()).status !== "owned") throw new Error("reset journal is absent");
    return (await this.native.bucket(this.bucket)).objects.filter((object) => object.key.startsWith(`runs/${run}/`));
  }
  private writeFailure(
    key: string,
    stage: ResetJournalWriteDiagnostic["stage"],
    response: Response,
    message: string,
    reason: ResetJournalWriteDiagnostic["reason"] = "http",
  ): never {
    const ray = response.headers.get("cf-ray");
    const diagnostic: ResetJournalWriteDiagnostic = {
      account: this.native.account,
      bucket: this.bucket,
      keySha256: createHash("sha256").update(key).digest("hex"),
      stage,
      reason,
      httpStatus: response.status,
      requestId: ray && /^[a-f0-9]{16,32}(?:-[a-z]{3})?$/i.test(ray) ? ray : null,
      writeOutcome: "unknown",
    };
    const error = new ResetJournalWriteError(message, diagnostic);
    try {
      console.error(JSON.stringify({ event: "installation.reset.journal.failure", ...diagnostic }));
    } catch (reportingError) {
      // Built-in classes identify the sink failure without copying arbitrary names or private prose.
      diagnostic.reporting = "failed";
      diagnostic.reportingError =
        reportingError instanceof TypeError
          ? "TypeError"
          : reportingError instanceof RangeError
            ? "RangeError"
            : reportingError instanceof SyntaxError
              ? "SyntaxError"
              : reportingError instanceof Error
                ? "Error"
                : "non-error";
    }
    throw error;
  }
  /** Unique immutable names plus the shared deployment lock preserve the original write. */
  async write(key: string, sealed: SealedCredential) {
    if (
      !envelope.safeParse(sealed).success ||
      !sealed.serverId.startsWith(`installation-reset:${this.native.account}:`)
    )
      throw new Error("reset journal accepts only this account's sealed records");
    const path = this.objectPath(key);
    const existing = await this.native.response(path);
    if (existing.status !== 404) {
      if (existing.ok) throw new Error("reset journal key exists or its absence is unverified");
      this.writeFailure(key, "absence", existing, "reset journal key absence is unverified; no write is allowed");
    }
    const text = JSON.stringify(sealed) + "\n";
    const put = await this.native.response(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: text,
    });
    if (!put.ok) this.writeFailure(key, "put", put, "original reset journal write is unverified; no retry is allowed");
    const read = await this.native.response(path);
    if (!read.ok)
      this.writeFailure(key, "readback", read, "original reset journal readback is unverified; no deletion is allowed");
    if ((await read.text()) !== text)
      this.writeFailure(
        key,
        "readback",
        read,
        "original reset journal readback differs; no deletion is allowed",
        "body-mismatch",
      );
    return {
      bucket: this.bucket,
      key,
      sha256: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  }
}
