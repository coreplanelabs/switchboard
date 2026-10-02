import { booleanAudienceVerifier } from "../testing/audienceVerifier.js";
import { describe, expect, it } from "vitest";
import { privateWorkerThreadKey } from "../../channels/privateWorker.js";
import { ALL_GRANTS } from "../authz/grants.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import { InMemoryPrivateWorkerLog } from "../privateWorkerLog.js";
import { FollowUpInbox } from "../threadAdmission.js";
import { workProgressTool } from "../../tools/mainWorker.js";
import type { ToolContext } from "../../tools/runnableTool.js";
import { sourceHash } from "../references/receipts.js";
import type { MainWorkRead } from "../coordinator/mainWorkObservation.js";
import {
  mainWorkerCapabilityFor as bindMainWorkerCapabilityFor,
  privateProgressSourceTrusted,
} from "./mainWorkerCapability.js";

type BindArgs = Parameters<typeof bindMainWorkerCapabilityFor>;
const mainWorkerCapabilityFor = (
  deps: BindArgs[0],
  agentName: BindArgs[1],
  msg: BindArgs[2],
  io?: BindArgs[3],
  sourceTrusted: () => boolean = () => true,
) => bindMainWorkerCapabilityFor(deps, agentName, msg, io, sourceTrusted);

const threadKey = "slack:DMAIN:1.0";
const instance: CoordinatorInstance = {
  id: "ship_signup_1",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:DMAIN",
  threadKey,
  repo: "acme/api",
  branch: "ship/signup",
  base: "main",
  plan: { id: "signup" },
  merge: "person",
  createdAt: 1,
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "task",
  slug: "signup",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  workBrief: {
    requesterId: instance.userId,
    mainThreadKey: threadKey,
    actId: "fix-signups",
    repo: instance.repo,
    base: instance.base!,
    question: "How many signups failed?",
    findings: [],
    requestedChange: "Fix signups",
  },
};

async function claimLinkedWork(
  instances: InMemoryCoordinatorInstanceStore,
  linkedInstance: CoordinatorInstance = instance,
  linkedUnit: CoordinatorUnit = unit,
): Promise<void> {
  expect(
    await instances.recordRequesterTurn({
      threadKey,
      requesterId: linkedInstance.userId,
      messageId: "1",
    }),
  ).toMatchObject({ ok: true });
  expect(
    await instances.claimMainTask({ mainThreadKey: threadKey, actId: "fix-signups" }, linkedInstance, linkedUnit, {
      requesterId: linkedInstance.userId,
      sourceMessageId: "1",
      revision: 1,
      repo: linkedInstance.repo,
    }),
  ).toMatchObject({ ok: true });
}

