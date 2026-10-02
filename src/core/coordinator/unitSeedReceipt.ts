import type { UnitContextBinding } from "../dispatch/unitContext.js";

/** Acknowledges exact persisted child input. It says nothing about provider execution or source truth. */
export interface UnitSeedReceipt {
  version: 1;
  binding: UnitContextBinding;
  child: { runId: string; requester: string; channelId: string; threadKey: string };
  ownerGen: string;
  workBriefHash: string;
  capsuleHash: string;
  contractHash: string;
  seed: { key: string; from: number; through: number; messagesHash: string; systemHash: string };
  acknowledgedAt: number;
}

/** The reader supplies child identity and contract facts from canonical storage, independently of the receipt. */
export interface UnitSeedEvidence {
  role: "coding" | "review";
  receipt: UnitSeedReceipt;
  child: UnitSeedReceipt["child"];
  binding: UnitContextBinding;
  contractHash: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));

export function isUnitSeedReceipt(value: unknown): value is UnitSeedReceipt {
  if (
    !record(value) ||
    !keys(value, [
      "version",
      "binding",
      "child",
      "ownerGen",
      "workBriefHash",
      "capsuleHash",
      "contractHash",
      "seed",
      "acknowledgedAt",
    ])
  )
    return false;
  const { binding, child, seed } = value;
  return (
    value.version === 1 &&
    record(binding) &&
    keys(binding, ["instanceId", "unit", "instanceAttempt", "idempotencyKey"]) &&
    [binding.instanceId, binding.unit, binding.idempotencyKey].every(text) &&
    index(binding.instanceAttempt) &&
    record(child) &&
    keys(child, ["runId", "requester", "channelId", "threadKey"]) &&
    Object.values(child).every(text) &&
    text(value.ownerGen) &&
    [value.workBriefHash, value.capsuleHash, value.contractHash].every(hash) &&
    record(seed) &&
    keys(seed, ["key", "from", "through", "messagesHash", "systemHash"]) &&
    text(seed.key) &&
    index(seed.from) &&
    index(seed.through) &&
    seed.from <= seed.through &&
    [seed.messagesHash, seed.systemHash].every(hash) &&
    typeof value.acknowledgedAt === "number" &&
    Number.isFinite(value.acknowledgedAt) &&
    value.acknowledgedAt >= 0
  );
}
