import { describe, expect, it } from "vitest";
import {
  identityMatches,
  newTicket,
  planCallback,
  planComplete,
  planOpen,
  planStart,
  refusalMessage,
} from "./connect.js";
import {
  isMcpServerEntry,
  isMcpTicket,
  MCP_TICKET_STATES,
  MCP_TICKET_TTL_MS,
  MCP_TOKEN_MAX_CHARS,
} from "./registry.js";

const NOW = 1_000_000;
const base = { nonce: "n".repeat(24), serverId: "user:slack:U1/vanta", requesterId: "slack:U1", now: NOW };
const justin = { sub: "cf-1", email: "justin@coreplane.ai" };
const other = { sub: "cf-2", email: "someone@else.example" };

describe("connect tickets (features/mcp-tools.md item 15)", () => {
  it("a ticket lives 10 minutes, starts pending, lowercases the requester email", () => {
    const t = newTicket({ ...base, requesterEmail: "Justin@CorePlane.ai" });
    expect(t).toMatchObject({
      state: "pending",
      expiresAt: NOW + MCP_TICKET_TTL_MS,
      requesterEmail: "justin@coreplane.ai",
    });
  });

  it("email-bound: only the matching Access email may open or complete; case-insensitive", () => {
    const t = newTicket({ ...base, requesterEmail: "justin@coreplane.ai" });
    expect(identityMatches(t, { sub: "x", email: "JUSTIN@coreplane.ai" })).toBe(true);
    expect(planOpen(t, other, NOW).ok).toBe(false);
    expect(planOpen(t, other, NOW)).toEqual({ ok: false, refusal: { kind: "wrong_identity" } });
    expect(planComplete(t, other, "tok", NOW)).toEqual({ ok: false, refusal: { kind: "wrong_identity" } });
    const open = planOpen(t, justin, NOW);
    expect(open.ok && !open.bound && open.ticket.state === "opened").toBe(true);
  });

  it("unbound: the FIRST opener binds the ticket; anyone else is then refused", () => {
    const t = newTicket(base);
    const first = planOpen(t, other, NOW + 1);
    expect(first.ok && first.bound).toBe(true);
    const bound = (first as { ticket: typeof t }).ticket;
    expect(bound.openedBy).toEqual({ sub: "cf-2", email: "someone@else.example", at: NOW + 1 });
    expect(planOpen(bound, justin, NOW + 2)).toEqual({ ok: false, refusal: { kind: "wrong_identity" } });
    expect(planComplete(bound, justin, "tok", NOW + 2)).toEqual({ ok: false, refusal: { kind: "wrong_identity" } });
    const done = planComplete(bound, other, "tok", NOW + 3);
    expect(done.ok && done.ticket.state === "completed" && done.ticket.completedBy?.sub === "cf-2").toBe(true);
  });

  it("expired, completed, cancelled, and unknown tickets are refused with distinct reasons", () => {
    const t = newTicket(base);
    expect(planOpen(t, justin, NOW + MCP_TICKET_TTL_MS + 1)).toEqual({ ok: false, refusal: { kind: "expired" } });
    expect(planOpen({ ...t, state: "completed" }, justin, NOW)).toEqual({ ok: false, refusal: { kind: "used" } });
    expect(planOpen({ ...t, state: "cancelled" }, justin, NOW)).toEqual({ ok: false, refusal: { kind: "cancelled" } });
    expect(planOpen(null, justin, NOW)).toEqual({ ok: false, refusal: { kind: "not_found" } });
    // A completed ticket stays used even before its expiry.
    expect(planComplete({ ...t, state: "completed" }, justin, "tok", NOW)).toEqual({
      ok: false,
      refusal: { kind: "used" },
    });
  });

  it("the token is trimmed and must be non-empty, single-line, and under the cap", () => {
    const t = newTicket({ ...base, requesterEmail: "justin@coreplane.ai" });
    expect(planComplete(t, justin, "   ", NOW)).toEqual({
      ok: false,
      refusal: { kind: "bad_token", reason: "the token is empty" },
    });
    expect(planComplete(t, justin, "a\nb", NOW)).toMatchObject({ ok: false, refusal: { kind: "bad_token" } });
    expect(planComplete(t, justin, "x".repeat(MCP_TOKEN_MAX_CHARS + 1), NOW)).toMatchObject({
      ok: false,
      refusal: { kind: "bad_token" },
    });
    const ok = planComplete(t, justin, "  tok-123  ", NOW);
    expect(ok.ok && ok.token === "tok-123").toBe(true);
  });

  it("every refusal has a human sentence that names the next step", () => {
    for (const kind of ["not_found", "expired", "used", "cancelled", "wrong_identity", "not_authorizing"] as const) {
      expect(refusalMessage({ kind })).toMatch(/link|user/);
    }
    expect(refusalMessage({ kind: "bad_token", reason: "the token is empty" })).toBe(
      "The token was not accepted: the token is empty.",
    );
    expect(refusalMessage({ kind: "oauth_failed", reason: "no code" })).toBe(
      "Sign-in with the server did not complete: no code.",
    );
  });
});

