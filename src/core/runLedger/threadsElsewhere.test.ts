import { describe, expect, it } from "vitest";
import { ThreadsElsewhere } from "./threadsElsewhere.js";

describe("ThreadsElsewhere — the threads whose live run is on the ledger but not in this process (thread-admission item 5)", () => {
  it("replace() is the whole truth each sweep: a listed thread answers with its run, a dropped one is forgotten, forget() takes one out early", () => {
    const t = new ThreadsElsewhere();
    expect(t.get("slack:C1:1.0")).toBeUndefined();
    t.replace([
      { threadKey: "slack:C1:1.0", runId: "r1", startedAt: 5, meta: { agent: "review" } },
      { threadKey: "slack:C1:2.0", runId: "r2", startedAt: 6, meta: {} },
    ]);
    expect(t.get("slack:C1:1.0")).toEqual({ runId: "r1", agent: "review", startedAt: 5 });
    expect(t.get("slack:C1:2.0")).toEqual({ runId: "r2", startedAt: 6 });
    expect(t.size).toBe(2);
    t.forget("slack:C1:2.0");
    expect(t.get("slack:C1:2.0")).toBeUndefined();
    t.replace([]);
    expect(t.size).toBe(0);
  });
});
