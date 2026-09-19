// `POST /plane/effects` — the plane transport's push half (record 0064, "Where
// it lives"; docs/reference/specs/orchestration-plane.md item 44): the state
// Worker POSTs committed effects to the bot shim over its service binding, the
// shim checks the bearer and forwards here, and this route runs each effect
// through the SAME executor and ack path the heartbeat answer uses — so an
// admit lands within a push instead of waiting up to a heartbeat interval.
// Best-effort like the heartbeat's: an ack that fails leaves the offer
// standing, and it rides the next heartbeat or reclaim-sweep answer.
//
// Fail-closed bearer: the state Worker speaks with `MEMORY_TOKEN` — the same
// secret the bot presents to the state Worker — and the shim already refused
// everything else; this check keeps the route closed when the container is
// reached another way, or when the token is not configured at all.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Secret } from "../secrets.js";
import type { PlaneAckOutcome, PlaneEffect } from "../core/plane/decide.js";
import { constantTimeEqual } from "../deploy/restart.js";
import { readBody } from "./http.js";

/** Effect pushes are small (at most the answer cap of effects, each one queued
 *  request); anything larger is not this route's traffic. */
const MAX_PUSH_BODY_BYTES = 1024 * 1024;

export interface PlaneEffectsDeps {
  /** The `MEMORY_TOKEN` secret as the process sees it; unset refuses every push. */
  token: Secret | undefined;
  /** The wired effect executor — the one object the heartbeat path runs
   *  effects through (src/index.ts), so push and pull execute identically.
   *  Absent (no ledger): every effect defers and stays offered. */
  execute:
    | {
        draining(): boolean;
        admit(effect: PlaneEffect): Promise<PlaneAckOutcome>;
      }
    | undefined;
  /** `RunLedger.planeAck` — closes or re-offers the effect on the object. */
  ack: (id: string, outcome: PlaneAckOutcome) => Promise<void>;
  warn?: (line: string) => void;
  log?: (line: string) => void;
}

/** One pushed effect, shape-checked before anything runs: the push crosses a
 *  process boundary, so a malformed body is a 400, never a throw. */
function parseEffect(v: unknown): PlaneEffect | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const e = v as Record<string, unknown>;
  if (e.kind !== "admit") return undefined;
  if (typeof e.id !== "string" || e.id.length === 0) return undefined;
  if (typeof e.runId !== "string" || e.runId.length === 0) return undefined;
  if (typeof e.threadKey !== "string" || e.threadKey.length === 0) return undefined;
  if (typeof e.request !== "object" || e.request === null || Array.isArray(e.request)) return undefined;
  return {
    id: e.id,
    kind: "admit",
    runId: e.runId,
    threadKey: e.threadKey,
    request: e.request as PlaneEffect["request"],
  };
}

export function handlePlaneEffects(req: IncomingMessage, res: ServerResponse, deps: PlaneEffectsDeps): void {
  const warn = deps.warn ?? console.warn;
  const json = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") {
    json(405, { ok: false, error: "method not allowed: POST /plane/effects" });
    return;
  }
  const token = deps.token?.reveal();
  const presented = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!token || !presented || !constantTimeEqual(token, presented)) {
    json(401, { ok: false, error: "unauthorized" });
    return;
  }
  void (async () => {
    const read = await readBody(req, MAX_PUSH_BODY_BYTES);
    if (!read.ok) {
      json(413, { ok: false, error: "body too large" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(read.body);
    } catch {
      json(400, { ok: false, error: "body must be JSON" });
      return;
    }
    const raw = (body as { effects?: unknown } | null)?.effects;
    if (!Array.isArray(raw)) {
      json(400, { ok: false, error: "effects must be an array" });
      return;
    }
    const effects = raw.map(parseEffect);
    if (effects.some((e) => e === undefined)) {
      json(400, { ok: false, error: "malformed effect" });
      return;
    }
    // The heartbeat path's exact contract (writeThrough.ts): no executor or a
    // draining generation defers — the offer stays for a bot that can run it —
    // and a failed ack leaves the offer standing to ride the next answer.
    const acks: { id: string; outcome: PlaneAckOutcome }[] = [];
    for (const effect of effects as PlaneEffect[]) {
      try {
        const executor = deps.execute;
        const outcome: PlaneAckOutcome =
          executor === undefined || executor.draining() ? "deferred" : await executor.admit(effect);
        await deps.ack(effect.id, outcome);
        acks.push({ id: effect.id, outcome });
      } catch (err) {
        warn(
          `[plane/effects] effect ${effect.id} failed: ${err instanceof Error ? err.message : String(err)} — it stays offered and rides the next heartbeat`,
        );
      }
    }
    (deps.log ?? console.log)(
      `[plane/effects] push of ${effects.length} effect(s): ${acks.map((a) => `${a.id}=${a.outcome}`).join(", ") || "none acked"}`,
    );
    json(200, { ok: true, acks });
  })().catch((err: unknown) => {
    warn(`[plane/effects] ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) json(500, { ok: false, error: "push failed" });
  });
}
