import { finishAdmission, failedAdmission } from "../core/organization/admissionTrace.js";
import { personalTokenApprovalMatchesPin, type PersonalTokenApprovalPin } from "../core/personalToken.js";
import type { OrganizationNativeEvidence } from "./organizationAuthentication.js";
import type { OrganizationAdmissionInput } from "../core/organization/service.js";
import type { OrganizationResult } from "../core/organization/contract.js";
import { authorize } from "../core/authz/authorize.js";
import { z } from "zod";
import { hasConfirmationConsent } from "../core/confirmationConsent.js";
import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { resolveChatActor, type GrantsLookup } from "../core/authz/actor.js";
import {
  blastRadius,
  CommandRegistry,
  type Caller,
  type CommandDef,
  type CommandInvoker,
  type InvokeErrorCode,
  resourceOf,
} from "../core/commandRegistry.js";
import { jsonSchemaFor, mcpToolName, namedToInput } from "../core/commandSurface.js";
import type { McpToolInfo } from "../mcp/types.js";
import { dispatch as realDispatch, type CoreDeps } from "../core/dispatcher.js";
import { startRequestRoot } from "../core/requestTrace.js";
import { systemClock } from "../core/trace/clock.js";
import type { IncomingMessage, ConfirmationOffer } from "../core/types.js";
import { withCommandConfirmation } from "../core/commandConfirmations.js";
import {
  approvalUrl,
  connectionIdentity,
  mcpRequester,
  type McpIdentity,
  ownApproval,
  resumeApproval,
  requestHash,
} from "./mcpApproval.js";
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
  isLegacyRequest,
  createMcpHandler as createSdkHandler,
  ProtocolError,
  inputRequired,
  acceptedContent,
  type ServerContext,
  type CallToolResult,
  type ListToolsResult,
  type ClientCapabilities,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { type PersonLookup, type Requester } from "./requester.js";
import { digestBearer, type PersonalTokenStore } from "../mcp/personalTokens.js";
import { redactAndCap } from "../core/redact.js";
import type { DashboardVerifier } from "./dashboardAuth.js";
import { callerFor, callerIdFor, originAllowed, type CommandHttpOptions } from "./commandHttp.js";
import { requesterOf } from "./web.js";
import { dispatchSingleShot, SingleShotIO } from "./singleShotDispatch.js";
import {
  authorizeRequest,
  hasDispatch,
  ingressComponentError,
  ingressThreadKeyError,
  MAX_BODY_BYTES,
  readBody,
  type DispatchFn,
  admissionResponse,
  type OrganizationIngress,
  nativeMessageId,
  idempotencyKeyError,
  type IngressConfig,
  type IngressIdentity,
} from "./http.js";

// MCP channel adapter: adapter #4. Like Slack, the CLI, and HTTP ingress, it is
// pure transport — it turns an inbound MCP tool call into an IncomingMessage,
// calls the channel-agnostic core dispatch(), and provides a ChannelIO to reply
// through. Nothing about routing, config, permissions, or agents lives here.
//
// The official SDK owns modern and legacy Streamable HTTP protocol handling.
// Authentication and body limits are checked before SDK request processing.
//
// Tools: the hand-written `dispatch` (starts an agent run through dispatch())
// PLUS every command registry entry exposed to MCP: tool
// `runs_list` ↔ command `runs.list`, `inputSchema` derived from the typed
// arguments + options (all addressed by name, camelCase),
// result text = one header line + the JSON object `invoke` returned, errors as
// JSON-RPC errors carrying `data.code`. No per-command code lives here; the
// registry authorizes the `mcp:<subject>` actor over the policy table, whose
// grants are config's `grants` entry for that id (a token with no entry holds
// nothing — not even `dispatch`).
//
// Static bearer auth reuses HTTP ingress. SSO reuses the dashboard verifier
// and browser actor resolver; those sessions keep their browser grants.
// Personal bearers remain delegated MCP credentials in the digest store.

const PLATFORM = "mcp";
const DEFAULT_CHANNEL = "default";
const DEFAULT_THREAD = "default";

const SERVER_INFO = { name: "switchboard", version: "0.1.0" } as const;

/** The one hand-written tool; every other tool is a registry command. */
const DISPATCH_TOOL = {
  name: "dispatch",
  description: "send a request to Switchboard",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "the request to send to Switchboard" },
      thread: { type: "string", description: "conversation thread key (optional; defaults to a single thread)" },
      channel: { type: "string", description: "config/permission scope (optional; a token may pin this)" },
      idempotencyKey: {
        type: "string",
        description: "retain this key with the exact same request when retrying an uncertain admission",
        minLength: 1,
        maxLength: 128,
      },
      async: { type: "boolean", description: "return a run id now and read progress with runs_get/runs_events" },
    },
    required: ["text"],
  },
} as const;

// JSON-RPC 2.0 error codes (spec-defined) plus one server-defined auth code.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** Server-defined (the -32000..-32099 range is reserved for implementations). */
const AUTH_ERROR = -32001;

