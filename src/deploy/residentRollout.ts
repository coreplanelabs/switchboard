import { createHash } from "node:crypto";

export interface ResidentRolloutReceipt {
  /** Immutable linux/amd64 manifest copied into this Cloudflare account registry. */
  manifestDigest: string;
  /** Durable receipt for the control-reset path retaining the live pi process. */
  controlResetPiReceipt: string;
  /** The complete effective Containers configuration this receipt verified. */
  configuration: Record<string, unknown>;
  /** SHA-256 of `configuration`, including every nested declared field. */
  configurationFingerprint: string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export function configurationFingerprint(configuration: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonical(configuration)).digest("hex")}`;
}

export type ResidentRolloutDecision = { rollout: "none"; reason: string } | { rollout: "drain"; reason: string };

/**
 * The only door to `--containers-rollout=none`. Any missing or inconsistent
 * receipt falls back to the ordinary drain/preflight/deploy/reconcile/lift
 * sequence; a force always asks Cloudflare to apply the declared container
 * configuration.
 */
export function residentRolloutDecision(input: {
  account: string;
  mode: "build" | "registry";
  force: boolean;
  receipt?: ResidentRolloutReceipt;
  current: Record<string, unknown> | undefined;
}): ResidentRolloutDecision {
  if (input.force) return { rollout: "drain", reason: "a forced deploy always applies the container configuration" };
  if (input.mode !== "registry")
    return { rollout: "drain", reason: "build mode has no immutable registry manifest receipt" };
  const receipt = input.receipt;
  if (!receipt) return { rollout: "drain", reason: "the profile has no resident rollout receipt" };
  if (!DIGEST.test(receipt.manifestDigest))
    return { rollout: "drain", reason: "the profile's resident manifest digest is not immutable" };
  if (receipt.controlResetPiReceipt.trim() === "")
    return { rollout: "drain", reason: "the profile has no control-reset/pi receipt" };
  if (!FINGERPRINT.test(receipt.configurationFingerprint))
    return { rollout: "drain", reason: "the profile's resident configuration fingerprint is malformed" };
  const declaredFingerprint = configurationFingerprint(receipt.configuration);
  if (declaredFingerprint !== receipt.configurationFingerprint)
    return { rollout: "drain", reason: "the declared resident configuration does not match its fingerprint" };
  if (!input.current) return { rollout: "drain", reason: "the current resident container configuration is unreadable" };
  if (configurationFingerprint(input.current) !== declaredFingerprint)
    return { rollout: "drain", reason: "wrangler containers info does not exactly match the declared configuration" };
  const image = input.current.image;
  const immutablePrefix = `registry.cloudflare.com/${input.account}/`;
  if (typeof image !== "string" || !image.startsWith(immutablePrefix) || !image.endsWith(`@${receipt.manifestDigest}`))
    return { rollout: "drain", reason: "the current resident image is not the receipted immutable account image" };
  return {
    rollout: "none",
    reason: "the immutable resident image and full effective container configuration match the verified receipt",
  };
}
