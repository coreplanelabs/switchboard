import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseConfigLocation } from "./configDocument.js";

/** A code identity, not a health display value or an authorization grant. */
export interface ConfigConsumerIdentity {
  readonly commit: string;
}
export const IMAGE_CONSUMER_BUILD_FILE = "/usr/share/switchboard/build.json";
export type ConsumerIdentityRead = { ok: true; identity: ConfigConsumerIdentity } | { ok: false; problem: string };

export function parseConfigConsumerIdentity(text: string | undefined): ConsumerIdentityRead {
  let value: unknown;
  try {
    value = text === undefined ? undefined : JSON.parse(text);
  } catch {
    value = undefined;
  }
  const commit =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).commit
      : undefined;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit))
    return { ok: false, problem: "config consumer requires an exact clean full build commit" };
  return { ok: true, identity: Object.freeze({ commit }) };
}

export function consumerConfigKey(identity: ConfigConsumerIdentity): string {
  if (!/^[0-9a-f]{40}$/.test(identity.commit)) throw new Error("invalid config consumer identity");
  return `base-${identity.commit}`;
}

/** The legacy state location is only a mode hint for new consumers. */
export function consumerConfigLocation(location: string, identity: ConfigConsumerIdentity): string {
  const parsed = parseConfigLocation(location);
  if (parsed.kind === "file") return location;
  const key = consumerConfigKey(identity);
  if (parsed.key !== "base" && parsed.key !== key)
    throw new Error("state config slot does not belong to this consumer");
  return `state://${key}`;
}

interface ImageIdentityIO {
  read(path: string): string;
  stat(path: string): { uid: number; mode: number; isSymbolicLink(): boolean };
}

/** Fixed image-owned bytes in a protected directory; runtime variables cannot
 *  select another artifact. Models run without root access to this directory. */
export function readImageConfigConsumerIdentity(
  io: ImageIdentityIO = { read: (path) => readFileSync(path, "utf8"), stat: lstatSync },
): ConsumerIdentityRead {
  try {
    for (const path of [IMAGE_CONSUMER_BUILD_FILE, dirname(IMAGE_CONSUMER_BUILD_FILE)]) {
      const stat = io.stat(path);
      if (stat.uid !== 0 || (stat.mode & 0o222) !== 0 || stat.isSymbolicLink())
        return { ok: false, problem: "config consumer build artifact is not protected" };
    }
    return parseConfigConsumerIdentity(io.read(IMAGE_CONSUMER_BUILD_FILE));
  } catch {
    return { ok: false, problem: "config consumer build artifact is missing or unreadable" };
  }
}

export interface ServedConfigConsumer {
  readonly identity: ConfigConsumerIdentity;
  readonly key: string;
  readonly version: number;
  readonly sha256: string;
}

/** Eligibility comes from the installed slot receipt, never a mutable build display. */
export function servedConfigConsumer(
  value: unknown,
): { ok: true; consumer: ServedConfigConsumer } | { ok: false; problem: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, problem: "serving config consumer is unknown" };
  const body = value as Record<string, unknown>;
  const loaded = body.loadedBase;
  if (
    body.ok !== true ||
    body.draining !== false ||
    typeof loaded !== "object" ||
    loaded === null ||
    Array.isArray(loaded)
  )
    return { ok: false, problem: "serving config consumer is unavailable or draining" };
  const receipt = loaded as Record<string, unknown>;
  const process = receipt.process;
  const source = receipt.source;
  if (
    receipt.schema !== 1 ||
    typeof process !== "object" ||
    process === null ||
    Array.isArray(process) ||
    typeof source !== "object" ||
    source === null ||
    Array.isArray(source)
  )
    return { ok: false, problem: "serving config consumer receipt is incomplete" };
  const identity = parseConfigConsumerIdentity(JSON.stringify(process));
  const state = source as Record<string, unknown>;
  if (
    !identity.ok ||
    state.kind !== "state" ||
    state.key !== consumerConfigKey(identity.identity) ||
    typeof state.version !== "number" ||
    !Number.isSafeInteger(state.version) ||
    state.version < 1 ||
    typeof receipt.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.sha256)
  )
    return { ok: false, problem: "serving config consumer has no exact owned slot receipt" };
  return {
    ok: true,
    consumer: Object.freeze({
      identity: identity.identity,
      key: state.key as string,
      version: state.version,
      sha256: receipt.sha256,
    }),
  };
}

/** Refusal data can identify a code consumer, but never an installed config. */
export function refusingConfigConsumer(value: unknown): ConsumerIdentityRead {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, problem: "refusing consumer is unknown" };
  const body = value as Record<string, unknown>;
  const consumer = body.consumer;
  if (body.ok !== false || typeof consumer !== "object" || consumer === null || Array.isArray(consumer))
    return { ok: false, problem: "refusing consumer identity is unavailable" };
  const identity = parseConfigConsumerIdentity(JSON.stringify(consumer));
  if (!identity.ok || (consumer as Record<string, unknown>).expectedKey !== consumerConfigKey(identity.identity))
    return { ok: false, problem: "refusing consumer identity or slot is mismatched" };
  return identity;
}