export interface McpOptions {
  auth: IngressConfig;
  /** The existing dashboard identity strategy; `none` never enables remote MCP. */
  sso?: DashboardVerifier;
  /** Request-scoped credential recheck for a saved SSO confirmation. */
  revalidateConnection?: (id: string) => Promise<McpIdentity | undefined>;
  channelsOf?: CommandHttpOptions["channelsOf"];
  /** True only when the authenticated browser approval route is wired. */
  approvalsEnabled?: boolean;
  /** Browser-approved personal credentials, stored by digest outside the static ingress map. */
  personalTokens?: PersonalTokenStore;
  /** When configured, current host realm proof is required for every personal credential. */
  personalApprovalPin?: () => PersonalTokenApprovalPin | undefined;
  /** Defaults to the real core dispatch(); overridden in tests. */
  dispatch?: DispatchFn;
  /** Host-only original-owner admission for a protected saved choice. */
  admit?: OrganizationIngress;
  replayChoice?: (
    msg: IncomingMessage,
    evidence: OrganizationNativeEvidence,
    choice: NonNullable<OrganizationAdmissionInput["continuation"]>,
  ) => Promise<OrganizationResult | undefined>;
  /** Max body size in bytes (node wrapper enforces at read time). */
  maxBodyBytes?: number;
  /** The command registry (deps bound) whose MCP-exposed commands become tools
   *  beside `dispatch`. Absent → `dispatch` is the only tool. */
  commands?: CommandInvoker;
  /** Grants by actor id for the `Caller.actor` a tool call carries and for the
   *  `dispatch` gate. Absent → `deps.config.grantsFor` (the bot's store). */
  grantsFor?: GrantsLookup;
  /** The person an entry's `email` names (authorization.md item 15), as the
   *  HTTP ingress takes it. Absent → every token is its own requester. */
  personByEmail?: PersonLookup;
  /** Base URL for an async run's live page. */
  publicBaseUrl?: string;
}

/** `runs.list` → tool `runs_list`; `inputSchema` = the command's
 *  arguments (by name) + options (camelCase keys), derived from the definition;
 *  `annotations` = the definition's blast radius in MCP's own `ToolAnnotations`
 *  names (the shape the bot's own MCP client reads, `McpToolInfo.annotations`):
 *  `readOnlyHint` from the effect, `destructiveHint` from
 *  `annotations.destructive` (false for a read and for an exec-class write,
 *  whatever they declare — `blastRadius` never reads it for them),
 *  `idempotentHint` and `openWorldHint` from the definition, false unless it
 *  says otherwise, because MCP presumes a non-read-only tool destructive when
 *  the hint is absent and the registry never leaves a client presuming. */
function toMcpTool(cmd: CommandDef<unknown>): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: NonNullable<McpToolInfo["annotations"]>;
} {
  const radius = blastRadius(cmd);
  return {
    name: mcpToolName(cmd.id),
    description: cmd.describe,
    inputSchema: jsonSchemaFor(cmd),
    annotations: {
      readOnlyHint: radius === "read",
      destructiveHint: radius === "destructive",
      idempotentHint: cmd.annotations?.idempotent === true,
      openWorldHint: cmd.annotations?.openWorld === true,
    },
  };
}

function mcpExposed(commands: CommandInvoker | undefined): CommandDef<unknown>[] {
  return (commands?.list() ?? []).filter((c) => CommandRegistry.exposedTo(c, "mcp"));
}

/** The Caller an MCP bearer identity resolves to — the `service` Actor
 *  `mcp:<subject>` with the grants config names for it. A verified email link
 *  adds the person's id to `self` for owner checks, without adding grants.
 *  A token with no entry holds nothing and sees no run
 *  (authorization.md item 9). Nothing here decides what it may do
 *  (docs/decisions/0007-authorization-policy-table.md). */
export function toCaller(identity: IngressIdentity, lookup: GrantsLookup, requester?: Requester): Caller {
  const credentialId = `${PLATFORM}:${identity.subject}`;
  const actor = resolveChatActor(
    {
      channelId: "mcp:default",
      threadKey: "mcp:default:default",
      ...requester,
      userId: requester?.userId ?? credentialId,
    },
    lookup,
  );
  const { origin: _origin, ...withoutOrigin } = actor;
  return { kind: "mcp", id: credentialId, actor: withoutOrigin, ...(identity.email ? { email: identity.email } : {}) };
}

/** Registry error codes → JSON-RPC codes; the registry code itself rides in `data.code`. */
const RPC_CODE_FOR: Readonly<Record<InvokeErrorCode, number>> = {
  unauthorized: -32001, // AUTH_ERROR
  invalid_input: -32602, // INVALID_PARAMS
  not_found: -32002,
  conflict: -32003,
  unavailable: -32004,
  busy: -32004, // as over HTTP (503 for both): `data.code` tells the transient refusal apart
  internal: -32603, // INTERNAL_ERROR
};

type JsonRpcId = string | number | null;

interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  id: JsonRpcId;
  /** `data.code` carries the registry's error vocabulary for command tools. */
  error: { code: number; message: string; data?: { code: InvokeErrorCode } };
}

