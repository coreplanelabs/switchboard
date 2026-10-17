/** Closed model-call observations shared by the signer and run history.
 * These facts confer no provider, ending or retry authority. Keep this
 * module free of Node imports so Workers can read the event contract. */
export type ProxyUnknownTerminalReason = "malformed_json" | "consumer_rejected" | "unverified_terminal";

export const PROXY_INTERRUPTION_KINDS = [
  "aborted",
  "capacity",
  "worker-error",
  "worker-exit",
  "protocol",
  "frame-bytes",
  "stream-bytes",
  "fields",
  "output-bytes",
  "graph",
  "ipc-bytes",
  "storage",
] as const;

export type ProxyRejectionObservation =
  | {
      phase: "admission" | "request_validation" | "response_validation";
      kind: (typeof PROXY_INTERRUPTION_KINDS)[number];
    }
  | { phase: "sdk_consume"; kind: "rejected" };
