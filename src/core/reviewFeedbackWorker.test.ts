import { describe, expect, it } from "vitest";
import { WorkerReviewFeedbackStore } from "./reviewFeedbackWorker.js";

const publication = {
  runId: "a",
  repo: "acme/api",
  pr: 7,
  head: "a".repeat(40),
  bodyHash: "b".repeat(64),
  format: 1,
  findings: 0,
  publishedAt: 1000,
};
describe("durable feedback client", () => {
  it("reads every page and keeps the original bearer and store binding", async () => {
    const bodies: unknown[] = [],
      headers: unknown[] = [];
    const store = new WorkerReviewFeedbackStore({
      baseUrl: "https://state.test",
      token: "test",
      storeKey: "runs:main",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        headers.push(init?.headers);
        return Response.json(
          bodies.length === 1
            ? { entries: [{ publication }], nextCursor: "a" }
            : { entries: [{ publication: { ...publication, runId: "b" } }] },
        );
      },
    });
    expect((await store.list(0, 2000)).entries.map((r) => r.publication.runId)).toEqual(["a", "b"]);
    expect(bodies).toEqual([
      { storeKey: "runs:main", sinceMs: 0, untilMs: 2000 },
      { storeKey: "runs:main", sinceMs: 0, untilMs: 2000, after: "a" },
    ]);
    expect(headers).toEqual(Array(2).fill({ authorization: "Bearer test", "content-type": "application/json" }));
  });
  it("refuses incomplete, malformed and looping responses instead of reporting empty feedback", async () => {
    for (const result of [
      { entries: [{}] },
      { entries: [{ publication }], nextCursor: "wrong" },
      { entries: [{ publication }], nextCursor: "a" },
    ]) {
      const store = new WorkerReviewFeedbackStore({
        baseUrl: "https://state.test",
        token: "test",
        storeKey: "runs:main",
        fetch: async () => Response.json(result),
      });
      await expect(store.list(0, 2000)).rejects.toThrow(/Invalid review feedback/);
    }
  });
});