interface JsonRpcResultBody {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

/** A validated JSON-RPC request envelope. */
interface JsonRpcRequest {
  id?: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
}

/** ChannelIO for a single-shot MCP tool call: reply() collects, status() is a
 *  no-op (no live surface to edit in one shot), history() is empty (a tool call
 *  carries no prior turns — conversation state, if any, rides on threadKey). */
export class McpIO extends SingleShotIO {
  private shown?: ConfirmationOffer;
  offer?: (offer: ConfirmationOffer) => Promise<void | string>;
  constructor(
    priorTurns: ConstructorParameters<typeof SingleShotIO>[0] = [],
    threadKey?: string,
    display?: (offer: ConfirmationOffer) => string,
  ) {
    super(priorTurns, threadKey);
    if (display)
      this.offer = async (offer) => {
        this.shown = offer;
        return display(offer);
      };
  }
  offered(): ConfirmationOffer | undefined {
    return this.shown;
  }
}

/** Build the `mcp:`-namespaced IncomingMessage from an authed identity + the
 *  tool arguments. Mirrors http.ts's namespacing (invariant 4) but with the
 *  `mcp:` prefix so MCP and HTTP credentials are distinct actors. A token's
 *  pinned channel wins over the arguments'; otherwise the arguments choose,
 *  else the default scope. */
async function toIncomingMessage(
  identity: IngressIdentity,
  args: { text: string; channel?: string; thread?: string },
  requester: Requester,
): Promise<IncomingMessage> {
  const channel = identity.channel ?? args.channel ?? DEFAULT_CHANNEL;
  const thread = args.thread ?? DEFAULT_THREAD;
  return {
    // The requester is the person the entry's `email` names when the lookup
    // finds one (`userId` the person, `authenticatedAs` the credential), else
    // the credential itself — the HTTP ingress's rule (authorization.md item 15).
    ...requester,
    channelId: `${PLATFORM}:${channel}`,
    threadKey: `${PLATFORM}:${channel}:${thread}`,
    text: args.text,
  };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResultBody {
  return { jsonrpc: "2.0", id, result };
}

function err(id: JsonRpcId, code: number, message: string, data?: { code: InvokeErrorCode }): JsonRpcErrorBody {
  return { jsonrpc: "2.0", id, error: data ? { code, message, data } : { code, message } };
}

export interface McpRequest {
  /** HTTP method; only POST is accepted. */
  method?: string;
  headers: IncomingHttpHeaders;
  /** Raw request body: a single JSON-RPC 2.0 message. */
  body: string;
}

export interface McpResponse {
  /** HTTP status. Transport gating uses 405/401/403/503; everything past the gate
   *  is 200 with a JSON-RPC envelope, except an accepted notification (202,
   *  empty body). */
  status: number;
  /** JSON-RPC response envelope, or undefined for an accepted notification. */
  body?: JsonRpcResultBody | JsonRpcErrorBody;
}

/** Extract the JSON-RPC id from a parsed message if it is a valid id type. */

/**
 * Route one validated JSON-RPC request to its handler. Transport-free (no
 * socket, no HTTP concepts): a parsed request + an already-authed identity in,
 * a JSON-RPC response envelope out. This is the pure MCP method surface;
 * handleMcpRequest wraps it with HTTP gating, auth, and JSON parsing.
 */
async function route(
  req: JsonRpcRequest,
  identity: McpIdentity,
  deps: CoreDeps,
  options: McpOptions,
  lookup: GrantsLookup,
  connectionId: string,
  ctx?: ServerContext,
): Promise<JsonRpcResultBody | JsonRpcErrorBody> {
  const id = req.id ?? null;
  switch (req.method) {
    case "tools/list":
      return ok(id, {
        tools: [
          DISPATCH_TOOL,
          ...mcpExposed(options.commands).map(toMcpTool),
          ...(["approval_resume", "approval_cancel"] as const).map((name) => ({
            name,
            description:
              name === "approval_resume"
                ? "Execute an offer already approved in the authenticated browser, once. The saved action cannot be changed."
                : "Cancel your connection's pending offer; nothing runs.",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: name === "approval_cancel",
              openWorldHint: false,
            },
          })),
        ],
      });

    case "tools/call": {
      const name = req.params.name;
      const rawArgs = req.params.arguments;
      const args = typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
      const sessionCaller = identity.session
        ? await callerFor(identity.session, {
            grantsFor: lookup,
            personByEmail: options.personByEmail,
            channelsOf: options.channelsOf,
          })
        : undefined;
      const requester = sessionCaller
        ? options.admit && name === "dispatch"
          ? { userId: sessionCaller.id, authenticatedAs: sessionCaller.id }
          : { ...requesterOf(sessionCaller.actor, identity.session!), authenticatedAs: sessionCaller.id }
        : options.admit && name === "dispatch" && !identity.verifiedUserId
          ? { userId: `mcp:${identity.subject}` }
          : await mcpRequester(identity, options);
      if (!requester)
        return err(id, AUTH_ERROR, "The verified person for this connection is unavailable; nothing ran", {
          code: "unauthorized",
        });
      const caller = sessionCaller ?? toCaller(identity, lookup, requester);
      if (name === "approval_resume" || name === "approval_cancel") {
        if (typeof args.id !== "string" || Object.keys(args).some((key) => key !== "id"))
          return err(id, INVALID_PARAMS, "Only the saved offer id is accepted");
        if (ctx?.mcpReq.requestState<string>() !== undefined && ctx.mcpReq.requestState<string>() !== args.id)
          return err(id, AUTH_ERROR, "The saved confirmation does not match this request; nothing ran");
        return approvalResult(id, args.id, deps, options, caller.actor, connectionId, name === "approval_cancel", ctx);
      }
      const state = ctx?.mcpReq.requestState<string>();
      if (typeof state === "string") {
        const row = deps.confirmations && (await ownApproval(deps.confirmations, state, caller.actor, connectionId));
        if (
          (!row && !options.replayChoice) ||
          (row && row.message.approvalConnection?.requestHash !== requestHash(String(name), args))
        )
          return err(id, AUTH_ERROR, "The offer is used, expired, or does not match this request; nothing ran");
        return approvalResult(id, state, deps, options, caller.actor, connectionId, false, ctx);
      }
      const command = options.commands && mcpExposed(options.commands).find((c) => mcpToolName(c.id) === name);
      if (command) {
        // Registry tool: the by-name arguments split onto the definition's
        // `{ args, options }` and handed to invoke (authorization and the
        // schemas live there), the returned object straight back out.
        const input = namedToInput(command, args, "camel");
        if ("error" in input) return err(id, INVALID_PARAMS, input.error, { code: "invalid_input" });
        const msg = await toIncomingMessage(identity, { text: "" }, requester);
        // A direct command is a separate request, not the shared prose thread.
        msg.threadKey = `${msg.channelId}:command:${randomUUID()}`;
        msg.approvalConnection = {
          id: connectionId,
          credentialId: caller.id,
          requestHash: requestHash(String(name), args),
          ...(supportsForm(ctx) ? { mode: "form" as const } : {}),
        };
        const io = new McpIO(
          [],
          msg.threadKey,
          !!msg.authenticatedAs &&
            (supportsForm(ctx) || !!approvalUrl(options, "")) &&
            !!deps.confirmations?.approve &&
            !!deps.confirmations.get
            ? (offer) => `Nothing ran. Confirm the saved action ${offer.line} in your MCP client.`
            : undefined,
        );
        const result = await withCommandConfirmation({ message: msg, io, store: deps.confirmations }, () =>
          options.commands!.invoke(command.id, input, caller),
        );
        if (io.offered()) return offeredResult(id, io.offered()!, options, ctx);
        if (!result.ok) return err(id, RPC_CODE_FOR[result.error], result.message, { code: result.error });
        return ok(id, { content: [{ type: "text", text: `${command.id}: ok\n${JSON.stringify(result.value)}` }] });
      }
      if (name !== DISPATCH_TOOL.name) {
        return err(id, INVALID_PARAMS, `unknown tool: ${typeof name === "string" ? name : "(none)"}`);
      }
      // Machines need the transport grant; browser sessions reach the same
      // agent and repository policy gates as browser chat in core dispatch.
      if (!identity.session && !hasDispatch(caller.actor.grants)) {
        return err(id, RPC_CODE_FOR.unauthorized, `${caller.id} is not allowed to call dispatch`, {
          code: "unauthorized",
        });
      }
      if (typeof args.text !== "string" || args.text.trim() === "") {
        return err(id, INVALID_PARAMS, "`text` is required and must be a non-empty string");
      }
      if (args.async !== undefined && typeof args.async !== "boolean") {
        return err(id, INVALID_PARAMS, "`async` must be a boolean");
      }
      if (args.channel !== undefined) {
        if (typeof args.channel !== "string") return err(id, INVALID_PARAMS, "`channel` must be a string");
        const error = ingressComponentError("channel", args.channel);
        if (error) return err(id, INVALID_PARAMS, error);
      }
      if (args.thread !== undefined) {
        if (typeof args.thread !== "string") return err(id, INVALID_PARAMS, "`thread` must be a string");
        const error = ingressComponentError("thread", args.thread);
        if (error) return err(id, INVALID_PARAMS, error);
      }
      if (identity.channel !== undefined) {
        const error = ingressComponentError("channel", identity.channel);
        if (error) return err(id, INVALID_PARAMS, error);
      }
      const keyErrorInput = idempotencyKeyError(args.idempotencyKey);
      if (keyErrorInput) return err(id, INVALID_PARAMS, keyErrorInput);
      const receivedAt = systemClock();
      const incoming = await toIncomingMessage(
        identity,
        {
          text: args.text,
          channel: args.channel as string | undefined,
          thread: args.thread as string | undefined,
        },
        requester,
      );
      const keyError = ingressThreadKeyError(incoming.threadKey);
      if (keyError) return err(id, INVALID_PARAMS, keyError);
      // The request's root (docs/reference/specs/tracing.md), once the caller is known.
      const trace = startRequestRoot(deps, {
        channel: "mcp",
        receivedAt,
        ...(options.admit ? { attrs: { admissionStage: "host" as const, receiptObserved: false } } : {}),
      });
      // One bounded identity per admitted call, retained by the in-flight async
      // dispatch. Neither mutable text/thread nor a reusable JSON-RPC id names it.
      const msg: IncomingMessage = {
        ...incoming,
        approvalConnection: {
          id: connectionId,
          credentialId: caller.id,
          requestHash: requestHash(String(name), args),
          ...(supportsForm(ctx) ? { mode: "form" as const } : {}),
        },
        messageId: options.admit
          ? nativeMessageId("mcp", args.idempotencyKey as string | undefined)
          : `${PLATFORM}:${randomUUID()}`,
        receivedAt,
      };
      const io = new McpIO(
        [],
        msg.threadKey,
        !!msg.authenticatedAs &&
          (supportsForm(ctx) || !!approvalUrl(options, "")) &&
          !!deps.confirmations?.approve &&
          !!deps.confirmations.get
          ? (offer) => `Nothing ran. Confirm the saved action ${offer.line} in your MCP client.`
          : undefined,
      );
      if (options.admit) {
        try {
          let result: OrganizationResult;
          try {
            result = await options.admit(msg, io, nativeEvidence(identity, connectionId, options), undefined, {
              span: trace.root,
            });
          } catch (error) {
            failedAdmission(trace.root, error);
            result = { status: "unavailable" };
          }
          const admitted = admissionResponse(result);
          const diagnostic = finishAdmission(trace.root, result, admitted.status);
          const admission = (admitted.body as { admission: { status: string } }).admission;
          return ok(id, {
            content: [
              {
                type: "text",
                text:
                  admission.status === "accepted" || admission.status === "pending"
                    ? "Request admitted. Execution and completion are recorded separately."
                    : admission.status === "unavailable"
                      ? "Admission could not be confirmed."
                      : `Request not admitted: ${admission.status}.`,
              },
            ],
            structuredContent: {
              ...(admitted.body as Record<string, unknown>),
              diagnostic,
              ...(result.status === "receipt" && result.receipt.ownerRunId
                ? { runId: result.receipt.ownerRunId, threadKey: msg.threadKey }
                : {}),
              ...(deps.build ? { build: deps.build } : {}),
            },
            ...(admitted.status >= 400 ? { isError: true } : {}),
          });
        } finally {
          trace.root.end();
        }
      }
      const dispatchFn = options.dispatch ?? realDispatch;
      const result = await dispatchSingleShot({
        deps,
        msg,
        io,
        dispatch: dispatchFn,
        trace,
        async: args.async === true,
        publicBaseUrl: options.publicBaseUrl,
        logPrefix: "mcp",
      });
      if (io.offered()) return offeredResult(id, io.offered()!, options, ctx);
      if (result.kind === "started")
        return ok(id, {
          content: [{ type: "text", text: `Started run ${result.receipt.runId}. Progress is available via runs_get.` }],
          structuredContent: result.receipt,
        });
      return ok(id, { content: [{ type: "text", text: result.reply }] });
    }

    default:
      return err(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

/**
 * Core request handler, decoupled from node's http so it is fully unit-testable
 * (no socket). Ordering mirrors http.ts's handleIngressRequest and is
 * deliberate:
 *   1. non-POST                -> 405
 *   2. no static, SSO or personal credential -> 503/401 (FAIL-CLOSED: never open)
 *   3. missing/unknown token   -> 401 unauthorized
 *   4. malformed JSON          -> 200 + JSON-RPC parse error (-32700)
 *   5. not a JSON-RPC request  -> 200 + invalid request (-32600)
 *   6. notification (no id)    -> 202, no body (never answered per JSON-RPC)
 *   7. valid request           -> 200 + JSON-RPC result/error from route()
 * Bearers reuse HTTP auth; SSO reuses dashboard auth. Body-size enforcement (413)
 * happens upstream in the node wrapper, before the body is ever fully buffered.
 */
export async function handleMcpRequest(req: McpRequest, deps: CoreDeps, options: McpOptions): Promise<McpResponse> {
  // Authenticate before parsing any client input; map refusals to MCP errors.
  const gate = await authorizeMcpRequest(req.method, req.headers, options);
  if (!("status" in gate))
    return handleMcpMessage(
      gate.identity,
      req.body,
      deps,
      {
        ...options,
        get personalApprovalPin() {
          return options.personalApprovalPin;
        },
        revalidateConnection: gate.revalidateConnection ?? options.revalidateConnection,
      },
      gate.connectionId ?? digestBearer(bearerFrom(req.headers)),
      req.headers,
    );
  return mcpErrorForStatus(gate.status);
}

async function authorizeMcpRequest(
  method: string | undefined,
  headers: IncomingHttpHeaders,
  options: McpOptions,
): Promise<
  | { identity: McpIdentity; connectionId?: string; revalidateConnection?: McpOptions["revalidateConnection"] }
  | { status: number }
> {
  const gate = authorizeRequest(method, headers, options);
  if (!("status" in gate) && !gate.identity.subject.startsWith("personal:")) return gate;
  if ("status" in gate && gate.status === 405) return gate;
  const sso = options.sso?.mode !== "none" ? options.sso : undefined;
  const bearer = bearerFrom(headers);
  const personalBearer = /^[a-f0-9]{64}$/i.test(bearer) ? bearer : undefined;
  // A personal credential keeps its delegated identity and limits. Its
  // revocation or store failure must not fall back to a browser assertion.
  if (personalBearer && options.personalTokens) {
    try {
      const token = await options.personalTokens.get(digestBearer(personalBearer));
      if (token) {
        if (
          options.personalApprovalPin &&
          !personalTokenApprovalMatchesPin(token.approval, options.personalApprovalPin())
        )
          return { status: 401 };
        return { identity: { subject: token.subject, email: token.email, verifiedUserId: token.userId } };
      }
      // A configured dashboard bearer can itself be 64 hex characters. Only
      // its token verifier may prove that same bearer; Access cannot replace it.
      if (sso?.mode !== "token") return { status: 401 };
    } catch {
      return { status: 503 };
    }
  }
  if (sso) {
    const raw = sso.credentialHeader ? headers[sso.credentialHeader] : undefined;
    try {
      const verdict = await sso.verify({ headers });
      if (!verdict.ok && verdict.status >= 500) return { status: 503 };
      if (verdict.ok && verdict.identity.sub) {
        if (!originAllowed({ headers }, options)) return { status: 403 };
        const credential = bearerFrom(headers) || (Array.isArray(raw) ? raw[0] : raw);
        if (!credential) return { status: 401 };
        const connectionId = digestBearer(credential);
        const identity = { subject: verdict.identity.sub, session: verdict.identity };
        return {
          identity,
          connectionId,
          revalidateConnection: async (id) => {
            if (id !== connectionId) return undefined;
            const current = await sso.verify({ headers });
            if (!current.ok && current.status >= 500) throw new Error("MCP source authentication unavailable");
            return current.ok && current.identity.sub === identity.subject
              ? { subject: current.identity.sub, session: current.identity }
              : undefined;
          },
        };
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      for (const credential of [bearerFrom(headers), ...(Array.isArray(raw) ? raw : [raw])])
        if (credential) message = message.replaceAll(credential, "«redacted»");
      console.error(`[mcp] dashboard verifier fault: ${redactAndCap(message).replace(/\s+/g, " ")}`);
      return { status: 503 };
    }
  }
  if (!options.personalTokens) return sso ? { status: 401 } : "status" in gate ? gate : { status: 401 };
  return { status: 401 };
}

/** Map the shared (HTTP-shaped) authorizeRequest rejection status to the
 *  equivalent MCP JSON-RPC error response. */
function mcpErrorForStatus(status: number): McpResponse {
  if (status === 405) return { status, body: err(null, INVALID_REQUEST, "method not allowed; POST only") };
  if (status === 503) return { status, body: err(null, AUTH_ERROR, "MCP access unavailable") };
  if (status === 403) return { status, body: err(null, AUTH_ERROR, "forbidden") };
  return { status: 401, body: err(null, AUTH_ERROR, "unauthorized") };
}

/** Native source proof is host-only. The verifier closure is never persisted. */
function nativeEvidence(identity: McpIdentity, connectionId: string, options: McpOptions): OrganizationNativeEvidence {
  return {
    source: "mcp",
    identity,
    credentialDigest: connectionId,
    ...(identity.session && options.revalidateConnection
      ? {
          attestation: {
            kind: "mcp-sso",
            mode: options.sso?.mode,
            revalidateConnection: options.revalidateConnection,
          },
        }
      : {}),
  };
}

/** Normalize the credential once for personal lookup and connection binding. */
function bearerFrom(headers: IncomingHttpHeaders): string {
  const value = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  return /^Bearer\s+(.+)$/i.exec(value?.trim() ?? "")?.[1] ?? "";
}

async function handleMcpMessage(
  identity: McpIdentity,
  rawBody: string,
  deps: CoreDeps,
  options: McpOptions,
  connectionId: string,
  incomingHeaders: IncomingHttpHeaders,
): Promise<McpResponse> {
  const handler = sdkHandler(identity, deps, options, connectionId);
  const mirrored = Object.fromEntries(
    ["mcp-protocol-version", "mcp-method", "mcp-name"].flatMap((name) =>
      typeof incomingHeaders[name] === "string" ? [[name, incomingHeaders[name] as string]] : [],
    ),
  );
  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      body: rawBody,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...mirrored },
    }),
  );
  const raw = await response.text();
  await handler.close();
  return { status: response.status, ...(raw ? { body: JSON.parse(raw) } : {}) };
}

function sdkHandler(identity: McpIdentity, deps: CoreDeps, options: McpOptions, connectionId: string) {
  const makeServer = () => {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, inputRequired: { legacyShim: false } });
    const lookup = options.grantsFor ?? ((actorId: string) => deps.config.grantsFor(actorId));
    server.setRequestHandler("tools/list", async () => {
      const body = await route({ method: "tools/list", params: {} }, identity, deps, options, lookup, connectionId);
      return (body as JsonRpcResultBody).result as ListToolsResult;
    });
    server.setRequestHandler("tools/call", async (request, ctx) => {
      const body = await route(
        { id: ctx.mcpReq.id, method: "tools/call", params: request.params ?? {} },
        identity,
        deps,
        options,
        lookup,
        connectionId,
        ctx,
      );
      if ("error" in body) throw new ProtocolError(body.error.code, body.error.message, body.error.data);
      return body.result as CallToolResult;
    });
    return server;
  };
  const modern = createSdkHandler(makeServer, {
    legacy: "reject",
    maxRequestBodySize: options.maxBodyBytes ?? MAX_BODY_BYTES,
  });
  return {
    close: modern.close,
    fetch: async (request: Request, requestOptions?: { parsedBody?: unknown }) => {
      if (!(await isLegacyRequest(request))) return modern.fetch(request, requestOptions);
      // The maintained transport keeps the established JSON-only legacy wire.
      const server = makeServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request, requestOptions);
      } finally {
        await server.close();
      }
    },
  };
}

