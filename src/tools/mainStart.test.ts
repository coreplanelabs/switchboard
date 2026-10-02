import { booleanAudienceVerifier } from "../core/testing/audienceVerifier.js";
import { describe, expect, it, vi } from "vitest";
import { ALL_GRANTS } from "../core/authz/grants.js";
import type { Actor } from "../core/authz/types.js";
import type { IncomingMessage } from "../core/types.js";
import type { MainStartInput, MainStartResult } from "../core/coordinator/mainStart.js";
import { MainSourceTracker } from "../core/dispatch/mainSource.js";
import { contextCapsuleOf } from "../core/dispatch/unitContext.js";
import { canOfferMainStart, mainStartForRun, workStartTool } from "./mainStart.js";
import type { ToolContext } from "./runnableTool.js";

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

const input = {
  schemaVersion: 1,
  cause: { kind: "unknown", reason: "Not investigated" },
  evidence: { availability: "provided" },
  requirements: { analysis: "not_required", evidence: "required" },
  acceptance: "Regression test passes",
  repo: "acme/api",
  question: "Why did signup fail?",
  findings: [{ kind: "observation", text: "Five failed signups yesterday", sourceUrl: "https://example.com/signup" }],
  requestedChange: "Fix signup and add a regression test",
  sourceMessage: "fix it",
};

const context = (mainStart?: ReturnType<typeof mainStartForRun>): ToolContext =>
  ({ executor: {} as ToolContext["executor"], ...(mainStart ? { mainStart } : {}) }) as ToolContext;
const verifyDirectAudience = async () => true;
const resolveSource = (sources: MainSourceTracker, quote: string, repo: string, configuredRepo = "acme/api") => {
  const selected = sources.select(quote);
  return selected.kind === "refused" ? selected : sources.bindRepository(selected.source, repo, configuredRepo);
};

