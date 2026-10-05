import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

describe("intake A/B CLI", () => {
  it("accepts the documented experiment and samples flags and reads only the ledger", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          receipts: [
            {
              verdict: "addressed",
              reason: "",
              source: "model",
              mode: "classify",
              model: "typesafe/jev-1.13.0",
              gen: 1,
              threadKey: "slack:C:1",
              decidedAt: 1791158400000,
              experiment: {
                id: "trial",
                messageKey: "C:2",
                arm: "jev",
                elapsedMs: 100,
                calls: 1,
                inputTokens: 100,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                knownCostUsd: 0.001,
                unpricedCalls: 0,
                missingUsageCalls: 0,
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server port");
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/load.ts",
          "intake",
          "--live",
          "--experiment",
          "trial",
          "--samples",
          "--since",
          "2026-10-05T00:00:00Z",
          "--state-url",
          `http://127.0.0.1:${address.port}`,
          "--token-env",
          "INTAKE_CLI_TEST_TOKEN",
        ],
        { cwd: process.cwd(), env: { PATH: process.env.PATH, INTAKE_CLI_TEST_TOKEN: "test-only" } },
      );
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({
        experiment: "trial",
        arms: [{ arm: "jev", events: 1 }],
        samples: [{ experiment: { messageKey: "C:2" } }],
      });
      expect(requests).toEqual(["/runs/intake/list"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 30_000);
});
