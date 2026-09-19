// Types for runtime-supervisor.mjs (plain-Node ESM: the sandbox image copies
// the file as-is, no build step). The seams exist so the tests can drive the
// loop with a fake child, a fake clock and a fake signal source.
export const DEFAULT_RUNTIME: "/container-server/sandbox";
export const QUICK_EXIT_SECS: 10;
export const QUICK_EXIT_LIMIT: 5;
export const RESTART_PAUSE_MS: 1000;

/** The least a spawned child must offer the loop. */
export type SupervisedChild = {
  kill(signal: "SIGTERM"): unknown;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (err: unknown) => void): unknown;
};

export type SignalSource = {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
};

export function endCode(code: number | null, signal: string | null): number;

export function supervise(deps: {
  runtime: string;
  args: string[];
  spawn: (runtime: string, args: string[]) => SupervisedChild;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  log: (line: string) => void;
  signals: SignalSource;
}): Promise<number>;
