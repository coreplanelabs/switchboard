import type { PlaneEndingCause } from "./plane/decide.js";
import { oneLine, redactAndCap } from "./redact.js";

/** The server-owned condition of an admitted run. A plane queue row is not admitted and has none. */
export type RunLiveStateName =
  | "admitted"
  | "waiting_deploy"
  | "waiting_repository"
  | "falling_back"
  | "preparing"
  | "working"
  | "waiting_provider"
  | "wrapping_up"
  | "ended";

export const RUN_LIVE_STATE_NAMES = [
  "admitted",
  "waiting_deploy",
  "waiting_repository",
  "falling_back",
  "preparing",
  "working",
  "waiting_provider",
  "wrapping_up",
  "ended",
] as const satisfies readonly RunLiveStateName[];

export const LIVE_STATE_DETAIL_MAX = 160;

export type ResidentLiveStateObservation =
  | { state: "waiting_deploy"; bound: number; reason: "deploy"; attempt: number }
  | { state: "waiting_repository"; bound: number; reason: "repository_container"; attempt: number };

export type ResidentLiveStateObserver = (observation: ResidentLiveStateObservation) => Promise<void>;

export interface RunLiveState {
  state: RunLiveStateName;
  /** Epoch ms at the most recent state boundary. Same-state refreshes preserve it. */
  since: number;
  /** Absolute epoch-ms deadline of the durable fact that created this live condition. */
  bound?: number;
  /** Capped, redacted user words. Never a provider body or resident refusal code. */
  detail?: string;
}

export interface RunStateEvent extends RunLiveState {
  type: "run_state";
  /** Required only for the terminal boundary; it names the plane's existing closed cause. */
  cause?: PlaneEndingCause;
  seq?: number;
  at?: number;
}

export interface RunLiveStateFoldEvent {
  type: string;
  seq?: number;
  at?: number;
  state?: unknown;
  since?: number;
  bound?: number;
  detail?: string;
  endsAt?: number;
  boundMs?: number;
}

export interface RunLiveStateMaterialized {
  liveState?: RunLiveState;
  /** Authoritative event sequence that produced or refreshed `liveState`. */
  liveStateSeq?: number;
}

const TRANSITIONS = {
  admitted: ["waiting_deploy", "waiting_repository", "falling_back", "preparing", "working", "wrapping_up", "ended"],
  waiting_deploy: ["waiting_repository", "falling_back", "preparing", "working", "wrapping_up", "ended"],
  waiting_repository: ["waiting_deploy", "falling_back", "preparing", "working", "wrapping_up", "ended"],
  falling_back: ["preparing", "working", "wrapping_up", "ended"],
  preparing: ["waiting_deploy", "waiting_repository", "falling_back", "working", "wrapping_up", "ended"],
  working: [
    "waiting_deploy",
    "waiting_repository",
    "falling_back",
    "preparing",
    "waiting_provider",
    "wrapping_up",
    "ended",
  ],
  waiting_provider: ["working", "wrapping_up", "ended"],
  wrapping_up: ["ended"],
  ended: [],
} as const satisfies Record<RunLiveStateName, readonly RunLiveStateName[]>;

const UNSAFE_DETAIL =
  /(?:\bimage-stale\b|\battach-failed\b|\bparked-provider\b|<\/?(?:html|body|head)\b|\bbad gateway\b)/i;

/** Admit only display-ready prose. Typed mappers create normal details; this is the final leak guard. */
export function safeLiveStateDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const line = oneLine(detail);
  if (line === "" || UNSAFE_DETAIL.test(line)) return undefined;
  return redactAndCap(line, LIVE_STATE_DETAIL_MAX - 1);
}

export type AssignRunLiveStateInput = {
  expectedSeq: number;
  at: number;
  state: RunLiveStateName;
  bound?: number;
  detail?: string;
  cause?: PlaneEndingCause;
};

export type AssignRunLiveStateResult =
  | { ok: true; liveState: RunLiveState; event?: RunStateEvent }
  | {
      ok: false;
      reason:
        "stale-sequence" | "terminal" | "invalid-transition" | "bound-required" | "invalid-bound" | "cause-required";
    };

/** Pure assignment gate. Persistence chooses the next stream sequence and commits the result atomically. */
export function assignRunLiveState(
  current: RunLiveState | undefined,
  currentSeq: number,
  input: AssignRunLiveStateInput,
): AssignRunLiveStateResult {
  if (input.expectedSeq !== currentSeq) return { ok: false, reason: "stale-sequence" };
  if (current === undefined && input.state !== "admitted") return { ok: false, reason: "invalid-transition" };
  if (current?.state === "ended") return { ok: false, reason: "terminal" };
  if (input.state !== "ended") {
    if (input.bound === undefined) return { ok: false, reason: "bound-required" };
    if (!Number.isFinite(input.bound) || input.bound < input.at) return { ok: false, reason: "invalid-bound" };
  } else if (input.cause === undefined) return { ok: false, reason: "cause-required" };
  if (
    current !== undefined &&
    current.state !== input.state &&
    !TRANSITIONS[current.state].includes(input.state as never)
  )
    return { ok: false, reason: "invalid-transition" };

  const detail = safeLiveStateDetail(input.detail);
  const liveState: RunLiveState = {
    state: input.state,
    since: current?.state === input.state ? current.since : input.at,
    ...(input.state !== "ended" ? { bound: input.bound } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
  if (current?.state === input.state) return { ok: true, liveState };
  return {
    ok: true,
    liveState,
    event: {
      type: "run_state",
      ...liveState,
      ...(input.state === "ended" ? { cause: input.cause } : {}),
      at: input.at,
    },
  };
}

/** Rebuild the projection from boundaries. A later event sequence always defeats stale materialized state. */
export function foldRunLiveState(
  events: readonly RunLiveStateFoldEvent[],
  materialized: RunLiveStateMaterialized = {},
): RunLiveStateMaterialized {
  let liveState = materialized.liveState;
  let liveStateSeq = materialized.liveStateSeq ?? 0;
  let leaseEndsAt: number | undefined;
  for (const event of [...events].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))) {
    if (event.type === "lease" && event.endsAt !== undefined) leaseEndsAt = event.endsAt;
    const seq = event.seq ?? 0;
    if (seq <= liveStateSeq) continue;
    if (
      event.type === "run_state" &&
      RUN_LIVE_STATE_NAMES.includes(event.state as RunLiveStateName) &&
      event.since !== undefined
    ) {
      liveState = {
        state: event.state as RunLiveStateName,
        since: event.since,
        ...(event.bound !== undefined ? { bound: event.bound } : {}),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      };
      liveStateSeq = seq;
      continue;
    }
    if (
      event.type === "tool_call" &&
      liveState?.state === "working" &&
      event.at !== undefined &&
      event.boundMs !== undefined
    ) {
      liveState = { ...liveState, bound: event.at + event.boundMs, detail: "running a tool" };
      liveStateSeq = seq;
      continue;
    }
    if (event.type === "tool_result" && liveState?.state === "working" && leaseEndsAt !== undefined) {
      liveState = { ...liveState, bound: leaseEndsAt, detail: "model turn" };
      liveStateSeq = seq;
    }
  }
  return {
    ...(liveState !== undefined ? { liveState } : {}),
    ...(liveStateSeq > 0 ? { liveStateSeq } : {}),
  };
}
