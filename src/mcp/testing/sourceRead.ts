// A second source speaks the same operation protocol with its own query schema.
// Production admission must depend on the protocol, never a server or tool name.
import type { McpToolInfo } from "../types.js";

export const readDescriptor = {
  version: 1,
  operationId: "metrics.failures.list",
  operationRevision: "1",
  lifecycle: "execute_inspect",
  resourceEffect: "read",
  incidentalEffects: ["receipt_storage", "authorization_cache", "telemetry"],
  replayPolicy: "reconcile_only",
  revocationConsistency: "eventual",
};

export const readQuery = { resource: { project: "checkout" }, input: { limit: 10 } };
export const readTool = {
  name: "readFailures",
  annotations: { readOnlyHint: false, destructiveHint: false },
  _meta: { sourceAction: readDescriptor },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["version", "action", "actionId", "operationRevision", "resource", "input"],
    properties: {
      version: { type: "number", const: 1 },
      action: { type: "string", enum: ["execute", "inspect"] },
      actionId: { type: "string", pattern: "^[a-zA-Z0-9_.:-]{1,160}$" },
      operationRevision: { type: "string", const: "1" },
      resource: {
        type: "object",
        additionalProperties: false,
        required: ["project"],
        properties: { project: { type: "string", minLength: 1 } },
      },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["limit"],
        properties: { limit: { type: "integer", minimum: 1, maximum: 25 } },
      },
    },
  },
} satisfies McpToolInfo;

export function readResponse(actionId: string, sessionId = "session-original") {
  return {
    version: 1,
    actionId,
    operationId: readDescriptor.operationId,
    operationRevision: "1",
    binding: {
      id: "binding-original",
      revision: "revision-original",
      subjectId: "subject-original",
      sessionId,
      ...readQuery,
      expiresAt: "2030-01-01T01:00:00.000Z",
    },
    status: "succeeded",
    attempt: "completed",
    observedAt: "2030-01-01T00:00:00.000Z",
    truncation: "none",
    result: { failures: [{ id: "failure-real-response", count: 17 }] },
  };
}
