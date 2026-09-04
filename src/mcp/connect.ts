import { MCP_TICKET_TTL_MS, MCP_TOKEN_MAX_CHARS, type McpTicket } from "./registry.js";

// The connect flow's state machine (features/mcp-tools.md item 15) as PURE
// decisions — the HTTP handler (src/channels/mcpConnectView.ts) applies them.
// A ticket is minted by `mcp add`/`mcp connect`, lives MCP_TICKET_TTL_MS, is
// single-use, and is bound to the requester: by email when the channel could
// resolve one (the Access identity completing the page must carry the same
// email), else to the FIRST Access identity that opens it. Nothing here is
// stochastic and no model is ever involved.

export interface ConnectIdentity {
  sub: string;
  email?: string;
}

export type TicketRefusal =
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "cancelled" }
  | { kind: "wrong_identity" };

export type OpenDecision = { ok: true; ticket: McpTicket; bound: boolean } | { ok: false; refusal: TicketRefusal };

export function newTicket(input: { nonce: string; serverId: string; requesterId: string; requesterEmail?: string; now: number; ttlMs?: number }): McpTicket {
  return {
    nonce: input.nonce,
    serverId: input.serverId,
    requesterId: input.requesterId,
    ...(input.requesterEmail ? { requesterEmail: input.requesterEmail.toLowerCase() } : {}),
    createdAt: input.now,
    expiresAt: input.now + (input.ttlMs ?? MCP_TICKET_TTL_MS),
    state: "pending",
  };
}

function refuse(ticket: McpTicket | null, now: number): TicketRefusal | undefined {
  if (!ticket) return { kind: "not_found" };
  if (ticket.state === "completed") return { kind: "used" };
  if (ticket.state === "cancelled") return { kind: "cancelled" };
  if (now > ticket.expiresAt) return { kind: "expired" };
  return undefined;
}

/** Whether `identity` is the person this ticket belongs to. */
export function identityMatches(ticket: McpTicket, identity: ConnectIdentity): boolean {
  if (ticket.requesterEmail) return (identity.email ?? "").toLowerCase() === ticket.requesterEmail;
  if (ticket.openedBy) return ticket.openedBy.sub === identity.sub;
  return true; // unbound: the first opener binds it (see planOpen)
}

/** GET: may this identity see the form? Binds an unbound ticket to the opener
 *  (`bound: true` → the caller must persist the returned ticket). */
export function planOpen(ticket: McpTicket | null, identity: ConnectIdentity, now: number): OpenDecision {
  const r = refuse(ticket, now);
  if (r) return { ok: false, refusal: r };
  const t = ticket as McpTicket;
  if (!identityMatches(t, identity)) return { ok: false, refusal: { kind: "wrong_identity" } };
  if (!t.requesterEmail && !t.openedBy) {
    return { ok: true, bound: true, ticket: { ...t, state: "opened", openedBy: { sub: identity.sub, ...(identity.email ? { email: identity.email } : {}), at: now } } };
  }
  return { ok: true, bound: false, ticket: t.state === "pending" ? { ...t, state: "opened" } : t };
}

export type CompleteDecision = { ok: true; ticket: McpTicket; token: string } | { ok: false; refusal: TicketRefusal | { kind: "bad_token"; reason: string } };

/** POST: may this identity complete the ticket with this token? Returns the
 *  completed ticket for the service to CLAIM (a compare-and-swap from the
 *  state it read) before sealing the credential. */
export function planComplete(ticket: McpTicket | null, identity: ConnectIdentity, rawToken: string, now: number): CompleteDecision {
  const r = refuse(ticket, now);
  if (r) return { ok: false, refusal: r };
  const t = ticket as McpTicket;
  if (!identityMatches(t, identity)) return { ok: false, refusal: { kind: "wrong_identity" } };
  // An unbound ticket completed without a prior GET binds to the completer —
  // the same rule as opening; a bound one must be completed by its opener.
  const token = rawToken.trim();
  if (!token) return { ok: false, refusal: { kind: "bad_token", reason: "the token is empty" } };
  if (token.length > MCP_TOKEN_MAX_CHARS) return { ok: false, refusal: { kind: "bad_token", reason: `the token is longer than ${MCP_TOKEN_MAX_CHARS} characters` } };
  if (/[\r\n\0]/.test(token)) return { ok: false, refusal: { kind: "bad_token", reason: "the token contains a line break" } };
  return {
    ok: true,
    token,
    ticket: { ...t, state: "completed", completedBy: { sub: identity.sub, ...(identity.email ? { email: identity.email } : {}), at: now } },
  };
}

/** Human wording for each refusal — the page shows exactly this. */
export function refusalMessage(r: TicketRefusal | { kind: "bad_token"; reason: string }): string {
  switch (r.kind) {
    case "not_found":
      return "This connect link is not known. Ask for a new one with `mcp connect <name>`.";
    case "expired":
      return "This connect link has expired (links last 10 minutes). Ask for a new one with `mcp connect <name>`.";
    case "used":
      return "This connect link was already used. If the credential needs replacing, ask for a new one with `mcp connect <name>`.";
    case "cancelled":
      return "This connect link was cancelled.";
    case "wrong_identity":
      return "This connect link belongs to another user. Only the person who ran `mcp add` can complete it.";
    case "bad_token":
      return `The token was not accepted: ${r.reason}.`;
  }
}
