import { seedCoordinatorUnit } from "../testing/coordinatorInstance.js";
import { describe, expect, it } from "vitest";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { InMemoryCoordinatorInstanceStore, NullCoordinatorInstanceStore } from "./instanceStore.js";
import { handOffToCoordinator, type HandOffDeps, type HandOffInput } from "./handOff.js";
import { generatedTaskOf } from "./generatedTask.js";
import { contractFor } from "./briefs.js";
import type { CreateInstanceAnswer, InstanceStatusAnswer } from "./instancesRoute.js";
import { MAX_FILE_CHARS } from "../../execution/githubApi.js";
import { PLAN_MAX_CHARS } from "../ship/contract.js";
import { generatedPlanId } from "../ship/coordinator.js";
import { DecisionRecordAllocator } from "../decisionRecordReservation.js";
import { InMemoryPrivateWorkerLog, UnavailablePrivateWorkerLog } from "../privateWorkerLog.js";

// Feature: docs/reference/specs/agent-ship.md item 16 — every `agent:ship`
// request the preflight admitted is handed to the plan runner: the bot writes
// the instance record and one unit row per selected unit (a task string is a
// plan of one unit; a resume at review is that unit with the pull request on
// its row), asks its shim for the Workflow
// instance under the plan's id — or, when an earlier attempt's records are
// there, asks its status first: a live attempt refuses the request, a leftover
// is replaced, an ended attempt is resumed as the next under the attempt's id
// with the merged units skipped — and answers the thread with where the plan
// runs. Every refusal is a reply, never a throw, and nothing is created on one.

const NOW = 1_700_000_000_000;
const MAIN_AUTHORITY = {
  requesterId: "slack:UALICE",
  sourceMessageId: "1",
  revision: 1,
  repo: "acme/api",
};
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
    ...(over.mainTask ? { privateWorkerReady: true, stillPrivate: async () => true } : {}),
    ...over,
    ...(over.mainTask ? { mainTask: { ...over.mainTask, authority: over.mainTask.authority ?? MAIN_AUTHORITY } } : {}),
  };
}

function harness(
  over: {
    files?: Record<string, string>;
    create?: CreateInstanceAnswer | Error | ((id: string) => CreateInstanceAnswer | Error);
    /** The shim's status of an earlier attempt's instance, by id; `absent` when unscripted. */
    status?: Record<string, InstanceStatusAnswer>;
    store?: HandOffDeps["instances"];
    privateWorkerLog?: HandOffDeps["privateWorkerLog"];
  } = {},
) {
  const files = over.files ?? { "docs/plans/fixture.md": PLAN };
  const instances = over.store ?? new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
  void instances.recordRequesterTurn({
    threadKey: "slack:C1:1.0",
    requesterId: "slack:UALICE",
    messageId: "1",
  });
  const created: string[] = [];
  const statusAsked: string[] = [];
  const reads: Array<[string, string, string]> = [];
  const deps: HandOffDeps = {
    // The App's read as `GithubApi.readFile` answers it: clipped at the caller's
    // bound (the tool clip when none is given), `truncated` saying so.
    readFile: async (repo, path, ref, opts) => {
      reads.push([repo, path, ref]);
      const content = files[path];
      if (content === undefined) throw new Error(`HTTP 404 Not Found: ${path}`);
      const maxChars = opts?.maxChars ?? MAX_FILE_CHARS;
      return content.length > maxChars ? { content: content.slice(0, maxChars), truncated: true } : { content };
    },
    instances,
    privateWorkerLog: over.privateWorkerLog ?? new InMemoryPrivateWorkerLog(),
    create: async (id) => {
      created.push(id);
      const answer = typeof over.create === "function" ? over.create(id) : (over.create ?? { kind: "created", id });
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

const EMPTY_EVIDENCE = {
  schemaVersion: 1,
  cause: { kind: "unknown", reason: "Not investigated" },
  evidence: { availability: "unavailable", reason: "Code-only task" },
  requirements: { analysis: "not_required", evidence: "may_be_unavailable" },
  acceptance: "Regression test passes",
} as const;

describe("main-agent work hand-off", () => {
  it("proves the durable private log before claiming a main task or starting a Workflow", async () => {
    const h = harness({ privateWorkerLog: new UnavailablePrivateWorkerLog() });
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main" },
        requestText: "fix failed signups",
        mainTask: {
          mainThreadKey: "slack:C1:1.0",
          actId: "act-private",
          brief: {
            ...EMPTY_EVIDENCE,
            question: "How many signups failed?",
            findings: [],
            requestedChange: "Fix the failure",
          },
        },
        privateWorkerReady: true,
        stillLive: () => true,
        stillPrivate: async () => true,
      }),
    );
    expect(out).toMatchObject({ status: "aborted", refusal: { code: "setup_failed" } });
    expect(out.reply).toContain("could not be verified");
    expect(h.created).toEqual([]);
    expect(await h.instances.getMainTask({ mainThreadKey: "slack:C1:1.0", actId: "act-private" })).toBeNull();
  });

  it("rechecks the private log before retrying a saved main task", async () => {
    const h = harness({ create: new Error("Workflow unavailable") });
    const request = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix failed signups",
      mainTask: {
        mainThreadKey: "slack:C1:1.0",
        actId: "act-private",
        brief: {
          ...EMPTY_EVIDENCE,
          question: "How many signups failed?",
          findings: [],
          requestedChange: "Fix the failure",
        },
      },
      privateWorkerReady: true,
      stillLive: () => true,
      stillPrivate: async () => true,
    });
    const first = await handOffToCoordinator(h.deps, request);
    expect(first).toMatchObject({ status: "pending", instanceId: expect.any(String) });
    expect(h.created).toHaveLength(1);
    expect(await h.instances.getMainTask({ mainThreadKey: "slack:C1:1.0", actId: "act-private" })).not.toBeNull();

    h.deps.privateWorkerLog = new UnavailablePrivateWorkerLog();
    const second = await handOffToCoordinator(h.deps, request);
    expect(second).toMatchObject({ status: "aborted", refusal: { code: "setup_failed" } });
    expect(second.reply).toContain("could not be verified");
    expect(h.created).toHaveLength(1);
  });

  it("does not create a claimed but absent Workflow after a newer requester turn", async () => {
    const h = harness({ create: new Error("Workflow unavailable") });
    const request = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix signup",
      mainTask: {
        mainThreadKey: "slack:C1:1.0",
        actId: "act-private",
        brief: { ...EMPTY_EVIDENCE, question: "Why?", findings: [], requestedChange: "Fix signup" },
      },
      stillLive: () => true,
    });
    expect((await handOffToCoordinator(h.deps, request)).status).toBe("pending");
    expect(h.created).toHaveLength(1);
    await h.instances.recordRequesterTurn({
      threadKey: "slack:C1:1.0",
      requesterId: "slack:UALICE",
      messageId: "2",
    });
    const retried = await handOffToCoordinator(h.deps, request);
    expect(retried.status).toBe("aborted");
    expect(retried.reply).toContain("newer request");
    expect(h.created).toHaveLength(1);
  });

  it("does not create a newly claimed Workflow when the requester changes during final privacy checks", async () => {
    const h = harness();
    let checks = 0;
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main" },
        requestText: "fix signup",
        mainTask: {
          mainThreadKey: "slack:C1:1.0",
          actId: "act-private",
          brief: { ...EMPTY_EVIDENCE, question: "Why?", findings: [], requestedChange: "Fix signup" },
        },
        stillLive: () => true,
        stillPrivate: async () => {
          if (++checks === 4)
            await h.instances.recordRequesterTurn({
              threadKey: "slack:C1:1.0",
              requesterId: "slack:UALICE",
              messageId: "2",
            });
          return true;
        },
      }),
    );
    expect(checks).toBe(4);
    expect(out.status).toBe("aborted");
    expect(out.reply).toContain("newer request");
    expect(h.created).toEqual([]);
  });

  it("does not retry a saved Workflow when the requester changes during final privacy checks", async () => {
    const h = harness({ create: new Error("Workflow unavailable") });
    const request = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix signup",
      mainTask: {
        mainThreadKey: "slack:C1:1.0",
        actId: "act-private",
        brief: { ...EMPTY_EVIDENCE, question: "Why?", findings: [], requestedChange: "Fix signup" },
      },
      stillLive: () => true,
    });
    expect((await handOffToCoordinator(h.deps, request)).status).toBe("pending");
    expect(h.created).toHaveLength(1);
    let checks = 0;
    const retried = await handOffToCoordinator(h.deps, {
      ...request,
      stillPrivate: async () => {
        if (++checks === 2)
          await h.instances.recordRequesterTurn({
            threadKey: "slack:C1:1.0",
            requesterId: "slack:UALICE",
            messageId: "2",
          });
        return true;
      },
    });
    expect(checks).toBe(3);
    expect(retried.status).toBe("aborted");
    expect(retried.reply).toContain("newer request");
    expect(h.created).toHaveLength(1);
  });

  it("describes a private worker without promising a requester-thread unit or card", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main" },
        requestText: "fix failed signups",
        mainTask: {
          mainThreadKey: "slack:C1:1.0",
          actId: "act-private",
          brief: {
            ...EMPTY_EVIDENCE,
            question: "How many signups failed?",
            findings: [],
            requestedChange: "Fix the failure",
          },
        },
        privateWorkerReady: true,
        stillLive: () => true,
        stillPrivate: async () => true,
      }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toContain("private work log");
    expect(out.reply).not.toContain("in this thread");
    expect(out.reply).not.toContain("this card follows");
    expect(h.created).toHaveLength(1);
  });

  it("holds a main task before any claim or Workflow until private worker routing exists", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main" },
        requestText: "fix failed signups",
        mainTask: {
          mainThreadKey: "slack:C1:1.0",
          actId: "act-private",
          brief: {
            ...EMPTY_EVIDENCE,
            question: "How many signups failed?",
            findings: [],
            requestedChange: "Fix the failure",
          },
        },
        privateWorkerReady: false,
      }),
    );
    expect(out).toMatchObject({ status: "aborted", refusal: { code: "setup_failed" } });
    expect(out.reply).toContain("private worker");
    expect(h.created).toEqual([]);
    expect(h.reads).toEqual([]);
    expect(await h.instances.getMainTask({ mainThreadKey: "slack:C1:1.0", actId: "act-private" })).toBeNull();
  });

  it("requires a live main-run fence even when private worker routing exists", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main" },
        requestText: "fix failed signups",
        mainTask: {
          mainThreadKey: "slack:C1:1.0",
          actId: "act-private",
          brief: {
            ...EMPTY_EVIDENCE,
            question: "How many signups failed?",
            findings: [],
            requestedChange: "Fix the failure",
          },
        },
        privateWorkerReady: true,
        stillPrivate: async () => true,
      }),
    );
    expect(out).toMatchObject({ status: "aborted", refusal: { code: "setup_failed" } });
    expect(h.created).toEqual([]);
    expect(await h.instances.getMainTask({ mainThreadKey: "slack:C1:1.0", actId: "act-private" })).toBeNull();
  });

  it("refuses a caller-selected branch for a fresh main task", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main", branch: "attacker/chosen" },
        requestText: "fix failed signups",
        mainTask: {
          mainThreadKey: "slack:C1:1.0",
          actId: "act-private",
          brief: {
            ...EMPTY_EVIDENCE,
            question: "How many signups failed?",
            findings: [],
            requestedChange: "Fix the failure",
          },
        },
        privateWorkerReady: true,
        stillLive: () => true,
        stillPrivate: async () => true,
      }),
    );
    expect(out).toMatchObject({ status: "aborted", refusal: { code: "setup_failed" } });
    expect(h.created).toEqual([]);
    expect(await h.instances.getMainTask({ mainThreadKey: "slack:C1:1.0", actId: "act-private" })).toBeNull();
  });
});

