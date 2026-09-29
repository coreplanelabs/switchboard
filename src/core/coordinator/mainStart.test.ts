import { describe, expect, it } from "vitest";
import { ALL_GRANTS } from "../authz/grants.js";
import type { Actor } from "../authz/types.js";
import type { IncomingMessage } from "../types.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { createMainTaskStarter, type MainStartDeps, type MainStartInput } from "./mainStart.js";

const msg: IncomingMessage = {
  channelId: "slack:D123",
  userId: "slack:U123",
  threadKey: "slack:D123:1700000000.000001",
  messageId: "1700000000.000002",
  text: "fix it",
};
const actor: Actor = {
  kind: "user",
  id: msg.userId,
  origin: { channelId: msg.channelId, threadKey: msg.threadKey },
  grants: ALL_GRANTS,
};
const brief = {
  question: "How many signups failed yesterday?",
  findings: [
    {
      kind: "analysis" as const,
      text: "17 of 120 failed",
      query: "SELECT count(*) FROM signups WHERE failed = true",
      result: "17 failures among 120 attempts",
      timeWindow: "yesterday UTC",
      sourceUrl: "https://example.com/metrics/signups",
    },
  ],
  requestedChange: "Fix failed signups and add a regression test",
  acceptance: "A reviewed PR explains the cause and test",
};

function harness(over: Partial<MainStartDeps> = {}) {
  const instances = new InMemoryCoordinatorInstanceStore();
  const created: string[] = [];
  const deps: MainStartDeps = {
    instances,
    readFile: async () => ({ content: "" }),
    create: async (id) => {
      created.push(id);
      return { kind: "created", id };
    },
    status: async () => ({ kind: "status", status: "running" }),
    repoInfo: async () => ({ defaultBranch: "main" }),
    canUseRepo: () => true,
    canRunAgent: () => true,
    adminsHint: () => "an admin",
    privateWorkerAvailable: true,
    caps: { maxRounds: 3, maxMinutes: 45 },
    clock: () => 1_700_000_000_000,
    ...over,
  };
  const start = createMainTaskStarter(deps);
  const input = {
    actor,
    msg,
    mainRunId: "main-run-1",
    repo: "acme/api",
    brief,
    stillLive: () => true,
    stillPrivate: async () => true,
  };
  return { start, input, instances, created };
}

describe("main-agent private worker start", () => {
  it("binds a plain-language fix and sourced findings to one fresh person-merged unit", async () => {
    const h = harness();
    const out = await h.start(h.input);
    expect(out.kind).toBe("accepted");
    if (out.kind !== "accepted") return;
    const instance = await h.instances.get(out.instanceId);
    const units = await h.instances.listUnits(out.instanceId);
    expect(instance).toMatchObject({
      kind: "ship",
      userId: msg.userId,
      repo: "acme/api",
      base: "main",
      merge: "person",
    });
    expect(instance?.runId).toBeUndefined();
    expect(units).toHaveLength(1);
    expect(units[0]?.workBrief).toMatchObject({
      requesterId: msg.userId,
      mainThreadKey: msg.threadKey,
      actId: out.actId,
      question: brief.question,
      findings: brief.findings,
      requestedChange: brief.requestedChange,
    });
  });

  it("repeats one user message without starting a second worker or replacing evidence", async () => {
    const h = harness();
    const first = await h.start(h.input);
    const second = await h.start({ ...h.input, brief: { ...brief, requestedChange: "Different task" } });
    expect(first.kind).toBe("accepted");
    expect(second.kind).toBe("accepted");
    if (first.kind !== "accepted" || second.kind !== "accepted") return;
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.actId).toBe(first.actId);
    expect(h.created).toEqual([first.instanceId]);
    expect((await h.instances.listUnits(first.instanceId))[0]?.workBrief?.requestedChange).toBe(brief.requestedChange);
  });

  it("treats task prose that resembles a plan command as a person-merged fix", async () => {
    const h = harness();
    const out = await h.start({
      ...h.input,
      brief: { ...brief, requestedChange: "plan docs/fix-signups.md" },
    });
    expect(out.kind).toBe("accepted");
    if (out.kind !== "accepted") return;
    const instance = await h.instances.get(out.instanceId);
    const units = await h.instances.listUnits(out.instanceId);
    expect(instance?.merge).toBe("person");
    expect(instance?.plan?.path).toBeUndefined();
    expect(units).toHaveLength(1);
    expect(units[0]?.workBrief?.requestedChange).toBe("plan docs/fix-signups.md");
  });

  it("refuses foreign origins, unbound messages, denied repositories, and absent private IO before claiming", async () => {
    const cases: Array<Partial<MainStartDeps> | "foreign" | "unbound"> = [
      { canUseRepo: () => false },
      { privateWorkerAvailable: false },
      { canRunAgent: (_, name) => name !== "review" },
      "foreign",
      "unbound",
    ];
    for (const over of cases) {
      const h = harness(typeof over === "string" ? {} : over);
      const input =
        over === "foreign"
          ? { ...h.input, actor: { ...actor, origin: { channelId: "slack:DOTHER", threadKey: msg.threadKey } } }
          : over === "unbound"
            ? { ...h.input, msg: { ...msg, messageId: undefined } }
            : h.input;
      expect((await h.start(input)).kind).toBe("refused");
      expect(h.created).toEqual([]);
    }
  });

  it("refuses a stopped main run or lost private audience before claiming", async () => {
    const h = harness();
    expect((await h.start({ ...h.input, stillLive: () => false })).kind).toBe("refused");
    expect((await h.start({ ...h.input, stillPrivate: async () => false })).kind).toBe("refused");
    expect(
      (
        await h.start({
          ...h.input,
          stillPrivate: async () => {
            throw new Error("offline");
          },
        })
      ).kind,
    ).toBe("refused");
    expect(h.created).toEqual([]);
  });

  it("refuses a missing or indeterminate main-run fence before claiming", async () => {
    const h = harness();
    const { stillLive: _omitted, ...withoutFence } = h.input;
    for (const input of [
      withoutFence as MainStartInput,
      { ...h.input, stillLive: () => undefined as unknown as boolean },
      {
        ...h.input,
        stillLive: () => {
          throw new Error("run status unavailable");
        },
      },
    ]) {
      expect((await h.start(input)).kind).toBe("refused");
      expect(h.created).toEqual([]);
    }
  });

  it("rechecks the main-run fence after async preflight before claiming", async () => {
    let live = true;
    const h = harness({
      repoInfo: async () => {
        live = false;
        return { defaultBranch: "main" };
      },
    });
    expect((await h.start({ ...h.input, stillLive: () => live })).kind).toBe("refused");
    expect(h.created).toEqual([]);
  });
});
