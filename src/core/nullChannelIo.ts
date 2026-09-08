// The channel IO for a resumed run whose caller is gone (features/run-history.md
// item 38): an HTTP `/ingress` or MCP request that was answered — or whose
// client dropped — when the previous generation died. The run's deliverable is
// its record (and, for a coding run, the PR it opens); the reply has nowhere
// to go, so it is logged, never sent. The status card and the thread history
// have no counterpart on those channels either.

import type { ChannelIO, StatusHandle } from "./types.js";

export function nullChannelIO(logKey: string, log: (line: string) => void = console.log): ChannelIO {
  return {
    reply: async (text) => {
      log(`[resume] ${logKey} reply (no channel to deliver to): ${text.length} chars`);
    },
    status: async (): Promise<StatusHandle> => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
  };
}
