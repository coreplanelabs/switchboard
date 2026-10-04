import { z } from "zod";
import { dependencyLayoutProgram } from "./seedPlan.js";
import { shellQuote } from "./shellQuote.js";

export const dependencyInspectionInputSchema = z
  .object({
    threadKey: z.string().min(1).max(512),
    ref: z.string().min(1).max(255),
    head: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();

const inspectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
  z
    .object({
      kind: z.literal("invalid"),
      reason: z.enum([
        "root-layout",
        "manifest",
        "workspace-layout",
        "package-name",
        "package-missing",
        "package-manifest",
        "bin-target",
        "bin-link",
      ]),
      package: z
        .string()
        .max(256)
        .regex(/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/)
        .optional(),
      bin: z
        .string()
        .max(256)
        .regex(/^[A-Za-z0-9_.-]+$/)
        .optional(),
    })
    .strict(),
]);
export type DependencyInspection = z.infer<typeof inspectionSchema>;

/** The shared readiness probe loads only native modules and installed manifests. */
export function dependencyInspectionCommand(workspace: string, head: string): string {
  return `node -e ${shellQuote(dependencyLayoutProgram(head))} ${shellQuote(workspace)}`;
}

/** Native process errors may contain private bytes; only the closed schema crosses the boundary. */
export function parseDependencyInspection(raw: unknown): DependencyInspection {
  if (typeof raw !== "object" || raw === null) return { kind: "unknown" };
  const output = raw as Record<string, unknown>;
  if (
    typeof output.stdout !== "string" ||
    output.stdout.length > 2048 ||
    output.stderr !== "" ||
    output.truncated === true ||
    output.timedOut === true
  )
    return { kind: "unknown" };
  try {
    const parsed = inspectionSchema.safeParse(JSON.parse(output.stdout));
    if (
      !parsed.success ||
      (parsed.data.kind === "ready"
        ? output.exitCode !== 0
        : parsed.data.kind === "invalid"
          ? output.exitCode !== 2
          : output.exitCode !== 1)
    )
      return { kind: "unknown" };
    return parsed.data;
  } catch {
    return { kind: "unknown" };
  }
}

/** Drain both native streams concurrently; retain at most the parser's byte cap per stream. */
export async function collectDependencyInspection(process: {
  stdout: ReadableStream<Uint8Array> | null | undefined;
  stderr: ReadableStream<Uint8Array> | null | undefined;
  exitCode: Promise<number>;
}): Promise<DependencyInspection> {
  const read = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
    if (!stream) return { text: "", invalid: true };
    const reader = stream.getReader();
    let size = 0,
      invalid = false;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || value.byteLength > 2048 - size) {
          invalid = true;
          chunks.length = 0;
        } else if (!invalid) {
          size += value.byteLength;
          chunks.push(value);
        }
      }
    } catch {
      invalid = true;
    } finally {
      reader.releaseLock();
    }
    if (invalid) return { text: "", invalid };
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(bytes), invalid };
  };
  const settled = await Promise.allSettled([read(process.stdout), read(process.stderr), process.exitCode]);
  const [stdout, stderr, exit] = settled;
  if (
    stdout.status !== "fulfilled" ||
    stderr.status !== "fulfilled" ||
    exit.status !== "fulfilled" ||
    stdout.value.invalid ||
    stderr.value.invalid
  )
    return { kind: "unknown" };
  return parseDependencyInspection({ stdout: stdout.value.text, stderr: stderr.value.text, exitCode: exit.value });
}
