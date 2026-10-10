import { createHash } from "node:crypto";
import type { Actor } from "../core/authz/types.js";
import type { Confirmation, ConfirmationStore } from "../core/confirmations.js";
import type { ChannelIO } from "../core/types.js";
import type { CoreDeps } from "../core/dispatcher.js";
import { dispatchClick } from "../core/dispatcher.js";
import { actorIdsOf } from "../core/dispatch/confirm.js";
import { digestBearer } from "../mcp/personalTokens.js";
import { boundRequester } from "./requester.js";
import type { IngressIdentity } from "./http.js";
import type { McpOptions } from "./mcp.js";

export type McpIdentity = IngressIdentity & { verifiedUserId?: string };

export async function mcpRequester(
  identity: McpIdentity,
  options: McpOptions,
): Promise<import("./requester.js").Requester | undefined> {
  const credentialId = `mcp:${identity.subject}`;
  if (identity.verifiedUserId?.startsWith("access:"))
    return { userId: identity.verifiedUserId, authenticatedAs: credentialId };
  const requester = await boundRequester(credentialId, identity.email, options.personByEmail);
  if (
    !identity.verifiedUserId &&
    identity.subject.startsWith("personal:") &&
    requester.authenticatedAs !== credentialId
  ) {
    const sub = identity.subject.slice("personal:".length);
    return sub ? { userId: `access:${sub}`, authenticatedAs: credentialId } : undefined;
  }
  if (identity.verifiedUserId && requester.userId !== identity.verifiedUserId) return undefined;
  if ((identity.email || identity.subject.startsWith("personal:")) && requester.authenticatedAs !== credentialId)
    return undefined;
  return requester;
}

export const MCP_APPROVAL_PATH = "/settings/approve";
export const APPROVAL_UNAVAILABLE =
  "This action needs a signed-in browser approval. Approval is unavailable for this connection; nothing ran.";

/** Canonical JSON ignores object key order and retains array order and literal values. */
export function requestHash(name: string, args: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify([name, canonical(args)]))
    .digest("hex");
}

/** This lookup revalidates the exact credential, including durable revocation. */
export async function connectionIdentity(connectionId: string, options: McpOptions): Promise<McpIdentity | undefined> {
  for (const [bearer, identity] of Object.entries(options.auth.tokens))
    if (!identity.subject.startsWith("personal:") && digestBearer(bearer) === connectionId) return identity;
  const token = await options.personalTokens?.get(connectionId);
  return token ? { subject: token.subject, email: token.email, verifiedUserId: token.userId } : undefined;
}

export function approvalUrl(options: McpOptions, id: string): string | undefined {
  if (!options.approvalsEnabled || !options.publicBaseUrl) return undefined;
  const base = new URL(options.publicBaseUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") return undefined;
  return new URL(`${MCP_APPROVAL_PATH}?id=${encodeURIComponent(id)}`, base).href;
}

export async function ownApproval(
  store: ConfirmationStore,
  id: string,
  actor: Actor,
  connectionId: string,
): Promise<Confirmation | undefined> {
  const row = await store.get?.(id);
  return row &&
    row.message.approvalConnection?.id === connectionId &&
    actorIdsOf(actor).includes(row.message.userId) &&
    row.message.authenticatedAs === actor.id
    ? row
    : undefined;
}

/** The shared click path executes the saved input. Single-use consumption precedes any effect. */
export async function resumeApproval(
  deps: CoreDeps,
  store: ConfirmationStore,
  row: Confirmation,
  actor: Actor,
  io: ChannelIO,
  connectionId: string,
  options: McpOptions,
): Promise<string> {
  const identity = await connectionIdentity(connectionId, options);
  const requester = identity ? await mcpRequester(identity, options) : undefined;
  if (!identity || requester?.userId !== row.message.userId || `mcp:${identity.subject}` !== actor.id)
    return "This connection or its verified identity was revoked; nothing ran.";
  if (row.browserApproved !== true) return "Browser approval is still required; nothing ran.";
  await dispatchClick(deps, { kind: "confirm", id: row.id, actor, io, connectionId });
  return "";
}
