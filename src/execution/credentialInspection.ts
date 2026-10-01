import { z } from "zod";
import { CREDENTIAL_INSPECTION_MAX_MS } from "../core/budgets.js";
import { CREDENTIAL_PROBE_SOURCE } from "./credentialProbeSource.js";
import { shellQuote } from "./shellQuote.js";

const count = z.number().int().min(0).max(1_000_000);
const receipt = z
  .object({
    completed: z.boolean(),
    bindingMatched: z.boolean(),
    commandEnvironments: count,
    harnessEnvironments: count,
    filesChecked: count,
    helperEntries: count,
    appTokenMatches: count,
    unknownCount: count,
  })
  .strict();

export type CredentialInspection = z.infer<typeof receipt>;
export interface CredentialProbeOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}
export const credentialInspectionInputSchema = z
  .object({
    runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    pid: z.number().int().positive().max(2147483647),
    processBirth: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[0-9]{1,20}$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    ref: z.string().min(1).max(255),
    head: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
export interface CredentialInspectionInput {
  runId: string;
  pid: number;
  processBirth: string;
  repo: string;
  ref: string;
  head: string;
  signal?: AbortSignal;
}

/** A missing observation is never a zero-count success. */
export function emptyCredentialInspection(): CredentialInspection {
  return {
    completed: false,
    bindingMatched: false,
    commandEnvironments: 0,
    harnessEnvironments: 0,
    filesChecked: 0,
    helperEntries: 0,
    appTokenMatches: 0,
    unknownCount: 1,
  };
}

export function parseCredentialInspection(value: unknown): CredentialInspection {
  const parsed = receipt.safeParse(value);
  if (!parsed.success) return emptyCredentialInspection();
  const out = parsed.data;
  // A transport cannot label partial evidence complete merely by setting a flag.
  if (
    out.completed &&
    (!out.bindingMatched ||
      out.commandEnvironments !== 1 ||
      out.harnessEnvironments !== 1 ||
      out.filesChecked === 0 ||
      out.helperEntries === 0 ||
      out.unknownCount !== 0)
  )
    return emptyCredentialInspection();
  return out;
}

/** Called inside the trusted Worker before output can cross its RPC or HTTP
 * boundary. The callback sends once, without repair or output recovery. */
export async function runCredentialInspection(
  execute: (command: string, opts: CredentialProbeOptions) => Promise<unknown>,
  input: CredentialInspectionInput,
): Promise<CredentialInspection> {
  try {
    if (input.signal?.aborted || !Number.isSafeInteger(input.pid) || input.pid <= 0) return emptyCredentialInspection();
    const args = JSON.stringify({
      runId: input.runId,
      pid: input.pid,
      processBirth: input.processBirth,
      repo: input.repo,
      ref: input.ref,
      head: input.head,
    });
    const command = `/usr/bin/python3 -I -c ${shellQuote(CREDENTIAL_PROBE_SOURCE)} ${shellQuote(args)}`;
    const raw = await execute(command, { timeoutMs: CREDENTIAL_INSPECTION_MAX_MS, signal: input.signal });
    if (input.signal?.aborted || typeof raw !== "object" || raw === null) return emptyCredentialInspection();
    const result = raw as Record<string, unknown>;
    if (
      result.exitCode !== 0 ||
      result.timedOut === true ||
      result.truncated !== false ||
      result.stderr !== "" ||
      typeof result.stdout !== "string" ||
      result.stdout.length > 2048 ||
      "error" in result
    )
      return emptyCredentialInspection();
    return parseCredentialInspection(JSON.parse(result.stdout));
  } catch {
    // Neither an SDK error nor a malformed probe response is safe to log.
    return emptyCredentialInspection();
  }
}