describe("main worker capability", () => {
  it("restores the exact progress observation and refreshes a later canonical settlement", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await claimLinkedWork(instances);
    const deps = {
      config: { grantsFor: () => ALL_GRANTS },
      coordinatorInstances: instances,
      privateWorkerLog: new InMemoryPrivateWorkerLog(),
      clock: () => 20,
    };
    const message = {
      userId: instance.userId,
      channelId: instance.channelId,
      threadKey,
      text: "status?",
      directAudience: {
        kind: "slack-unshared-im" as const,
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey,
      },
    };
    let audience = true;
    const io = { verifyDirectAudience: booleanAudienceVerifier(async () => audience) };
    const reads: MainWorkRead[] = [];
    const capability = await bindMainWorkerCapabilityFor(
      deps,
      "orchestrator",
      message,
      io,
      () => true,
      (read) => {
        reads.push(read);
      },
    );
    const content = await workProgressTool.run(
      { actId: "fix-signups", afterSeq: 0 },
      { executor: {} as ToolContext["executor"], mainWorker: capability, callId: "progress-call" },
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      tool: "work_progress",
      callId: "progress-call",
      input: { actId: "fix-signups", afterSeq: 0 },
      content,
      resultHash: await sourceHash(content),
    });
    const { refresh: _refresh, content: _content, ...receipt } = reads[0]!;
    const restarted = (await bindMainWorkerCapabilityFor(deps, "orchestrator", message, io, () => true))!.restoreRead!(
      JSON.parse(JSON.stringify(receipt)),
    )!;
    expect(await restarted()).toEqual({ kind: "unchanged" });
    await instances.putUnits([{ ...unit, ending: { kind: "aborted", report: "New ending", at: 19 } }]);
    const changed = await restarted();
    expect(changed.kind).toBe("changed");
    if (changed.kind !== "changed") throw new Error("Expected a fresh settlement");
    expect(JSON.parse(changed.content)).toMatchObject({ final: { kind: "aborted" }, asOf: { observedAt: 20 } });
    expect(changed.resultHash).toBe(await sourceHash(changed.content));
    expect(await restarted()).toEqual({ kind: "unchanged" });
    audience = false;
    expect(await restarted()).toEqual({ kind: "unavailable" });
    expect(
      capability!.restoreRead!({
        ...receipt,
        observation: { ...receipt.observation, mainThreadKey: "slack:DOTHER:1.0" },
      }),
    ).toBeUndefined();
  });

  it("keeps private worker reports out of shared and web conversation run events", async () => {
    const deps = {
      config: { grantsFor: () => ALL_GRANTS },
      coordinatorInstances: new InMemoryCoordinatorInstanceStore(),
      privateWorkerLog: new InMemoryPrivateWorkerLog(),
    };
    const shared = { userId: "slack:UALICE", channelId: "slack:CMAIN", threadKey: "slack:CMAIN:1.0", text: "status?" };
    expect(await mainWorkerCapabilityFor(deps, "orchestrator", shared)).toBeUndefined();
    expect(
      await mainWorkerCapabilityFor(deps, "orchestrator", {
        ...shared,
        channelId: "slack:GPRIVATE",
        threadKey: "slack:GPRIVATE:1.0",
      }),
    ).toBeUndefined();
    expect(
      await mainWorkerCapabilityFor(deps, "orchestrator", {
        ...shared,
        userId: "access:alice",
        channelId: "web:alice",
        threadKey: "web:alice:1.0",
      }),
    ).toBeUndefined();
    expect(
      await mainWorkerCapabilityFor(deps, "orchestrator", {
        ...shared,
        channelId: "slack:DMAIN",
        threadKey: "slack:DMAIN:1.0",
        postedBy: "slack:bot:B0RELAY",
      }),
    ).toBeUndefined();
    expect(
      await mainWorkerCapabilityFor(deps, "orchestrator", {
        ...shared,
        channelId: "slack:DMAIN",
        threadKey: "slack:DMAIN:1.0",
        authenticatedAs: "http:operator",
      }),
    ).toBeUndefined();
    expect(
      await mainWorkerCapabilityFor(deps, "orchestrator", {
        ...shared,
        channelId: "slack:DMAIN",
        threadKey: "slack:DMAIN:1.0",
        relayedBy: "external bot",
      }),
    ).toBeUndefined();
  });

  it("binds a later main turn to the resolved requester and current thread", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await claimLinkedWork(instances);
    const log = new InMemoryPrivateWorkerLog();
    await log.append(privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }), {
      kind: "status",
      phase: "start",
      frame: { title: "Working" },
      at: 2,
    });
    const deps = { config: { grantsFor: () => ALL_GRANTS }, coordinatorInstances: instances, privateWorkerLog: log };
    const message = {
      userId: instance.userId,
      channelId: instance.channelId,
      threadKey,
      text: "status?",
      directAudience: {
        kind: "slack-unshared-im" as const,
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey,
      },
    };
    const io = { verifyDirectAudience: booleanAudienceVerifier(async () => true) };
    const first = await mainWorkerCapabilityFor(deps, "orchestrator", message, io);
    expect(first).toBeDefined();
    expect(await first!.read({ actId: "fix-signups" })).toMatchObject({
      kind: "found",
      cursor: 1,
      progress: [{ title: "Working" }],
    });
    expect(
      await (await mainWorkerCapabilityFor(
        deps,
        "orchestrator",
        {
          ...message,
          userId: "slack:UBOB",
          directAudience: { ...message.directAudience, userId: "slack:UBOB" },
        },
        io,
      ))!.read({
        actId: "fix-signups",
      }),
    ).toEqual({ kind: "not_found" });
    expect(
      await (await mainWorkerCapabilityFor(
        deps,
        "orchestrator",
        {
          ...message,
          threadKey: "slack:DMAIN:2.0",
          directAudience: { ...message.directAudience, threadKey: "slack:DMAIN:2.0" },
        },
        io,
      ))!.read({
        actId: "fix-signups",
      }),
    ).toEqual({ kind: "not_found" });
    expect(await mainWorkerCapabilityFor(deps, "coding", message, io)).toBeUndefined();
    expect(
      await mainWorkerCapabilityFor({ ...deps, privateWorkerLog: undefined }, "orchestrator", message, io),
    ).toBeUndefined();
  });

  it("hides private progress for an unverified, shared, external, or pending Slack D conversation", async () => {
    const deps = {
      config: { grantsFor: () => ALL_GRANTS },
      coordinatorInstances: new InMemoryCoordinatorInstanceStore(),
      privateWorkerLog: new InMemoryPrivateWorkerLog(),
    };
    const msg = {
      userId: instance.userId,
      channelId: instance.channelId,
      threadKey,
      text: "status?",
    };
    const directAudience = {
      kind: "slack-unshared-im" as const,
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey,
    };
    expect(
      await mainWorkerCapabilityFor(deps, "orchestrator", msg, {
        verifyDirectAudience: booleanAudienceVerifier(async () => true),
      }),
    ).toBeUndefined();
    for (const state of ["shared", "external", "pending", "metadata unavailable"]) {
      const io = { verifyDirectAudience: booleanAudienceVerifier(async () => state === "unshared") };
      expect(await mainWorkerCapabilityFor(deps, "orchestrator", { ...msg, directAudience }, io)).toBeUndefined();
    }
    expect(await mainWorkerCapabilityFor(deps, "orchestrator", { ...msg, directAudience })).toBeUndefined();
    expect(
      await mainWorkerCapabilityFor(
        deps,
        "orchestrator",
        { ...msg, directAudience },
        {
          verifyDirectAudience: booleanAudienceVerifier(async () => {
            throw new Error("Slack lookup unavailable");
          }),
        },
      ),
    ).toBeUndefined();
    expect(
      await mainWorkerCapabilityFor(
        deps,
        "orchestrator",
        {
          ...msg,
          directAudience: { ...directAudience, userId: "slack:UBOB" },
        },
        { verifyDirectAudience: booleanAudienceVerifier(async () => true) },
      ),
    ).toBeUndefined();
    expect(
      await mainWorkerCapabilityFor(
        deps,
        "orchestrator",
        { ...msg, directAudience, relayedBy: "external bot" },
        { verifyDirectAudience: booleanAudienceVerifier(async () => true) },
      ),
    ).toBeUndefined();
  });

  it("rechecks the direct audience on every private read and denies a changed audience", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await claimLinkedWork(instances);
    const log = new InMemoryPrivateWorkerLog();
    await log.append(privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }), {
      kind: "status",
      phase: "start",
      frame: { title: "Working" },
      at: 2,
    });
    const deps = { config: { grantsFor: () => ALL_GRANTS }, coordinatorInstances: instances, privateWorkerLog: log };
    const msg = {
      userId: instance.userId,
      channelId: instance.channelId,
      threadKey,
      text: "status?",
      directAudience: {
        kind: "slack-unshared-im" as const,
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey,
      },
    };
    let verified = true;
    let calls = 0;
    const io = {
      verifyDirectAudience: booleanAudienceVerifier(async () => {
        calls++;
        return verified;
      }),
    };
    const cap = await mainWorkerCapabilityFor(deps, "orchestrator", msg, io);
    expect(cap).toBeDefined();
    expect(await cap!.read({ actId: "fix-signups" })).toMatchObject({
      kind: "found",
      progress: [{ title: "Working" }],
    });
    verified = false;
    expect(await cap!.read({ actId: "fix-signups" })).toEqual({ kind: "unavailable" });
    expect(calls).toBe(4);
  });

  it("drops a private result when the audience changes during a read", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await claimLinkedWork(instances);
    const log = new InMemoryPrivateWorkerLog();
    await log.append(privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }), {
      kind: "status",
      phase: "start",
      frame: { title: "Working" },
      at: 2,
    });
    const deps = { config: { grantsFor: () => ALL_GRANTS }, coordinatorInstances: instances, privateWorkerLog: log };
    const msg = {
      userId: instance.userId,
      channelId: instance.channelId,
      threadKey,
      text: "status?",
      directAudience: {
        kind: "slack-unshared-im" as const,
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey,
      },
    };
    let calls = 0;
    const io = { verifyDirectAudience: booleanAudienceVerifier(async () => ++calls < 3) };
    const cap = await mainWorkerCapabilityFor(deps, "orchestrator", msg, io);
    expect(cap).toBeDefined();
    expect(await cap!.read({ actId: "fix-signups" })).toEqual({ kind: "unavailable" });
    expect(calls).toBe(3);
  });

  it("accepts a verified Slack W requester on its own linked work", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    const userId = "slack:WALICE";
    await claimLinkedWork(
      instances,
      { ...instance, userId },
      { ...unit, workBrief: { ...unit.workBrief!, requesterId: userId } },
    );
    const deps = {
      config: { grantsFor: () => ALL_GRANTS },
      coordinatorInstances: instances,
      privateWorkerLog: new InMemoryPrivateWorkerLog(),
    };
    const msg = {
      userId,
      channelId: instance.channelId,
      threadKey,
      text: "status?",
      directAudience: { kind: "slack-unshared-im" as const, channelId: instance.channelId, userId, threadKey },
    };
    const cap = await mainWorkerCapabilityFor(deps, "orchestrator", msg, {
      verifyDirectAudience: booleanAudienceVerifier(async () => true),
    });
    expect(cap).toBeDefined();
    expect(await cap!.read({ actId: "fix-signups" })).toMatchObject({ kind: "found" });
  });

  it("permanently revokes private reads when an app follow-up joins the main run", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    await claimLinkedWork(instances);
    const log = new InMemoryPrivateWorkerLog();
    await log.append(privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }), {
      kind: "status",
      phase: "start",
      frame: { title: "Private progress" },
      at: 2,
    });
    const inbox = new FollowUpInbox();
    const deps = { config: { grantsFor: () => ALL_GRANTS }, coordinatorInstances: instances, privateWorkerLog: log };
    const msg = {
      userId: instance.userId,
      channelId: instance.channelId,
      threadKey,
      text: "status?",
      directAudience: {
        kind: "slack-unshared-im" as const,
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey,
      },
    };
    const cap = await mainWorkerCapabilityFor(
      deps,
      "orchestrator",
      msg,
      { verifyDirectAudience: booleanAudienceVerifier(async () => true) },
      privateProgressSourceTrusted(msg.userId, inbox),
    );
    expect(await cap!.read({ actId: "fix-signups" })).toMatchObject({ kind: "found" });
    inbox.push({ text: "fix it", userId: msg.userId, postedBy: "slack:bot:B1", at: 3 });
    inbox.drain();
    expect(await cap!.read({ actId: "fix-signups" })).toEqual({ kind: "unavailable" });
    inbox.push({ text: "same person", userId: msg.userId, at: 4 });
    expect(await cap!.read({ actId: "fix-signups" })).toEqual({ kind: "unavailable" });
  });

  it("keeps a resumed main run private only when its durable inputs prove one source", () => {
    const inbox = new FollowUpInbox();
    expect(privateProgressSourceTrusted("slack:UX", inbox, [{ type: "input" }])()).toBe(true);
    expect(privateProgressSourceTrusted("slack:UX", inbox, [])()).toBe(false);
    expect(privateProgressSourceTrusted("slack:UX", inbox, [{ type: "input" }, { type: "input" }])()).toBe(false);
    inbox.push({ text: "from worker", userId: "slack:UX", from: { runId: "worker-1" }, at: 3 });
    inbox.drain();
    expect(privateProgressSourceTrusted("slack:UX", inbox, [{ type: "input" }])()).toBe(false);
  });
});
