import { expect, it, vi } from "vitest";
import { WorkerPrivateWorkerLog } from "./privateWorkerLogWorker.js";
import { originalStorageFailure } from "./storageFailureDiagnostic.js";

it("keeps malformed private reply acknowledgements on the original attributed request", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = new WorkerPrivateWorkerLog({
    baseUrl: "https://storage.invalid",
    token: "fixture",
    storeKey: "runs:fixture",
    fetch: async () => Response.json({ event: { malformed: "PRIVATE_RESPONSE" } }),
  });
  try {
    const error = await log
      .append("worker:fixture:task", { kind: "reply", text: "PRIVATE_REPLY", runId: "original", at: 1 })
      .catch((value) => value);
    expect(error).toMatchObject({ name: "Error", message: "private worker log append: invalid answer" });
    expect(originalStorageFailure(error)).toMatchObject({
      operation: "/runs/private-worker/append",
      phase: "response",
      httpStatus: 200,
    });
    const evidence = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(evidence).toMatchObject([
      { runIds: ["original"], context: { scope: "runs" }, targetCounts: { total: 1, emitted: 1, omitted: 0 } },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_");
  } finally {
    warn.mockRestore();
  }
});
