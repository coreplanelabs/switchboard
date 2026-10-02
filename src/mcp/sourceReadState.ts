import { z } from "zod";
import { sourceReadJson, sourceReadQuerySchema, sourceReadResponseSchema } from "./sourceReadProtocol.js";

/** Node-free canonical source-action state shared by live and retained storage. */
const text = z.string().min(1).max(1024);
const ownerSchema = z.object({ runId: text, requester: text, agent: text, channelId: text, threadKey: text }).strict();
const recordSchema = z
  .object({
    actionId: text,
    callIds: z.array(text).min(1).max(50),
    toolName: text,
    serverId: text,
    connectionRevision: text,
    sessionId: text,
    operationId: text,
    operationRevision: text,
    query: sourceReadQuerySchema,
    phase: z.enum(["pending", "unknown", "settled"]),
    exposed: z.boolean(),
    response: sourceReadResponseSchema.optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    owner: ownerSchema,
    recoverable: z.boolean(),
    records: z.array(recordSchema).max(50),
  })
  .strict();
export type SourceReadOwner = z.infer<typeof ownerSchema>;
export type SourceReadState = z.infer<typeof stateSchema>;
export type ReadRecord = SourceReadState["records"][number];

export function sourceReadState(value: unknown, owner: SourceReadOwner): SourceReadState | undefined {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success || sourceReadJson(parsed.data.owner) !== sourceReadJson(owner)) return undefined;
  const ids = new Set<string>(),
    calls = new Set<string>();
  for (const r of parsed.data.records) {
    if (ids.has(r.actionId)) return undefined;
    ids.add(r.actionId);
    for (const call of r.callIds) {
      if (calls.has(call)) return undefined;
      calls.add(call);
    }
  }
  return parsed.data;
}

/** Reference to the original persisted tool action, never model-authored proof. */
export interface SourceReadReference {
  runId: string;
  actionId: string;
  callIds: string[];
  responseHash: string;
}

const boundedString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function isSourceReadReference(value: unknown): value is SourceReadReference {
  if (!value || typeof value !== "object") return false;
  const r = value as SourceReadReference;
  return (
    boundedString(r.runId) &&
    boundedString(r.actionId) &&
    Array.isArray(r.callIds) &&
    r.callIds.length > 0 &&
    r.callIds.length <= 32 &&
    r.callIds.every(boundedString) &&
    new Set(r.callIds).size === r.callIds.length &&
    hash(r.responseHash)
  );
}
