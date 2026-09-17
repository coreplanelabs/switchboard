import { LINEAR_TIMING } from "../../core/budgets.js";
import type { Clock } from "../../core/trace/types.js";
import { object, required, type LinearApi } from "./api.js";
import type { LinearDelivery, LinearInbox } from "./inbox.js";
import { linearMessage } from "./session.js";

/** A deterministic UUID in the API's accepted v4 shape, derived from the signed
 * event key. It is an idempotency key, never an authentication credential. */
async function acknowledgementId(key: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`linear-ack:${key}`)),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Runs in the edge's waitUntil and durable alarm. The dispatch phase cannot
 * begin before this finishes, so a delayed retry cannot reopen a completed
 * session by sending an old thought after its final response. */
export class LinearAcknowledgements {
  private flushing?: Promise<void>;
  constructor(
    private readonly deps: {
      inbox: LinearInbox;
      api(organizationId: string): Promise<LinearApi>;
      clock: Clock;
      warn(message: string): void;
    },
  ) {}

  flush(): Promise<void> {
    return (this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
    }));
  }

  private async drain(): Promise<void> {
    let remaining = 32;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (remaining-- > 0) {
          const delivery = await this.deps.inbox.claimAck(
            this.deps.clock(),
            LINEAR_TIMING.ackLeaseMs,
            crypto.randomUUID(),
          );
          if (!delivery) return;
          await this.send(delivery);
        }
      }),
    );
  }

  private async send({ event, lease }: LinearDelivery): Promise<void> {
    const { inbox, clock } = this.deps;
    try {
      const api = await this.deps.api(event.payload.organizationId);
      const session = await api.session(required(object(event.payload.agentSession).id));
      if (session.dismissedAt) {
        await inbox.complete(event.key, lease, clock());
        return;
      }
      const id = await acknowledgementId(event.key);
      try {
        linearMessage(event, session, session.appUserId);
      } catch {
        await api.activity(
          session.id,
          {
            type: "error",
            body: "Switchboard could not establish a supported request and its human sender. Please send a new mention or delegate this issue again.",
          },
          { id },
        );
        await inbox.complete(event.key, lease, clock());
        return;
      }
      await api.activity(
        session.id,
        { type: "thought", body: "Request received. Switchboard is preparing to work on it." },
        { id },
      );
      await inbox.acknowledge(event.key, lease, clock());
    } catch {
      this.deps.warn("[linear] acknowledgement unfinished; retained for retry");
      await inbox.retry(event.key, lease, clock() + LINEAR_TIMING.progressMs);
    }
  }
}
