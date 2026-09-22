import { describe, expect, it } from "vitest";
import type { Caller } from "../commandRegistry.js";
import { CommandError } from "../commandRegistry.js";
import type { CostsByReport } from "../costsBy.js";
import { COSTS_OFF_MESSAGE, NoCostsSnapshotError, NullCostsService, type CostsService } from "../costsService.js";
import { costsBy, costsSnapshot, takerLabel } from "./costs.js";

// `costs snapshot` (docs/reference/specs/costs.md item 6): the on-demand take — who
// it is credited to, what it answers, and how a take that could not happen is
// told apart from cost reporting that is off. `costs by` (items 10–10a): the
// dimension report on every surface, its text renderings, and its refusals.

/** A calendar day as the stamps spell it (YYYY-MM-DD, UTC). */
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const SEP_14 = iso(2026, 9, 14);
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
    byReport: (g, d, dim, v) => base.byReport(g, d, dim, v),
    status: () => base.status(),
    snapshot: (by) => base.snapshot(by),
    subscribe: () => base.subscribe(),
    ...over,
  };
};

describe("costs.snapshot", () => {
  it("credits the take to the linked person's name, else the name the caller's adapter resolved, else the caller's id", () => {
    expect(takerLabel(caller({ asUser: { id: "slack:UCASEY", name: "casey" } }))).toBe("casey");
    expect(takerLabel({ ...caller(), name: "Casey Q" })).toBe("Casey Q");
    expect(takerLabel({ ...caller({ asUser: { id: "slack:UCASEY", name: "casey" } }), name: "Casey Q" })).toBe("casey");
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

// Feature: docs/reference/specs/costs.md items 10–10a — `costs by <dimension>`.
describe("costs.by", () => {
  const byUser: CostsByReport = {
    group: "switchboard",
    dimension: "user",
    range: { from: SEP_14, to: SEP_16, days: 3, partialLastDay: true },
    coverage: { from: SEP_14, retentionDays: 30, clamped: false, historyOn: true },
    rows: [
      {
        key: "slack:UALICE",
        label: "alice",
        runs: 7,
        turns: 40,
        wallMs: 3_600_000,
        llmUsd: 12.25,
        cloudUsd: 1.5,
        totalUsd: 13.75,
        unpricedTokens: 0,
        byModel: {},
      },
      {
        key: "http:ops",
        runs: 2,
        turns: 3,
        wallMs: 1_200_000,
        llmUsd: 3.5,
        cloudUsd: 0.5,
        totalUsd: 4,
        unpricedTokens: 1200,
        byModel: {},
      },
    ],
    days: [],
    pending: 3,
    cloudAllocated: true,
    reconciliation: {
      attributedLlmUsd: 15.75,
      workspaceLlmUsd: 19.5,
      unattributedLlmUsd: 3.75,
      comparedDays: 3,
      uncomparedDays: 0,
      uncomparedLlmUsd: 0,
      cloudAllocatedUsd: 2,
      cloudUnallocatedUsd: 1.4,
    },
    viewer: { userIds: [], matchedByEmail: false },
    generatedAt: Date.parse(`${SEP_16}T06:15:00.000Z`),
    snapshot: { takenAt: `${SEP_16}T06:15:00.000Z`, takenBy: "schedule", durationMs: 31_000 },
  };
  const byModel: CostsByReport = {
    ...byUser,
    dimension: "model",
    cloudAllocated: false,
    rows: [
      {
        key: "anthropic/claude-fable-5-1",
        runs: 6,
        turns: 40,
        wallMs: 0,
        llmUsd: 15.75,
        cloudUsd: 0,
        totalUsd: 15.75,
        unpricedTokens: 0,
        byModel: {},
      },
    ],
    viewer: undefined,
  };
  const asked: Array<{ group: string; days: string | null; dimension: string; viewer: unknown }> = [];
  const deps = (report: CostsByReport, groups = ["switchboard", "other"]) => ({
    costs: {
      service: async () =>
        service({
          groups: () => groups,
          byReport: async (group, days, dimension, viewer) => {
            asked.push({ group, days, dimension, viewer });
            return { ...report, dimension };
          },
        }),
    },
  });

  it("asks the service for the dimension over the first group and the default range, or the named group and --days; an Access caller is the viewer, a chat caller is not", async () => {
    asked.length = 0;
    const out = await costsBy.handler({
      args: { dimension: "user" },
      options: {},
      caller: caller(),
      deps: deps(byUser),
    } as never);
    expect((out as unknown as CostsByReport).rows.map((r) => r.key)).toEqual(["slack:UALICE", "http:ops"]);
    const access: Caller = { kind: "access", id: "access:s1", email: "alice@example.com", actor: caller().actor };
    await costsBy.handler({
      args: { dimension: "agent" },
      options: { days: 7, group: "other" },
      caller: access,
      deps: deps(byUser),
    } as never);
    expect(asked).toEqual([
      { group: "switchboard", days: null, dimension: "user", viewer: undefined },
      { group: "other", days: "7", dimension: "agent", viewer: { sub: "access:s1", email: "alice@example.com" } },
    ]);
  });

  it("renders the report for the terminal — a header naming the dimension, group, range and snapshot; one aligned line per row largest first with runs, LLM, cloud, total and share; the coverage and the tie-out — and for chat as bullets", async () => {
    const out = await costsBy.handler({
      args: { dimension: "user" },
      options: {},
      caller: caller(),
      deps: deps(byUser),
    } as never);
    const text = costsBy.render!(out);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`costs by user · switchboard · ${SEP_14} → ${SEP_16} (3d) · snapshot ${SEP_16} 06:15 UTC`);
    expect(lines[1]).toMatch(/^user\s+runs\s+LLM\s+cloud\s+total share$/);
    expect(lines[2]).toMatch(/^alice \(slack:UALICE\)\s+7\s+\$12\.25\s+\$1\.50\s+\$13\.75\s+77%$/);
    expect(lines[3]).toMatch(/^http:ops\s+2\s+\$3\.50\s+\$0\.50\s+\$4\.00\s+23% · unpriced tokens$/);
    expect(lines[4]).toBe(`runs from ${SEP_14} · 3 run(s) still being priced`);
    expect(lines[5]).toBe(
      "LLM attributed $15.75 of $19.50 on the workspace over 3 day(s) · $3.75 unattributed · cloud allocated $2.00 · $1.40 on days with no runs",
    );
    const chat = costsBy.renderChat!(out).split("\n");
    expect(chat[1]).toBe("• alice (slack:UALICE) — 7 runs · LLM $12.25 · cloud $1.50 · total $13.75 (77%)");
    expect(chat[2]).toBe("• http:ops — 2 runs · LLM $3.50 · cloud $0.50 · total $4.00 (23%) · unpriced tokens");
    expect(chat).toHaveLength(5); // no column header line in chat
  });

  it("renders the model dimension with turns and no cloud column, and an empty range as such", async () => {
    const out = await costsBy.handler({
      args: { dimension: "model" },
      options: {},
      caller: caller(),
      deps: deps(byModel),
    } as never);
    const lines = costsBy.render!(out).split("\n");
    expect(lines[1]).toMatch(/^model\s+turns\s+LLM\s+total share$/);
    expect(lines[2]).toMatch(/^anthropic\/claude-fable-5-1\s+40\s+\$15\.75\s+\$15\.75\s+100%$/);
    expect(lines[4]).toBe("LLM attributed $15.75 of $19.50 on the workspace over 3 day(s) · $3.75 unattributed");
    const empty = await costsBy.handler({
      args: { dimension: "thread" },
      options: {},
      caller: caller(),
      deps: deps({
        ...byUser,
        rows: [],
        pending: 0,
        reconciliation: { ...byUser.reconciliation, comparedDays: 0, cloudAllocatedUsd: 0, cloudUnallocatedUsd: 0 },
      }),
    } as never);
    const text = costsBy.render!(empty);
    expect(text).toContain("(no runs in this range)");
    expect(text).toContain("no day in range has a workspace LLM figure to compare against · cloud allocated $0.00");
  });

  it("cost reporting off is `unavailable`; an unknown group is `not_found`; before the first snapshot it is `busy` (retry), any other failure `unavailable` with the reason", async () => {
    const off = { costs: { service: async () => new NullCostsService() } };
    await expect(
      costsBy.handler({ args: { dimension: "user" }, options: {}, caller: caller(), deps: off } as never),
    ).rejects.toMatchObject({ code: "unavailable", message: COSTS_OFF_MESSAGE });
    await expect(
      costsBy.handler({
        args: { dimension: "user" },
        options: { group: "nope" },
        caller: caller(),
        deps: deps(byUser),
      } as never),
    ).rejects.toMatchObject({ code: "not_found", message: "no cost group named nope" });
    const notYet = {
      costs: {
        service: async () =>
          service({
            groups: () => ["switchboard"],
            byReport: async () => {
              throw new NoCostsSnapshotError();
            },
          }),
      },
    };
    await expect(
      costsBy.handler({ args: { dimension: "user" }, options: {}, caller: caller(), deps: notYet } as never),
    ).rejects.toMatchObject({ code: "busy", message: expect.stringContaining("no cost snapshot yet") });
    const broken = {
      costs: {
        service: async () =>
          service({
            groups: () => ["switchboard"],
            byReport: async () => {
              throw new Error("state Worker unreachable");
            },
          }),
      },
    };
    await expect(
      costsBy.handler({ args: { dimension: "user" }, options: {}, caller: caller(), deps: broken } as never),
    ).rejects.toMatchObject({ code: "unavailable", message: "cost report unavailable: state Worker unreachable" });
  });
});
