import { describe, expect, it, vi } from "vitest";
import { ALL_GRANTS } from "../authz/grants.js";
import type { Actor } from "../authz/types.js";
import type { IncomingMessage } from "../types.js";
import { InMemoryPrivateWorkerLog } from "../privateWorkerLog.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { createMainTaskStarter, type MainStartDeps, type MainStartInput } from "./mainStart.js";
import { workStartTool } from "../../tools/mainStart.js";
import type { ToolContext } from "../../tools/runnableTool.js";
import { contractFor } from "./briefs.js";

const msg: IncomingMessage = {
  channelId: "slack:D123",
  userId: "slack:U123",
  threadKey: "slack:D123:1700000000.000001",
  directAudience: {
    kind: "slack-unshared-im",
    channelId: "slack:D123",
    userId: "slack:U123",
    threadKey: "slack:D123:1700000000.000001",
  },
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
  schemaVersion: 1 as const,
  cause: { kind: "unknown" as const, reason: "The failure has not been investigated" },
  evidence: { availability: "provided" as const },
  requirements: { analysis: "required" as const, evidence: "required" as const },
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
  void instances.recordRequesterTurn({
    threadKey: msg.threadKey,
    requesterId: msg.userId,
    messageId: msg.messageId!,
  });
  const created: string[] = [];
  const deps: MainStartDeps = {
    instances,
    privateWorkerLog: new InMemoryPrivateWorkerLog(),
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
    authorizedRepo: "acme/api",
    authority: {
      requesterId: msg.userId,
      sourceMessageId: msg.messageId!,
      revision: 1,
      repo: "acme/api",
    },
    brief,
    stillLive: () => true,
    stillPrivate: async () => true,
  };
  return { start, input, instances, created };
}