describe("OAuth transitions (features/mcp-tools.md item 18)", () => {
  const sealed = { keyId: "k1", sealed: "c2VhbGVk" };

  it("the shared validators accept the new kind, state and record — and refuse a malformed record", () => {
    expect(isMcpServerEntry({ url: "https://mcp.vanta.com/mcp", auth: "oauth" })).toBe(true);
    expect(isMcpServerEntry({ url: "https://mcp.vanta.com/mcp", auth: "magic" })).toBe(false);
    const t = { ...newTicket(base), state: "authorizing" as const, oauth: sealed };
    expect(isMcpTicket(t)).toBe(true);
    expect(MCP_TICKET_STATES).toContain("authorizing");
    expect(isMcpTicket({ ...t, oauth: { keyId: "k1" } })).toBe(false);
    expect(isMcpTicket({ ...t, oauth: "sealed" })).toBe(false);
    expect(isMcpTicket({ ...t, state: "dancing" })).toBe(false);
    // The completion's outcome (item 19): a count, a warning, or neither — never a negative count or a novel.
    expect(isMcpTicket({ ...t, state: "completed", outcome: { toolCount: 100 } })).toBe(true);
    expect(
      isMcpTicket({ ...t, state: "completed", outcome: { warning: "stored, but the server could not be reached" } }),
    ).toBe(true);
    expect(isMcpTicket({ ...t, state: "completed", outcome: {} })).toBe(true);
    expect(isMcpTicket({ ...t, outcome: { toolCount: -1 } })).toBe(false);
    expect(isMcpTicket({ ...t, outcome: { warning: "w".repeat(2_000) } })).toBe(false);
    expect(isMcpTicket({ ...t, outcome: "100 tools" })).toBe(false);
  });

  it("start: planOpen's identity rules (binding an unbound ticket to the starter), then `authorizing` with the sealed record attached", () => {
    const t = newTicket(base);
    const first = planStart(t, other, sealed, NOW + 1);
    expect(first.ok && first.bound).toBe(true);
    expect((first as { ticket: typeof t }).ticket).toMatchObject({
      state: "authorizing",
      oauth: sealed,
      openedBy: { sub: "cf-2" },
    });
    const bound = (first as { ticket: typeof t }).ticket;
    expect(planStart(bound, justin, sealed, NOW + 2)).toEqual({ ok: false, refusal: { kind: "wrong_identity" } });
    // Starting again (the person reopened the link) replaces the record; the owner may.
    const again = planStart(bound, other, { keyId: "k1", sealed: "bmV3" }, NOW + 3);
    expect(again.ok && !again.bound && again.ticket.oauth?.sealed === "bmV3").toBe(true);
    expect(planStart({ ...t, state: "completed" }, other, sealed, NOW)).toEqual({
      ok: false,
      refusal: { kind: "used" },
    });
    expect(planStart(t, other, sealed, NOW + MCP_TICKET_TTL_MS + 1)).toEqual({
      ok: false,
      refusal: { kind: "expired" },
    });
  });

  it("callback: only an `authorizing` ticket, only its owner, once — a pending/opened ticket is `not_authorizing`, a completed one `used`", () => {
    const t = newTicket({ ...base, requesterEmail: "justin@coreplane.ai" });
    expect(planCallback(t, justin, NOW)).toEqual({ ok: false, refusal: { kind: "not_authorizing" } });
    const started = (planStart(t, justin, sealed, NOW) as { ticket: typeof t }).ticket;
    expect(planCallback(started, other, NOW + 1)).toEqual({ ok: false, refusal: { kind: "wrong_identity" } });
    const done = planCallback(started, justin, NOW + 1);
    expect(done.ok && done.ticket.state === "completed" && done.ticket.completedBy?.sub === "cf-1").toBe(true);
    expect(planCallback((done as { ticket: typeof t }).ticket, justin, NOW + 2)).toEqual({
      ok: false,
      refusal: { kind: "used" },
    });
    expect(planCallback(started, justin, NOW + MCP_TICKET_TTL_MS + 1)).toEqual({
      ok: false,
      refusal: { kind: "expired" },
    });
    expect(planCallback(null, justin, NOW)).toEqual({ ok: false, refusal: { kind: "not_found" } });
  });
});
