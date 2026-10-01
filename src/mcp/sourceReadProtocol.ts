import { z } from "zod";
import type { McpToolInfo } from "./types.js";

const id = z.string().min(1).max(256);
const object = z.record(z.string(), z.json());
export const sourceReadQuerySchema = z.object({ resource: object, input: object }).strict();
export type SourceReadQuery = z.infer<typeof sourceReadQuerySchema>;
const descriptorSchema = z
  .object({
    version: z.literal(1),
    operationId: id,
    operationRevision: id,
    lifecycle: z.literal("execute_inspect"),
    resourceEffect: z.literal("read"),
    incidentalEffects: z.array(z.enum(["receipt_storage", "authorization_cache", "telemetry"])).max(3),
    replayPolicy: z.literal("reconcile_only"),
    revocationConsistency: z.literal("eventual"),
  })
  .strict();
export type SourceReadDescriptor = z.infer<typeof descriptorSchema>;
export const sourceReadBindingSchema = z
  .object({
    id,
    revision: id,
    subjectId: id,
    sessionId: id,
    resource: object,
    input: object,
    expiresAt: z.iso.datetime(),
  })
  .strict();
const reason = z.enum([
  "invalid_request",
  "unauthorized",
  "unavailable",
  "action_conflict",
  "not_found",
  "expired",
  "authorization_changed",
  "capacity",
]);
const receiptBase = z.object({
  version: z.literal(1),
  actionId: id,
  operationId: id,
  operationRevision: id,
  binding: sourceReadBindingSchema,
});
export const sourceReadResponseSchema = z.union([
  z.object({ version: z.literal(1), status: z.literal("refused"), actionId: id.optional(), reason }).strict(),
  receiptBase
    .extend({
      status: z.literal("succeeded"),
      attempt: z.literal("completed"),
      observedAt: z.iso.datetime(),
      truncation: z.enum(["none", "limit_reached", "result_budget"]),
      result: object,
    })
    .strict(),
  receiptBase
    .extend({
      status: z.literal("unknown"),
      attempt: z.literal("possibly_dispatched"),
      reason: z.enum(["pending", "provider_unavailable", "receipt_unavailable"]),
    })
    .strict(),
  receiptBase
    .extend({
      status: z.literal("refused"),
      attempt: z.enum(["not_attempted", "possibly_dispatched", "completed"]),
      reason,
    })
    .strict(),
]);
export type SourceReadResponse = z.infer<typeof sourceReadResponseSchema>;
export type SourceReadReceipt = Extract<SourceReadResponse, { binding: unknown }>;

/** Canonical structured equality, independent of object key ordering. */
export function sourceReadJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sourceReadJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${sourceReadJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** This version accepts closed inline query schemas; references/composition cannot hide authority fields. */
function closed(schema: unknown, depth = 0): boolean {
  if (
    !record(schema) ||
    depth > 8 ||
    Object.keys(schema).some((key) =>
      ["$ref", "$dynamicRef", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "patternProperties"].includes(
        key,
      ),
    )
  )
    return false;
  if (schema.type === "object")
    return (
      schema.additionalProperties === false &&
      record(schema.properties) &&
      Object.keys(schema.properties).length <= 32 &&
      Object.values(schema.properties).every((s) => closed(s, depth + 1))
    );
  if (schema.type === "array") return closed(schema.items, depth + 1);
  return ["string", "number", "integer", "boolean", "null"].includes(String(schema.type));
}

export interface SourceReadContract {
  descriptor: SourceReadDescriptor;
  querySchema: Record<string, unknown>;
  accepts(query: unknown): query is SourceReadQuery;
}

/** A declaration is parsed, never inferred from annotations, names, or tool prose. */
export function sourceReadContract(tool: McpToolInfo): SourceReadContract | undefined {
  const parsed = descriptorSchema.safeParse(tool._meta?.sourceAction);
  if (!parsed.success) return undefined;
  const schema = tool.inputSchema;
  if (!closed(schema) || !record(schema.properties)) return undefined;
  const fields = ["version", "action", "actionId", "operationRevision", "resource", "input"];
  if (
    sourceReadJson(Object.keys(schema.properties).sort()) !== sourceReadJson([...fields].sort()) ||
    !Array.isArray(schema.required) ||
    sourceReadJson([...schema.required].sort()) !== sourceReadJson([...fields].sort())
  )
    return undefined;
  const p = schema.properties;
  if (
    !record(p.version) ||
    p.version.const !== 1 ||
    !record(p.operationRevision) ||
    p.operationRevision.const !== parsed.data.operationRevision ||
    !record(p.action) ||
    sourceReadJson(p.action.enum) !== sourceReadJson(["execute", "inspect"]) ||
    !record(p.resource) ||
    p.resource.type !== "object" ||
    !record(p.input) ||
    p.input.type !== "object"
  )
    return undefined;
  const querySchema = {
    type: "object" as const,
    additionalProperties: false,
    required: ["resource", "input"],
    properties: { resource: p.resource, input: p.input },
  };
  try {
    const validator = z.fromJSONSchema(querySchema);
    return {
      descriptor: parsed.data,
      querySchema,
      accepts: (query): query is SourceReadQuery =>
        sourceReadQuerySchema.safeParse(query).success && validator.safeParse(query).success,
    };
  } catch {
    return undefined;
  }
}
