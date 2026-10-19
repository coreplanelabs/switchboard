// Saved producer decoding is shared with Workers and must not load the bot runtime.
import { WIRES, type Wire } from "../provider.js";
import type { HarnessFacts, PiHarnessFacts, OpenCodeHarnessFacts } from "./contract.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A relaunch count as a row carries it: a non-negative integer, else 0 (a row from before the field, or a corrupt one). */
const relaunchesOf = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** The harness facts a previous generation wrote on the row, read by the shape
 *  the row's `harness` names: a row naming `pi`, or none (written before the
 *  discriminator existed, when pi was the one harness that ever wrote a row),
 *  is pi's; a row naming `opencode` is OpenCode's. Each shape's known fields
 *  are read by type and a field of the wrong type is dropped; every other key
 *  is kept as it stands, so a field a later build writes survives this build's
 *  rewrite of the row. A row missing a shape's required fields, or naming a
 *  harness this build does not know, is no facts: nothing of it can be judged
 *  or ended here. */
export function harnessFactsOf(value: unknown): HarnessFacts | undefined {
  if (!isRecord(value)) return undefined;
  const name = value.harness === undefined ? "pi" : value.harness;
  if (name === "pi") return piFactsOf(value);
  if (name === "opencode") return openCodeFactsOf(value);
  return undefined;
}

function piFactsOf(v: Record<string, unknown>): PiHarnessFacts | undefined {
  const {
    harness: _harness,
    pid,
    processBirth,
    logOffset,
    sessionFile,
    root,
    bearerHash,
    wire,
    container,
    relaunches,
    ...rest
  } = v;
  if (typeof pid !== "number" || typeof logOffset !== "number") return undefined;
  return {
    ...rest,
    harness: "pi",
    pid,
    ...(typeof processBirth === "string" ? { processBirth } : {}),
    logOffset,
    relaunches: relaunchesOf(relaunches),
    ...(typeof sessionFile === "string" ? { sessionFile } : {}),
    ...(typeof bearerHash === "string" ? { bearerHash } : {}),
    ...(typeof root === "string" ? { root } : {}),
    ...((WIRES as readonly unknown[]).includes(wire) ? { wire: wire as Wire } : {}),
    ...(typeof container === "string" ? { container } : {}),
  };
}

function openCodeFactsOf(v: Record<string, unknown>): OpenCodeHarnessFacts | undefined {
  const {
    harness: _harness,
    pid,
    processBirth,
    port,
    tailerPid,
    tailerProcessBirth,
    logOffset,
    sessionID,
    root,
    bearerHash,
    container,
    relaunches,
    ...rest
  } = v;
  if (typeof pid !== "number" || typeof port !== "number" || typeof logOffset !== "number") return undefined;
  if (typeof sessionID !== "string" || typeof root !== "string") return undefined;
  return {
    ...rest,
    harness: "opencode",
    pid,
    ...(typeof processBirth === "string" ? { processBirth } : {}),
    port,
    logOffset,
    sessionID,
    root,
    relaunches: relaunchesOf(relaunches),
    ...(typeof tailerPid === "number" ? { tailerPid } : {}),
    ...(typeof tailerProcessBirth === "string" ? { tailerProcessBirth } : {}),
    ...(typeof bearerHash === "string" ? { bearerHash } : {}),
    ...(typeof container === "string" ? { container } : {}),
  };
}
