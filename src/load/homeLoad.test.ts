import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../packageRoot.js";
import { describe, expect, it } from "vitest";
import { homeAttentionInViewport, runHomeLoad } from "./homeLoad.js";

describe("canonical Home load", () => {
  it("enumerates one thousand owned units through real HTTP without losing cross-pipeline attention", async () => {
    const result = await runHomeLoad({ units: 1000, pipelines: 1000, iterations: 20, browser: false });
    expect(result.observations).toEqual({
      discoveredUnits: 1000,
      attentionUnits: 1000,
      pipelines: 1000,
      complete: true,
    });
    expect(result.samples.map((row) => [row.op, row.ok])).toEqual(
      Array.from({ length: 20 }, () => [
        ["first-attention", true],
        ["complete-list", true],
      ]).flat(),
    );
    expect(result.parameters.authorizedLiveFleetSizing).toBe("unverified");
    expect(result.parameters.source).toMatchObject({
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim(),
    });
    expect(result.parameters.source.diffSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.parameters.implementation).toBe("local canonical inventory/render");
    expect(result.parameters.privateSourceAuthentication).toBe("unmeasured");
  });
  it("refuses under-sized or insufficient measurements before starting a server", async () => {
    await expect(runHomeLoad({ units: 999, pipelines: 1, iterations: 20, browser: false })).rejects.toThrow(
      "at least 1000 units",
    );
    await expect(runHomeLoad({ units: 1000, pipelines: 1001, iterations: 20, browser: false })).rejects.toThrow(
      "1..units pipelines",
    );
    await expect(runHomeLoad({ units: 1000, pipelines: 1, iterations: 1, browser: false })).rejects.toThrow(
      "20 whole iterations",
    );
  });
  it("refuses a browser bundle outside the current checkout instead of qualifying unrelated assets", async () => {
    await expect(
      runHomeLoad({
        units: 1000,
        pipelines: 1000,
        iterations: 20,
        browser: true,
        distDir: join(PACKAGE_ROOT, "another-build/dist"),
      }),
    ).rejects.toThrow("Home browser proof requires this checkout's web/dist");
  });

  it("requires attention inside both the browser and scroll list without an overlay covering it", () => {
    const makeRow = (top: number, listTop: number, covered = false) => {
      const box = { top, bottom: top + 20, left: 10, right: 30 };
      const row = {
        isConnected: true,
        getBoundingClientRect: () => box,
        closest: () => ({
          getBoundingClientRect: () => ({ top: listTop, bottom: listTop + 100, left: 0, right: 100 }),
        }),
        contains: (element: unknown) => element === row,
        ownerDocument: {
          defaultView: { innerWidth: 100, innerHeight: 100 },
          elementFromPoint: () => (covered ? {} : row),
        },
      };
      return row as unknown as Element;
    };
    expect(homeAttentionInViewport(makeRow(10, 0))).toBe(true);
    expect(homeAttentionInViewport(makeRow(150, 0))).toBe(false);
    expect(homeAttentionInViewport(makeRow(10, 50))).toBe(false);
    expect(homeAttentionInViewport(makeRow(10, 0, true))).toBe(false);
  });
});
