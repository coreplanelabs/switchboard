import { describe, expect, it } from "vitest";
import { NullResidentAdminClient, type ResidentAdminResponse } from "./residentAdmin.js";
import { recordingSink } from "./testing/recordingSink.js";
import type { Span } from "./trace/types.js";
import { FLEET_REFRESH_MS, NO_FLEET, residentFleetWatcherFor, watchResidentFleet } from "./residentFleet.js";

// Feature: docs/reference/specs/routing-and-config.md item 11 — the resident cap the About
// block names comes from the resident Worker's own listing, read in the
// background, never a constant in the bot.

function admin(answers: Array<ResidentAdminResponse | Error>) {
  let calls = 0;
  return {
    calls: () => calls,
    residents: async () => {
      calls++;
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("watchResidentFleet", () => {
  it("is unknown until the first listing answers, then the Worker's cap; a later listing updates it", async () => {
    const a = admin([
      { status: 200, data: { cap: 6, count: 2, residents: [] } },
      { status: 200, data: { cap: 8, count: 2, residents: [] } },
    ]);
    const fleet = watchResidentFleet(a, { warn: () => {} });
    expect(fleet.cap()).toBeUndefined();
    await fleet.refresh();
    expect(fleet.cap()).toBe(6);
    await fleet.refresh();
    expect(fleet.cap()).toBe(8);
  });

  it("a non-200 answer, a throw, or a listing without a numeric cap leaves the last value and warns — never a crash on the run path", async () => {
    const warnings: string[] = [];
    const a = admin([
      { status: 200, data: { cap: 6 } },
      { status: 503, data: { error: "down" } },
      new Error("fetch failed"),
      { status: 200, data: { cap: "six" } },
    ]);
    const fleet = watchResidentFleet(a, { warn: (m) => warnings.push(m) });
    await fleet.refresh();
    await fleet.refresh();
    await fleet.refresh();
    await fleet.refresh();
    expect(fleet.cap()).toBe(6);
    expect(warnings).toEqual([
      "[residents] fleet facts not refreshed: /residents answered 503",
      "[residents] fleet facts not refreshed: fetch failed",
    ]);
  });

  it("start() reads at once and then on the interval (unref'd); stop() clears it", async () => {
    const a = admin([
      { status: 200, data: { cap: 6 } },
      { status: 200, data: { cap: 7 } },
    ]);
    let tick: (() => void) | undefined;
    let unrefed = false;
    let cleared = false;
    const fleet = watchResidentFleet(a, {
      warn: () => {},
      refreshMs: 1234,
      setInterval: (fn, ms) => {
        expect(ms).toBe(1234);
        tick = fn;
        return { unref: () => void (unrefed = true) };
      },
      clearInterval: () => void (cleared = true),
    });
    fleet.start();
    await new Promise((r) => setImmediate(r));
    expect(fleet.cap()).toBe(6);
    expect(unrefed).toBe(true);
    tick!();
    await new Promise((r) => setImmediate(r));
    expect(fleet.cap()).toBe(7);
    fleet.stop();
    expect(cleared).toBe(true);
    expect(FLEET_REFRESH_MS).toBe(5 * 60_000);
  });

  it("NO_FLEET knows nothing", () => {
    expect(NO_FLEET.cap()).toBeUndefined();
  });
});

// Review finding on the wiring: with a resident Worker named but its admin
// bearer unset, `capabilities.residents` is true while the admin plane is the
// Null Object — a watcher on it would warn every five minutes and never learn
// a cap. The decision lives here, once, for both entry points.
describe("residentFleetWatcherFor — only an admin plane that can answer is watched", () => {
  it("a real client gets a watcher; the reason there is none, or the null client itself, gets no watcher at all", async () => {
    const a = admin([{ status: 200, data: { cap: 6 } }]);
    const watcher = residentFleetWatcherFor(a, { warn: () => {} });
    expect(watcher).toBeDefined();
    await watcher!.refresh();
    expect(watcher!.cap()).toBe(6);
    expect(a.calls()).toBe(1);

    const warnings: string[] = [];
    expect(
      residentFleetWatcherFor({ unavailable: "RESIDENT_ADMIN_TOKEN is not set" }, { warn: (m) => warnings.push(m) }),
    ).toBeUndefined();
    expect(
      residentFleetWatcherFor(new NullResidentAdminClient("no fleet"), { warn: (m) => warnings.push(m) }),
    ).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("watchResidentFleet — the read is traced (docs/reference/specs/tracing.md item 20)", () => {
  it("a refresh runs under a resident.fleet_refresh root handed to the client's withSpan, with the listing's status and count; a failed read ends the root error", async () => {
    const sink = recordingSink();
    const bound: string[] = [];
    let answer: ResidentAdminResponse | Error = { status: 200, data: { cap: 6, count: 2, residents: [] } };
    const client = {
      residents: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
      withSpan(span: Span) {
        bound.push(span.name);
        return client;
      },
    };
    const fleet = watchResidentFleet(client, { warn: () => {}, trace: { sinks: [sink] } });
    await fleet.refresh();
    expect(bound).toEqual(["resident.fleet_refresh"]);
    const ok = sink.ended("resident.fleet_refresh");
    expect(ok?.parentSpanId).toBeUndefined();
    expect(ok?.status).toBe("ok");
    expect(ok?.attrs).toMatchObject({ httpStatus: 200, residents: 2 });
    expect(fleet.cap()).toBe(6);

    answer = new Error("resident Worker unreachable");
    await fleet.refresh();
    const failed = sink.ends.filter((e) => e.name === "resident.fleet_refresh")[1];
    expect(failed?.status).toBe("error");
    expect(fleet.cap()).toBe(6);
  });

  it("without trace deps the read is untraced and the client is used unbound", async () => {
    const bound: string[] = [];
    const client = {
      residents: async () => ({ status: 200, data: { cap: 3, count: 0, residents: [] } }),
      withSpan(span: Span) {
        bound.push(span.name);
        return client;
      },
    };
    const fleet = watchResidentFleet(client, { warn: () => {} });
    await fleet.refresh();
    expect(bound).toEqual([]);
    expect(fleet.cap()).toBe(3);
  });
});
