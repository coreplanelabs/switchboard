import { describe, expect, it } from "vitest";
import type { Caller } from "../commandRegistry.js";
import { CommandError } from "../commandRegistry.js";
import { COSTS_OFF_MESSAGE, NullCostsService, type CostsService } from "../costsService.js";
import { costsSnapshot, takerLabel } from "./costs.js";

// `costs snapshot` (docs/reference/specs/costs.md item 6): the on-demand take — who
// it is credited to, what it answers, and how a take that could not happen is
// told apart from cost reporting that is off.

/** A calendar day as the stamps spell it (YYYY-MM-DD, UTC). */
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const SEP_16 = iso(2026, 9, 16);
const SEP_17 = iso(2026, 9, 17);

const caller = (over: Partial<Caller["actor"]> = {}): Caller =>
  ({
    kind: "chat",
    id: "slack:UCASEY",
    actor: { kind: "user", id: "slack:UCASEY", grants: { actions: "all", channels: "all", repos: "all" }, ...over },
  }) as Caller;

/** The Null Object's answers, with the named ones replaced (class methods do not spread). */
const service = (over: Partial<CostsService>): CostsService => {
  const base = new NullCostsService();
  return {
    groups: () => base.groups(),
    report: (g, d) => base.report(g, d),
    usersReport: (g, d, v) => base.usersReport(g, d, v),
    status: () => base.status(),
    snapshot: (by) => base.snapshot(by),
    subscribe: () => base.subscribe(),
    ...over,
  };
};

describe("costs.snapshot", () => {
  it("credits the take to the linked person's name, else the caller's id", () => {
    expect(takerLabel(caller({ asUser: { id: "slack:UCASEY", name: "casey" } }))).toBe("casey");
    expect(takerLabel(caller())).toBe("slack:UCASEY");
  });

  it("answers the stamp of the take and when the next scheduled one falls", async () => {
    const stamp = { takenAt: `${SEP_16}T06:15:00.000Z`, takenBy: "casey", durationMs: 4_200 };
    const taken: string[] = [];
    const deps = {
      costs: {
        service: async () =>
          service({
            snapshot: async (by) => {
              taken.push(by);
              return stamp;
            },
            status: () => ({
              snapshot: stamp,
              inFlight: null,
              everyHours: 24,
              nextAt: `${SEP_17}T06:15:00.000Z`,
              lastFailure: null,
            }),
          }),
      },
    };
    const out = await costsSnapshot.handler({
      args: [],
      options: {},
      caller: caller({ asUser: { id: "slack:UCASEY", name: "casey" } }),
      deps,
    } as never);
    expect(out).toEqual({ ...stamp, nextAt: `${SEP_17}T06:15:00.000Z` });
    expect(taken).toEqual(["casey"]);
    expect(costsSnapshot.render?.(out)).toBe(
      `Costs snapshot taken ${SEP_16} 06:15 UTC by casey in 4.2 s · next scheduled ${SEP_17} 06:15 UTC`,
    );
  });

  it("cost reporting off is `unavailable` with the reason; a take that failed is `busy` — the previous snapshot still serves, the caller may retry", async () => {
    const off = { costs: { service: async () => new NullCostsService() } };
    await expect(
      costsSnapshot.handler({ args: [], options: {}, caller: caller(), deps: off } as never),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: COSTS_OFF_MESSAGE,
    });
    const failing = {
      costs: {
        service: async () =>
          service({
            snapshot: async () => {
              throw new Error("cloudflare graphql 502");
            },
          }),
      },
    };
    const err = await costsSnapshot
      .handler({ args: [], options: {}, caller: caller(), deps: failing } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ code: "busy" });
    expect(String((err as Error).message)).toContain("costs snapshot not taken: cloudflare graphql 502");
  });
});