describe("main-agent private worker start", () => {
  it("a lost create reply leaves one saved act and stays pending when same-id status alone cannot attribute private work", async () => {
    const created: string[] = [];
    let status: "unanswered" | "running" = "unanswered";
    const h = harness({
      create: async (id) => {
        created.push(id);
        return { kind: "unanswered", reason: "create reply lost" };
      },
      status: async () =>
        status === "running"
          ? { kind: "status", status: "running" }
          : { kind: "unanswered", reason: "status unavailable" },
    });
    const first = await h.start(h.input);
    expect(first).toMatchObject({
      kind: "pending",
      actId: expect.stringMatching(/^m_/),
      instanceId: expect.any(String),
    });
    if (first.kind !== "pending") throw new Error("pending admission expected");
    expect(await h.instances.getMainTask({ mainThreadKey: msg.threadKey, actId: first.actId })).toMatchObject({
      instanceId: first.instanceId,
      unit: expect.any(String),
    });

    const replay = await workStartTool.run(
      { repo: h.input.repo, sourceMessage: "fix it", ...brief, requestedChange: "Different wording" },
      {
        mainStart: {
          start: async () => h.start({ ...h.input, brief: { ...brief, requestedChange: "Different wording" } }),
        },
      } as unknown as ToolContext,
    );
    expect(replay).toContain(first.actId);
    expect(replay).toContain("pending");
    expect(replay).not.toContain("nothing ran");
    expect(created).toEqual([first.instanceId]);

    status = "running";
    const observed = await h.start({ ...h.input, brief: { ...brief, requestedChange: "More changed wording" } });
    expect(observed).toMatchObject({ kind: "pending", actId: first.actId, instanceId: first.instanceId });
    expect(observed.reply).not.toContain("already owns");
    expect(created).toEqual([first.instanceId]);
  });

  it("preserves typed tool evidence through resolved admission storage and child rendering", async () => {
    const h = harness();
    let instanceId = "";
    const finding = { ...brief.findings[0]!, query: "SELECT failures WHERE budget:900", result: "17 of 120" };
    const result = await workStartTool.run(
      { repo: h.input.repo, sourceMessage: "fix it", ...brief, findings: [finding] },
      {
        mainStart: {
          start: async (repo: string, proposal: MainStartInput["brief"]) => {
            const out = await h.start({ ...h.input, repo, brief: proposal });
            if (out.kind === "accepted") instanceId = out.instanceId;
            return out;
          },
        },
      } as unknown as ToolContext,
    );
    expect(result).toContain("Started one private worker");
    const instance = (await h.instances.get(instanceId))!;
    const unit = (await h.instances.listUnits(instanceId))[0]!;
    expect(unit.workBrief).toMatchObject({
      schemaVersion: 1,
      findings: [finding],
      acceptance: brief.acceptance,
      cause: brief.cause,
    });
    const child = await contractFor(instance, unit, { readRepoFile: async () => undefined } as unknown as Parameters<
      typeof contractFor
    >[2]);
    expect(child.unit.section).toContain("17 of 120");
    expect(child.unit.section).toContain(finding.timeWindow);
    expect(child.unit.section).toContain(finding.sourceUrl);
    expect(child.unit.section).not.toContain("budget:900");
    expect(child.unit.section).toContain("Cause: unknown");
  });
  it("returns typed brief issues before claiming incomplete or mislabeled evidence", async () => {
    for (const [patch, code] of [
      [{ acceptance: undefined }, "acceptance_required"],
      [{ cause: undefined }, "cause_required"],
      [{ findings: [] }, "evidence_required"],
      [{ findings: [{ ...brief.findings[0], kind: "observation" }] }, "finding_shape"],
      [
        { findings: [{ kind: "observation", text: "A failure", sourceUrl: "https://example.com/failure" }] },
        "analysis_required",
      ],
      [{ evidence: { availability: "unavailable", reason: "Source offline" }, findings: [] }, "analysis_required"],
      [{ schemaVersion: undefined }, "schema_version"],
    ] as const) {
      const h = harness();
      const claim = vi.spyOn(h.instances, "claimMainTask");
      const out = await h.start({ ...h.input, brief: { ...brief, ...patch } as unknown as MainStartInput["brief"] });
      expect(out).toMatchObject({
        kind: "refused",
        issues: expect.arrayContaining([expect.objectContaining({ code })]),
      });
      expect(h.created).toEqual([]);
      expect(claim).not.toHaveBeenCalled();
    }
  });

  it("admits explicit unknown cause and unavailable evidence only under the declared policy", async () => {
    const h = harness();
    const out = await h.start({
      ...h.input,
      brief: {
        ...brief,
        findings: [],
        evidence: { availability: "unavailable", reason: "No source evidence is needed for this code-only change" },
        requirements: { analysis: "not_required", evidence: "may_be_unavailable" },
      } as unknown as MainStartInput["brief"],
    });
    expect(out.kind).toBe("accepted");
    if (out.kind !== "accepted") return;
    expect((await h.instances.listUnits(out.instanceId))[0]?.workBrief).toMatchObject({
      schemaVersion: 1,
      cause: { kind: "unknown" },
      evidence: { availability: "unavailable" },
    });
  });
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
    expect(second.kind).toBe("existing");
    if (first.kind !== "accepted" || second.kind !== "existing") return;
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.actId).toBe(first.actId);
    expect(h.created).toEqual([first.instanceId]);
    expect((await h.instances.listUnits(first.instanceId))[0]?.workBrief?.requestedChange).toBe(brief.requestedChange);
  });

  it("refuses a model-selected repository outside the trusted request target", async () => {
    const h = harness();
    const result = await h.start({ ...h.input, repo: "acme/web" });
    expect(result.kind).toBe("refused");
    expect(h.created).toEqual([]);
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
      { privateWorkerLog: undefined },
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
  it("refuses work if a direct conversation becomes shared during repository preflight", async () => {
    let releasePreflight: (() => void) | undefined;
    let enteredPreflight: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => (enteredPreflight = resolve));
    const h = harness({
      repoInfo: async () => {
        enteredPreflight?.();
        await new Promise<void>((resolve) => (releasePreflight = resolve));
        return { defaultBranch: "main" };
      },
    });
    let privateNow = true;
    const pending = h.start({ ...h.input, stillPrivate: async () => privateNow });
    await entered;
    privateNow = false;
    releasePreflight?.();
    expect((await pending).kind).toBe("refused");
    expect(h.created).toEqual([]);
  });

  it("rechecks privacy after a durable claim and before Workflow creation", async () => {
    const h = harness();
    let privateNow = true;
    const originalClaim = h.instances.claimMainTask.bind(h.instances);
    h.instances.claimMainTask = async (...args) => {
      const result = await originalClaim(...args);
      privateNow = false;
      return result;
    };
    const result = await h.start({ ...h.input, stillPrivate: async () => privateNow });
    expect(result.kind).toBe("refused");
    expect(h.created).toEqual([]);
  });

  it("does not claim work when the main run stops during the privacy check", async () => {
    const h = harness();
    const originalClaim = h.instances.claimMainTask.bind(h.instances);
    let claimed = false;
    h.instances.claimMainTask = async (...args) => {
      claimed = true;
      return originalClaim(...args);
    };
    let entered!: () => void;
    const atGate = new Promise<void>((resolve) => (entered = resolve));
    let release!: (value: boolean) => void;
    let checks = 0;
    let live = true;
    const pending = h.start({
      ...h.input,
      stillLive: () => live,
      stillPrivate: () => {
        if (++checks !== 2) return Promise.resolve(true);
        entered();
        return new Promise<boolean>((resolve) => (release = resolve));
      },
    });
    await atGate;
    live = false;
    release(true);
    expect((await pending).kind).toBe("refused");
    expect(claimed).toBe(false);
    expect(h.created).toEqual([]);
  });

  it("does not start a Workflow when the main run stops during the last privacy check", async () => {
    const h = harness();
    let entered!: () => void;
    const atGate = new Promise<void>((resolve) => (entered = resolve));
    let release!: (value: boolean) => void;
    let checks = 0;
    let live = true;
    const pending = h.start({
      ...h.input,
      stillLive: () => live,
      stillPrivate: () => {
        if (++checks !== 3) return Promise.resolve(true);
        entered();
        return new Promise<boolean>((resolve) => (release = resolve));
      },
    });
    await atGate;
    live = false;
    release(true);
    expect((await pending).kind).toBe("refused");
    expect(h.created).toEqual([]);
  });

  it("does not retry a linked Workflow when the main run stops during its privacy check", async () => {
    const h = harness({ status: async () => ({ kind: "absent" }) });
    expect((await h.start(h.input)).kind).toBe("accepted");
    let entered!: () => void;
    const atGate = new Promise<void>((resolve) => (entered = resolve));
    let release!: (value: boolean) => void;
    let checks = 0;
    let live = true;
    const pending = h.start({
      ...h.input,
      stillLive: () => live,
      stillPrivate: () => {
        if (++checks !== 2) return Promise.resolve(true);
        entered();
        return new Promise<boolean>((resolve) => (release = resolve));
      },
    });
    await atGate;
    live = false;
    release(true);
    expect((await pending).kind).toBe("refused");
    expect(h.created).toHaveLength(1);
  });
});
