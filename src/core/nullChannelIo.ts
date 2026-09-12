// The channel IO for a resumed run whose caller is gone (docs/reference/specs/run-history.md
// item 38): an HTTP `/ingress` or MCP request that was answered — or whose
// client dropped — when the previous generation died. The run's deliverable is
// its record (and, for a coding run, the PR it opens); the reply has nowhere
// to go, so it is logged, never sent. The status card and the thread history
// have no counterpart on those channels either. A child thread it opens
// (docs/reference/specs/thread-admission.md item 6) is a null channel of its
// own under a derived key, so a resumed parent's spawn is a run with a record
// rather than a refusal for want of a thread.

import type { ChannelIO, StatusHandle } from "./types.js";

export function nullChannelIO(logKey: string, log: (line: string) => void = console.log): ChannelIO {
  let children = 0;
  return {
    reply: async (text) => {
      log(`[resume] ${logKey} reply (no channel to deliver to): ${text.length} chars`);
    },
    status: async (): Promise<StatusHandle> => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
    openThread: async (lead) => {
      const threadKey = `${logKey}/child-${++children}`;
      log(`[resume] ${logKey} opened child thread ${threadKey} (no channel to post to): ${lead.length} chars`);
      return { thread: { threadKey }, io: nullChannelIO(threadKey, log) };
    },
  };
}
