import { describe, expect, it } from "vitest";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { InMemoryCoordinatorInstanceStore, NullCoordinatorInstanceStore } from "./instanceStore.js";
import { handOffToCoordinator, type HandOffDeps, type HandOffInput } from "./handOff.js";
import type { CreateInstanceAnswer } from "./instancesRoute.js";

// Feature: docs/reference/specs/agent-ship.md item 16 — `ship.coordinator: true`
// hands an `agent:ship` request to the plan runner instead of the in-process
// round loop: the bot writes the instance record and one unit row per selected
// unit (a task string is a plan of one unit), asks its shim for the Workflow
// instance under the plan's id, and answers the thread with where the plan
// runs. Every refusal is a reply, never a throw, and nothing is created on one.

const NOW = 1_700_000_000_000;
const PLAN = [
  "# Fixture - Plan",
  "",
  "### U10. Warm the cache on wake",
  "",
  "- **Dependencies**: none.",
  "",
  "### U11. Retire the alarm",
  "",
  "- **Dependencies**: U10.",
  "",
  "### U12. Trim the log",
  "",
  "- **Dependencies**: none.",
  "",
].join("\n");

function input(over: Partial<HandOffInput> = {}): HandOffInput {
  return {
    entry: { repo: "acme/api", branch: "ship/warm-the-cache-abc123", base: "main" },
    requestText: "in acme/api: plan docs/plans/fixture.md",
    msg: {
      channelId: "slack:C1",
      channelName: "general",
      userId: "slack:UALICE",
      userName: "alice",
      threadKey: "slack:C1:1.0",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
    },
    runId: "run-s",
    label: "*ship* · acme/api",
    caps: { maxRounds: 3, maxMinutes: 45 },
    card: { channel: "C1", ts: "1.5" },
    now: NOW,
    ...over,
  };
}

