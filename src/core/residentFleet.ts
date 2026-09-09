import { NullResidentAdminClient, type ResidentAdminResponse } from "./residentAdmin.js";
import { startProcessRoot, type RequestTraceDeps } from "./requestTrace.js";
import type { Span } from "./trace/types.js";

// What the bot knows about its resident fleet without asking on the run path
// (docs/reference/specs/routing-and-config.md item 11): the cap the resident Worker
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
  /** Where a refresh's root goes (docs/reference/specs/tracing.md item 20): each read runs
   *  under a `resident.fleet_refresh` root handed to the client, so the Worker's
   *  `/residents` call adopts a trace instead of minting its own. Absent (the
   *  one-shot CLI, tests without tracing) → the read is untraced. */
  trace?: RequestTraceDeps;
}

/** What the watcher needs of the admin client: the listing, and (optionally) the
 *  same listing bound to a span — `ResidentAdminClient` satisfies it as is. */
export interface FleetListingSource {
  residents(): Promise<ResidentAdminResponse>;
  withSpan?(span: Span): FleetListingSource;
}

export function watchResidentFleet(admin: FleetListingSource, opts: ResidentFleetOptions): ResidentFleetWatcher {
  let cap: number | undefined;
  let timer: { unref?(): void } | undefined;
  const refresh = async (): Promise<void> => {
    const root = opts.trace ? startProcessRoot(opts.trace, "resident.fleet_refresh") : undefined;
    const client = root && admin.withSpan ? admin.withSpan(root) : admin;
    try {
      const res = await client.residents();
      root?.setAttrs({ httpStatus: res.status });
      if (res.status !== 200) {
        opts.warn(`[residents] fleet facts not refreshed: /residents answered ${res.status}`);
        root?.end("error");
        return;
      }
      if (typeof res.data.cap === "number" && Number.isFinite(res.data.cap)) cap = res.data.cap;
      if (typeof res.data.count === "number" && Number.isFinite(res.data.count))
        root?.setAttrs({ residents: res.data.count });
      root?.end("ok");
    } catch (err) {
      root?.fail(err);
      root?.end("error");
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

/**
 * The one place a process decides whether it has a fleet to watch: the admin
 * plane `residentAdminFromConfig` resolved to — a client, the reason there is
 * none, or the `NullResidentAdminClient` that stands in for that reason. Only
 * a plane that can answer gets a watcher: the null one answers 503 forever, so
 * a watcher on it would never learn a cap and would warn on every read. Both
 * entry points call this and fall back to `NO_FLEET`; how the watcher is driven
 * is theirs (the bot `start()`s it, the one-shot CLI awaits one `refresh()`).
 */
export function residentFleetWatcherFor(
  admin: FleetListingSource | { unavailable: string },
  opts: ResidentFleetOptions,
): ResidentFleetWatcher | undefined {
  if ("unavailable" in admin || admin instanceof NullResidentAdminClient) return undefined;
  return watchResidentFleet(admin, opts);
}