const APPROVAL_DECISIONS = ["approve", "cancel"] as const;
const approvalDecision = z.object({ decision: z.enum(APPROVAL_DECISIONS) }).strict();

function supportsForm(ctx?: ServerContext): boolean {
  const capabilities = (ctx?.mcpReq.envelope as { [CLIENT_CAPABILITIES_META_KEY]?: ClientCapabilities } | undefined)?.[
    CLIENT_CAPABILITIES_META_KEY
  ];
  const elicitation = capabilities?.elicitation;
  return !!elicitation && ("form" in elicitation || Object.keys(elicitation).length === 0);
}

function offeredResult(
  id: JsonRpcId,
  offer: ConfirmationOffer,
  options: McpOptions,
  ctx?: ServerContext,
  form = supportsForm(ctx),
): JsonRpcResultBody | JsonRpcErrorBody {
  if (!form) {
    const url = approvalUrl(options, offer.id);
    if (!url) return err(id, -32004, "This connection cannot show the required approval; nothing ran");
    const capabilities = (
      ctx?.mcpReq.envelope as { [CLIENT_CAPABILITIES_META_KEY]?: ClientCapabilities } | undefined
    )?.[CLIENT_CAPABILITIES_META_KEY];
    if (capabilities?.elicitation && "url" in capabilities.elicitation)
      return ok(
        id,
        inputRequired({
          requestState: offer.id,
          inputRequests: {
            approval: inputRequired.elicitUrl({
              url,
              message: `Review this saved Switchboard action in your signed-in browser: ${offer.line}${offer.risk ? "\n" + offer.risk : ""}`,
            }),
          },
        }),
      );
    return ok(id, {
      content: [
        {
          type: "text",
          text: `Nothing ran. Review ${url}. After browser approval, resume saved action ${offer.id}. Expires: ${new Date(offer.expiresAt).toISOString()}`,
        },
      ],
    });
  }
  if (!supportsForm(ctx)) return err(id, -32004, "This client cannot show the required confirmation; nothing ran");
  return ok(
    id,
    inputRequired({
      requestState: offer.id,
      inputRequests: {
        approval: inputRequired.elicit({
          mode: "form",
          message: `Confirm this saved Switchboard action: ${offer.line}${offer.risk ? "\n" + offer.risk : ""}`,
          requestedSchema: {
            type: "object",
            properties: { decision: { type: "string", enum: [...APPROVAL_DECISIONS] } },
            required: ["decision"],
          },
        }),
      },
    }),
  );
}

