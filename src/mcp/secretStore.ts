import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  isMcpTicket,
  isSealedCredential,
  type McpTicket,
  type McpTicketState,
  type SealedCredential,
} from "./registry.js";

// Where sealed MCP credentials and connect tickets live (features/mcp-tools.md
// items 15–16). The server ENTRIES are config (`Scope.mcpServers`, persisted
// through the config store's overrides backing); only the two things that must
// never be in a config document — ciphertext and one-time tickets — live here,
// beside the overrides on the same state Worker. Three implementations
// (AGENTS.md invariant 2): `WorkerMcpSecretStore` (the ConfigDO's secrets and
// tickets tables — production), `FileMcpSecretStore` (a JSON file of SEALED
// blobs — the local-dev twin of `FileOverridesBacking`), `InMemoryMcpSecretStore`.
//
// Route contract (bearer = MEMORY_TOKEN):
//   POST /config/secrets/put    {sealed}    → {ok}
//   POST /config/secrets/get    {serverId}  → {sealed: SealedCredential | null}
//   POST /config/secrets/delete {serverId}  → {ok, removed}
//   POST /config/tickets/put    {ticket}    → {ok}          (insert or replace)
//   POST /config/tickets/get    {nonce}     → {ticket: McpTicket | null}
//   POST /config/tickets/transition {ticket, fromState} → {ok, applied}  (write only if the stored state is still fromState)

export interface McpSecretStore {
  putCredential(sealed: SealedCredential): Promise<void>;
  getCredential(serverId: string): Promise<SealedCredential | null>;
  deleteCredential(serverId: string): Promise<boolean>;
  /** Insert or replace — how a ticket is minted. */
  putTicket(ticket: McpTicket): Promise<void>;
  getTicket(nonce: string): Promise<McpTicket | null>;
  /** Compare-and-swap: write `ticket` only if the stored ticket is still in
   *  `fromState`; `false` when it moved (a concurrent open/complete won) or is
   *  unknown. Every state transition after minting goes through here, so
   *  "single-use" holds under concurrent requests. */
  transitionTicket(ticket: McpTicket, fromState: McpTicketState): Promise<boolean>;
  describe(): string;
}

export class InMemoryMcpSecretStore implements McpSecretStore {
  readonly credentials = new Map<string, SealedCredential>();
  readonly tickets = new Map<string, McpTicket>();
  async transitionTicket(ticket: McpTicket, fromState: McpTicketState): Promise<boolean> {
    const cur = this.tickets.get(ticket.nonce);
    if (!cur || cur.state !== fromState) return false;
    this.tickets.set(ticket.nonce, structuredClone(ticket));
    return true;
  }
  async putCredential(sealed: SealedCredential): Promise<void> {
    this.credentials.set(sealed.serverId, { ...sealed });
  }
  async getCredential(serverId: string): Promise<SealedCredential | null> {
    const c = this.credentials.get(serverId);
    return c ? { ...c } : null;
  }
  async deleteCredential(serverId: string): Promise<boolean> {
    return this.credentials.delete(serverId);
  }
  async putTicket(ticket: McpTicket): Promise<void> {
    this.tickets.set(ticket.nonce, structuredClone(ticket));
  }
  async getTicket(nonce: string): Promise<McpTicket | null> {
    const t = this.tickets.get(nonce);
    return t ? structuredClone(t) : null;
  }
  describe(): string {
    return "in-memory";
  }
}

/** Sealed blobs and tickets in one JSON file (`data/mcp-secrets.json`). The
 *  blobs are ciphertext, so the file is no more sensitive than the overrides
 *  file — but it is the dev/single-host choice for the same reason. */
export class FileMcpSecretStore implements McpSecretStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  private read(): { credentials: Record<string, SealedCredential>; tickets: Record<string, McpTicket> } {
    if (!existsSync(this.path)) return { credentials: {}, tickets: {} };
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as {
      credentials?: Record<string, unknown>;
      tickets?: Record<string, unknown>;
    };
    const credentials: Record<string, SealedCredential> = {};
    for (const [k, v] of Object.entries(raw.credentials ?? {})) if (isSealedCredential(v)) credentials[k] = v;
    const tickets: Record<string, McpTicket> = {};
    for (const [k, v] of Object.entries(raw.tickets ?? {})) if (isMcpTicket(v)) tickets[k] = v;
    return { credentials, tickets };
  }
  private write(doc: { credentials: Record<string, SealedCredential>; tickets: Record<string, McpTicket> }): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(doc, null, 2));
  }
  async putCredential(sealed: SealedCredential): Promise<void> {
    const doc = this.read();
    doc.credentials[sealed.serverId] = sealed;
    this.write(doc);
  }
  async getCredential(serverId: string): Promise<SealedCredential | null> {
    return this.read().credentials[serverId] ?? null;
  }
  async deleteCredential(serverId: string): Promise<boolean> {
    const doc = this.read();
    const had = serverId in doc.credentials;
    delete doc.credentials[serverId];
    this.write(doc);
    return had;
  }
  async putTicket(ticket: McpTicket): Promise<void> {
    const doc = this.read();
    doc.tickets[ticket.nonce] = ticket;
    // Sweep tickets expired more than a day ago so the file never grows without bound.
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [n, t] of Object.entries(doc.tickets)) if (t.expiresAt < cutoff) delete doc.tickets[n];
    this.write(doc);
  }
  async getTicket(nonce: string): Promise<McpTicket | null> {
    return this.read().tickets[nonce] ?? null;
  }
  /** Read-check-write on one process's file: atomic for the single bot that owns it. */
  async transitionTicket(ticket: McpTicket, fromState: McpTicketState): Promise<boolean> {
    const doc = this.read();
    const cur = doc.tickets[ticket.nonce];
    if (!cur || cur.state !== fromState) return false;
    doc.tickets[ticket.nonce] = ticket;
    this.write(doc);
    return true;
  }
  describe(): string {
    return `file ${this.path}`;
  }
}

export const MCP_SECRET_WORKER_TIMEOUT_MS = 8_000;

export class WorkerMcpSecretStore implements McpSecretStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }
  async putCredential(sealed: SealedCredential): Promise<void> {
    await this.post("/config/secrets/put", { sealed });
  }
  async getCredential(serverId: string): Promise<SealedCredential | null> {
    const body = await this.post("/config/secrets/get", { serverId });
    return isSealedCredential(body.sealed) ? body.sealed : null;
  }
  async deleteCredential(serverId: string): Promise<boolean> {
    const body = await this.post("/config/secrets/delete", { serverId });
    return body.removed === true;
  }
  async putTicket(ticket: McpTicket): Promise<void> {
    await this.post("/config/tickets/put", { ticket });
  }
  async getTicket(nonce: string): Promise<McpTicket | null> {
    const body = await this.post("/config/tickets/get", { nonce });
    return isMcpTicket(body.ticket) ? body.ticket : null;
  }
  async transitionTicket(ticket: McpTicket, fromState: McpTicketState): Promise<boolean> {
    const body = await this.post("/config/tickets/transition", { ticket, fromState });
    return body.applied === true;
  }
  describe(): string {
    return `state Worker ${this.baseUrl} (ConfigDO secrets)`;
  }
  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(MCP_SECRET_WORKER_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`MCP secret store unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`MCP secret store answered HTTP ${res.status} on ${path}`);
    const body: unknown = await res.json().catch(() => undefined);
    if (!body || typeof body !== "object") throw new Error(`MCP secret store returned a non-JSON body on ${path}`);
    return body as Record<string, unknown>;
  }
}
