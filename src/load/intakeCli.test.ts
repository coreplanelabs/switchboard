import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("intake A/B CLI", () => {
  it("reads the telemetry report without touching the ledger, Slack or a model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "intake-telemetry-cli-"));
    const shim = join(dir, "fetch.mjs");
    writeFileSync(
      shim,
      `globalThis.fetch = async (url, options) => {
      if (url !== "https://api.cloudflare.com/client/v4/accounts/account/analytics_engine/sql") throw new Error("unexpected endpoint");
      if (options.headers.authorization !== "Bearer test-only") throw new Error("missing authenticated query");
      if (!options.body.includes("blob1 = 'intake-1'") || !options.body.includes("blob2 = 'trial'") || !options.body.includes("blob8 NOT IN ('slack:C1:1.0')")) throw new Error("missing query filters");
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };`,
    );
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          shim,
          "scripts/load.ts",
          "intake",
          "--telemetry",
          "--account",
          "account",
          "--dataset",
          "runs",
          "--experiment",
          "trial",
          "--since",
          "2026-10-05T00:00:00Z",
          "--until",
          "2026-10-06T00:00:00Z",
          "--samples",
          "--exclude-threads",
          "slack:C1:1.0",
          "--token-env",
          "INTAKE_CLI_TEST_TOKEN",
        ],
        { cwd: process.cwd(), env: { PATH: process.env.PATH, INTAKE_CLI_TEST_TOKEN: "test-only" } },
      );
      expect(JSON.parse(stdout)).toMatchObject({
        source: "analytics-engine",
        experiment: "trial",
        dataset: "runs",
        arms: [],
        samples: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
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
