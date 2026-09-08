import { systemClock } from "../core/trace/clock.js";
// Socket-state observability (companion to slackCatchUpStatus.ts, #271
// pattern). The HTTP server starts BEFORE the Slack Socket Mode handshake
// (src/index.ts), so there is a real window where `/healthz` answers while the
// bot cannot hear Slack — and a socket that silently dies leaves the same
// deaf-but-healthy shape for up to a reconnect. This module is the ONE place
// the socket's live state is kept so `GET /healthz` can report it: an operator
// (or the cold-start validation poller) reads `slack.connected` instead of
// container stdout, which is not queryable off-box.
//
// In-process and live-only, on purpose (invariant 6): this is a diagnostic of
// THIS process's socket, not state anything rebuilds from. A restart starts at
// `{connected: false}` — which is the truth until the handshake lands.

/** What `/healthz` shows as `slack`. */
export interface SlackSocketStatus {
  /** True while the Socket Mode websocket is up. */
  connected: boolean;
  /** ISO instant of the last recorded transition into the current state;
   *  absent only at process start, before any event has been recorded (a
   *  failed initial handshake emits `disconnected` and stamps it too). */
  since?: string;
  /** Times the socket has connected in this process's lifetime (1 = the boot
   *  handshake; more = reconnects). Absent until the first connect. */
  connects?: number;
}

let status: SlackSocketStatus = { connected: false };
let connects = 0;

export function recordSocketConnected(at: number = systemClock()): void {
  connects++;
  status = { connected: true, since: new Date(at).toISOString(), connects };
}

export function recordSocketDisconnected(at: number = systemClock()): void {
  status = { connected: false, since: new Date(at).toISOString(), ...(connects > 0 ? { connects } : {}) };
}

/** A copy — callers never mutate the record. */
export function getSocketStatus(): SlackSocketStatus {
  return { ...status };
}

/** Tests only. */
export function resetSocketStatus(): void {
  status = { connected: false };
  connects = 0;
}
