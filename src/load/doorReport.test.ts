import { describe, expect, it } from "vitest";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent } from "../core/runEvents.js";
import type { RunRecord } from "../core/runRecord.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore, type RunStore } from "../core/runStore.js";
import { createRunsService } from "../core/runsService.js";
import { doorReport, renderDoor } from "./doorReport.js";

// Feature: docs/reference/specs/load-harness.md item 19 (record 0044, the
// counts before anything is built): `npm run load -- door` reads the run
// store's command records and prints, per day and per command, the hand-backs
// the door recorded, the pastes that followed and the paste-through rate. It
// invokes nothing; the store's list and per-run events are its only inputs.

const DAY = 24 * 60 * 60 * 1000;
/** Two days a while back: the store keeps rows by age against the clock it is given. */
const DAY_ONE = Date.UTC(1999, 0, 3, 12);
const DAY_TWO = DAY_ONE + DAY;
const NOW = DAY_TWO + 6 * 60 * 60 * 1000;

type Route = Extract<RunEvent, { type: "route" }>;

/** A command run's `route` event as the door records it. */
function decision(command: string, over: Partial<Route> = {}): Route {
  return {
    type: "route",
    preset: "command",
    reason: `command ${command}`,
    model: "anthropic/m",
    command,
    input: { args: [], options: {} },
    receipt: command.replace(".", " "),
    seq: 3,
    ...over,
  };
}

function commandRecord(id: string, finishedAt: number, route?: Route, over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = [
    { type: "input", messageId: id, text: `request of ${id}`, seq: 1 },
    { type: "run_meta", agent: "command", seq: 2 },
    ...(route ? [route] : []),
    { type: "answer", text: `answer of ${id}`, seq: 4 },
  ];
  return {
    id,
    label: `config · #ops · someone · request of ${id}`,
    agent: "command",
    channelId: "slack:COPS",
    userId: "slack:USOMEONE",
    threadKey: `slack:COPS:${id}`,
    channelVisibility: "public",
    startedAt: finishedAt - 1_000,
    finishedAt,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
    ...over,
  };
}

async function serviceOver(records: readonly RunRecord[]) {
  const store = new InMemoryRunStore({ now: () => NOW });
  for (const r of records) await store.put(r);
  return createRunsService({ registry: new RunRegistry({ now: () => NOW }), store, clock: () => NOW });
}

/** Two days, three commands, one paste joined, one paste whose hand-back is
 *  outside the window, one routed read and one agent run to be left alone. */
const FIXTURE: RunRecord[] = [
  commandRecord("hb-1", DAY_ONE, decision("config.set", { outcome: "hand_back" })),
  commandRecord("hb-2", DAY_ONE + 60_000, decision("mcp.add", { outcome: "hand_back" })),
  // The paste lands the next day: it is counted under its hand-back's day and command.
  commandRecord(
    "p-1",
    DAY_TWO,
    decision("config.set", { reason: "pasted after hand-back", outcome: "pasted", handBackRunId: "hb-1" }),
  ),
  commandRecord("hb-3", DAY_TWO + 60_000, decision("repo.offboard", { outcome: "hand_back" })),
  commandRecord(
    "p-old",
    DAY_TWO + 120_000,
    decision("config.set", { reason: "pasted after hand-back", outcome: "pasted", handBackRunId: "hb-gone" }),
  ),
  // A routed read: a route with no outcome. Not a door decision about a state change.
  commandRecord("read-1", DAY_TWO + 180_000, decision("friction.report")),
  // A typed inline run with no route at all.
  commandRecord("typed-1", DAY_TWO + 240_000),
  // An agent run in the window: never a command run, so never read.
  commandRecord("agent-1", DAY_TWO + 300_000, undefined, { agent: "review", label: "review · #ops" }),
];

describe("doorReport — hand-backs, the pastes that followed and the rate, per day and per command", () => {
  it("counts a hand-back under its day and command, joins a paste to its hand-back by id (the hand-back's bucket, whatever day the paste landed), keeps a paste whose hand-back is outside the window apart, and ignores a routed read and a typed run", async () => {
    const report = await doorReport(await serviceOver(FIXTURE));
    expect(report).toEqual({
      handBacks: 3,
      pastes: 1,
      unmatchedPastes: 1,
      commandRuns: 7,
      storeUnavailable: false,
      rows: [
        { day: "1999-01-03", command: "config.set", handBacks: 1, pastes: 1 },
        { day: "1999-01-03", command: "mcp.add", handBacks: 1, pastes: 0 },
        { day: "1999-01-04", command: "repo.offboard", handBacks: 1, pastes: 0 },
      ],
    });
  });

  it("renders the totals with the rate, then each day with its commands — a rate over zero hand-backs prints as a dash, never a division error", async () => {
    const lines = renderDoor(await doorReport(await serviceOver(FIXTURE)));
    expect(lines).toEqual([
      "door: 3 hand-back(s), 1 paste(s) joined (33.3% pasted), 1 paste(s) whose hand-back is outside the window; 7 command run(s) read",
      "- 1999-01-03: hand-backs 2, pastes 1 (50%)",
      "  - config.set: hand-backs 1, pastes 1 (100%)",
      "  - mcp.add: hand-backs 1, pastes 0 (0%)",
      "- 1999-01-04: hand-backs 1, pastes 0 (0%)",
      "  - repo.offboard: hand-backs 1, pastes 0 (0%)",
    ]);
    const nothing = renderDoor(await doorReport(await serviceOver([])));
    expect(nothing).toEqual([
      "door: 0 hand-back(s), 0 paste(s) joined (— pasted), 0 paste(s) whose hand-back is outside the window; 0 command run(s) read",
    ]);
    expect(nothing.join("\n")).not.toMatch(/NaN|Infinity/);
  });

  it("`sinceMs` bounds the window: a hand-back before it is not read, so its later paste is the unmatched kind", async () => {
    const report = await doorReport(await serviceOver(FIXTURE), { sinceMs: DAY_TWO });
    expect(report.handBacks).toBe(1);
    expect(report.pastes).toBe(0);
    expect(report.unmatchedPastes).toBe(2);
    expect(report.rows).toEqual([{ day: "1999-01-04", command: "repo.offboard", handBacks: 1, pastes: 0 }]);
  });

  it("pages the store to its end with the list's own cursor, so a window larger than one page counts every run", async () => {
    const paged = await doorReport(await serviceOver(FIXTURE), { pageSize: 2 });
    const whole = await doorReport(await serviceOver(FIXTURE));
    expect(paged).toEqual(whole);
  });

  it("a store that cannot be reached is said so on the report, and the rows are what the live registry held", async () => {
    const registry = new RunRegistry({ now: () => NOW });
    const store = new InMemoryRunStore({ now: () => NOW });
    const broken: RunStore = {
      put: (record) => store.put(record),
      abandoned: () => {},
      get: (id) => store.get(id),
      getSummary: (id) => store.getSummary(id),
      list: async () => {
        throw new Error("store down");
      },
      events: (id, opts) => store.events(id, opts),
      delete: (id) => store.delete(id),
      usage: (query) => store.usage(query),
    };
    const service = createRunsService({ registry, store: broken, clock: () => NOW, warn: () => {} });
    const report = await doorReport(service);
    expect(report.storeUnavailable).toBe(true);
    expect(report.handBacks).toBe(0);
    expect(renderDoor(report).at(-1)).toBe(
      "the run store could not be read: the counts above are the live registry's alone",
    );
  });
});
