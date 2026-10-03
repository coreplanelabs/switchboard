// Controlled fixture reads only. No provider API, production config or deployment is wired here.
import { MINUTE_MS, SOURCE_READ_ELIGIBILITY_MS } from "../../src/core/budgets.js";
import { systemClock } from "../../src/core/trace/clock.js";
import { MCP_PROTOCOL_VERSION } from "../../src/mcp/client.js";
const DELAY_MS = 35_000; // Beyond the client's 30 s timeout; the alarm survives its disconnect.
const RETENTION_MS = SOURCE_READ_ELIGIBILITY_MS;
const RETRY_WINDOW_MS = MINUTE_MS;
const RETRY_DELAY_MS = MINUTE_MS / 12;
const OPERATION = "acceptance.fixture.read";
const REVISION = "1";
const VALUES = { quick: "fixture-quick-v1", slow: "fixture-slow-v1" } as const;
type Resource = keyof typeof VALUES;
const isResource = (value: unknown): value is Resource => value === "quick" || value === "slow";
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  object(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const actionIdValid = (value: unknown): value is string =>
  typeof value === "string" && (/^[a-f0-9-]{36}$/.test(value) || /^read:[a-f0-9]{64}$/.test(value));

export const READ_TOOL = {
  name: "readControlledFixture",
  description: "Read one controlled fixture, or inspect the original action on the same session. No external data.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      version: { type: "number", const: 1 },
      action: { type: "string", enum: ["execute", "inspect"] },
      actionId: { type: "string", pattern: "^([a-f0-9-]{36}|read:[a-f0-9]{64})$" },
      operationRevision: { type: "string", const: REVISION },
      resource: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string", enum: ["quick", "slow"] } },
      },
      input: { type: "object", additionalProperties: false, properties: {}, required: [] },
    },
    required: ["version", "action", "actionId", "operationRevision", "resource", "input"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  _meta: {
    sourceAction: {
      version: 1,
      operationId: OPERATION,
      operationRevision: REVISION,
      lifecycle: "execute_inspect",
      resourceEffect: "read",
      incidentalEffects: ["receipt_storage", "telemetry"],
      replayPolicy: "reconcile_only",
      revocationConsistency: "eventual",
    },
  },
} as const;

type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(at: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  transaction<T>(fn: (tx: Pick<Storage, "get" | "put" | "setAlarm" | "getAlarm">) => Promise<T>): Promise<T>;
};
type State = { storage: Storage };
type Stub = { fetch(request: Request): Promise<Response> };
export interface Env {
  /** Secret binding, provided outside the repository. */
  SOURCE_BEARER: string;
  SOURCE_REQUESTER: string;
  /** Comma-separated subset of the two fixed resource IDs. */
  SOURCE_RESOURCE_SCOPE: string;
  ACTIONS: { idFromName(name: string): unknown; get(id: unknown): Stub };
}
type Query = { resource: { id: Resource }; input: Record<string, never> };
type Entry = {
  actionId: string;
  sessionId: string;
  subjectId: string;
  bindingId: string;
  bindingRevision: string;
  enteredAt: string;
  dueAt: number;
  expiresAt: string;
  stage: "pending" | "succeeded" | "unknown";
  resource: Resource;
  result?: { fixture: string; verified: true };
  observedAt?: string;
};
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const refused = (reason: string, actionId?: string) => ({
  version: 1,
  status: "refused",
  ...(actionId ? { actionId } : {}),
  reason,
});
const queryFor = (args: unknown): (Query & { actionId: string; action: "execute" | "inspect" }) | undefined => {
  if (
    !exact(args, ["version", "action", "actionId", "operationRevision", "resource", "input"]) ||
    args.version !== 1 ||
    args.operationRevision !== REVISION ||
    !actionIdValid(args.actionId) ||
    (args.action !== "execute" && args.action !== "inspect") ||
    !exact(args.resource, ["id"]) ||
    !isResource(args.resource.id) ||
    !exact(args.input, [])
  )
    return undefined;
  return { action: args.action, actionId: args.actionId, resource: { id: args.resource.id }, input: {} };
};

