import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DepotCiGrant } from "../core/depotCi.js";

/** One-use permits for IN-FLIGHT bot → edge calls, not durable run authority.
 * The dispatcher supplies the run/repo and live permission check, never model
 * input. A restart deliberately drops these: an interrupted mutation is unknown,
 * not permission to replay it. Nothing can mint a permit over HTTP. */
export class DepotCiAuthorizations {
  private readonly pending = new Map<string, { grant: DepotCiGrant; allowed: () => boolean; release: () => void }>();

  issue(grant: DepotCiGrant, allowed: () => boolean, signal: AbortSignal): { ticket: string; release: () => void } {
    signal.throwIfAborted();
    const ticket = randomBytes(32).toString("hex");
    const release = () => {
      this.pending.delete(ticket);
      signal.removeEventListener("abort", release);
    };
    this.pending.set(ticket, { grant: structuredClone(grant), allowed: () => !signal.aborted && allowed(), release });
    signal.addEventListener("abort", release, { once: true });
    return { ticket, release };
  }

  /** Consume before returning anything, including a refusal. A second edge
   * request cannot spend the same permit on a second retry. */
  consume(ticket: string): DepotCiGrant | undefined {
    const entry = this.pending.get(ticket);
    if (!entry) return undefined;
    entry.release();
    return entry.allowed() ? structuredClone(entry.grant) : undefined;
  }
}

export const depotCiAuthorizations = new DepotCiAuthorizations();

/** Only the Worker's fixed container binding calls this route; its public
 * router refuses the path. The ticket is itself an unguessable one-use secret.
 * No body, mint/list endpoint, query token, or logging of request material. */
export function handleDepotCiAuthorization(
  req: IncomingMessage,
  res: ServerResponse,
  permits = depotCiAuthorizations,
): void {
  const ticket = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
  let grant: DepotCiGrant | undefined;
  try {
    if (req.method === "POST" && ticket) grant = permits.consume(ticket);
  } catch {
    // Permission lookup failure denies, without exposing its exception.
  }
  res.writeHead(req.method !== "POST" ? 405 : grant ? 200 : 404, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(grant ?? { error: "Depot CI authorization refused." }));
  req.resume();
}
