import { analyzeRunFriction } from "../runFriction.js";
import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
const request = {
  effectKey: "org:request:1",
  digest: "a".repeat(64),
  requester: "access:alice",
  threadKey: "http:home:alice",
  request: { text: "Start original work", authenticatedAs: "access:alice" },
  contentExpiresAt: 100,
};
const receiverRecord = {
  channelVisibility: "unknown" as const,
  id: "receiver",
  channelId: "http:home",
  userId: request.requester,
  threadKey: request.threadKey,
  startedAt: 1,
  finishedAt: 2,
  status: "completed" as const,
  eventCount: 0,
  storedEventCount: 0,
  truncated: false,
  events: [],
  diagnosis: analyzeRunFriction([]),
};
const origin = {
  version: 1 as const,
  organization: "org:test",
  source: "http" as const,
  sourceEvent: "original",
  key: "once",
  digest: request.digest,
  actor: {
    identity: { issuer: "http:test", tenant: null, subject: "alice" },
    kind: "human" as const,
    principal: "access:alice",
    stream: "stream:alice",
    bindingRevision: 0,
    onBehalfOf: null,
  },
  destination: { kind: "broad" as const },
  workload: "message" as const,
  target: null,
  content: "",
  context: [],
  sourceReference: {
    actorId: "access:alice",
    userId: "access:alice",
    channelId: "http:home",
    threadKey: request.threadKey,
    credentialDigest: "c".repeat(64),
  },
};
describe("original ingress owner", () => {
  it.each(["completed", "content cleared", "pending", "uncertain", "refusal", "live custody", "dependent consumer"])(
    "bounds unread continuation metadata after its original horizon: %s",
    async (kind) => {
      let now = 1;
      const ledger = new InMemoryRunLedger(() => now);
      const input = { ...request, origin, originExpiresAt: 365 };
      const owned = await ledger.consumeIngress(input);
      if (owned.status !== "claimed") throw new Error("original owner not claimed");
      const profile = { preset: "general", machine: "none" as const, identity: "none" as const, minutes: 1 };
      const claim = (runId: string, state = {}) =>
        ledger.claim({
          runId,
          gen: "g",
          threadKey: input.threadKey,
          leaseMs: 30000,
          startedAt: 1,
          meta: { channelId: "http:home", userId: input.requester, threadKey: input.threadKey, profile },
          state,
          system: "",
          tools: [],
          card: null,
        });
      expect(await claim("receiver")).toMatchObject({ ok: true });
      const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
      const { durableInboxMessage } = await import("./inboxMessage.js");
      const message = withOriginalOrganizationDispatch(
        { channelId: "http:home", userId: input.requester, threadKey: input.threadKey, text: "Start original work" },
        { ingressRunId: owned.record.runId, organizationSequence: 7 },
      );
      expect(await ledger.pushInbox("receiver", durableInboxMessage(message, message.text, 1))).toMatchObject({
        ok: true,
        seq: 1,
      });
      expect(
        await ledger.holdUnreadIngress({
          ingressRunId: owned.record.runId,
          receiverRunId: "receiver",
          receiverGen: "g",
          inboxSeq: 1,
        }),
      ).toMatchObject({ status: "record", record: { unread: { status: "pending" } } });
      expect(await ledger.finish("receiver", "g", receiverRecord)).toMatchObject({ ok: true });
      if (kind !== "pending")
        expect(await ledger.claimUnreadIngress(owned.record.runId)).toMatchObject({
          status: "claimed",
          record: { runId: owned.record.runId, unread: { status: "claimed" } },
        });
      if (kind !== "pending" && kind !== "uncertain") {
        expect(await claim(owned.record.runId)).toMatchObject({ ok: true });
        if (kind !== "live custody")
          expect(
            await ledger.finish(owned.record.runId, "g", {
              ...receiverRecord,
              id: owned.record.runId,
              profile,
              answerOutcome: { version: 1, ending: "answered", output: "absent" },
            }),
          ).toMatchObject({ ok: true });
      }
      const status = kind === "uncertain" ? "uncertain" : "completed";
      expect(
        await ledger.finishIngress({
          effectKey: input.effectKey,
          digest: input.digest,
          runId: owned.record.runId,
          status,
          outcome: "Original continuation returned.",
          ...(kind === "refusal" ? { refusalPending: true } : {}),
        }),
      ).toMatchObject({ status: "record", record: { status } });
      if (kind === "content cleared")
        expect(await ledger.clearIngressContent(input.effectKey)).toMatchObject({
          status: "record",
          record: { request: null, unread: { status: "claimed" } },
        });
      if (kind === "dependent consumer")
        expect(
          await claim("consumer", {
            contextDependencies: {
              version: 3,
              status: "known",
              revision: 1,
              origins: [],
              slack: [],
              mcp: [],
              nativeMediaSources: [
                {
                  executionRunId: "execution-source",
                  executionSequence: 2,
                  reference: {
                    version: 1,
                    kind: "confirmed",
                    sourceRunId: owned.record.runId,
                    sourceSequence: 1,
                    sourceDigest: input.digest,
                    confirmationId: "saved-choice",
                    intentDigest: "b".repeat(64),
                  },
                },
              ],
            },
          }),
        ).toMatchObject({ ok: true });
      now = 364;
      expect(await ledger.consumeIngress(input)).toMatchObject({
        status: "duplicate",
        record: { runId: owned.record.runId, status, unread: { status: kind === "pending" ? "pending" : "claimed" } },
      });
      expect(await ledger.readIngressByRun(owned.record.runId)).toMatchObject({
        status: "record",
        record: { runId: owned.record.runId, origin: { sourceEvent: "original" } },
      });
      now = 365;
      if (kind === "completed" || kind === "content cleared") {
        expect(await ledger.readIngress(input.effectKey)).toEqual({ status: "not_found" });
        expect(await ledger.readIngressByRun(owned.record.runId)).toEqual({ status: "not_found" });
        expect(await ledger.consumeIngress(input)).toEqual({ status: "invalid" });
      } else {
        expect(await ledger.readIngress(input.effectKey)).toMatchObject({
          status: "record",
          record: { runId: owned.record.runId, status, request: null },
        });
        expect(await ledger.consumeIngress(input)).toMatchObject({
          status: "duplicate",
          record: { runId: owned.record.runId },
        });
      }
      expect(await ledger.claimUnreadIngress(owned.record.runId)).toEqual({
        status: kind === "completed" || kind === "content cleared" ? "not_found" : "fenced",
      });
    },
  );
  it("never resets a deletion deadline from retry, policy or request-body changes", async () => {
    let now = 1;
    const ledger = new InMemoryRunLedger(() => now);
    const input = {
      ...request,
      origin,
      originExpiresAt: 50,
      contentExpiresAt: 1000,
      request: { ...request.request, protection: { expiresAt: 1 } },
    };
    expect(await ledger.clearIngressContent(request.effectKey, { expiresAt: 50, receiptTtlMs: 900 })).toEqual({
      status: "not_found",
    });
    now = 20;
    expect(await ledger.clearIngressContent(request.effectKey, { expiresAt: 900, receiptTtlMs: 9000 })).toEqual({
      status: "not_found",
    });
    now = 49;
    expect(await ledger.consumeIngress(input)).toEqual({ status: "fenced" });
    now = 50;
    expect(await ledger.consumeIngress(input)).toEqual({ status: "invalid" });
  });
  it.each(["known none", "unknown ending", "missing ending", "changed profile"] as const)(
    "retires terminal metadata only for canonical %s evidence",
    async (caseName) => {
      let now = 1;
      const ledger = new InMemoryRunLedger(() => now);
      const owned = await ledger.consumeIngress({ ...request, origin, originExpiresAt: 365 });
      if (owned.status !== "claimed") throw new Error("owner not claimed");
      const profile = { preset: "general", machine: "none" as const, identity: "none" as const, minutes: 1 };
      expect(
        await ledger.claim({
          runId: owned.record.runId,
          gen: "g",
          threadKey: request.threadKey,
          leaseMs: 30000,
          startedAt: 1,
          meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey, profile },
          state: {},
          system: "",
          tools: [],
          card: null,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await ledger.finish(owned.record.runId, "g", {
          ...receiverRecord,
          id: owned.record.runId,
          profile: caseName === "changed profile" ? { ...profile, machine: "repo-cold" } : profile,
          ...(caseName === "missing ending"
            ? {}
            : {
                answerOutcome: {
                  version: 1,
                  ending: caseName === "unknown ending" ? "unknown" : "answered",
                  output: "absent",
                },
              }),
        }),
      ).toMatchObject({ ok: true });
      await ledger.finishIngress({
        effectKey: request.effectKey,
        digest: request.digest,
        runId: owned.record.runId,
        status: "completed",
        outcome: "handler returned",
      });
      now = 365;
      expect((await ledger.readIngress(request.effectKey)).status).toBe(
        caseName === "known none" ? "not_found" : "record",
      );
      expect(await ledger.consumeIngress({ ...request, origin, originExpiresAt: 365 })).toMatchObject({
        status: caseName === "known none" ? "invalid" : "duplicate",
      });
    },
  );
  it("preserves an expired source owner required by an exact retained native A/B/C dependency", async () => {
    let now = 1;
    const ledger = new InMemoryRunLedger(() => now);
    const owned = await ledger.consumeIngress({ ...request, origin, originExpiresAt: 365 });
    if (owned.status !== "claimed") throw new Error("owner not claimed");
    await ledger.finishIngress({
      effectKey: request.effectKey,
      digest: request.digest,
      runId: owned.record.runId,
      status: "completed",
      outcome: "handler returned",
    });
    const context = {
      version: 3 as const,
      status: "known" as const,
      revision: 1,
      origins: [],
      slack: [],
      mcp: [],
      nativeMediaSources: [
        {
          executionRunId: "source-B",
          executionSequence: 2,
          reference: {
            version: 1 as const,
            kind: "confirmed" as const,
            sourceRunId: owned.record.runId,
            sourceSequence: 1,
            sourceDigest: "a".repeat(64),
            confirmationId: "saved-choice",
            intentDigest: "b".repeat(64),
          },
        },
      ],
    };
    expect(
      await ledger.claim({
        runId: "consumer-C",
        gen: "g",
        threadKey: request.threadKey,
        leaseMs: 30000,
        startedAt: 1,
        meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey },
        state: { contextDependencies: context },
        system: "",
        tools: [],
        card: null,
      }),
    ).toMatchObject({ ok: true });
    now = 365;
    expect(await ledger.readIngress(request.effectKey)).toMatchObject({
      status: "record",
      record: { runId: owned.record.runId },
    });
    // A malformed retained dependency cannot become a pruning permission.
    ledger.live.get("consumer-C")!.state.contextDependencies = {
      ...context,
      nativeMediaSources: [
        {
          ...context.nativeMediaSources[0],
          reference: { ...context.nativeMediaSources[0]!.reference, sourceDigest: "bad" },
        },
      ],
    };
    expect(await ledger.readIngress(request.effectKey)).toMatchObject({
      status: "record",
      record: { runId: owned.record.runId },
    });
  });
  it.each(["ordinary", "target answer", "saved confirmation"] as const)(
    "retires completed %s owner metadata after its receipt horizon",
    async (kind) => {
      let now = 1;
      const ledger = new InMemoryRunLedger(() => now);
      const input = {
        ...request,
        effectKey: `expired:${kind}`,
        origin: {
          ...origin,
          ...(kind === "target answer" ? { target: { key: "unit:question", revision: 1 } } : {}),
          ...(kind === "saved confirmation"
            ? {
                workload: "act" as const,
                continuation: { kind: "confirm" as const, id: "00000000-0000-4000-8000-000000000001" },
              }
            : {}),
        },
        originExpiresAt: 365,
      };
      const owned = await ledger.consumeIngress(input);
      if (owned.status !== "claimed") throw new Error("original owner not claimed");
      expect(
        await ledger.finishIngress({
          effectKey: input.effectKey,
          digest: input.digest,
          runId: owned.record.runId,
          status: "completed",
          outcome: "handler returned",
        }),
      ).toMatchObject({ status: "record", record: { status: "completed" } });
      expect(await ledger.readIngress(input.effectKey)).toMatchObject({
        status: "record",
        record: { runId: owned.record.runId },
      });
      now = 365;
      expect(await ledger.readIngress(input.effectKey)).toEqual({ status: "not_found" });
      expect(await ledger.readIngressByRun(owned.record.runId)).toEqual({ status: "not_found" });
      expect(await ledger.consumeIngress(input)).toEqual({ status: "invalid" });
    },
  );
  it("retires an expired completed deleted owner and its marker without permitting its expired request", async () => {
    let now = 1;
    const ledger = new InMemoryRunLedger(() => now);
    const owned = await ledger.consumeIngress({ ...request, origin, originExpiresAt: 365 });
    if (owned.status !== "claimed") throw new Error("original owner not claimed");
    await ledger.finishIngress({
      effectKey: request.effectKey,
      digest: request.digest,
      runId: owned.record.runId,
      status: "completed",
      outcome: "handler returned",
    });
    expect(await ledger.clearIngressContent(request.effectKey)).toMatchObject({
      status: "record",
      record: { request: null },
    });
    expect(await ledger.consumeIngress(request)).toMatchObject({
      status: "duplicate",
      record: { runId: owned.record.runId, request: null },
    });
    now = Number.MAX_SAFE_INTEGER - 1;
    expect(await ledger.readIngress(request.effectKey)).toEqual({ status: "not_found" });
    expect(await ledger.readIngressByRun(owned.record.runId)).toEqual({ status: "not_found" });
    expect(await ledger.consumeIngress(request)).toEqual({ status: "invalid" });
  });
  it("retires a standalone deletion marker behind a bounded retained-owner backlog", async () => {
    let now = 1;
    const ledger = new InMemoryRunLedger(() => now);
    for (let i = 0; i < 100; i++) {
      const effectKey = `retained:${i}`;
      expect(await ledger.consumeIngress({ ...request, effectKey, origin, originExpiresAt: 20 })).toMatchObject({
        status: "claimed",
      });
      expect(await ledger.clearIngressContent(effectKey, { expiresAt: 20, receiptTtlMs: 19 })).toMatchObject({
        status: "record",
        record: { request: null },
      });
    }
    expect(await ledger.clearIngressContent("standalone", { expiresAt: 20, receiptTtlMs: 19 })).toEqual({
      status: "not_found",
    });
    now = 21;
    expect(await ledger.consumeIngress({ ...request, effectKey: "standalone", origin, originExpiresAt: 20 })).toEqual({
      status: "invalid",
    });
    expect(await ledger.readIngress("retained:0")).toMatchObject({
      status: "record",
      record: { status: "dispatching", request: null },
    });
  });
  it("bounds a deletion-before-consume marker and still rejects an expired original request", async () => {
    let now = 1;
    const ledger = new InMemoryRunLedger(() => now);
    expect(await ledger.clearIngressContent(request.effectKey)).toEqual({ status: "not_found" });
    expect(await ledger.consumeIngress(request)).toEqual({ status: "fenced" });
    now = Number.MAX_SAFE_INTEGER - 1;
    expect(await ledger.consumeIngress(request)).toEqual({ status: "invalid" });
  });
  it.each(["dispatching", "uncertain", "completed with live custody"] as const)(
    "keeps expired %s original ownership",
    async (status) => {
      let now = 1;
      const ledger = new InMemoryRunLedger(() => now);
      const owned = await ledger.consumeIngress({ ...request, origin, originExpiresAt: 365 });
      if (owned.status !== "claimed") throw new Error("original owner not claimed");
      if (status !== "dispatching")
        await ledger.finishIngress({
          effectKey: request.effectKey,
          digest: request.digest,
          runId: owned.record.runId,
          status: status === "uncertain" ? "uncertain" : "completed",
          outcome: "original disposition",
        });
      if (status === "completed with live custody")
        expect(
          await ledger.claim({
            runId: owned.record.runId,
            gen: "g",
            threadKey: request.threadKey,
            leaseMs: 30000,
            startedAt: 1,
            meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey },
            system: "",
            tools: [],
            card: null,
          }),
        ).toMatchObject({ ok: true });
      now = 365;
      expect(await ledger.readIngress(request.effectKey)).toMatchObject({
        status: "record",
        record: { runId: owned.record.runId, request: null },
      });
      expect(await ledger.consumeIngress(request)).toMatchObject({
        status: "duplicate",
        record: { runId: owned.record.runId },
      });
    },
  );
  it("replays a committed unread handback after its live receiver closes without a step", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const owned = await ledger.consumeIngress(request);
    if (owned.status !== "claimed") throw new Error("not claimed");
    await ledger.claim({
      runId: "receiver",
      gen: "g",
      threadKey: request.threadKey,
      leaseMs: 30000,
      startedAt: 1,
      meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey },
      system: "",
      tools: [],
      card: null,
    });
    const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
    const { durableInboxMessage } = await import("./inboxMessage.js");
    const msg = withOriginalOrganizationDispatch(
      { channelId: "http:home", userId: request.requester, threadKey: request.threadKey, text: "Start original work" },
      { ingressRunId: owned.record.runId, organizationSequence: 7 },
    );
    await ledger.pushInbox("receiver", durableInboxMessage(msg, msg.text, 1));
    const proof = { ingressRunId: owned.record.runId, receiverRunId: "receiver", receiverGen: "g", inboxSeq: 1 };
    const held = await ledger.holdUnreadIngress(proof);
    expect(held).toMatchObject({ status: "record", record: { unread: { status: "pending" } } });
    expect(await ledger.finish("receiver", "g", receiverRecord)).toMatchObject({ ok: true });
    expect(await ledger.holdUnreadIngress(proof)).toEqual(held);
    const claimed = await ledger.claimUnreadIngress(owned.record.runId);
    expect(claimed).toMatchObject({ status: "claimed", record: { unread: { status: "claimed" } } });
    if (claimed.status !== "claimed") throw new Error("not claimed");
    expect(await ledger.holdUnreadIngress(proof)).toEqual({ status: "record", record: claimed.record });
    expect(await ledger.claimUnreadIngress(owned.record.runId)).toEqual({ status: "fenced" });
    expect(await ledger.holdUnreadIngress({ ...proof, inboxSeq: 2 })).toEqual({ status: "fenced" });
    expect(await ledger.holdUnreadIngress({ ...proof, receiverGen: "another" })).toEqual({ status: "fenced" });
    await ledger.clearIngressContent(request.effectKey);
    expect(await ledger.holdUnreadIngress(proof)).toEqual({ status: "fenced" });
  });
  it.each(["consumed", "missing", "malformed", "foreign generation", "deferred"])(
    "uses the exact terminal receiver closure for unread eligibility: %s",
    async (mode) => {
      const ledger = new InMemoryRunLedger(() => 1);
      const owned = await ledger.consumeIngress(request);
      if (owned.status !== "claimed") throw new Error("not claimed");
      await ledger.claim({
        runId: "receiver",
        gen: "g",
        threadKey: request.threadKey,
        leaseMs: 30000,
        startedAt: 1,
        meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey },
        system: "",
        tools: [],
        card: null,
      });
      const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
      const { durableInboxMessage } = await import("./inboxMessage.js");
      const msg = withOriginalOrganizationDispatch(
        {
          channelId: "http:home",
          userId: request.requester,
          threadKey: request.threadKey,
          text: "Start original work",
        },
        { ingressRunId: owned.record.runId, organizationSequence: 7 },
      );
      await ledger.pushInbox("receiver", durableInboxMessage(msg, msg.text, 1));
      await ledger.step(
        "receiver",
        "g",
        {
          step: 0,
          seq: 0,
          turnIndex: 0,
          inFlight: [],
          inboxConsumedSeq: 1,
          ...(mode === "deferred" ? { inboxDeferredSeqs: [1] } : {}),
          remainingMs: 1,
          turn: 0,
          iteration: 0,
        },
        [],
      );
      expect(await ledger.finish("receiver", "g", receiverRecord)).toMatchObject({ ok: true });
      const steps = ledger.steps.get("receiver")!;
      if (mode === "missing") delete steps.inboxSegmentArchive;
      else if (mode === "malformed") steps.inboxSegmentArchive = { version: 1, kind: "closed-inbox-segment" };
      else if (mode === "foreign generation") {
        const archive = steps.inboxSegmentArchive as { latest: { owner: { gen: string } } };
        archive.latest.owner.gen = "different-generation";
      }
      const result = await ledger.holdUnreadIngress({
        ingressRunId: owned.record.runId,
        receiverRunId: "receiver",
        receiverGen: "g",
        inboxSeq: 1,
      });
      expect(result).toMatchObject(
        mode === "deferred" ? { status: "record", record: { unread: { status: "pending" } } } : { status: "fenced" },
      );
      expect(await ledger.readIngress(request.effectKey)).toMatchObject({
        status: "record",
        record: { request: { text: "Start original work" } },
      });
    },
  );
  it("never demotes positive completion with a late uncertainty or refusal repair", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const owned = await ledger.consumeIngress(request);
    if (owned.status !== "claimed") throw new Error("not claimed");
    const identity = { effectKey: request.effectKey, digest: request.digest, runId: owned.record.runId };
    await ledger.claim({
      runId: "receiver",
      gen: "g",
      threadKey: request.threadKey,
      leaseMs: 30000,
      startedAt: 1,
      meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey },
      system: "",
      tools: [],
      card: null,
    });
    const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
    const { durableInboxMessage } = await import("./inboxMessage.js");
    const msg = withOriginalOrganizationDispatch(
      { channelId: "http:home", userId: request.requester, threadKey: request.threadKey, text: "Start original work" },
      { ingressRunId: owned.record.runId, organizationSequence: 7 },
    );
    await ledger.pushInbox("receiver", durableInboxMessage(msg, msg.text, 1));
    await ledger.holdUnreadIngress({
      ingressRunId: owned.record.runId,
      receiverRunId: "receiver",
      receiverGen: "g",
      inboxSeq: 1,
    });
    await ledger.finish("receiver", "g", receiverRecord);
    await ledger.finishIngress({ ...identity, status: "completed", outcome: "Original effect completed." });
    await ledger.finishIngress({
      ...identity,
      status: "uncertain",
      outcome: "Late lookup unavailable",
      refusalPending: true,
    });
    await ledger.ackIngressRefusal(identity);
    expect(await ledger.readIngress(request.effectKey)).toMatchObject({
      status: "record",
      record: { status: "completed", outcome: "Original effect completed." },
    });
    expect(await ledger.claimUnreadIngress(owned.record.runId)).toEqual({ status: "fenced" });
  });
  it("concurrent cleanup and refusal acknowledgement cannot restore deleted input or replace a completed owner", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const owned = await ledger.consumeIngress(request);
    if (owned.status !== "claimed") throw new Error("not claimed");
    const identity = { effectKey: request.effectKey, digest: request.digest, runId: owned.record.runId };
    await ledger.finishIngress({
      ...identity,
      status: "completed",
      outcome: "Refused without effect.",
      refusalPending: true,
    });
    await Promise.all([ledger.clearIngressContent(request.effectKey), ledger.ackIngressRefusal(identity)]);
    expect(await ledger.readIngress(request.effectKey)).toMatchObject({
      status: "record",
      record: { request: null, refusalPending: false, status: "completed" },
    });
    const next = await ledger.consumeIngress({ ...request, effectKey: "completion-race" });
    if (next.status !== "claimed") throw new Error("not claimed");
    await Promise.all([
      ledger.clearIngressContent("completion-race"),
      ledger.finishIngress({
        ...identity,
        effectKey: "completion-race",
        runId: next.record.runId,
        status: "completed",
        outcome: "Original effect completed.",
      }),
    ]);
    expect(await ledger.readIngress("completion-race")).toMatchObject({
      status: "record",
      record: { request: null, status: "completed", outcome: "Original effect completed." },
    });
  });

  it.each(["before hold", "before claim"])(
    "never continues a positively completed owner %s even without a physical model run",
    async (phase) => {
      const ledger = new InMemoryRunLedger(() => 1);
      const owned = await ledger.consumeIngress(request);
      if (owned.status !== "claimed") throw new Error("not claimed");
      await ledger.claim({
        runId: "receiver",
        gen: "g",
        threadKey: request.threadKey,
        leaseMs: 30000,
        startedAt: 1,
        meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey },
        system: "",
        tools: [],
        card: null,
      });
      const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
      const { durableInboxMessage } = await import("./inboxMessage.js");
      const msg = withOriginalOrganizationDispatch(
        {
          channelId: "http:home",
          userId: request.requester,
          threadKey: request.threadKey,
          text: "Start original work",
        },
        { ingressRunId: owned.record.runId, organizationSequence: 7 },
      );
      await ledger.pushInbox("receiver", durableInboxMessage(msg, msg.text, 1));
      const proof = { ingressRunId: owned.record.runId, receiverRunId: "receiver", receiverGen: "g", inboxSeq: 1 };
      if (phase === "before claim") expect(await ledger.holdUnreadIngress(proof)).toMatchObject({ status: "record" });
      await ledger.finish("receiver", "g", receiverRecord);
      expect(
        await ledger.finishIngress({
          effectKey: request.effectKey,
          digest: request.digest,
          runId: owned.record.runId,
          status: "completed",
          outcome: "The original canonical owner completed without a model run.",
        }),
      ).toMatchObject({ status: "record", record: { status: "completed" } });
      expect(
        phase === "before hold"
          ? await ledger.holdUnreadIngress(proof)
          : await ledger.claimUnreadIngress(owned.record.runId),
      ).toEqual({ status: "fenced" });
      expect(await ledger.consumeIngress(request)).toMatchObject({
        status: "duplicate",
        record: { runId: owned.record.runId, status: "completed" },
      });
    },
  );

  it("rotates bounded unread repairs past unavailable owners and omits deleted and expired input", async () => {
    let now = 1;
    const ledger = new InMemoryRunLedger(() => now);
    const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
    const { durableInboxMessage } = await import("./inboxMessage.js");
    for (const key of ["unread:a", "unread:b"]) {
      const owned = await ledger.consumeIngress({ ...request, effectKey: key, origin, originExpiresAt: 365 });
      if (owned.status !== "claimed") throw new Error("not claimed");
      const receiver = `receiver:${key}`;
      await ledger.claim({
        runId: receiver,
        gen: "g",
        threadKey: request.threadKey,
        leaseMs: 30000,
        startedAt: 1,
        meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey },
        system: "",
        tools: [],
        card: null,
      });
      const msg = withOriginalOrganizationDispatch(
        {
          channelId: "http:home",
          userId: request.requester,
          threadKey: request.threadKey,
          text: "Start original work",
        },
        { ingressRunId: owned.record.runId, organizationSequence: 7 },
      );
      await ledger.pushInbox(receiver, durableInboxMessage(msg, msg.text, 1));
      expect(
        await ledger.holdUnreadIngress({
          ingressRunId: owned.record.runId,
          receiverRunId: receiver,
          receiverGen: "g",
          inboxSeq: 1,
        }),
      ).toMatchObject({ status: "record", record: { unread: { status: "pending" } } });
      await ledger.finish(receiver, "g", { ...receiverRecord, id: receiver });
    }
    const first = await ledger.pendingUnreadIngress("org:test", 1),
      second = await ledger.pendingUnreadIngress("org:test", 1);
    if (first.status !== "unread" || second.status !== "unread") throw new Error("No repairs");
    expect([...first.records, ...second.records].map((record) => record.effectKey).sort()).toEqual([
      "unread:a",
      "unread:b",
    ]);
    expect(await ledger.pendingUnreadIngress("org:test", 1)).toMatchObject({
      status: "unread",
      records: [{ effectKey: first.records[0]!.effectKey }],
    });
    await ledger.clearIngressContent("unread:a");
    expect(await ledger.pendingUnreadIngress("org:test", 10)).toMatchObject({
      status: "unread",
      records: [{ effectKey: "unread:b" }],
    });
    now = 100;
    expect(await ledger.pendingUnreadIngress("org:test", 10)).toEqual({ status: "unread", records: [] });
  });

  it("holds only the original unread inbox item, then claims its continuation once across replacement", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const owned = await ledger.consumeIngress(request);
    if (owned.status !== "claimed") throw new Error("not claimed");
    await ledger.claim({
      runId: "receiver",
      gen: "original-generation",
      threadKey: request.threadKey,
      leaseMs: 30000,
      startedAt: 1,
      meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey },
      system: "",
      tools: [],
      card: null,
    });
    const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
    const { durableInboxMessage } = await import("./inboxMessage.js");
    const message = withOriginalOrganizationDispatch(
      {
        channelId: "http:home",
        userId: request.requester,
        threadKey: request.threadKey,
        messageId: "original-message",
        text: "Start original work",
      },
      { ingressRunId: owned.record.runId, organizationSequence: 7 },
    );
    const pushed = await ledger.pushInbox("receiver", durableInboxMessage(message, message.text, 1));
    const proof = {
      ingressRunId: owned.record.runId,
      receiverRunId: "receiver",
      receiverGen: "original-generation",
      inboxSeq: pushed.seq!,
    };
    expect(await ledger.holdUnreadIngress({ ...proof, receiverGen: "impostor" })).toEqual({ status: "fenced" });
    expect(await ledger.holdUnreadIngress(proof)).toMatchObject({
      status: "record",
      record: {
        runId: owned.record.runId,
        status: "uncertain",
        unread: { status: "pending", receiverRunId: "receiver", inboxSeq: 1, organizationSequence: 7 },
      },
    });
    expect(await ledger.readInbox("receiver", 0)).toEqual([]);
    expect(await ledger.claimUnreadIngress(owned.record.runId)).toEqual({ status: "fenced" });
    expect(await ledger.finish("receiver", "original-generation", receiverRecord)).toMatchObject({ ok: true });
    expect(await ledger.claimUnreadIngress(owned.record.runId)).toMatchObject({
      status: "claimed",
      record: { runId: owned.record.runId, unread: { status: "claimed" }, request: { text: "Start original work" } },
    });
    expect(await ledger.claimUnreadIngress(owned.record.runId)).toEqual({ status: "fenced" });
    expect(await ledger.consumeIngress(request)).toMatchObject({
      status: "duplicate",
      record: { runId: owned.record.runId, unread: { status: "claimed" } },
    });
  });
  it("never returns already consumed, deleted, or expired input to a provider", async () => {
    let now = 1;
    const ledger = new InMemoryRunLedger(() => now);
    const owned = await ledger.consumeIngress(request);
    if (owned.status !== "claimed") throw new Error("not claimed");
    await ledger.claim({
      runId: "receiver",
      gen: "g",
      threadKey: request.threadKey,
      leaseMs: 30000,
      startedAt: 1,
      meta: { channelId: "http:home", userId: request.requester, threadKey: request.threadKey },
      system: "",
      tools: [],
      card: null,
    });
    const { withOriginalOrganizationDispatch } = await import("../dispatch/originalOrganizationInput.js");
    const { durableInboxMessage } = await import("./inboxMessage.js");
    const msg = withOriginalOrganizationDispatch(
      { channelId: "http:home", userId: request.requester, threadKey: request.threadKey, text: "Start original work" },
      { ingressRunId: owned.record.runId, organizationSequence: 7 },
    );
    await ledger.pushInbox("receiver", durableInboxMessage(msg, msg.text, 1));
    ledger.steps.set("receiver", [
      { step: 0, seq: 0, turnIndex: 0, inFlight: [], inboxConsumedSeq: 1, remainingMs: 1, turn: 0, iteration: 0 },
    ]);
    const proof = { ingressRunId: owned.record.runId, receiverRunId: "receiver", receiverGen: "g", inboxSeq: 1 };
    expect(await ledger.holdUnreadIngress(proof)).toEqual({ status: "fenced" });
    ledger.steps.set("receiver", []);
    await ledger.holdUnreadIngress(proof);
    await ledger.finish("receiver", "g", receiverRecord);
    now = 100;
    expect(await ledger.claimUnreadIngress(owned.record.runId)).toEqual({ status: "fenced" });
    expect(await ledger.readIngress(request.effectKey)).toMatchObject({
      status: "record",
      record: { request: null, unread: { status: "pending" } },
    });
  });
  it("retains indexed original source proof after content deletion and fences it at origin expiry", async () => {
    let now = 1;
    const ledger = new InMemoryRunLedger(() => now);
    const first = await ledger.consumeIngress({ ...request, origin, originExpiresAt: 365 });
    if (first.status !== "claimed") throw new Error("not claimed");
    await ledger.clearIngressContent(request.effectKey);
    expect(await ledger.readIngressByRun(first.record.runId)).toMatchObject({
      status: "record",
      record: {
        runId: first.record.runId,
        request: null,
        origin: { sourceReference: { credentialDigest: "c".repeat(64) }, content: "", context: [] },
      },
    });
    now = 365;
    expect(await ledger.readIngressByRun(first.record.runId)).toEqual({ status: "fenced" });
  });
  it("deletes original content and fences a later admission when deletion wins the race", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const first = await ledger.consumeIngress(request);
    if (first.status !== "claimed") throw new Error("not claimed");
    expect(await ledger.clearIngressContent(request.effectKey)).toMatchObject({
      status: "record",
      record: { runId: first.record.runId, request: null },
    });
    expect(await ledger.consumeIngress(request)).toMatchObject({
      status: "duplicate",
      record: { runId: first.record.runId, request: null },
    });
    expect(await ledger.clearIngressContent("deleted-before-admission")).toEqual({ status: "not_found" });
    expect(await ledger.consumeIngress({ ...request, effectKey: "deleted-before-admission" })).toEqual({
      status: "fenced",
    });
  });
  it("retains the original request and identity and refuses a retry before any run exists", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const first = await ledger.consumeIngress(request);
    expect(first).toMatchObject({
      status: "claimed",
      record: { status: "dispatching", requester: "access:alice", request: { text: "Start original work" } },
    });
    if (first.status !== "claimed") throw new Error("not claimed");
    expect(await ledger.consumeIngress(request)).toEqual({ status: "duplicate", record: first.record });
    expect(await ledger.consumeIngress({ ...request, requester: "access:bob" })).toEqual({ status: "conflict" });
    expect(await ledger.consumeIngress({ ...request, digest: "b".repeat(64) })).toEqual({ status: "conflict" });
    expect(
      await ledger.finishIngress({
        effectKey: request.effectKey,
        digest: request.digest,
        runId: "other",
        status: "completed",
        outcome: "completed",
      }),
    ).toEqual({ status: "fenced" });
    expect(
      await ledger.finishIngress({
        effectKey: request.effectKey,
        digest: request.digest,
        runId: first.record.runId,
        status: "uncertain",
        outcome: "delivery unknown",
      }),
    ).toMatchObject({
      status: "record",
      record: { runId: first.record.runId, status: "uncertain", outcome: "delivery unknown" },
    });
    expect(await ledger.consumeIngress(request)).toMatchObject({
      status: "duplicate",
      record: { runId: first.record.runId, status: "uncertain" },
    });
    expect(
      await ledger.finishIngress({
        effectKey: request.effectKey,
        digest: request.digest,
        runId: first.record.runId,
        status: "completed",
        outcome: "original run completed",
      }),
    ).toMatchObject({ status: "record", record: { status: "completed", outcome: "original run completed" } });
  });
  it("clears expired request content while preserving the original refusal tombstone", async () => {
    let now = 1;
    const ledger = new InMemoryRunLedger(() => now);
    const first = await ledger.consumeIngress(request);
    if (first.status !== "claimed") throw new Error("not claimed");
    now = 100;
    expect(await ledger.readIngress(request.effectKey)).toMatchObject({
      status: "record",
      record: { runId: first.record.runId, request: null },
    });
    expect(await ledger.consumeIngress(request)).toMatchObject({
      status: "duplicate",
      record: { runId: first.record.runId, request: null },
    });
    expect(await ledger.consumeIngress({ ...request, effectKey: "expired:new" })).toEqual({ status: "invalid" });
  });
});