/** All action/session state lives in one Durable Object; it never stores a bearer or a private query. */
export class AcceptanceActions {
  constructor(
    private readonly state: State,
    private readonly env: Env,
  ) {}
  private get storage() {
    return this.state.storage;
  }
  private async session(id: string) {
    return !!id && (await this.storage.get<string>(`session:${id}`)) === this.env.SOURCE_REQUESTER;
  }
  private stage(row: Entry): Entry["stage"] {
    if (row.stage !== "pending") return row.stage;
    if (row.resource === "quick" || systemClock() >= row.dueAt + RETRY_WINDOW_MS) return "unknown";
    return "pending";
  }
  private receipt(row: Entry) {
    const binding = {
      id: row.bindingId,
      revision: row.bindingRevision,
      subjectId: row.subjectId,
      sessionId: row.sessionId,
      resource: { id: row.resource },
      input: {},
      expiresAt: row.expiresAt,
    };
    const base = { version: 1, actionId: row.actionId, operationId: OPERATION, operationRevision: REVISION, binding };
    if (systemClock() >= Date.parse(row.expiresAt))
      return { ...base, status: "refused", attempt: "possibly_dispatched", reason: "expired" };
    if (this.stage(row) === "succeeded" && row.result && row.observedAt)
      return {
        ...base,
        status: "succeeded",
        attempt: "completed",
        observedAt: row.observedAt,
        truncation: "none",
        result: row.result,
      };
    return {
      ...base,
      status: "unknown",
      attempt: "possibly_dispatched",
      reason: this.stage(row) === "pending" ? "pending" : "receipt_unavailable",
    };
  }
  private async verifyFixture(resource: Resource, deadline?: number) {
    const key = `fixture:${resource}`;
    // Bootstrap fixed, non-customer data; success requires an independent durable readback.
    const prior = await this.storage.get<string>(key);
    if (deadline !== undefined && systemClock() >= deadline) return undefined;
    if (prior === undefined) {
      await this.storage.put(key, VALUES[resource]);
      if (deadline !== undefined && systemClock() >= deadline) return undefined;
    }
    const readback = prior ?? (await this.storage.get<string>(key));
    if (deadline !== undefined && systemClock() >= deadline) return undefined;
    return readback === VALUES[resource] ? { fixture: VALUES[resource], verified: true as const } : undefined;
  }
  private async finish(row: Entry) {
    const deadline = row.resource === "slow" ? row.dueAt + RETRY_WINDOW_MS : undefined;
    const result = await this.verifyFixture(row.resource, deadline);
    if (!result || (row.resource === "slow" && systemClock() >= row.dueAt + RETRY_WINDOW_MS)) {
      await this.storage.put(`action:${row.actionId}`, { ...row, stage: "unknown" } satisfies Entry);
      return;
    }
    await this.storage.put(`action:${row.actionId}`, {
      ...row,
      stage: "succeeded",
      result,
      observedAt: new Date(systemClock()).toISOString(),
    } satisfies Entry);
  }
  async alarm() {
    const pending = (await this.storage.get<string[]>("pending")) ?? [];
    for (const id of pending) {
      const row = await this.storage.get<Entry>(`action:${id}`);
      if (!row || row.stage !== "pending" || systemClock() < row.dueAt) continue;
      if (systemClock() >= Date.parse(row.expiresAt) || this.stage(row) === "unknown") {
        try {
          await this.storage.put(`action:${id}`, { ...row, stage: "unknown" } satisfies Entry);
        } catch {
          // Reads derive the same terminal state if the write is unavailable.
        }
        continue;
      }
      try {
        await this.finish(row);
      } catch {
        // Unknown remains unknown. Only the bounded retry window can schedule another read.
      }
    }
    await this.storage.transaction(async (tx) => {
      // Re-read the queue transactionally: a concurrent execute must not be lost.
      const current = (await tx.get<string[]>("pending")) ?? [];
      const keep: string[] = [];
      let next = Infinity;
      const now = systemClock();
      for (const id of current) {
        const row = await tx.get<Entry>(`action:${id}`);
        if (!row || row.stage !== "pending") continue;
        if (now >= Date.parse(row.expiresAt) || now >= row.dueAt + RETRY_WINDOW_MS) continue;
        keep.push(id);
        next = Math.min(next, Math.max(now + RETRY_DELAY_MS, row.dueAt));
      }
      await tx.put("pending", keep);
      if (keep.length) await tx.setAlarm(next);
    });
  }
  async fetch(request: Request): Promise<Response> {
    const msg = (await request.json()) as Record<string, unknown>;
    const method = msg.method;
    const sessionId = request.headers.get("mcp-session-id") ?? "";
    if (method === "initialize") {
      const id = crypto.randomUUID();
      await this.storage.put(`session:${id}`, this.env.SOURCE_REQUESTER);
      return json({
        sessionId: id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "controlled-fixture", version: "1" },
        },
      });
    }
    if (!(await this.session(sessionId))) return json({ status: 404 }, 404);
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "tools/list") return json({ result: { tools: [READ_TOOL] } });
    if (method === "diagnostic") {
      const id = msg.actionId;
      if (!actionIdValid(id)) return json({}, 404);
      const row = await this.storage.get<Entry>(`action:${id}`);
      if (!row || row.sessionId !== sessionId) return json({}, 404);
      return json({
        actionId: id,
        enteredAt: row.enteredAt,
        dueAt: new Date(row.dueAt).toISOString(),
        stage: this.stage(row),
      });
    }
    if (method !== "tools/call" || !object(msg.params) || msg.params.name !== READ_TOOL.name)
      return json({ error: { code: -32601, message: "Method not found" } });
    const query = queryFor(msg.params.arguments);
    if (!query) return json({ result: { content: [], structuredContent: refused("invalid_request") } });
    const { actionId, resource, action } = query;
    const allowed = this.env.SOURCE_RESOURCE_SCOPE.split(",").includes(resource.id);
    if (!allowed) return json({ result: { content: [], structuredContent: refused("unauthorized", actionId) } });
    let row = await this.storage.get<Entry>(`action:${actionId}`);
    if (action === "inspect") {
      const response =
        !row || row.sessionId !== sessionId
          ? refused("not_found", actionId)
          : row.resource !== resource.id || row.subjectId !== this.env.SOURCE_REQUESTER
            ? refused("action_conflict", actionId)
            : this.receipt(row);
      return json({ result: { content: [], structuredContent: response } });
    }
    if (row) return json({ result: { content: [], structuredContent: refused("action_conflict", actionId) } });
    const now = systemClock();
    row = {
      actionId,
      sessionId,
      subjectId: this.env.SOURCE_REQUESTER,
      bindingId: crypto.randomUUID(),
      bindingRevision: crypto.randomUUID(),
      enteredAt: new Date(now).toISOString(),
      dueAt: now + (resource.id === "slow" ? DELAY_MS : 0),
      expiresAt: new Date(now + RETENTION_MS).toISOString(),
      stage: "pending",
      resource: resource.id,
    };
    const entry = row;
    const inserted = await this.storage.transaction(async (tx) => {
      if (await tx.get<Entry>(`action:${actionId}`)) return false;
      await tx.put(`action:${actionId}`, entry);
      if (resource.id === "slow") {
        const pending = (await tx.get<string[]>("pending")) ?? [];
        await tx.put("pending", [...pending, actionId]);
        // Commit the alarm with the entry: a disconnect cannot strand a pending action.
        await tx.setAlarm(Math.min((await tx.getAlarm()) ?? Infinity, row.dueAt));
      }
      return true;
    });
    if (!inserted) return json({ result: { content: [], structuredContent: refused("action_conflict", actionId) } });
    if (resource.id === "quick") {
      try {
        await this.finish(row);
      } catch {
        // The action entry is durable; an unavailable result is inspectable
        // and cannot be executed again under this action ID.
      }
    }
    return json({
      result: {
        content: [],
        structuredContent: this.receipt((await this.storage.get<Entry>(`action:${actionId}`)) ?? row),
      },
    });
  }
}