function nativeChoiceMessageId(id: string, kind: "confirm" | "cancel"): string {
  return `mcp:${createHash("sha256").update(`choice:${id}:${kind}`).digest("hex")}`;
}
function nativeChoiceResponse(id: JsonRpcId, result: OrganizationResult): JsonRpcResultBody {
  const receipt = result.status === "receipt" ? result.receipt : undefined;
  const accepted = receipt?.status === "accepted" || receipt?.status === "pending";
  return ok(id, {
    content: [{ type: "text", text: accepted ? "Choice received." : "This saved choice is unavailable; nothing ran." }],
    structuredContent: {
      admission: receipt
        ? {
            status: receipt.status,
            receiptId: receipt.id,
            duplicate: result.status === "receipt" && result.duplicate,
            ...(receipt.ownerRunId ? { runId: receipt.ownerRunId } : {}),
            ...(receipt.reason ? { reason: receipt.reason } : {}),
          }
        : { status: result.status },
    },
    ...(!accepted ? { isError: true } : {}),
  });
}

async function approvalResult(
  id: JsonRpcId,
  offerId: string,
  deps: CoreDeps,
  options: McpOptions,
  actor: Caller["actor"],
  connectionId: string,
  cancel: boolean,
  ctx?: ServerContext,
): Promise<JsonRpcResultBody | JsonRpcErrorBody> {
  const store = deps.confirmations;
  const row = store && (await ownApproval(store, offerId, actor, connectionId));
  const response = ctx?.mcpReq.inputResponses?.approval;
  const decision = acceptedContent(ctx?.mcpReq.inputResponses, "approval", approvalDecision);
  const declined =
    typeof response === "object" &&
    response !== null &&
    "action" in response &&
    (response.action === "decline" || response.action === "cancel");
  const kind = cancel || declined || decision?.decision === "cancel" ? ("cancel" as const) : ("confirm" as const);
  const identity = await connectionIdentity(connectionId, options);
  const requester =
    identity?.session && (row?.originalOrganization || (!row && options.replayChoice))
      ? { userId: callerIdFor(identity.session), authenticatedAs: callerIdFor(identity.session) }
      : identity
        ? await mcpRequester(identity, options)
        : undefined;
  if (!row && identity && requester && options.replayChoice) {
    const channelId = `mcp:${identity.channel ?? DEFAULT_CHANNEL}`;
    const prior = await options.replayChoice(
      {
        ...requester,
        channelId,
        threadKey: `${channelId}:${DEFAULT_THREAD}`,
        text: "",
        messageId: nativeChoiceMessageId(offerId, kind),
        ...(identity.session
          ? {
              approvalConnection: {
                id: connectionId,
                credentialId: actor.id,
                requestHash: requestHash(cancel ? "approval_cancel" : "approval_resume", { id: offerId }),
              },
            }
          : {}),
      },
      nativeEvidence(identity, connectionId, options),
      { kind, id: offerId },
    );
    if (prior) return nativeChoiceResponse(id, prior);
  }
  if (!row && ctx?.mcpReq.requestState<string>() === offerId)
    return err(id, AUTH_ERROR, "The offer is used, expired, or does not match this request; nothing ran");
  if (!store || !row)
    return err(
      id,
      -32003,
      "This offer is unavailable or already used. Check its original run history before requesting another action.",
    );
  const allowedChoice = (saved: typeof row, caller: Caller): boolean => {
    if (saved.kind !== "run") return hasDispatch(caller.actor.grants);
    const command = options.commands?.list().find((command) => command.id === saved.command);
    if (!command) return false;
    const bound = {
      ...caller,
      origin: saved.caller?.origin
        ? { ...saved.caller.origin, repo: async () => saved.originRepo ?? undefined }
        : undefined,
    };
    try {
      return authorize(caller.actor, command.action, resourceOf(command, saved.parsedInput ?? saved.input, bound))
        .allow;
    } catch {
      return false;
    }
  };
  const nativeAdmission = async (saved: typeof row): Promise<JsonRpcResultBody | JsonRpcErrorBody> => {
    if (!options.admit) return err(id, AUTH_ERROR, "The original choice owner is unavailable; nothing ran");
    const current = await connectionIdentity(connectionId, options);
    const currentRequester = current?.session
      ? { userId: callerIdFor(current.session), authenticatedAs: callerIdFor(current.session) }
      : current
        ? await mcpRequester(current, options)
        : undefined;
    if (
      !current ||
      !currentRequester ||
      currentRequester.userId !== saved.message.userId ||
      (current.session ? callerIdFor(current.session) : `mcp:${current.subject}`) !== actor.id ||
      (saved.message.authenticatedAs ?? saved.message.userId) !== actor.id
    )
      return err(id, AUTH_ERROR, "This connection or its verified identity was revoked; nothing ran");
    const caller = current.session
      ? await callerFor(current.session, {
          grantsFor: options.grantsFor ?? ((id: string) => deps.config.grantsFor(id)),
        })
      : toCaller(current, options.grantsFor ?? ((id: string) => deps.config.grantsFor(id)), currentRequester);
    if (!allowedChoice(saved, caller))
      return err(id, AUTH_ERROR, "Current permissions do not allow this saved action; nothing ran");
    return nativeChoiceResponse(
      id,
      await options.admit(
        {
          userId: saved.message.userId,
          channelId: saved.message.channelId,
          threadKey: saved.message.threadKey,
          ...(saved.message.authenticatedAs ? { authenticatedAs: saved.message.authenticatedAs } : {}),
          ...(saved.message.postedBy ? { postedBy: saved.message.postedBy } : {}),
          ...(saved.message.approvalConnection ? { approvalConnection: { ...saved.message.approvalConnection } } : {}),
          text: "",
          messageId: nativeChoiceMessageId(offerId, kind),
        },
        new McpIO([], saved.message.threadKey),
        nativeEvidence(current, connectionId, options),
        { kind, id: offerId },
      ),
    );
  };
  if (row.originalOrganization) {
    if (!identity || requester?.userId !== row.message.userId)
      return err(id, AUTH_ERROR, "This connection or its verified identity was revoked; nothing ran");
    // Refuse current command loss before recording a new consent or consuming the saved id.
    const caller = identity.session
      ? await callerFor(identity.session, {
          grantsFor: options.grantsFor ?? ((id: string) => deps.config.grantsFor(id)),
        })
      : toCaller(identity, options.grantsFor ?? ((id: string) => deps.config.grantsFor(id)), requester);
    if (!allowedChoice(row, caller))
      return err(id, AUTH_ERROR, "Current permissions do not allow this saved action; nothing ran");
  }
  if (cancel || declined || decision?.decision === "cancel") {
    if (row.originalOrganization) return nativeAdmission(row);
    const result = await store.cancel(offerId, [row.message.userId], connectionId);
    return ok(id, {
      content: [
        { type: "text", text: result.ok ? "Cancelled; nothing ran" : "This offer is already used; nothing ran" },
      ],
    });
  }
  if (row.expiresAt <= (deps.clock ?? systemClock)())
    return err(id, -32003, "The saved confirmation expired; nothing ran");
  if (!hasConfirmationConsent(row)) {
    if (
      decision?.decision === "approve" &&
      ctx?.mcpReq.requestState<string>() === row.id &&
      row.message.approvalConnection?.mode === "form" &&
      store.approve
    ) {
      const approved = await store.approve(row.id, [row.message.userId], connectionId, "mcp-form");
      if (!approved.ok) return err(id, AUTH_ERROR, "The saved confirmation is unavailable; nothing ran");
      if (approved.row.approvedBy !== "mcp-form")
        return err(id, -32004, "The state service cannot record client confirmation; nothing ran");
    } else {
      return offeredResult(
        id,
        {
          id: row.id,
          line: row.kind === "run" ? row.receipt : row.line,
          risk:
            row.kind === "run"
              ? [row.risk, row.originRepo ? `Repository: ${row.originRepo}` : ""].filter(Boolean).join("\n")
              : "",
          expiresAt: row.expiresAt,
        },
        options,
        ctx,
        row.message.approvalConnection?.mode === "form",
      );
    }
  }
  const approvedRow = await ownApproval(store, row.id, actor, connectionId);
  if (!approvedRow) return err(id, AUTH_ERROR, "The saved confirmation is unavailable; nothing ran");
  if (approvedRow.originalOrganization) {
    if (!hasConfirmationConsent(approvedRow))
      return err(id, AUTH_ERROR, "Client confirmation is still required; nothing ran");
    return nativeAdmission(approvedRow);
  }
  const io = new McpIO([], row.message.threadKey);
  const refusal = await resumeApproval(deps, store, approvedRow, actor, io, connectionId, options);
  return ok(id, {
    content: [{ type: "text", text: refusal || io.collected() }],
    ...(io.run() ? { structuredContent: io.run() } : {}),
  });
}

