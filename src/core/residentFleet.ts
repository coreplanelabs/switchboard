import type { ResidentAdminClient } from "./residentAdmin.js";

// What the bot knows about its resident fleet without asking on the run path
// (features/routing-and-config.md item 11): the cap the resident Worker
// reports on `GET /residents` — a fact of that Worker's build and its test
// overrides, never a constant compiled into the bot. The self-description
// block reads it synchronously on every dispatch, so the value is refreshed in
// the background (at boot, then every `refreshMs`) and read from memory;
// unknown until the first answer, or when the Worker cannot be reached — the
// block then says the fleet is capped without naming the number.

export interface ResidentFleetFacts {
  /** The resident cap the Worker last reported; undefined until known. */
  cap(): number | undefined;
}

/** The facts of a process without residents (or before any answer): nothing known. */
export const NO_FLEET: ResidentFleetFacts = Object.freeze({ cap: () => undefined });

export interface ResidentFleetWatcher extends ResidentFleetFacts {
  /** One read of the admin listing; a failure is a warning, the last value stands. */
  refresh(): Promise<void>;
  /** Refresh now and every `refreshMs` (an unref'd timer — never holds the process). */
  start(): void;
  stop(): void;
}

/** How often the fleet facts are re-read; the cap changes only on a resident Worker deploy or a test override. */
export const FLEET_REFRESH_MS = 5 * 60_000;

export interface ResidentFleetOptions {
  refreshMs?: number;
  warn: (message: string) => void;
  setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  clearInterval?: (timer: { unref?(): void }) => void;
}

export function watchResidentFleet(
  admin: Pick<ResidentAdminClient, "residents">,
  opts: ResidentFleetOptions,
): ResidentFleetWatcher {
  let cap: number | undefined;
  let timer: { unref?(): void } | undefined;
  const refresh = async (): Promise<void> => {
    try {
      const res = await admin.residents();
      if (res.status !== 200) {
        opts.warn(`[residents] fleet facts not refreshed: /residents answered ${res.status}`);
        return;
      }
      if (typeof res.data.cap === "number" && Number.isFinite(res.data.cap)) cap = res.data.cap;
    } catch (err) {
      opts.warn(`[residents] fleet facts not refreshed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    cap: () => cap,
    refresh,
    start() {
      void refresh();
      timer = (opts.setInterval ?? setInterval)(() => void refresh(), opts.refreshMs ?? FLEET_REFRESH_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) (opts.clearInterval ?? clearInterval)(timer as never);
      timer = undefined;
    },
  };
}