function harness(
  over: {
    files?: Record<string, string>;
    create?: CreateInstanceAnswer | Error;
    store?: HandOffDeps["instances"];
  } = {},
) {
  const files = over.files ?? { "docs/plans/fixture.md": PLAN };
  const instances = over.store ?? new InMemoryCoordinatorInstanceStore();
  const created: string[] = [];
  const reads: Array<[string, string, string]> = [];
  const deps: HandOffDeps = {
    readFile: async (repo, path, ref) => {
      reads.push([repo, path, ref]);
      const content = files[path];
      if (content === undefined) throw new Error(`HTTP 404 Not Found: ${path}`);
      return { content };
    },
    instances,
    create: async (id) => {
      created.push(id);
      const answer = over.create ?? { kind: "created", id };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    log: () => {},
  };
  return { deps, instances, created, reads };
}

describe("handOffToCoordinator — the ship request as a plan runner instance (item 16)", () => {
  it("a plan request: the plan is read at the base ref, the instance is written under the plan's id with the requester, thread, card, caps and run id, one row per unit in the plan's order, the Workflow instance is created, and the reply says where the plan runs", async () => {
    const h = harness();
    const out = await handOffToCoordinator(h.deps, input());
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner `plan-fixture`: plan `fixture` (`docs/plans/fixture.md` at `main`), 3 units in dependency order — U10, U11, U12. Each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread.",
    );
    expect(h.reads).toEqual([["acme/api", "docs/plans/fixture.md", "main"]]);
    expect(h.created).toEqual(["plan-fixture"]);
    const instance = await h.instances.get("plan-fixture");
    expect(instance).toEqual({
      id: "plan-fixture",
      kind: "ship",
      userId: "slack:UALICE",
      userName: "alice",
      channelId: "slack:C1",
      channelName: "general",
      threadKey: "slack:C1:1.0",
      sourceUrl: "https://acme.slack.com/archives/C1/p1",
      repo: "acme/api",
      branch: "plan/fixture/u10-warm-the-cache-on-wake",
      base: "main",
      createdAt: NOW,
      plan: { id: "fixture", path: "docs/plans/fixture.md" },
      caps: { maxRounds: 3, maxMinutes: 45 },
      card: { channel: "C1", ts: "1.5" },
      runId: "run-s",
      label: "*ship* · acme/api",
    } satisfies CoordinatorInstance);
    const rows = await h.instances.listUnits("plan-fixture");
    expect(rows).toEqual([
      {
        instanceId: "plan-fixture",
        unit: "U10",
        slug: "u10-warm-the-cache-on-wake",
        title: "Warm the cache on wake",
        branch: "plan/fixture/u10-warm-the-cache-on-wake",
        dependsOn: [],
        rounds: [],
      },
      {
        instanceId: "plan-fixture",
        unit: "U11",
        slug: "u11-retire-the-alarm",
        title: "Retire the alarm",
        branch: "plan/fixture/u11-retire-the-alarm",
        dependsOn: ["U10"],
        rounds: [],
      },
      {
        instanceId: "plan-fixture",
        unit: "U12",
        slug: "u12-trim-the-log",
        title: "Trim the log",
        branch: "plan/fixture/u12-trim-the-log",
        dependsOn: [],
        rounds: [],
      },
    ] satisfies CoordinatorUnit[]);
  });

  it("a selection narrows the rows to the named units in the plan's order, a dependency outside it kept on the row as the plan states it; a unit the plan lacks is a refusal naming it and nothing is written or created", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: "in acme/api: plan docs/plans/fixture.md units U12, U11" }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toContain("2 units in dependency order — U11, U12");
    expect((await h.instances.listUnits("plan-fixture")).map((u) => [u.unit, u.dependsOn])).toEqual([
      ["U11", ["U10"]],
      ["U12", []],
    ]);
    const missing = harness();
    const refused = await handOffToCoordinator(
      missing.deps,
      input({ requestText: "in acme/api: plan docs/plans/fixture.md units U99" }),
    );
    expect(refused.status).toBe("aborted");
    expect(refused.reply).toContain("🚫");
    expect(refused.reply).toContain("U99");
    expect(missing.created).toEqual([]);
    expect(await missing.instances.get("plan-fixture")).toBeNull();
  });

  it("a task request is a plan of one unit, `task`, on the entry's ship branch in the requesting thread, under an instance named by the run", async () => {
    const h = harness();
    const out = await handOffToCoordinator(h.deps, input({ requestText: "in acme/api: warm the cache on wake" }));
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner `ship-run-s`: the task runs on `ship/warm-the-cache-abc123` in this thread under your grants; this card follows it and the report lands here.",
    );
    expect(h.reads).toEqual([]);
    expect(h.created).toEqual(["ship-run-s"]);
    expect(await h.instances.get("ship-run-s")).toMatchObject({
      id: "ship-run-s",
      branch: "ship/warm-the-cache-abc123",
      base: "main",
      runId: "run-s",
    });
    expect("plan" in (await h.instances.get("ship-run-s"))!).toBe(false);
    expect(await h.instances.listUnits("ship-run-s")).toEqual([
      {
        instanceId: "ship-run-s",
        unit: "task",
        slug: "task",
        branch: "ship/warm-the-cache-abc123",
        dependsOn: [],
        rounds: [],
      },
    ]);
  });

  it("refusals before anything is written: a plan file the repository does not have at the base, a plan whose name is not a plan id, no base branch, a plan without units; each names the reason and creates nothing", async () => {
    const cases: Array<[Partial<HandOffInput>, RegExp]> = [
      [
        { requestText: "in acme/api: plan docs/plans/missing.md" },
        /🚫 The plan `docs\/plans\/missing\.md` could not be read at `main` in acme\/api: HTTP 404/,
      ],
      [{ requestText: "in acme/api: plan docs/plans/Bad_Name.md" }, /🚫 .*plan id/i],
      [{ entry: { repo: "acme/api", branch: "ship/x", base: undefined } }, /🚫 .*no base branch/],
      [{ requestText: "in acme/api: plan docs/plans/empty.md" }, /🚫 .*no unit/i],
    ];
    for (const [over, expected] of cases) {
      const h = harness({
        files: { "docs/plans/fixture.md": PLAN, "docs/plans/empty.md": "# Empty - Plan\n\nNothing here.\n" },
      });
      const out = await handOffToCoordinator(h.deps, input(over));
      expect(out.status, JSON.stringify(over)).toBe("aborted");
      expect(out.reply, JSON.stringify(over)).toMatch(expected);
      expect(h.created, JSON.stringify(over)).toEqual([]);
      expect(await h.instances.listUnits("plan-fixture")).toEqual([]);
    }
  });

  it("the store decides first: a process without a durable instance store refuses by name and creates nothing; a record already there from an earlier attempt whose create failed does not block — its rows are not rewritten, the shim's answer decides, and the reply says the earlier records stand", async () => {
    const noStore = harness({ store: new NullCoordinatorInstanceStore() });
    const out = await handOffToCoordinator(noStore.deps, input());
    expect(out.status).toBe("aborted");
    expect(out.reply).toContain("⚠️ The plan runner needs run history on the state Worker");
    expect(noStore.created).toEqual([]);
    const leftover = new InMemoryCoordinatorInstanceStore();
    const first = await handOffToCoordinator(
      harness({ store: leftover, create: { kind: "failed", id: "plan-fixture", reason: "engine down" } }).deps,
      input(),
    );
    expect(first.status).toBe("aborted");
    expect(first.reply).toBe(
      "⚠️ The plan runner could not be started: engine down. Nothing ran; re-issue the request to try again.",
    );
    const before = { instance: await leftover.get("plan-fixture"), units: await leftover.listUnits("plan-fixture") };
    const second = harness({ store: leftover });
    const retried = await handOffToCoordinator(second.deps, input({ runId: "run-s2", now: NOW + 1 }));
    expect(retried.status).toBe("completed");
    expect(retried.reply).toContain("The records of an earlier attempt stand");
    expect(second.created).toEqual(["plan-fixture"]);
    expect(await leftover.get("plan-fixture")).toEqual(before.instance);
    expect(await leftover.listUnits("plan-fixture")).toEqual(before.units);
  });

  it("a live runner's rows are never touched: a second hand-off for a plan whose instance exists writes no row before the shim answers, and the duplicate refusal leaves every thread, round, pull request and ending as they were", async () => {
    const live = new InMemoryCoordinatorInstanceStore();
    const started = await handOffToCoordinator(harness({ store: live }).deps, input());
    expect(started.status).toBe("completed");
    // The runner has been at work: threads, rounds, a pull request and an ending on the rows.
    const rows = await live.listUnits("plan-fixture");
    const inFlight: CoordinatorUnit[] = [
      {
        ...rows[0]!,
        threadKey: "slack:C1:2.0",
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
        rounds: [{ index: 0, agent: "coding", outcome: "pr_opened", at: NOW + 5 }],
        ending: { kind: "merge_ready", report: "✅ Merge-ready", at: NOW + 9 },
      },
      {
        ...rows[1]!,
        threadKey: "slack:C1:3.0",
        rounds: [{ index: 0, agent: "coding", outcome: "started", at: NOW + 10 }],
      },
      rows[2]!,
    ];
    await live.putUnits(inFlight);
    const again = harness({ store: live, create: { kind: "duplicate", id: "plan-fixture", status: "running" } });
    const refused = await handOffToCoordinator(
      again.deps,
      input({ runId: "run-s2", now: NOW + 20, msg: { ...input().msg, threadKey: "slack:C1:9.0" } }),
    );
    expect(refused.status).toBe("aborted");
    expect(refused.reply).toContain("already exists (`plan-fixture`, status: running)");
    expect(again.created).toEqual(["plan-fixture"]);
    expect(await live.listUnits("plan-fixture")).toEqual(inFlight);
    expect((await live.get("plan-fixture"))?.runId).toBe("run-s");
  });

  it("the shim's other answers: a duplicate instance is a refusal naming the plan, the instance and its status — a plan runs once under its id; an unanswered shim and a create that threw are refusals by reason", async () => {
    const dup = harness({ create: { kind: "duplicate", id: "plan-fixture", status: "complete" } });
    const out = await handOffToCoordinator(dup.deps, input());
    expect(out.status).toBe("aborted");
    expect(out.reply).toBe(
      "🚫 A runner for plan `fixture` already exists (`plan-fixture`, status: complete): a plan runs once under its id — rename the plan file to run it again.",
    );
    const silent = harness({
      create: { kind: "unanswered", reason: "PUBLIC_BASE_URL is not set — the bot cannot address its own shim" },
    });
    expect((await handOffToCoordinator(silent.deps, input())).reply).toBe(
      "⚠️ The plan runner could not be started: PUBLIC_BASE_URL is not set — the bot cannot address its own shim. Nothing ran; re-issue the request to try again.",
    );
    const threw = harness({ create: new Error("boom") });
    expect((await handOffToCoordinator(threw.deps, input())).reply).toContain("could not be started: boom");
  });
});