/**
 * node:http adapter around handleMcpRequest: reads the body (size-capped), runs
 * the handler, and writes the response. Wire this at POST /mcp in the server
 * (src/index.ts). Mirrors http.ts's createIngressHandler.
 */
export function createMcpHandler(deps: CoreDeps, options: McpOptions): (req: HttpRequest, res: ServerResponse) => void {
  const maxBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const write = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  };
  return (req, res) => {
    void (async () => {
      try {
        // Authenticate from headers BEFORE reading the body: an unauthorized/wrong-method/disabled
        // caller is rejected without buffering a body it has no right to send.
        const gate = await authorizeMcpRequest(req.method, req.headers, options);
        if ("status" in gate) {
          const rejection = mcpErrorForStatus(gate.status);
          write(res, rejection.status, rejection.body);
          req.destroy();
          return;
        }
        const read = await readBody(req, maxBytes);
        if (!read.ok) {
          write(res, 413, err(null, INVALID_REQUEST, "request body too large"));
          req.destroy();
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(read.body);
        } catch {
          write(res, 200, err(null, PARSE_ERROR, "parse error: invalid JSON"));
          return;
        }
        const handler = sdkHandler(
          gate.identity,
          deps,
          {
            ...options,
            get personalApprovalPin() {
              return options.personalApprovalPin;
            },
            revalidateConnection: gate.revalidateConnection ?? options.revalidateConnection,
          },
          gate.connectionId ?? digestBearer(bearerFrom(req.headers)),
        );
        try {
          await toNodeHandler(handler)(req, res, parsed);
        } finally {
          await handler.close();
        }
      } catch (e) {
        // dispatch() catches its own errors and replies, so reaching here means
        // a transport fault. Answer honestly; never leak internals.
        console.error(`[mcp] ${e instanceof Error ? e.message : String(e)}`);
        write(res, 500, err(null, INTERNAL_ERROR, "internal error"));
      }
    })();
  };
}