/** Reject before forwarding to the DO: the authorization header never enters durable state. */
async function authorized(request: Request, env: Env) {
  const value = request.headers.get("authorization");
  if (!env.SOURCE_BEARER || !env.SOURCE_REQUESTER || !env.SOURCE_RESOURCE_SCOPE || !value?.startsWith("Bearer "))
    return false;
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const a = await digest(value.slice(7));
  const b = await digest(env.SOURCE_BEARER);
  return a.reduce((diff, byte, i) => diff | (byte ^ b[i]!), 0) === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await authorized(request, env))) return new Response(null, { status: 401 });
    const url = new URL(request.url);
    const stub = env.ACTIONS.get(env.ACTIONS.idFromName("controlled"));
    if (url.pathname.startsWith("/diagnostic/") && request.method === "GET") {
      const actionId = url.pathname.slice("/diagnostic/".length);
      if (!actionIdValid(actionId)) return new Response(null, { status: 404 });
      return stub.fetch(
        new Request("https://internal.invalid/", {
          method: "POST",
          headers: { "mcp-session-id": request.headers.get("mcp-session-id") ?? "" },
          body: JSON.stringify({ method: "diagnostic", actionId }),
        }),
      );
    }
    if (
      url.pathname !== "/mcp" ||
      request.method !== "POST" ||
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      return new Response(null, { status: 404 });
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!objectLike(parsed)) throw Error();
      message = parsed;
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const id = message.id;
    if (message.jsonrpc !== "2.0" || (id !== undefined && typeof id !== "number" && typeof id !== "string"))
      return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, 400);
    const reply = await stub.fetch(
      new Request("https://internal.invalid/", {
        method: "POST",
        headers: { "mcp-session-id": request.headers.get("mcp-session-id") ?? "" },
        body: JSON.stringify(message),
      }),
    );
    if (!reply.ok || reply.status === 202) return reply;
    let value = (await reply.json()) as {
      result?: { structuredContent?: { status?: string } };
      sessionId?: string;
      error?: unknown;
    };
    const args = object(message.params) ? message.params.arguments : undefined;
    const query = queryFor(args);
    if (
      message.method === "tools/call" &&
      query?.action === "execute" &&
      query.resource.id === "slow" &&
      value.result?.structuredContent?.status === "unknown"
    ) {
      // The DO has already committed the entry and armed its alarm. A canceled
      // HTTP request can only cancel this wait, not that durable work.
      await new Promise<void>((resolve) => setTimeout(resolve, DELAY_MS + 1_000));
      const inspection = await stub.fetch(
        new Request("https://internal.invalid/", {
          method: "POST",
          headers: { "mcp-session-id": request.headers.get("mcp-session-id") ?? "" },
          body: JSON.stringify({
            method: "tools/call",
            params: {
              name: READ_TOOL.name,
              arguments: { ...query, operationRevision: REVISION, version: 1, action: "inspect" },
            },
          }),
        }),
      );
      if (inspection.ok) value = (await inspection.json()) as typeof value;
    }
    return json(
      { jsonrpc: "2.0", id, ...(value.error ? { error: value.error } : { result: value.result }) },
      200,
      value.sessionId ? { "mcp-session-id": value.sessionId } : undefined,
    );
  },
};
function objectLike(value: unknown): value is Record<string, unknown> {
  return object(value);
}