describe("work_start — plain-language private worker handoff", () => {
  it("captures trusted context separately from tool arguments and refuses capture failures or changed authority", async () => {
    const capsule = contextCapsuleOf({
      version: 1,
      source: { runId: "main-run", requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey },
      session: { key: `${msg.threadKey}:@thread`, from: 0, to: -1 },
      assets: [],
    });
    const start = vi.fn(async (_value: MainStartInput): Promise<MainStartResult> => ({
      kind: "accepted",
      actId: "act",
      instanceId: "unit",
      reply: "started",
    }));
    let live = true;
    let privateNow = true;
    const captureContext = vi.fn(async () => capsule);
    const capability = mainStartForRun({
      agentName: "orchestrator",
      channelVisibility: "dm",
      initial: { actor, msg },
      source: () => ({ kind: "ready", actor, msg, authorizedRepo: input.repo }),
      live: () => live,
      runId: "main-run",
      verifyDirectAudience: booleanAudienceVerifier(async () => privateNow),
      captureContext,
      start,
    });
    expect(await workStartTool.run(input, context(capability))).toContain("Started");
    expect(start.mock.calls[0]?.[0].context).toEqual(capsule);
    expect(workStartTool.inputSchema.properties).not.toHaveProperty("context");
    captureContext.mockRejectedValueOnce(new Error("storage budget"));
    expect(await workStartTool.run(input, context(capability))).toContain("couldn't save");
    captureContext.mockImplementationOnce(async () => {
      live = false;
      return capsule;
    });
    expect(await workStartTool.run(input, context(capability))).toContain("stopped");
    live = true;
    captureContext.mockImplementationOnce(async () => {
      privateNow = false;
      return capsule;
    });
    expect(await workStartTool.run(input, context(capability))).toContain("no longer a private");
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("reports a reconciled existing worker without saying it started another", async () => {
    const start = vi.fn<(input: MainStartInput) => Promise<MainStartResult>>().mockResolvedValue({
      kind: "existing",
      actId: "m_saved",
      instanceId: "plan-saved",
      reply: "The saved Workflow exists under the same id.",
    });
    const capability = mainStartForRun({
      agentName: "orchestrator",
      channelVisibility: "dm",
      initial: { actor, msg },
      source: () => ({ kind: "ready", actor, msg, authorizedRepo: input.repo }),
      live: () => true,
      runId: "main-run",
      verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
      start,
    });
    const result = await workStartTool.run(input, context(capability));
    expect(result).toContain("already has a private worker");
    expect(result).toContain("m_saved");
    expect(result).not.toContain("Started one private worker");
  });

  it("a quoted incident and contextual repository cannot cross the trusted start gate", async () => {
    const question = { ...msg, text: "Why did signup fail? The log quotes vendor/lib" };
    const source = new MainSourceTracker(question, () => actor);
    source.accept([
      { userId: msg.userId, directAudience: msg.directAudience, text: "fix it", messageId: "later", at: 2 },
    ]);
    const start = vi.fn<(input: MainStartInput) => Promise<MainStartResult>>();
    const capability = mainStartForRun({
      agentName: "orchestrator",
      channelVisibility: "dm",
      initial: { actor, msg: question },
      source: (quote, repo) => resolveSource(source, quote, repo),
      live: () => true,
      runId: "main-run",
      verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
      start,
    });
    expect(await workStartTool.run({ ...input, repo: "vendor/lib" }, context(capability))).toContain("error:");
    expect(start).not.toHaveBeenCalled();
    source.accept([
      {
        userId: msg.userId,
        directAudience: msg.directAudience,
        text: "Please fix signup in acme/api",
        messageId: "targeted",
        at: 3,
      },
    ]);
    start.mockResolvedValue({ kind: "accepted", actId: "m_targeted", instanceId: "plan-targeted", reply: "started" });
    const out = await workStartTool.run(
      { ...input, sourceMessage: "Please fix signup", repo: "acme/api" },
      context(capability),
    );
    expect(out).toContain("m_targeted");
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      repo: "acme/api",
      authorizedRepo: "acme/api",
      msg: { messageId: "targeted" },
    });
  });
  it("binds the resolved requester, current message and run before model fields reach the starter", async () => {
    const start = vi.fn<(input: MainStartInput) => Promise<MainStartResult>>().mockResolvedValue({
      kind: "accepted",
      actId: "m_123",
      instanceId: "plan-123",
      reply: "started",
    });
    const capability = mainStartForRun({
      agentName: "orchestrator",
      channelVisibility: "dm",
      initial: { actor, msg },
      source: () => ({ kind: "ready", actor, msg, authorizedRepo: input.repo }),
      live: () => true,
      runId: "main-run",
      verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
      start,
    });
    expect(capability).toBeDefined();
    const result = await workStartTool.run(
      { ...input, actor: { id: "slack:UOTHER" }, threadKey: "slack:DOTHER:1" },
      context(capability),
    );
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toEqual({
      actor,
      msg,
      mainRunId: "main-run",
      repo: input.repo,
      authorizedRepo: input.repo,
      brief: {
        schemaVersion: 1,
        cause: input.cause,
        evidence: input.evidence,
        requirements: input.requirements,
        acceptance: input.acceptance,
        question: input.question,
        findings: input.findings,
        requestedChange: input.requestedChange,
      },
      stillLive: expect.any(Function),
      stillPrivate: expect.any(Function),
    });
    expect(result).toContain("m_123");
    expect(result).toContain("private worker");
  });

  it("refuses absent capability and invalid evidence without starting anything", async () => {
    const start = vi.fn<(input: MainStartInput) => Promise<MainStartResult>>();
    const capability = mainStartForRun({
      agentName: "orchestrator",
      channelVisibility: "dm",
      initial: { actor, msg },
      source: () => ({ kind: "ready", actor, msg, authorizedRepo: input.repo }),
      live: () => true,
      runId: "main-run",
      verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
      start,
    });
    expect(await workStartTool.run(input, context())).toContain("unavailable");
    expect(await workStartTool.run({ ...input, findings: [{ text: "" }] }, context(capability))).toContain("error:");
    expect(
      await workStartTool.run({ ...input, findings: [{ text: "A number without a source" }] }, context(capability)),
    ).toContain("error:");
    expect(start).not.toHaveBeenCalled();
    expect(
      mainStartForRun({
        agentName: "coding",
        channelVisibility: "dm",
        initial: { actor, msg },
        source: () => ({ kind: "ready", actor, msg, authorizedRepo: input.repo }),
        live: () => true,
        runId: "child",
        verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
        start,
      }),
    ).toBeUndefined();
  });

  it("offers no private-work start from a shared or unverified channel", () => {
    const start = vi.fn<(input: MainStartInput) => Promise<MainStartResult>>();
    for (const channelVisibility of ["public", "private", "unknown"] as const) {
      expect(
        mainStartForRun({
          agentName: "orchestrator",
          channelVisibility,
          initial: { actor, msg },
          source: () => ({ kind: "ready", actor, msg, authorizedRepo: input.repo }),
          live: () => true,
          runId: "r",
          verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
          start,
        }),
      ).toBeUndefined();
    }
    expect(start).not.toHaveBeenCalled();
  });

  it("requires a direct requester Slack DM, excluding web and app-relayed turns", () => {
    expect(canOfferMainStart("orchestrator", "dm", msg, actor, true)).toBe(true);
    const enterpriseMsg = {
      ...msg,
      userId: "slack:W123",
      directAudience: { ...msg.directAudience!, userId: "slack:W123" },
    };
    expect(canOfferMainStart("orchestrator", "dm", enterpriseMsg, { ...actor, id: enterpriseMsg.userId }, true)).toBe(
      true,
    );
    expect(canOfferMainStart("orchestrator", "dm", { ...msg, directAudience: undefined }, actor, true)).toBe(false);
    expect(
      canOfferMainStart(
        "orchestrator",
        "dm",
        { ...msg, directAudience: { ...msg.directAudience!, channelId: "slack:DOTHER" } },
        actor,
        true,
      ),
    ).toBe(false);
    expect(canOfferMainStart("orchestrator", "dm", { ...msg, channelId: "web:U123" }, actor, true)).toBe(false);
    expect(canOfferMainStart("orchestrator", "dm", { ...msg, postedBy: "slack:bot:B1" }, actor, true)).toBe(false);
    expect(canOfferMainStart("orchestrator", "dm", { ...msg, authenticatedAs: "slack:bot:B1" }, actor, true)).toBe(
      false,
    );
    expect(canOfferMainStart("orchestrator", "dm", msg, { ...actor, id: "slack:UOTHER" }, true)).toBe(false);
  });

  it("binds a steered fix request to its own requester and message", async () => {
    const start = vi.fn<(input: MainStartInput) => Promise<MainStartResult>>().mockResolvedValue({
      kind: "accepted",
      actId: "m_followup",
      instanceId: "plan-followup",
      reply: "started",
    });
    let source = { kind: "ready" as const, actor, msg, authorizedRepo: input.repo };
    const capability = mainStartForRun({
      agentName: "orchestrator",
      channelVisibility: "dm",
      initial: { actor, msg },
      source: () => source,
      live: () => true,
      runId: "main-run",
      verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
      start,
    });
    source = { ...source, msg: { ...msg, messageId: "1700000001.000003", text: "fix it now" } };
    await workStartTool.run({ ...input, sourceMessage: "fix it now" }, context(capability));
    expect(start.mock.calls[0]?.[0].msg.messageId).toBe("1700000001.000003");
    expect(start.mock.calls[0]?.[0].msg.text).toBe("fix it now");
  });

  it("binds a quote only to the latest delivered follow-up", async () => {
    const start = vi.fn<(input: MainStartInput) => Promise<MainStartResult>>().mockResolvedValue({
      kind: "accepted",
      actId: "m_two",
      instanceId: "plan-two",
      reply: "started",
    });
    const sources = new MainSourceTracker({ ...msg, messageId: "1", text: "fix signup" }, () => actor);
    sources.accept([
      { userId: msg.userId, directAudience: msg.directAudience, text: "fix billing", messageId: "2", at: 2 },
    ]);
    const capability = mainStartForRun({
      agentName: "orchestrator",
      channelVisibility: "dm",
      initial: { actor, msg },
      source: (sourceMessage, repo) => resolveSource(sources, sourceMessage, repo),
      live: () => true,
      runId: "main-run",
      verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
      start,
    });
    const { sourceMessage: _sourceMessage, ...withoutQuote } = input;
    for (const sourceInput of [withoutQuote, { ...input, sourceMessage: "" }, { ...input, sourceMessage: "  " }]) {
      const missing = await workStartTool.run(sourceInput, context(capability));
      expect(missing).toContain('"kind":"source_resolution"');
      expect(missing).toContain('"code":"source_quote_missing"');
    }
    expect(await workStartTool.run({ ...input, sourceMessage: "x".repeat(1001) }, context(capability))).toContain(
      "quote is too long",
    );
    const unclear = await workStartTool.run({ ...input, sourceMessage: "other request" }, context(capability));
    expect(unclear).toContain('"kind":"source_resolution"');
    expect(unclear).toContain('"code":"source_quote_mismatch"');
    expect(start).not.toHaveBeenCalled();
    expect(await workStartTool.run({ ...input, sourceMessage: "fix signup" }, context(capability))).toContain("error:");
    await workStartTool.run({ ...input, sourceMessage: "fix billing" }, context(capability));
    expect(start.mock.calls[0]?.[0].msg.messageId).toBe("2");
  });

  it("refuses a stopped main run before calling the starter", async () => {
    const start = vi.fn<(input: MainStartInput) => Promise<MainStartResult>>();
    const capability = mainStartForRun({
      agentName: "orchestrator",
      channelVisibility: "dm",
      initial: { actor, msg },
      source: () => ({ kind: "ready", actor, msg, authorizedRepo: input.repo }),
      live: () => false,
      runId: "main-run",
      verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
      start,
    });
    expect(await workStartTool.run(input, context(capability))).toContain("stopped");
    expect(start).not.toHaveBeenCalled();
  });

  it("rechecks the direct audience before starting and refuses a newly shared DM", async () => {
    const start = vi.fn<(input: MainStartInput) => Promise<MainStartResult>>();
    const verify = vi.fn().mockResolvedValue(false);
    const capability = mainStartForRun({
      agentName: "orchestrator",
      channelVisibility: "dm",
      initial: { actor, msg },
      source: () => ({ kind: "ready", actor, msg, authorizedRepo: input.repo }),
      live: () => true,
      runId: "main-run",
      verifyDirectAudience: booleanAudienceVerifier(verify),
      start,
    });
    expect(await workStartTool.run(input, context(capability))).toContain("private conversation");
    expect(verify).toHaveBeenCalledWith(msg.directAudience);
    verify.mockRejectedValueOnce(new Error("Slack unavailable"));
    expect(await workStartTool.run(input, context(capability))).toContain("private conversation");
    expect(start).not.toHaveBeenCalled();
  });
});