describe("handOffToCoordinator — the ship request as a plan runner instance (item 16)", () => {
  it("a typed work entry keeps a URL as the generated task instead of stripping it from a probe", async () => {
    const h = harness();
    const url = "https://github.com/acme/api/pull/7";
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: url, intent: "work", entry: { repo: "acme/api", base: "main" } }),
    );
    expect(out.status).toBe("completed");
    const row = (await h.instances.listUnits(h.created[0]!))[0]!;
    expect(row.title).toBe(url);
  });

  it("a typed work entry keeps the whole authored task without a Ship prefix parser", async () => {
    const h = harness();
    const text = "in acme/api: fix the failing check at https://github.com/acme/api/pull/7";
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: text, intent: "work", entry: { repo: "acme/api", base: "main" } }),
    );
    expect(out.status).toBe("completed");
    const row = (await h.instances.listUnits(h.created[0]!))[0]!;
    expect(row.title).toBe(text);
  });

  it("a typed work entry that spells a seeded plan remains a person-merged generated task", async () => {
    const h = harness();
    // Dispatch has already consumed the typed agent prefix, leaving the
    // plan-shaped words. The operator may still have bound them as work.
    const text = "plan docs/plans/fixture.md";
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: text, intent: "work", agentSource: "directive", entry: { repo: "acme/api", base: "main" } }),
    );
    expect(out.status).toBe("completed");
    expect(h.reads).toEqual([]);
    const id = h.created[0]!;
    expect(await h.instances.get(id)).toMatchObject({ merge: "person", plan: { id: expect.any(String) } });
    expect((await h.instances.listUnits(id))[0]!.title).toBe(text);
  });

  it("a typed plan entry needs the validated plan flag before it can read a seeded plan", async () => {
    const h = harness();
    const requestText = "plan docs/plans/fixture.md";
    const refused = await handOffToCoordinator(
      h.deps,
      input({ requestText, intent: "plan", agentSource: "directive", entry: { repo: "acme/api", base: "main" } }),
    );
    expect(refused).toMatchObject({ status: "aborted", refusal: { code: "setup_failed" } });
    expect(h.reads).toEqual([]);
    expect(h.created).toEqual([]);

    const accepted = await handOffToCoordinator(
      h.deps,
      input({
        requestText,
        intent: "plan",
        agentSource: "directive",
        entry: { repo: "acme/api", base: "main", plan: true },
      }),
    );
    expect(accepted.status).toBe("completed");
    expect(h.reads).toEqual([["acme/api", "docs/plans/fixture.md", "main"]]);
    expect(await h.instances.get(h.created[0]!)).toMatchObject({
      merge: "runner",
      plan: { path: "docs/plans/fixture.md" },
    });
  });

  it("refuses a terse inherited target when its durable source turns cannot be read again", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: "Fix it.", entry: { repo: "acme/api", base: "main" }, requiresThreadEvidence: true }),
    );
    expect(out).toMatchObject({ status: "aborted", refusal: { code: "plan_history_unavailable" } });
    expect(h.created).toEqual([]);
  });

  it("persists the prior requester question, issue and reconciliation on the one generated unit without changing the task identity", async () => {
    const h = harness();
    const evidence =
      "Requester: Why did monitoring fail?\nRequester: Investigate https://github.com/acme/api/issues/3814\nEarlier answer (recheck): Three failures; suspected timeout.";
    const result = await handOffToCoordinator(
      h.deps,
      input({ requestText: "Fix it.", entry: { repo: "acme/api", base: "main" }, threadEvidence: evidence }),
    );
    expect(result.status).toBe("completed");
    const row = (await h.instances.listUnits(h.created[0]!))[0]!;
    expect(row.threadEvidence).toBe(evidence);
    expect(row.title).toBe("Fix it.");
  });

  it("a refused initial Workflow create retains its exact unconfirmed admission", async () => {
    const h = harness({ create: { kind: "failed", id: "plan-fixture", reason: "workflow unavailable" } });
    const out = await handOffToCoordinator(h.deps, input());
    expect(out).toMatchObject({ status: "aborted", refusal: { code: "plan_start_failed" } });
    expect(h.created).toEqual(["plan-fixture"]);
    expect(await h.instances.get("plan-fixture")).toMatchObject({ admission: "unreconciled" });
  });

  it("initial Workflow admission keeps its identity and owner when the reply is lost", async () => {
    const h = harness({
      create: { kind: "unanswered", reason: "reply lost" },
      status: { "plan-fixture": { kind: "unanswered", reason: "status unavailable" } },
    });
    const out = await handOffToCoordinator(h.deps, input());
    expect(out).toMatchObject({ status: "pending", instanceId: "plan-fixture" });
    expect(out.reply).not.toContain("nothing ran");
    expect(h.created).toEqual(["plan-fixture"]);
    expect(h.statusAsked).toEqual(["plan-fixture"]);
    expect(await h.instances.get("plan-fixture")).toMatchObject({ admission: "unreconciled" });
    expect(await h.instances.listUnits("plan-fixture")).toMatchObject([
      { instanceId: "plan-fixture", unit: "U10" },
      { unit: "U11" },
      { unit: "U12" },
    ]);
  });

  it("a lost reply with visible same-id Workflow status stays pending until its create is attributable", async () => {
    const h = harness({
      create: new Error("reply lost"),
      status: { "plan-fixture": { kind: "status", status: "running" } },
    });
    const out = await handOffToCoordinator(h.deps, input());
    expect(out).toMatchObject({ status: "pending", instanceId: "plan-fixture" });
    expect(out.reply).toContain("reports running");
    expect((await h.instances.get("plan-fixture"))?.admission).toBe("unreconciled");
    expect(h.created).toEqual(["plan-fixture"]);
    expect(h.statusAsked).toEqual(["plan-fixture"]);
  });

  it("an answer naming another Workflow retains the pending owner instead of claiming this one started", async () => {
    const h = harness({ create: { kind: "created", id: "plan-other" } });
    const out = await handOffToCoordinator(h.deps, input());
    expect(out).toMatchObject({ status: "pending", instanceId: "plan-fixture" });
    expect(out.reply).not.toContain("Handed to the plan runner");
    expect(await h.instances.get("plan-fixture")).toMatchObject({ admission: "unreconciled" });
    expect(await h.instances.get("plan-other")).toBeNull();
  });

  it("a plan request: the plan is read at the base ref, the instance is written under the plan's id with the requester, thread, card, caps and run id, one row per unit in the plan's order, the Workflow instance is created, and the reply says where the plan runs", async () => {
    const h = harness();
    const out = await handOffToCoordinator(h.deps, input());
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner.\n• plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 3 units in dependency order: U10, U11, U12\n" +
        "• each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread",
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
      admission: "created",
      plan: { id: "fixture", path: "docs/plans/fixture.md" },
      merge: "runner",
      addressSeverity: "minor",
      addressSeveritySource: "org",
      grant: { renewals: 0 },
      grantSource: "org",
      verbosity: "quiet",
      // Absent on the input: zero days — nothing idles (record 0051).
      idleDays: 0,
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
    expect(out.reply).toContain("• 2 units in dependency order: U11, U12");
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

  it("a seeded plan selecting exactly one unit takes the task path's wording: the reply says the unit runs on its branch in this thread and the report lands here — never a thread per unit or a summary here (agent-ship item 16)", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: "in acme/api: plan docs/plans/fixture.md units U12" }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner.\n• plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 1 unit in dependency order: U12\n" +
        "• the unit runs on `plan/fixture/u12-trim-the-log` in this thread under your grants; this card follows the plan and its report lands here",
    );
    expect((await h.instances.listUnits("plan-fixture")).map((u) => u.unit)).toEqual(["U12"]);
  });

  it("a task request is a generated plan of one unit: the instance under `plan-<slug>-<hash>` carries `plan: { id }` with no `path` and `merge: person`, its one `U1` row is on `plan/<id>/u1`, and the reply says the unit runs in this thread — a task whose text contains the word runner included", async () => {
    const h = harness();
    const id = `plan-${generatedPlanId("warm the cache on wake", "slack:C1:1.0")}`;
    const out = await handOffToCoordinator(
      h.deps,
      input({ entry: { repo: "acme/api", base: "main" }, requestText: "in acme/api: warm the cache on wake" }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toBe(
      "🧭 Handed to the plan runner.\n• plan `warm-the-cache-on-wake-dfa06c`\n• the unit runs on `plan/warm-the-cache-on-wake-dfa06c/u1` in this thread under your grants; this card follows it and the report lands here",
    );
    expect(h.reads).toEqual([]);
    expect(h.created).toEqual([id]);
    const instance = (await h.instances.get(id))!;
    expect(instance).toMatchObject({
      id,
      branch: "plan/warm-the-cache-on-wake-dfa06c/u1",
      base: "main",
      runId: "run-s",
      merge: "person",
      plan: { id: "warm-the-cache-on-wake-dfa06c" },
    });
    expect("path" in instance.plan!).toBe(false);
    expect(await h.instances.listUnits(id)).toEqual([
      {
        instanceId: id,
        unit: "U1",
        slug: "u1",
        title: "warm the cache on wake",
        branch: "plan/warm-the-cache-on-wake-dfa06c/u1",
        dependsOn: [],
        generatedTask: generatedTaskOf("warm the cache on wake", {
          requesterId: "slack:UALICE",
          threadKey: "slack:C1:1.0",
          runId: "run-s",
          repo: "acme/api",
          sourceUrl: "https://acme.slack.com/archives/C1/p1",
        }),
        rounds: [],
      },
    ]);
    const stored = (await h.instances.listUnits(id))[0]!;
    const afterRestart = await contractFor(instance, stored, {
      readRepoFile: async () => undefined,
      readRunFacts: async () => undefined,
    });
    expect(afterRestart.unit.section).toContain("warm the cache on wake");
    // The field comes from the request's kind, never its words: "runner" in the text stays a person's merge.
    const wordy = harness();
    await handOffToCoordinator(
      wordy.deps,
      input({ entry: { repo: "acme/api", base: "main" }, requestText: "in acme/api: make the runner warm the cache" }),
    );
    expect(await wordy.instances.get("plan-make-the-runner-warm-the-eaaa45")).toMatchObject({ merge: "person" });
    expect(await h.instances.listEvents({ instanceId: id, unit: ["U", "1"].join("") })).toEqual([]);
  });

  it("refuses a generated task with no words to checkpoint before any unit or workflow exists", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({ entry: { repo: "acme/api", base: "main" }, requestText: "" }),
    );
    expect(out.status).toBe("aborted");
    expect(out.reply).toContain("no task to checkpoint");
    expect(h.created).toEqual([]);
  });

  it("two record-writing tasks admitted together carry consecutive reservations on their unit rows, and re-issuing the same task keeps its number", async () => {
    const allocator = new DecisionRecordAllocator(async () => new Set(["0074"]));
    const reserve = allocator.reserve.bind(allocator);
    const effect = harness();
    const provider = harness();
    effect.deps.reserveDecisionRecord = reserve;
    provider.deps.reserveDecisionRecord = reserve;
    const effectText =
      "in acme/api: Write the technical decision record (next free number in docs/decisions/, the repo's record shape) for one typed side-effect seam.";
    const providerText =
      "in acme/api: Write the technical decision record (next free number in docs/decisions/, the repo's record shape) for one provider-failure cause.";

    const [a, b] = await Promise.all([
      handOffToCoordinator(effect.deps, input({ entry: { repo: "acme/api", base: "main" }, requestText: effectText })),
      handOffToCoordinator(
        provider.deps,
        input({ entry: { repo: "acme/api", base: "main" }, requestText: providerText }),
      ),
    ]);
    expect((await effect.instances.listUnits(a.instanceId!))[0]?.record).toBe("0075");
    expect((await provider.instances.listUnits(b.instanceId!))[0]?.record).toBe("0076");

    const again = harness({
      store: effect.instances,
      status: { [a.instanceId!]: { kind: "status", status: "complete" } },
    });
    again.deps.reserveDecisionRecord = reserve;
    const reissued = await handOffToCoordinator(
      again.deps,
      input({ entry: { repo: "acme/api", base: "main" }, requestText: effectText }),
    );
    expect((await effect.instances.listUnits(reissued.instanceId!))[0]?.record).toBe("0075");
  });

  it("an unavailable durable decision-record store refuses admission without issuing a number or writing a unit", async () => {
    const h = harness();
    const allocator = new DecisionRecordAllocator(
      async () => new Set(["0074"]),
      async () => undefined,
    );
    h.deps.reserveDecisionRecord = allocator.reserve.bind(allocator);

    const task = "Document this choice in a decision record.";
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main" },
        requestText: `in acme/api: ${task}`,
      }),
    );

    expect(out).toMatchObject({
      status: "aborted",
      refusal: { cause: "system", code: "decision_record_store_unavailable" },
    });
    expect(out.reply).toContain("durable coordinator store");
    expect(h.created).toEqual([]);
    expect(await h.instances.listUnits(`plan-${generatedPlanId(task, "slack:C1:1.0")}`)).toEqual([]);
  });

  it("a generated task persists its accepted inline media as one retry-stable seed event after the unit row and before the Workflow starts; an over-cap seed says what was dropped", async () => {
    const h = harness();
    let creates = 0;
    let instanceId = "";
    const unit = ["U", "1"].join("");
    h.deps.create = async (id) => {
      instanceId = id;
      expect(await h.instances.listUnits(id)).toHaveLength(1);
      expect(await h.instances.listEvents({ instanceId: id, unit })).toHaveLength(1);
      return creates++ === 0 ? { kind: "failed", id, reason: "engine warming" } : { kind: "created", id };
    };
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText:
        "in acme/api: match the screenshot\n\n(Note: 1 attachment(s) could not be passed through: archive.zip — unsupported type)",
    });
    const shot = { mediaType: "image/png", data: "aGk=", name: "brief.png" };
    const oversized = { mediaType: "application/pdf", data: "x".repeat(500 * 1024), name: "huge.pdf" };
    (req.msg as typeof req.msg & { images: (typeof shot)[]; documents: (typeof oversized)[] }).images = [shot];
    (req.msg as typeof req.msg & { images: (typeof shot)[]; documents: (typeof oversized)[] }).documents = [oversized];

    const first = await handOffToCoordinator(h.deps, req);
    expect(first.status).toBe("aborted");
    expect(instanceId).not.toBe("");
    const key = { instanceId, unit };
    expect(await h.instances.listEvents(key)).toEqual([
      {
        seq: 1,
        id: `${instanceId}:${unit}:ship-request`,
        sender: "slack:UALICE",
        senderName: "alice",
        text: "Attachments from the ship request.",
        attachmentsDropped: 2,
        mode: "steer",
        at: NOW,
      },
    ]);
    const retry = await handOffToCoordinator(h.deps, req);
    expect(retry.status).toBe("completed");
    expect(await h.instances.listEvents(key)).toHaveLength(1);
  });

  it("a base the preflight fell back from (issue 1827) is named on the reply's FIRST plan line — the missing ref and the default branch the plan runs on", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main", baseFallback: { requested: "web/src/pages/runPage.test.ts" } },
        requestText: "in acme/api: warm the cache on wake",
      }),
    );
    expect(out.status).toBe("completed");
    const [headline, first] = out.reply.split("\n");
    expect(headline).toBe("\ud83e\udded Handed to the plan runner.");
    expect(first).toBe(
      "\u2022 plan `warm-the-cache-on-wake-dfa06c` \u2014 `web/src/pages/runPage.test.ts` is not a branch of the repository, so the plan runs on the default branch `main`",
    );
  });

  it("a task's urls reach the unit: a Slack `<url|label>` link is unwrapped to its bare url and kept in the unit's title and id text, the `in <repo>:` prefix alone is dropped — the entry probe's stripped text is never the unit", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", base: "main" },
        requestText: "in acme/api: point the redirect at <https://calendar.acme.test/TrrMBAg7|calendar.acme.test/…>",
      }),
    );
    expect(out.status).toBe("completed");
    const [id] = h.created;
    const [row] = await h.instances.listUnits(id!);
    // The title is the text's first line (cut at 80 by unitTitleOf); the child's
    // contract carries the whole text (briefs.test.ts).
    expect(row!.title).toBe("point the redirect at https://calendar.acme.test/TrrMBAg7");
    expect(id).toMatch(/^plan-point-the-redirect-at-ht-[0-9a-f]{6}$/);
  });

  it("a generated plan is re-issued by its id: the same text after `U1` merged is refused as merged already; after `U1` ended `merge_ready` it is attempt 2 under `plan-<id>-2` with `U1` selected on the same branch", async () => {
    const id = `plan-${generatedPlanId("warm the cache on wake", "slack:C1:1.0")}`;
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "in acme/api: warm the cache on wake",
    });
    req.threadEvidence = "Requester: this cache is the one behind /healthz";
    const merged = harness({ status: { [id]: { kind: "status", status: "complete" } } });
    await handOffToCoordinator(merged.deps, req);
    const rows = await merged.instances.listUnits(id);
    await merged.instances.putUnits([
      { ...rows[0]!, ending: { kind: "merged", at: NOW } as unknown as CoordinatorUnit["ending"] },
    ]);
    const again = await handOffToCoordinator(merged.deps, req);
    expect(again.status).toBe("aborted");
    expect(again.reply).toContain("merged already");
    expect(merged.created).toEqual([id]);

    const ready = harness({ status: { [id]: { kind: "status", status: "complete" } } });
    await handOffToCoordinator(ready.deps, req);
    const readyRows = await ready.instances.listUnits(id);
    await ready.instances.putUnits([
      { ...readyRows[0]!, ending: { kind: "merge_ready", at: NOW } as unknown as CoordinatorUnit["ending"] },
    ]);
    const attempt2 = await handOffToCoordinator(ready.deps, req);
    expect(attempt2.status).toBe("completed");
    expect(attempt2.instanceId).toBe(`${id}-2`);
    expect(attempt2.reply).toContain("• attempt 2 of plan `");
    expect(await ready.instances.get(`${id}-2`)).toMatchObject({ attempt: 2, merge: "person" });
    expect(await ready.instances.listUnits(`${id}-2`)).toMatchObject([
      { unit: "U1", branch: "plan/warm-the-cache-on-wake-dfa06c/u1" },
    ]);
    expect((await ready.instances.listUnits(`${id}-2`))[0]?.generatedTask).toEqual(readyRows[0]?.generatedTask);
    expect((await ready.instances.listUnits(`${id}-2`))[0]?.threadEvidence).toBe(readyRows[0]?.threadEvidence);
  });

  it("refuses reissue when the original generated task checkpoint is absent", async () => {
    const id = `plan-${generatedPlanId("warm the cache on wake", "slack:C1:1.0")}`;
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "in acme/api: warm the cache on wake",
    });
    const h = harness({ status: { [id]: { kind: "status", status: "complete" } } });
    await handOffToCoordinator(h.deps, req);
    const row = (await h.instances.listUnits(id))[0]!;
    const { generatedTask: _missing, ...legacy } = row;
    await h.instances.putUnits([{ ...legacy, ending: { kind: "held", report: "interrupted", at: NOW } }]);
    const again = await handOffToCoordinator(h.deps, req);
    expect(again.status).toBe("aborted");
    expect(again.reply).toContain("original task checkpoint");
    expect(h.created).toEqual([id]);
    expect(await h.instances.listUnits(`${id}-2`)).toEqual([]);
  });

  it("refuses a legacy first instance without either task checkpoint or unit", async () => {
    const id = "plan-warm-the-cache-on-wake-dfa06c";
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "in acme/api: warm the cache on wake",
    });
    const initial = harness();
    await handOffToCoordinator(initial.deps, req);
    const first = (await initial.instances.get(id))!;
    const { generatedTask: _missing, ...legacy } = first;
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(legacy);
    const h = harness({ store, status: { [id]: { kind: "absent" } } });
    const again = await handOffToCoordinator(h.deps, req);
    expect(again.status).toBe("aborted");
    expect(again.reply).toContain("original task checkpoint");
    expect(h.created).toEqual([]);
  });

  it("refuses a changed original task source before starting another attempt", async () => {
    const id = "plan-warm-the-cache-on-wake-dfa06c";
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "in acme/api: warm the cache on wake",
    });
    const h = harness({ status: { [id]: { kind: "status", status: "complete" } } });
    await handOffToCoordinator(h.deps, req);
    const row = (await h.instances.listUnits(id))[0]!;
    await h.instances.putUnits([
      {
        ...row,
        generatedTask: {
          ...row.generatedTask!,
          source: { ...row.generatedTask!.source, runId: "other-run" },
        },
        ending: { kind: "held", report: "interrupted", at: NOW },
      },
    ]);
    const again = await handOffToCoordinator(h.deps, req);
    expect(again.status).toBe("aborted");
    expect(again.reply).toContain("original task checkpoint");
    expect(h.created).toEqual([id]);
    expect(await h.instances.listUnits(`${id}-2`)).toEqual([]);
  });

  it("a failed generated unit with no PR reissues on its original branch and seeds an attached plan for the new attempt", async () => {
    const id = "plan-warm-the-cache-on-wake-dfa06c";
    const h = harness({ status: { [id]: { kind: "status", status: "errored" } } });
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "in acme/api: warm the cache on wake",
    });
    await handOffToCoordinator(h.deps, req);
    const [unit] = await h.instances.listUnits(id);
    await h.instances.putUnits([{ ...unit!, ending: { kind: "held", report: "no plan context", at: NOW } }]);
    req.msg.documents = [{ name: "plan.md", mediaType: "text/plain", data: "Warm the cache on wake" }];
    const again = await handOffToCoordinator(h.deps, req);
    expect(again).toMatchObject({ status: "completed", instanceId: `${id}-2` });
    expect(await h.instances.listUnits(`${id}-2`)).toMatchObject([{ branch: unit!.branch, unit: unit!.unit }]);
    expect(await h.instances.listEvents({ instanceId: `${id}-2`, unit: unit!.unit })).toEqual([
      expect.objectContaining({ attachments: [expect.objectContaining({ name: "plan.md" })] }),
    ]);
  });

  it("a generated unit with no PR keeps its original branch when a retry inherits an unrelated thread PR", async () => {
    const referencedPr = `PR ${"#"}42`;
    const requestText = `in acme/api: fix sandbox recovery, not release ${referencedPr}`;
    const planId = generatedPlanId(`fix sandbox recovery, not release ${referencedPr}`, "slack:C1:1.0");
    const id = `plan-${planId}`;
    const branch = `plan/${planId}/u1`;
    const h = harness({ status: { [id]: { kind: "status", status: "errored" } } });
    const req = input({ entry: { repo: "acme/api", base: "main" }, requestText });
    await handOffToCoordinator(h.deps, req);
    const [original] = await h.instances.listUnits(id);
    await h.instances.putUnits([{ ...original!, ending: { kind: "aborted", report: "coding failed", at: NOW } }]);

    const retry = await handOffToCoordinator(h.deps, {
      ...req,
      entry: {
        repo: "acme/api",
        branch: "release-please--main",
        base: "release-base",
        adopt: { pr: 42, headSha: "a".repeat(40) },
      },
    });

    expect(retry).toMatchObject({ status: "completed", instanceId: `${id}-2` });
    expect(retry.reply).toContain(`the unit runs on \`${branch}\``);
    expect(retry.reply).not.toContain(referencedPr);
    expect(await h.instances.get(`${id}-2`)).toMatchObject({ branch, base: "main" });
    expect(await h.instances.listUnits(`${id}-2`)).toMatchObject([{ branch, unit: ["U", "1"].join("") }]);
    expect((await h.instances.listUnits(`${id}-2`))[0]).not.toHaveProperty("publication");
  });

  it("keeps the original base when a no-PR retry has no entry branch", async () => {
    const requestText = "in acme/api: fix sandbox recovery";
    const planId = generatedPlanId("fix sandbox recovery", "slack:C1:1.0");
    const id = `plan-${planId}`;
    const h = harness({ status: { [id]: { kind: "status", status: "errored" } } });
    await handOffToCoordinator(h.deps, input({ entry: { repo: "acme/api", base: "main" }, requestText }));

    const retry = await handOffToCoordinator(
      h.deps,
      input({ entry: { repo: "acme/api", base: "release-base" }, requestText }),
    );

    expect(retry).toMatchObject({ status: "completed", instanceId: `${id}-2` });
    expect(await h.instances.get(`${id}-2`)).toMatchObject({ base: "main" });
    expect(await h.instances.listUnits(`${id}-2`)).toMatchObject([{ branch: `plan/${planId}/u1` }]);
  });

  it("keeps the original base when a no-PR retry retains its entry branch", async () => {
    const requestText = "in acme/api: fix sandbox recovery";
    const planId = generatedPlanId("fix sandbox recovery", "slack:C1:1.0");
    const id = `plan-${planId}`;
    const branch = `plan/${planId}/u1`;
    const h = harness({ status: { [id]: { kind: "status", status: "errored" } } });
    await handOffToCoordinator(h.deps, input({ entry: { repo: "acme/api", base: "main" }, requestText }));

    const retry = await handOffToCoordinator(
      h.deps,
      input({ entry: { repo: "acme/api", branch, base: "release-base" }, requestText }),
    );

    expect(retry).toMatchObject({ status: "completed", instanceId: `${id}-2` });
    expect(await h.instances.get(`${id}-2`)).toMatchObject({ branch, base: "main" });
  });

  it("refuses to discard a PR first recorded in a later attempt", async () => {
    const requestText = "in acme/api: fix sandbox recovery";
    const planId = generatedPlanId("fix sandbox recovery", "slack:C1:1.0");
    const id = `plan-${planId}`;
    const secondId = `${id}-2`;
    const h = harness({
      status: {
        [id]: { kind: "status", status: "errored" },
        [secondId]: { kind: "status", status: "terminated" },
      },
    });
    const req = input({ entry: { repo: "acme/api", base: "main" }, requestText });
    await handOffToCoordinator(h.deps, req);
    await handOffToCoordinator(h.deps, req);
    const [second] = await h.instances.listUnits(secondId);
    seedCoordinatorUnit(h.instances as InMemoryCoordinatorInstanceStore, {
      ...second!,
      pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
      lastPush: "b".repeat(40),
      ending: { kind: "stopped", report: "stopped", at: NOW },
    });

    const retry = await handOffToCoordinator(h.deps, {
      ...req,
      entry: {
        repo: "acme/api",
        branch: "release-please--main",
        base: "main",
        adopt: { pr: 43, headSha: "c".repeat(40) },
      },
    });

    expect(retry).toMatchObject({ status: "aborted", refusal: { code: "plan_runner_conflict" } });
    expect(await h.instances.get(`${id}-3`)).toBeNull();

    const samePr = await handOffToCoordinator(h.deps, {
      ...req,
      entry: {
        repo: "acme/api",
        branch: `plan/${planId}/u1`,
        base: "main",
        adopt: { pr: 42, headSha: "c".repeat(40) },
      },
    });
    expect(samePr).toMatchObject({ status: "aborted", refusal: { code: "plan_runner_conflict" } });
    expect(await h.instances.listUnits(`${id}-3`)).toEqual([]);
    expect(await h.instances.listUnits(secondId)).toMatchObject([{ pr: { number: 42 }, lastPush: "b".repeat(40) }]);
    expect(h.created).toEqual([id, secondId]);
  });

  it("replaces an absent first Workflow after its instance was written without a unit", async () => {
    const requestText = "in acme/api: fix sandbox recovery";
    const planId = generatedPlanId("fix sandbox recovery", "slack:C1:1.0");
    const id = `plan-${planId}`;
    const req = input({ entry: { repo: "acme/api", base: "main" }, requestText });
    const initial = harness();
    await handOffToCoordinator(initial.deps, req);
    const first = (await initial.instances.get(id))!;
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put(first);
    const h = harness({ store, status: { [id]: { kind: "absent" } } });

    const retry = await handOffToCoordinator(h.deps, {
      ...req,
      runId: "run-reissue",
      msg: { ...req.msg, sourceUrl: "https://acme.slack.com/archives/C1/p2" },
      entry: {
        repo: "acme/api",
        branch: "release-please--main",
        base: "release-base",
        adopt: { pr: 42, headSha: "a".repeat(40) },
      },
    });

    expect(retry).toMatchObject({ status: "completed", instanceId: id });
    expect(await h.instances.get(id)).toMatchObject({
      branch: `plan/${planId}/u1`,
      base: "main",
      runId: first.runId,
      sourceUrl: first.sourceUrl,
    });
    expect(await h.instances.listUnits(id)).toMatchObject([{ branch: `plan/${planId}/u1` }]);
    expect((await h.instances.get(id))?.generatedTask).toEqual(first.generatedTask);
    const restored = (await h.instances.get(id))!;
    const [unit] = await h.instances.listUnits(id);
    await expect(
      contractFor(restored, unit!, {
        readRepoFile: async () => undefined,
        readRunFacts: async () => undefined,
      }),
    ).resolves.toBeDefined();
  });

  it("retains a recovered legacy unit's saved push and record under its original owner", async () => {
    const requestText = "in acme/api: fix sandbox recovery";
    const planId = generatedPlanId("fix sandbox recovery", "slack:C1:1.0");
    const id = `plan-${planId}`;
    const branch = `plan/${planId}/u12`;
    const initial = harness();
    await handOffToCoordinator(initial.deps, input({ entry: { repo: "acme/api", base: "main" }, requestText }));
    const first = (await initial.instances.get(id))!;
    const [firstUnit] = await initial.instances.listUnits(id);
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await store.put({ ...first, branch });
    await store.putUnits([
      {
        ...firstUnit!,
        unit: ["U", "12"].join(""),
        slug: "u12",
        branch,
        pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
        lastPush: "b".repeat(40),
        record: "0050",
      },
    ]);
    const h = harness({ store, status: { [id]: { kind: "status", status: "errored" } } });

    const retry = await handOffToCoordinator(
      h.deps,
      input({
        entry: { repo: "acme/api", branch, base: "main", adopt: { pr: 42, headSha: "b".repeat(40) } },
        requestText,
      }),
    );

    expect(retry).toMatchObject({ status: "aborted", refusal: { code: "plan_runner_conflict" } });
    expect(await h.instances.listUnits(`${id}-2`)).toEqual([]);
    expect(await h.instances.listUnits(id)).toMatchObject([
      { unit: ["U", "12"].join(""), branch, lastPush: "b".repeat(40), record: "0050", pr: { number: 42 } },
    ]);
    expect(h.created).toEqual([]);
  });

  it("refuses to carry work recorded on another branch into a generated unit's original branch", async () => {
    const referencedPr = `PR ${"#"}42`;
    const requestText = `in acme/api: fix sandbox recovery, not release ${referencedPr}`;
    const planId = generatedPlanId(`fix sandbox recovery, not release ${referencedPr}`, "slack:C1:1.0");
    const id = `plan-${planId}`;
    const secondId = `${id}-2`;
    const h = harness({
      status: {
        [id]: { kind: "status", status: "errored" },
        [secondId]: { kind: "status", status: "terminated" },
      },
    });
    const req = input({ entry: { repo: "acme/api", base: "main" }, requestText });
    await handOffToCoordinator(h.deps, req);
    const originalInstance = (await h.instances.get(id))!;
    const [original] = await h.instances.listUnits(id);
    await h.instances.put({ ...originalInstance, id: secondId, attempt: 2, branch: "release-please--main" });
    await h.instances.putUnits([
      {
        ...original!,
        instanceId: secondId,
        branch: "release-please--main",
        pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
        rounds: [{ index: 0, agent: "coding", outcome: "stopped", at: NOW }],
        ending: { kind: "stopped", report: "stopped", at: NOW },
      },
    ]);

    const retry = await handOffToCoordinator(h.deps, {
      ...req,
      entry: {
        repo: "acme/api",
        branch: "release-please--main",
        base: "main",
        adopt: { pr: 42, headSha: "a".repeat(40) },
      },
    });

    expect(retry).toMatchObject({ status: "aborted", refusal: { code: "plan_runner_conflict" } });
    expect(retry.reply).toContain("branch history cannot be reconciled");
    expect(await h.instances.get(`${id}-3`)).toBeNull();
  });

  it("refuses foreign-branch work even when the next retry has no entry branch", async () => {
    const requestText = "in acme/api: fix sandbox recovery";
    const planId = generatedPlanId("fix sandbox recovery", "slack:C1:1.0");
    const id = `plan-${planId}`;
    const secondId = `${id}-2`;
    const h = harness({
      status: {
        [id]: { kind: "status", status: "errored" },
        [secondId]: { kind: "status", status: "terminated" },
      },
    });
    const req = input({ entry: { repo: "acme/api", base: "main" }, requestText });
    await handOffToCoordinator(h.deps, req);
    const originalInstance = (await h.instances.get(id))!;
    const [original] = await h.instances.listUnits(id);
    await h.instances.put({ ...originalInstance, id: secondId, attempt: 2, branch: "release-please--main" });
    await h.instances.putUnits([
      {
        ...original!,
        instanceId: secondId,
        branch: "release-please--main",
        lastPush: "b".repeat(40),
        rounds: [{ index: 0, agent: "coding", outcome: "stopped", at: NOW }],
        ending: { kind: "stopped", report: "stopped", at: NOW },
      },
    ]);

    const retry = await handOffToCoordinator(h.deps, req);

    expect(retry).toMatchObject({ status: "aborted", refusal: { code: "plan_runner_conflict" } });
    expect(retry.reply).toContain("branch history cannot be reconciled");
    expect(await h.instances.get(`${id}-3`)).toBeNull();
  });

  it("refuses to abandon or replace an originally adopted PR on retry", async () => {
    const requestText = "in acme/api: fix sandbox recovery";
    const planId = generatedPlanId("fix sandbox recovery", "slack:C1:1.0");
    const id = `plan-${planId}`;
    for (const retryEntry of [
      { repo: "acme/api", base: "main" },
      {
        repo: "acme/api",
        branch: "feat/recovery",
        base: "main",
        adopt: { pr: 43, headSha: "b".repeat(40) },
      },
    ]) {
      const h = harness({ status: { [id]: { kind: "status", status: "errored" } } });
      await handOffToCoordinator(
        h.deps,
        input({
          entry: {
            repo: "acme/api",
            branch: "feat/recovery",
            base: "main",
            adopt: { pr: 42, headSha: "a".repeat(40) },
          },
          requestText,
        }),
      );
      const [original] = await h.instances.listUnits(id);
      await h.instances.putUnits([{ ...original!, lastPush: "a".repeat(40) }]);

      const retry = await handOffToCoordinator(h.deps, input({ entry: retryEntry, requestText }));

      expect(retry).toMatchObject({ status: "aborted", refusal: { code: "plan_runner_conflict" } });
      expect(await h.instances.get(`${id}-2`)).toBeNull();
    }
  });

  it("refuses to transfer an originally adopted PR into a replacement attempt", async () => {
    const requestText = "in acme/api: fix sandbox recovery";
    const planId = generatedPlanId("fix sandbox recovery", "slack:C1:1.0");
    const id = `plan-${planId}`;
    const h = harness({ status: { [id]: { kind: "status", status: "errored" } } });
    const entry = {
      repo: "acme/api",
      branch: "feat/recovery",
      base: "main",
      adopt: { pr: 42, headSha: "a".repeat(40) },
    };
    await handOffToCoordinator(h.deps, input({ entry, requestText }));
    const [original] = await h.instances.listUnits(id);
    await h.instances.putUnits([{ ...original!, lastPush: "a".repeat(40) }]);

    const retry = await handOffToCoordinator(
      h.deps,
      input({ entry: { ...entry, adopt: { pr: 42, headSha: "b".repeat(40) } }, requestText }),
    );

    expect(retry).toMatchObject({ status: "aborted", refusal: { code: "plan_runner_conflict" } });
    expect(await h.instances.listUnits(`${id}-2`)).toEqual([]);
    expect(await h.instances.listUnits(id)).toMatchObject([
      { branch: "feat/recovery", publication: { pr: 42, expectedHeadSha: "a".repeat(40), owner: { instanceId: id } } },
    ]);
    expect(h.created).toEqual([id]);
  });

  it("a re-issue after a review_pending ending carries the row's lastPush — the coding child's own last push — onto the next attempt's row, so its pre-check starts at the review round", async () => {
    const id = "plan-warm-the-cache-on-wake-dfa06c";
    const req = input({
      entry: { repo: "acme/api", base: "main" },
      requestText: "in acme/api: warm the cache on wake",
    });
    const h = harness({ status: { [id]: { kind: "status", status: "complete" } } });
    await handOffToCoordinator(h.deps, req);
    const rows = await h.instances.listUnits(id);
    await h.instances.putUnits([
      {
        ...rows[0]!,
        lastPush: "abcdef1234abcdef1234abcdef1234abcdef1234",
        ending: { kind: "review_pending", at: NOW } as unknown as CoordinatorUnit["ending"],
      },
    ]);
    const attempt2 = await handOffToCoordinator(h.deps, req);
    expect(attempt2.status).toBe("completed");
    // The same unit, on attempt 2's row, carrying the head attempt 1 recorded.
    expect(await h.instances.listUnits(`${id}-2`)).toMatchObject([
      { unit: rows[0]!.unit, lastPush: "abcdef1234abcdef1234abcdef1234abcdef1234" },
    ]);
  });

  it("a resume at review (agent-ship item 10) is the one generated unit with the pull request on its row and the entry's branch — the pull request's own head — so the runner opens it at the review round; the reply names the pull request and that no coding round runs first", async () => {
    const h = harness();
    const id = "plan-implement-the-task-this-f502bc";
    const out = await handOffToCoordinator(
      h.deps,
      input({
        entry: {
          repo: "acme/api",
          branch: "feat/wake-cache",
          base: "main",
          resume: { pr: 7, headSha: "a".repeat(40), url: "https://github.com/acme/api/pull/7" },
        },
        requestText: "https://github.com/acme/api/pull/7",
      }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toContain("🧭 Handed to the plan runner.");
    expect(out.instanceId).toBe(id);
    expect(out.reply).toContain(
      "the review loop of https://github.com/acme/api/pull/7 resumes at its next review round on `feat/wake-cache` in this thread under your grants — no new coding round first",
    );
    expect(h.created).toEqual([id]);
    expect(await h.instances.listUnits(id)).toMatchObject([
      {
        instanceId: id,
        unit: "U1",
        slug: "u1",
        branch: "feat/wake-cache",
        dependsOn: [],
        rounds: [],
        resume: { pr: 7, headSha: "a".repeat(40), url: "https://github.com/acme/api/pull/7" },
        publication: {
          repo: "acme/api",
          pr: 7,
          headRef: "feat/wake-cache",
          baseRef: "main",
          expectedHeadSha: "a".repeat(40),
          publicationRef: "feat/wake-cache",
          owner: { instanceId: id, unit: `U${1}` },
        },
      },
    ]);
    // Without a url the reply builds the pull request's from the number.
    const bare = harness();
    const again = await handOffToCoordinator(
      bare.deps,
      input({
        entry: {
          repo: "acme/api",
          branch: "feat/wake-cache",
          base: "main",
          resume: { pr: 9, headSha: "b".repeat(40) },
        },
        requestText: "acme/api#9",
      }),
    );
    expect(again.reply).toContain("the review loop of https://github.com/acme/api/pull/9 resumes");
    expect((await bare.instances.listUnits(id))[0]!.resume).toEqual({ pr: 9, headSha: "b".repeat(40) });
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
    const leftover = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const first = await handOffToCoordinator(
      harness({ store: leftover, create: { kind: "failed", id: "plan-fixture", reason: "engine down" } }).deps,
      input(),
    );
    expect(first.status).toBe("aborted");
    expect(first.reply).toBe(
      "⚠️ This is a bug: the plan runner could not be started (engine down), nothing ran, and no automatic start retry was scheduled.",
    );
    const second = harness({ store: leftover, status: { "plan-fixture": { kind: "absent" } } });
    const retried = await handOffToCoordinator(
      second.deps,
      input({ runId: "run-s2", now: NOW + 1, requestText: "in acme/api: plan docs/plans/fixture.md units U10, U11" }),
    );
    expect(retried.status).toBe("completed");
    expect(retried.reply).toBe(
      "🧭 Handed to the plan runner.\n• plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 2 units in dependency order: U10, U11\n" +
        "• each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread\n• the records of an earlier attempt that never started were replaced",
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
    const live = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
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
        `🚫 A runner for plan \`fixture\` is still running (\`plan-fixture\`, status: ${status}), so this request started no second runner.`,
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
      "⚠️ The plan runner could not tell whether `plan-fixture` still runs (the shim could not be reached: ECONNREFUSED); its saved instance must be checked before another attempt.",
    );
    expect(odd.created).toEqual([]);
    expect(mute.created).toEqual([]);
    expect((await live.get("plan-fixture"))?.runId).toBe("run-s");
  });

  it("a plan whose latest attempt ended is resumed as the next attempt: the units the earlier attempts merged are skipped, the rest run under `plan-<plan-id>-<n>` with the attempt on the record, a dependency on a merged unit stays on the row and counts as done, the reply names what is left and what was merged; a third re-issue finds the latest attempt; every named unit merged is a refusal", async () => {
    /** A store holding attempt 1's records, ended: U10 merged, U11's merge refused, U12 capped. */
    async function afterFirstAttempt() {
      const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
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
        "🧭 Handed to the plan runner.\n• attempt 2 of plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 2 units left in dependency order: U11, U12\n• merged before: U10\n" +
          "• each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread",
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
    expect(out.reply).toContain("• 1 unit left in dependency order: U12\n• merged before: U10, U11");
    // One unit left is a one-unit plan: the attempt's reply takes the "in this thread" wording too.
    expect(out.reply).toContain(
      "• the unit runs on `plan/fixture/u12-trim-the-log` in this thread under your grants; this card follows the plan and its report lands here",
    );
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
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
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
      "🧭 Handed to the plan runner.\n• attempt 2 of plan `fixture` (`docs/plans/fixture.md` at `main`)\n• 2 units left in dependency order: U11, U12\n• merged before: U10\n" +
        "• each unit runs in a thread of its own in this channel under your grants; this card follows the plan and its summary lands in this thread\n• the records of an earlier attempt that never started were replaced",
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

  it("a duplicate or lost reply keeps its saved instance pending; a local refusal never attempted create", async () => {
    const dup = harness({ create: { kind: "duplicate", id: "plan-fixture", status: "complete" } });
    const out = await handOffToCoordinator(dup.deps, input());
    expect(out).toMatchObject({ status: "pending", instanceId: "plan-fixture" });
    expect(out.reply).toContain("ownership needs reconciliation");
    const silent = harness({
      create: { kind: "not_attempted", reason: "PUBLIC_BASE_URL is not set — the bot cannot address its own shim" },
    });
    expect((await handOffToCoordinator(silent.deps, input())).reply).toBe(
      "⚠️ This is a bug: the plan runner could not be started (PUBLIC_BASE_URL is not set — the bot cannot address its own shim), nothing ran, and no automatic start retry was scheduled.",
    );
    const threw = harness({ create: new Error("boom") });
    expect(await handOffToCoordinator(threw.deps, input())).toMatchObject({
      status: "pending",
      instanceId: "plan-fixture",
    });
  });

  it("an unreconciled duplicate cannot become a new plan attempt after its Workflow ends", async () => {
    const store = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const first = harness({ store, create: { kind: "duplicate", id: "plan-fixture", status: "complete" } });
    expect(await handOffToCoordinator(first.deps, input())).toMatchObject({ status: "pending" });
    expect((await store.get("plan-fixture"))?.admission).toBe("unreconciled");

    for (const status of [
      { kind: "status", status: "running" },
      { kind: "unanswered", reason: "offline" },
    ] as const) {
      const uncertain = harness({ store, status: { "plan-fixture": status } });
      expect((await handOffToCoordinator(uncertain.deps, input({ runId: "run-s2" }))).status).toBe("aborted");
      expect(uncertain.created).toEqual([]);
      expect(await store.get("plan-fixture-2")).toBeNull();
    }

    const ended = harness({ store, status: { "plan-fixture": { kind: "status", status: "complete" } } });
    const replay = await handOffToCoordinator(ended.deps, input({ runId: "run-s2", now: NOW + 1 }));
    expect(replay).toMatchObject({ status: "aborted", refusal: { code: "plan_instance_orphaned" } });
    expect(ended.created).toEqual([]);
    expect(await store.get("plan-fixture-2")).toBeNull();
    expect((await store.get("plan-fixture"))?.admission).toBe("unreconciled");
  });
});

describe("main-agent work hand-off", () => {
  const mainTask = (actId: string) => ({
    mainThreadKey: "slack:C1:1.0",
    actId,
    brief: {
      ...EMPTY_EVIDENCE,
      question: "How many signups failed yesterday?",
      findings: [
        {
          kind: "analysis" as const,
          text: "17 of 120 failed",
          query: "SELECT failed_signups FROM daily_signups",
          result: "17 failed of 120 attempts",
          timeWindow: "previous UTC day",
          sourceUrl: "https://example.com/metrics/signups",
        },
      ],
      cause: {
        kind: "hypothesis" as const,
        text: "The callback may reject expired state",
        uncertainty: "The cause has not been reproduced",
      },
      evidence: { availability: "provided" as const },
      requestedChange: "Fix the callback and keep the failure visible",
      acceptance: "The regression test passes and a reviewed PR is ready",
    },
  });

  const mainInput = (over: Partial<HandOffInput>) =>
    input({ privateWorkerReady: true, stillLive: () => true, stillPrivate: async () => true, ...over });

  it("retries a legacy checkpoint under its original act without upgrading or regenerating its brief", async () => {
    const h = harness();
    const request = mainInput({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix signup",
      mainTask: mainTask("act-legacy"),
    });
    const first = await handOffToCoordinator(h.deps, request);
    const instance = (await h.instances.get(first.instanceId!))!;
    const unit = (await h.instances.listUnits(instance.id))[0]!;
    const legacy = {
      ...unit.workBrief!,
      schemaVersion: undefined,
      cause: undefined,
      evidence: undefined,
      requirements: undefined,
      acceptance: undefined,
    };
    const restored = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    await restored.recordRequesterTurn({ threadKey: instance.threadKey, requesterId: instance.userId, messageId: "1" });
    await restored.claimMainTask(request.mainTask!, instance, { ...unit, workBrief: legacy }, MAIN_AUTHORITY);
    h.deps.instances = restored;
    const retried = await handOffToCoordinator(h.deps, request);
    expect(retried.status).toBe("completed");
    expect(retried.instanceId).toBe(instance.id);
    expect(h.created).toEqual([instance.id, instance.id]);
    expect((await restored.listUnits(instance.id))[0]?.workBrief).toEqual(JSON.parse(JSON.stringify(legacy)));
    const newAct = await handOffToCoordinator(h.deps, {
      ...request,
      mainTask: { ...request.mainTask!, actId: "act-new", brief: legacy },
    });
    expect(newAct).toMatchObject({
      status: "aborted",
      issues: expect.arrayContaining([{ code: "schema_version", path: "schemaVersion" }]),
    });
    expect(h.created).toHaveLength(2);
  });

  it("an act replay keeps one durable unit and no second attempt despite changed text", async () => {
    const status: Record<string, InstanceStatusAnswer> = {};
    const h = harness({ status });
    const first = await handOffToCoordinator(
      h.deps,
      mainInput({
        entry: { repo: "acme/api", base: "main" },
        requestText: "fix failed signups",
        mainTask: mainTask("act-1"),
      }),
    );
    status[first.instanceId!] = { kind: "status", status: "running" };
    const second = await handOffToCoordinator(
      h.deps,
      mainInput({
        entry: { repo: "acme/api", base: "main" },
        requestText: "different wording",
        mainTask: mainTask("act-1"),
      }),
    );
    expect(first.status, first.reply).toBe("completed");
    expect(second.status, second.reply).toBe("completed");
    expect(second.instanceId).toBe(first.instanceId);
    expect(h.created).toEqual([first.instanceId]);
    expect(await h.instances.listUnits(first.instanceId!)).toHaveLength(1);
    expect((await h.instances.get(first.instanceId!))?.runId).toBeUndefined();
    expect((await h.instances.listUnits(first.instanceId!))[0]?.workBrief).toMatchObject({
      requesterId: "slack:UALICE",
      mainThreadKey: "slack:C1:1.0",
      actId: "act-1",
      repo: "acme/api",
      base: "main",
      question: "How many signups failed yesterday?",
    });
  });

  it("an unreconciled private duplicate stays pending on same-id retry and later status reads", async () => {
    const status: Record<string, InstanceStatusAnswer> = {};
    const h = harness({ create: (id) => ({ kind: "duplicate", id, status: "running" }), status });
    const request = mainInput({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix failed signups",
      mainTask: mainTask("act-duplicate"),
    });
    const first = await handOffToCoordinator(h.deps, request);
    expect(first).toMatchObject({ status: "pending", instanceId: expect.any(String) });
    expect((await h.instances.get(first.instanceId!))?.admission).toBe("unreconciled");

    const retried = await handOffToCoordinator(h.deps, request);
    expect(retried).toMatchObject({ status: "pending", instanceId: first.instanceId });
    expect(retried.reply).not.toContain("already owns");
    expect(h.created).toEqual([first.instanceId, first.instanceId]);

    for (const runnerStatus of ["running", "complete"]) {
      status[first.instanceId!] = { kind: "status", status: runnerStatus };
      const observed = await handOffToCoordinator(h.deps, request);
      expect(observed).toMatchObject({ status: "pending", instanceId: first.instanceId });
      expect(observed.reply).not.toContain("already owns");
      expect((await h.instances.get(first.instanceId!))?.admission).toBe("unreconciled");
      expect(h.created).toEqual([first.instanceId, first.instanceId]);
    }
  });

  it("a saved act is not disclosed after private-audience or requester-revision revocation", async () => {
    const h = harness({ create: new Error("reply lost") });
    const request = mainInput({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix failed signups",
      mainTask: mainTask("act-revoked"),
    });
    const first = await handOffToCoordinator(h.deps, request);
    expect(first).toMatchObject({ status: "pending", instanceId: expect.any(String) });
    h.deps.status = async () => ({ kind: "status", status: "running" });
    const shared = await handOffToCoordinator(h.deps, { ...request, stillPrivate: async () => false });
    expect(shared).toMatchObject({ status: "aborted", refusal: { code: "setup_failed" } });
    expect(shared.instanceId).toBeUndefined();
    await h.instances.recordRequesterTurn({
      threadKey: request.msg.threadKey,
      requesterId: request.msg.userId,
      messageId: "2",
    });
    const superseded = await handOffToCoordinator(h.deps, request);
    expect(superseded).toMatchObject({ status: "aborted", refusal: { code: "setup_failed" } });
    expect(superseded.instanceId).toBeUndefined();
    expect(h.created).toEqual([first.instanceId]);
  });

  it("refuses an act claimed or replayed from a different conversation", async () => {
    const h = harness();
    const otherThread = "slack:COTHER:2.0";
    const altered = mainInput({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix failed signups",
      mainTask: mainTask("act-1"),
    });
    const refused = await handOffToCoordinator(h.deps, {
      ...altered,
      msg: { ...altered.msg, threadKey: otherThread, channelId: "slack:COTHER" },
    });
    expect(refused.status).toBe("aborted");
    expect(h.created).toEqual([]);
    expect(await h.instances.getMainTask({ mainThreadKey: "slack:C1:1.0", actId: "act-1" })).toBeNull();

    const first = await handOffToCoordinator(h.deps, altered);
    expect(first.status).toBe("completed");
    const replay = await handOffToCoordinator(h.deps, {
      ...altered,
      msg: { ...altered.msg, threadKey: otherThread, channelId: "slack:COTHER" },
    });
    expect(replay.status).toBe("aborted");
    expect(h.created).toEqual([first.instanceId]);
  });

  it("a different act may start a second generated unit in the same main thread", async () => {
    const h = harness();
    const ask = (actId: string) =>
      handOffToCoordinator(
        h.deps,
        mainInput({
          entry: { repo: "acme/api", base: "main" },
          requestText: "fix failed signups",
          mainTask: mainTask(actId),
        }),
      );
    const first = await ask("act-1");
    const second = await ask("act-2");
    expect(second.status).toBe("completed");
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(h.created).toEqual([first.instanceId, second.instanceId]);
  });

  it("a failed start replays the same recorded instance instead of minting another attempt", async () => {
    const h = harness({ create: new Error("offline") });
    const request = mainInput({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix failed signups",
      mainTask: mainTask("act-retry"),
    });
    const failed = await handOffToCoordinator(h.deps, request);
    expect(failed.status).toBe("pending");
    const link = await h.instances.getMainTask({ mainThreadKey: "slack:C1:1.0", actId: "act-retry" });
    expect(link?.unit).toBe(["U", "1"].join(""));
    h.deps.create = async (id) => {
      h.created.push(id);
      return { kind: "created", id };
    };
    const retried = await handOffToCoordinator(h.deps, { ...request, requestText: "changed wording" });
    expect(retried.status).toBe("completed");
    expect(retried.instanceId).toBe(link?.instanceId);
    expect(await h.instances.listUnits(link!.instanceId)).toHaveLength(1);
  });

  it("stops before a claim and before Workflow create, preserving a safe same-act retry", async () => {
    const h = harness();
    const request = mainInput({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix failed signups",
      mainTask: mainTask("act-stop"),
    });
    const beforeClaim = await handOffToCoordinator(h.deps, { ...request, stillLive: () => false });
    expect(beforeClaim.status).toBe("aborted");
    expect(await h.instances.getMainTask({ mainThreadKey: "slack:C1:1.0", actId: "act-stop" })).toBeNull();
    expect(h.created).toEqual([]);

    let live = true;
    const originalClaim = h.deps.instances.claimMainTask.bind(h.deps.instances);
    h.deps.instances.claimMainTask = async (...args) => {
      const result = await originalClaim(...args);
      live = false;
      return result;
    };
    const stopped = await handOffToCoordinator(h.deps, { ...request, stillLive: () => live });
    expect(stopped.status).toBe("aborted");
    expect(h.created).toEqual([]);
    const link = await h.instances.getMainTask({ mainThreadKey: "slack:C1:1.0", actId: "act-stop" });
    expect(link).not.toBeNull();

    const retried = await handOffToCoordinator(h.deps, { ...request, stillLive: () => true });
    expect(retried.status).toBe("completed");
    expect(retried.instanceId).toBe(link?.instanceId);
    expect(h.created).toEqual([link?.instanceId]);
  });

  it("a replay cannot silently retarget an act to another repository", async () => {
    const status: Record<string, InstanceStatusAnswer> = {};
    const h = harness({ status });
    const request = mainInput({
      entry: { repo: "acme/api", base: "main" },
      requestText: "fix signups",
      mainTask: mainTask("act-target"),
    });
    const first = await handOffToCoordinator(h.deps, request);
    status[first.instanceId!] = { kind: "status", status: "running" };
    const moved = await handOffToCoordinator(h.deps, { ...request, entry: { repo: "other/repo", base: "main" } });
    expect(moved.status).toBe("aborted");
    expect(moved.reply).toContain("target");
    expect(h.created).toEqual([first.instanceId]);
  });

  it("the exact query result and time window persist on the original unit", async () => {
    const h = harness();
    const out = await handOffToCoordinator(
      h.deps,
      mainInput({
        entry: { repo: "acme/api", base: "main" },
        requestText: "fix failed signups",
        mainTask: mainTask("act-query"),
      }),
    );
    expect(out.status).toBe("completed");
    expect((await h.instances.listUnits(out.instanceId!))[0]?.workBrief?.findings[0]).toMatchObject({
      query: "SELECT failed_signups FROM daily_signups",
      result: "17 failed of 120 attempts",
      timeWindow: "previous UTC day",
      sourceUrl: "https://example.com/metrics/signups",
    });
    const invalid = await handOffToCoordinator(
      h.deps,
      mainInput({
        entry: { repo: "acme/api", base: "main" },
        requestText: "fix",
        mainTask: {
          ...mainTask("act-long-query"),
          brief: {
            ...EMPTY_EVIDENCE,
            ...mainTask("act-long-query").brief,
            findings: [
              {
                kind: "analysis",
                text: "failed",
                query: "x".repeat(5000),
                result: "17",
                timeWindow: "previous UTC day",
                sourceUrl: "https://example.com/metrics/signups",
              },
            ],
          },
        },
      }),
    );
    expect(invalid.status).toBe("aborted");
    expect(h.created).toEqual([out.instanceId]);
  });

  it("an invalid brief or unavailable durable claim starts nothing", async () => {
    const h = harness();
    const invalid = await handOffToCoordinator(
      h.deps,
      mainInput({
        entry: { repo: "acme/api", base: "main" },
        requestText: "fix",
        mainTask: { ...mainTask("act-1"), brief: { ...mainTask("act-1").brief, question: "x".repeat(5000) } },
      }),
    );
    expect(invalid.status).toBe("aborted");
    const unavailable = harness({ store: new NullCoordinatorInstanceStore() });
    const missing = await handOffToCoordinator(
      unavailable.deps,
      mainInput({ entry: { repo: "acme/api", base: "main" }, requestText: "fix", mainTask: mainTask("act-1") }),
    );
    expect(missing.status).toBe("aborted");
    expect(h.created).toEqual([]);
    expect(unavailable.created).toEqual([]);
  });
});

describe("the severity to address — resolved once, written on the instance beside `merge`", () => {
  it("the hand-off writes the resolved level and its source on the instance; absent, the default (`minor`, org) is written so the machine always reads one value", async () => {
    const h = harness();
    await handOffToCoordinator(h.deps, input({ addressSeverity: { level: "blocking", source: "run" } }));
    expect(await h.instances.get("plan-fixture")).toMatchObject({
      merge: "runner",
      addressSeverity: "blocking",
      addressSeveritySource: "run",
    });
    const d = harness();
    await handOffToCoordinator(d.deps, input());
    expect(await d.instances.get("plan-fixture")).toMatchObject({
      addressSeverity: "minor",
      addressSeveritySource: "org",
    });
  });
});

describe("the grant — resolved once, written on the instance beside `merge` (decision 0046, the renewable lease)", () => {
  it("the hand-off writes the resolved grant and its source on the instance; absent, zero renewals and no cap are written as the org's, so nothing renews by default", async () => {
    const h = harness();
    await handOffToCoordinator(h.deps, input({ grant: { grant: { renewals: 4, costCapUsd: 30 }, source: "channel" } }));
    expect(await h.instances.get("plan-fixture")).toMatchObject({
      grant: { renewals: 4, costCapUsd: 30 },
      grantSource: "channel",
    });
    const d = harness();
    await handOffToCoordinator(d.deps, input());
    expect(await d.instances.get("plan-fixture")).toMatchObject({ grant: { renewals: 0 }, grantSource: "org" });
  });
});

describe("handOffToCoordinator — the plan is read whole, never through the tool clip (item 16)", () => {
  /** A plan whose last unit begins past the tool clip: filler units of prose
   *  until the file is longer than `MAX_FILE_CHARS`, then the unit asked for. */
  const filler = (n: number) =>
    [
      `### U${n}. Filler unit ${n}`,
      "",
      `- **Goal**: ${"the runner reads every unit of a long plan. ".repeat(60)}`,
      "",
      "---",
      "",
    ].join("\n");
  const longPlan = (() => {
    const parts = ["# Long - Plan", ""];
    for (let n = 10; parts.join("\n").length <= MAX_FILE_CHARS; n++) parts.push(filler(n));
    parts.push("### U99. The unit past the clip", "", "- **Goal**: lands.", "- **Dependencies**: none.", "");
    return parts.join("\n");
  })();

  it("a unit whose heading lies past the tool clip is found: the seed asks for the plan up to PLAN_MAX_CHARS, so a plan longer than the clip keeps every unit", async () => {
    expect(longPlan.length).toBeGreaterThan(MAX_FILE_CHARS);
    const h = harness({ files: { "docs/plans/long.md": longPlan } });
    const out = await handOffToCoordinator(
      h.deps,
      input({ requestText: "in acme/api: plan docs/plans/long.md units U99" }),
    );
    expect(out.status).toBe("completed");
    expect(out.reply).toContain("U99");
    expect(await h.instances.get("plan-long")).not.toBeNull();
    expect((await h.instances.listUnits("plan-long")).map((u) => u.unit)).toEqual(["U99"]);
  });

  it("a plan longer than PLAN_MAX_CHARS is refused naming the bound, with nothing created: its later units would be lost, and a short parse is never a plan", async () => {
    const h = harness({ files: { "docs/plans/long.md": longPlan } });
    const clipped: HandOffDeps = {
      ...h.deps,
      readFile: async (repo, path, ref, opts) => {
        const file = await h.deps.readFile(repo, path, ref, opts);
        return { content: file.content, truncated: true };
      },
    };
    const out = await handOffToCoordinator(
      clipped,
      input({ requestText: "in acme/api: plan docs/plans/long.md units U99" }),
    );
    expect(out.status).toBe("aborted");
    expect(out.reply).toBe(
      `🚫 The plan \`docs/plans/long.md\` is longer than ${PLAN_MAX_CHARS.toLocaleString("en-US")} characters at \`main\` in acme/api; its later units would be lost, so nothing was run — split the plan.`,
    );
    expect(h.created).toEqual([]);
    expect(await h.instances.get("plan-long")).toBeNull();
  });
});

describe("Ship admission refusal diagnostics", () => {
  it.each(["incomplete", "unavailable", "owned", "stale"] as const)(
    "retains the exact %s unit refusal without starting a runner",
    async (reason) => {
      const h = harness();
      h.deps.instances.putUnits = async () => ({ ok: false, reason });
      const out = await handOffToCoordinator(h.deps, input());
      expect(out.admissionDiagnostic).toEqual({
        operation: "units_put",
        reason,
        instanceId: "plan-fixture",
        unitCount: 3,
      });
      expect(out.status).toBe("aborted");
      expect(h.created).toEqual([]);
    },
  );
});
