import { describe, expect, it } from "vitest";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { InMemoryCoordinatorInstanceStore, NullCoordinatorInstanceStore } from "./instanceStore.js";
import { handOffToCoordinator, type HandOffDeps, type HandOffInput } from "./handOff.js";
import type { CreateInstanceAnswer, InstanceStatusAnswer } from "./instancesRoute.js";

// Feature: docs/reference/specs/agent-ship.md item 16 — `ship.coordinator: true`
// hands an `agent:ship` request to the plan runner instead of the in-process
// round loop: the bot writes the instance record and one unit row per selected
// unit (a task string is a plan of one unit), asks its shim for the Workflow
// instance under the plan's id — or, when an earlier attempt's records are
// there, asks its status first: a live attempt refuses the request, a leftover
// is replaced, an ended attempt is resumed as the next under the attempt's id
// with the merged units skipped — and answers the thread with where the plan
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
    /** The shim's status of an earlier attempt's instance, by id; `absent` when unscripted. */
    status?: Record<string, InstanceStatusAnswer>;
    store?: HandOffDeps["instances"];
  } = {},
) {
  const files = over.files ?? { "docs/plans/fixture.md": PLAN };
  const instances = over.store ?? new InMemoryCoordinatorInstanceStore();
  const created: string[] = [];
  const statusAsked: string[] = [];
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
    status: async (id) => {
      statusAsked.push(id);
      return over.status?.[id] ?? { kind: "absent" };
    },
    log: () => {},
  };
  return { deps, instances, created, statusAsked, reads };
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

  it("the store decides first: a process without a durable instance store refuses by name and creates nothing; a record left by an earlier attempt whose create failed — the shim knows no such instance — is replaced with this request's record and rows under the same id, and the reply says so", async () => {
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
    const second = harness({ store: leftover, status: { "plan-fixture": { kind: "absent" } } });
    const retried = await handOffToCoordinator(
      second.deps,
      input({ runId: "run-s2", now: NOW + 1, requestText: "in acme/api: plan docs/plans/fixture.md units U10, U11" }),
    );
    expect(retried.status).toBe("completed");
    expect(retried.reply).toBe(
      "🧭 Handed to the plan runner `plan-fixture`: plan `fixture` (`docs/plans/fixture.md` at `main`), 2 units in dependency order — U10, U11. Each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread. The records of an earlier attempt that never started were replaced.",
    );
    expect(second.statusAsked).toEqual(["plan-fixture"]);
    expect(second.created).toEqual(["plan-fixture"]);
    expect(await leftover.get("plan-fixture")).toMatchObject({
      id: "plan-fixture",
      runId: "run-s2",
      createdAt: NOW + 1,
    });
    expect((await leftover.get("plan-fixture"))?.attempt).toBeUndefined();
    expect((await leftover.listUnits("plan-fixture")).map((u) => u.unit)).toEqual(["U10", "U11"]);
  });

  it("a live runner's records are never touched: a re-issue for a plan whose latest attempt still runs is refused naming the instance and its status, writes nothing and asks for no instance", async () => {
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
        ending: { kind: "merged", report: "✅ Merged", at: NOW + 9 },
      },
      {
        ...rows[1]!,
        threadKey: "slack:C1:3.0",
        rounds: [{ index: 0, agent: "coding", outcome: "started", at: NOW + 10 }],
      },
      rows[2]!,
    ];
    await live.putUnits(inFlight);
    for (const status of ["running", "waiting", "queued", "paused", "waitingForPause"]) {
      const again = harness({ store: live, status: { "plan-fixture": { kind: "status", status } } });
      const refused = await handOffToCoordinator(
        again.deps,
        input({ runId: "run-s2", now: NOW + 20, msg: { ...input().msg, threadKey: "slack:C1:9.0" } }),
      );
      expect(refused.status, status).toBe("aborted");
      expect(refused.reply, status).toBe(
        `🚫 A runner for plan \`fixture\` is still running (\`plan-fixture\`, status: ${status}): wait for it to end — or terminate it in the Workflows dashboard — before re-issuing.`,
      );
      expect(again.created).toEqual([]);
    }
    expect(await live.listUnits("plan-fixture")).toEqual(inFlight);
    expect((await live.get("plan-fixture"))?.runId).toBe("run-s");
    // A state the bot does not read as ended, and a shim that could not say: refused by reason, nothing written.
    const odd = harness({ store: live, status: { "plan-fixture": { kind: "status", status: "unknown" } } });
    expect((await handOffToCoordinator(odd.deps, input({ runId: "run-s3" }))).reply).toContain(
      "a state the bot does not read as ended (unknown)",
    );
    const mute = harness({
      store: live,
      status: { "plan-fixture": { kind: "unanswered", reason: "the shim could not be reached: ECONNREFUSED" } },
    });
    expect((await handOffToCoordinator(mute.deps, input({ runId: "run-s4" }))).reply).toBe(
      "⚠️ The plan runner could not tell whether `plan-fixture` still runs: the shim could not be reached: ECONNREFUSED. Nothing ran; re-issue the request to try again.",
    );
    expect(odd.created).toEqual([]);
    expect(mute.created).toEqual([]);
    expect((await live.get("plan-fixture"))?.runId).toBe("run-s");
  });

  it("a plan whose latest attempt ended is resumed as the next attempt: the units the earlier attempts merged are skipped, the rest run under `plan-<plan-id>-<n>` with the attempt on the record, a dependency on a merged unit stays on the row and counts as done, the reply names what is left and what was merged; a third re-issue finds the latest attempt; every named unit merged is a refusal", async () => {
    /** A store holding attempt 1's records, ended: U10 merged, U11's merge refused, U12 capped. */
    async function afterFirstAttempt() {
      const store = new InMemoryCoordinatorInstanceStore();
      expect((await handOffToCoordinator(harness({ store }).deps, input())).status).toBe("completed");
      const rows = await store.listUnits("plan-fixture");
      await store.putUnits([
        { ...rows[0]!, ending: { kind: "merged", report: "✅ Merged", at: NOW + 9 } },
        { ...rows[1]!, ending: { kind: "merge_refused", report: "⚠️ conflict", at: NOW + 19 } },
        { ...rows[2]!, ending: { kind: "aborted", report: "⚠️ cap", at: NOW + 29 } },
      ]);
      return store;
    }
    for (const ended of ["complete", "errored", "terminated"]) {
      const store = await afterFirstAttempt();
      const resume = harness({ store, status: { "plan-fixture": { kind: "status", status: ended } } });
      const out = await handOffToCoordinator(resume.deps, input({ runId: "run-s2", now: NOW + 100 }));
      expect(out.status, ended).toBe("completed");
      expect(out.reply, ended).toBe(
        "🧭 Handed to the plan runner `plan-fixture-2`: attempt 2 of plan `fixture` (`docs/plans/fixture.md` at `main`), 2 units left in dependency order — U11, U12; merged before: U10. Each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread.",
      );
      expect(resume.statusAsked).toEqual(["plan-fixture"]);
      expect(resume.created).toEqual(["plan-fixture-2"]);
      expect(await store.get("plan-fixture-2")).toMatchObject({
        id: "plan-fixture-2",
        attempt: 2,
        runId: "run-s2",
        plan: { id: "fixture", path: "docs/plans/fixture.md" },
        branch: "plan/fixture/u11-retire-the-alarm",
      });
      expect((await store.listUnits("plan-fixture-2")).map((u) => [u.unit, u.dependsOn])).toEqual([
        ["U11", ["U10"]],
        ["U12", []],
      ]);
      // The first attempt's records stand untouched.
      expect((await store.get("plan-fixture"))?.runId).toBe("run-s");
      expect((await store.listUnits("plan-fixture")).map((u) => u.ending?.kind)).toEqual([
        "merged",
        "merge_refused",
        "aborted",
      ]);
    }
    // A third re-issue: attempt 2 ended with U11 merged and U12 capped → attempt 3 runs U12 alone.
    const store = await afterFirstAttempt();
    await handOffToCoordinator(
      harness({ store, status: { "plan-fixture": { kind: "status", status: "complete" } } }).deps,
      input({ runId: "run-s2", now: NOW + 100 }),
    );
    const second = await store.listUnits("plan-fixture-2");
    await store.putUnits([
      { ...second[0]!, ending: { kind: "merged", report: "✅ Merged", at: NOW + 200 } },
      { ...second[1]!, ending: { kind: "aborted", report: "⚠️ cap", at: NOW + 210 } },
    ]);
    const third = harness({ store, status: { "plan-fixture-2": { kind: "status", status: "complete" } } });
    const out = await handOffToCoordinator(third.deps, input({ runId: "run-s3", now: NOW + 300 }));
    expect(out.status).toBe("completed");
    expect(third.statusAsked).toEqual(["plan-fixture-2"]);
    expect(third.created).toEqual(["plan-fixture-3"]);
    expect(out.reply).toContain("attempt 3 of plan `fixture`");
    expect(out.reply).toContain("1 unit left in dependency order — U12; merged before: U10, U11");
    expect((await store.get("plan-fixture-3"))?.attempt).toBe(3);
    // Every unit the request names merged already: nothing to run, nothing written.
    const done = harness({ store, status: { "plan-fixture-3": { kind: "status", status: "complete" } } });
    const nothing = await handOffToCoordinator(
      done.deps,
      input({ runId: "run-s4", requestText: "in acme/api: plan docs/plans/fixture.md units U10, U11" }),
    );
    expect(nothing.status).toBe("aborted");
    expect(nothing.reply).toBe(
      "🚫 Every unit of plan `fixture` this request names is merged already (U10, U11) — nothing left to run.",
    );
    expect(done.created).toEqual([]);
    expect(await store.get("plan-fixture-4")).toBeNull();
  });

  it("a leftover at a later attempt — a resume whose create failed — is replaced under the same attempt id with the units the earlier attempts merged skipped, never rerun; every named unit merged already is a refusal there too", async () => {
    // Attempt 1 ended with U10 merged; the resume to attempt 2 wrote its records but its create failed.
    const store = new InMemoryCoordinatorInstanceStore();
    expect((await handOffToCoordinator(harness({ store }).deps, input())).status).toBe("completed");
    const rows = await store.listUnits("plan-fixture");
    await store.putUnits([
      { ...rows[0]!, ending: { kind: "merged", report: "✅ Merged", at: NOW + 9 } },
      { ...rows[1]!, ending: { kind: "aborted", report: "⚠️ cap", at: NOW + 19 } },
      { ...rows[2]!, ending: { kind: "aborted", report: "⚠️ cap", at: NOW + 29 } },
    ]);
    const failedResume = harness({
      store,
      status: { "plan-fixture": { kind: "status", status: "complete" } },
      create: { kind: "failed", id: "plan-fixture-2", reason: "engine down" },
    });
    expect((await handOffToCoordinator(failedResume.deps, input({ runId: "run-s2", now: NOW + 100 }))).status).toBe(
      "aborted",
    );
    expect((await store.get("plan-fixture-2"))?.attempt).toBe(2);
    // The re-issue: attempt 2's record is there and the shim knows no such instance → replaced, U10 still skipped.
    const again = harness({ store, status: { "plan-fixture-2": { kind: "absent" } } });
    const out = await handOffToCoordinator(again.deps, input({ runId: "run-s3", now: NOW + 200 }));
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner `plan-fixture-2`: attempt 2 of plan `fixture` (`docs/plans/fixture.md` at `main`), 2 units left in dependency order — U11, U12; merged before: U10. Each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread. The records of an earlier attempt that never started were replaced.",
    );
    expect(again.statusAsked).toEqual(["plan-fixture-2"]);
    expect(again.created).toEqual(["plan-fixture-2"]);
    expect(await store.get("plan-fixture-2")).toMatchObject({ id: "plan-fixture-2", attempt: 2, runId: "run-s3" });
    expect((await store.listUnits("plan-fixture-2")).map((u) => u.unit)).toEqual(["U11", "U12"]);
    // Named units all merged before: refused, and the leftover left as it was.
    const nothing = await handOffToCoordinator(
      harness({ store, status: { "plan-fixture-2": { kind: "absent" } } }).deps,
      input({ runId: "run-s4", requestText: "in acme/api: plan docs/plans/fixture.md units U10" }),
    );
    expect(nothing.status).toBe("aborted");
    expect(nothing.reply).toBe(
      "🚫 Every unit of plan `fixture` this request names is merged already (U10) — nothing left to run.",
    );
    expect((await store.get("plan-fixture-2"))?.runId).toBe("run-s3");
  });

  it("the shim's other answers: a duplicate instance the state Worker knew nothing of is a refusal a person decides; an unanswered shim and a create that threw are refusals by reason", async () => {
    const dup = harness({ create: { kind: "duplicate", id: "plan-fixture", status: "complete" } });
    const out = await handOffToCoordinator(dup.deps, input());
    expect(out.status).toBe("aborted");
    expect(out.reply).toBe(
      "🚫 A Workflow instance `plan-fixture` already exists on the platform, status: complete but the state Worker knew nothing of it — a person decides; re-issuing will not resume it.",
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
