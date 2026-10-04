import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  handleCheckRunIntake,
  handleIssueCommentIntake,
  handlePushIntake,
  verifyWebhookSignature,
  type CheckRunIntakeDeps,
  createMergeWaitRegistry,
} from "./checksIntake.js";
import { checksSettledEventType, unitNudgeEventType, type WorkflowSender } from "./contract.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { findRunnerPullOwner, runnerPullOwnerOf } from "../runnerOwnership.js";
import { isCoordinatorUnit, type CoordinatorUnit } from "./contract.js";

const SECRET = "hush";
const HEAD = "a".repeat(40);

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: "completed",
    check_run: { head_sha: HEAD },
    repository: { full_name: "octo/repo" },
    ...over,
  });

function workflow() {
  const sent: Array<{ instance: string; type: string; payload: unknown }> = [];
  const sender: WorkflowSender = {
    async get(id) {
      return {
        async sendEvent(event) {
          sent.push({ instance: id, ...event });
        },
      };
    },
  };
  return { sender, sent };
}

function deps(over: Partial<CheckRunIntakeDeps> = {}): CheckRunIntakeDeps {
  return {
    secret: SECRET,
    checksSettled: async () => true,
    instancesWaitingAt: async () => ["plan-x"],
    workflow: workflow().sender,
    now: () => 1000,
    ...over,
  };
}

describe("the GitHub check-run intake — the checks-settled event's publisher (http-ingress item 12)", () => {
  it("verifies the webhook signature: a valid HMAC passes, a wrong secret, a tampered body and a missing header are refused 401, and no secret disables the intake 503 — never open", async () => {
    const raw = body();
    const good = await sign(SECRET, raw);
    expect(await verifyWebhookSignature(SECRET, raw, good)).toBe(true);
    expect(await verifyWebhookSignature("other", raw, good)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, raw + " ", good)).toBe(false);

    const refused = await handleCheckRunIntake(
      { event: "check_run", signature: await sign("other", raw) },
      raw,
      deps(),
    );
    expect(refused.status).toBe(401);
    const missing = await handleCheckRunIntake({ event: "check_run" }, raw, deps());
    expect(missing.status).toBe(401);
    const disabled = await handleCheckRunIntake(
      { event: "check_run", signature: good },
      raw,
      deps({ secret: undefined }),
    );
    expect(disabled.status).toBe(503);
  });

  it("a completed check_run whose head has every check settled sends checks-settled-<head> to each waiting instance, best effort", async () => {
    const raw = body();
    const w = workflow();
    const res = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, raw) },
      raw,
      deps({ workflow: w.sender, instancesWaitingAt: async (h) => (h === HEAD ? ["plan-x", "plan-y"] : []) }),
    );
    expect(res).toEqual({ status: 200, body: { ok: true, settled: true, sent: 2, of: 2 } });
    expect(w.sent).toEqual([
      { instance: "plan-x", type: checksSettledEventType(HEAD), payload: { headSha: HEAD, settledAt: 1000 } },
      { instance: "plan-y", type: checksSettledEventType(HEAD), payload: { headSha: HEAD, settledAt: 1000 } },
    ]);
  });

  it("anything that is not the last settled check run sends nothing: another event, a non-completed action, checks still pending; a malformed body is 400; a failed send is answered, never thrown", async () => {
    const other = await handleCheckRunIntake({ event: "push", signature: await sign(SECRET, body()) }, body(), deps());
    expect(other.body).toMatchObject({ ignored: "event" });
    const created = body({ action: "created" });
    const notDone = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, created) },
      created,
      deps(),
    );
    expect(notDone.body).toMatchObject({ ignored: "action" });
    const raw = body();
    const pending = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, raw) },
      raw,
      deps({ checksSettled: async () => false }),
    );
    expect(pending.body).toEqual({ ok: true, settled: false });
    const bad = "{not json";
    const invalid = await handleCheckRunIntake({ event: "check_run", signature: await sign(SECRET, bad) }, bad, deps());
    expect(invalid.status).toBe(400);
    const noHead = body({ check_run: {} });
    const headless = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, noHead) },
      noHead,
      deps(),
    );
    expect(headless.status).toBe(400);
    const failing: WorkflowSender = {
      async get() {
        throw new Error("instance ended");
      },
    };
    const failed = await handleCheckRunIntake(
      { event: "check_run", signature: await sign(SECRET, raw) },
      raw,
      deps({ workflow: failing }),
    );
    expect(failed).toEqual({ status: 200, body: { ok: true, settled: true, sent: 0, of: 1 } });
    expect(GITHUB_SIGNATURE_HEADER).toBe("x-hub-signature-256");
    expect(GITHUB_EVENT_HEADER).toBe("x-github-event");
  });
});

describe("the pull-request comment intake — a person's answer wakes the owning unit", () => {
  const commentBody = (type = "User") =>
    JSON.stringify({
      action: "created",
      issue: { number: 7, pull_request: { url: "https://api.github.com/repos/octo/repo/pulls/7" } },
      comment: {
        id: 99,
        body: "The independent reader supplied the receipt.",
        created_at: ["2026", "09", "21"].join("-") + "T19:21:00Z",
        user: { login: "alice", id: 42, type },
      },
      repository: { full_name: "octo/repo" },
    });

  async function liveInstances(recoveryRequested = false) {
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const owner = { instanceId: "runner-fixture", unit: "U10" };
    await instances.put({
      id: owner.instanceId,
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:1",
      repo: "octo/repo",
      branch: "plan/fixture/u1",
      base: "main",
      createdAt: 1,
    });
    const row: CoordinatorUnit = {
      instanceId: owner.instanceId,
      unit: owner.unit,
      slug: "u1",
      branch: "fixture/x/u1",
      dependsOn: [],
      rounds: [],
      pr: { number: 7, url: "https://github.com/octo/repo/pull/7" },
      idle: { why: "held", at: 1, renewalsLeft: 0, spendUsd: 1, wakes: 0 },
    };
    if (recoveryRequested) {
      delete row.idle;
      row.recovery = {
        kind: "review",
        round: 2,
        expectedHeadSha: "a".repeat(40),
        remainingMs: 60_000,
        claimedAt: 2,
        step: "unit/recovery/2/review",
        reviewRunId: "review-original",
        reviewKey: "runner-fixture:U10/2/review",
        previousEnding: { kind: "aborted", report: "recoverable", at: 1 },
        workflowId: "recovery-original",
        deadlineAt: 60_002,
      };
    }
    let actionId: string | undefined;
    if (!recoveryRequested) expect(await instances.putUnits([row])).toEqual({ ok: true });
    else {
      expect(isCoordinatorUnit(row)).toBe(true);
      const { recovery, ...original } = row;
      const ended = { ...original, ending: recovery!.previousEnding };
      expect(await instances.putUnits([ended])).toEqual({ ok: true });
      const claim = await instances.transitionRecovery({
        kind: "claim",
        expected: ended,
        replacement: row,
        request: { userId: "slack:UALICE", threadKey: "slack:C1:1", messageId: "recovery-request" },
      });
      expect(claim).toMatchObject({ ok: true });
      if (!claim.ok) throw new Error(claim.reason);
      actionId = claim.unit.recovery!.actionId;
    }
    return { instances, owner, actionId };
  }

  it("awaits canonical durable ownership without a process-local recovery map", async () => {
    const { instances, owner } = await liveInstances();
    const w = workflow();
    const raw = commentBody();
    const result = await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      ownerOf: (repo, pr) => findRunnerPullOwner(instances, repo, pr),
      instances,
      commenterAuthorized: async () => true,
      workflow: w.sender,
      now: () => 1,
    });
    expect(result.body).toMatchObject({ appended: true, nudge: "sent" });
    expect(await instances.listEvents(owner)).toHaveLength(1);
  });

  it("revalidates the canonical resumed PR target without requiring a duplicate display PR field", async () => {
    const { instances, owner } = await liveInstances();
    const [row] = await instances.listUnits(owner.instanceId);
    expect(await instances.putUnits([{ ...row!, pr: undefined, resume: { pr: 7, headSha: HEAD } }])).toEqual({
      ok: true,
    });
    const raw = commentBody();
    const w = workflow();
    const result = await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      ownerOf: (repo, pr) => findRunnerPullOwner(instances, repo, pr),
      instances,
      commenterAuthorized: async () => true,
      workflow: w.sender,
      now: () => 1,
    });
    expect(result.body).toMatchObject({ appended: true, nudge: "sent" });
    expect(await instances.listEvents(owner)).toHaveLength(1);
  });

  it("retains a committed comment and offers the original owner for reconciliation after a failed nudge", async () => {
    const { instances, owner } = await liveInstances();
    const offer = vi.spyOn(instances, "offerReconciliation");
    const raw = commentBody();
    const result = await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      ownerOf: (repo, pr) => findRunnerPullOwner(instances, repo, pr),
      instances,
      commenterAuthorized: async () => true,
      workflow: {
        get: async () => {
          throw new Error("native Workflow unavailable");
        },
      },
      now: () => 1,
    });
    expect(result.body).toMatchObject({ appended: true, nudge: "failed" });
    expect(await instances.listEvents(owner)).toHaveLength(1);
    expect(offer).toHaveBeenCalledExactlyOnceWith({ instanceId: owner.instanceId, unit: owner.unit });
  });

  it("does not append or nudge on an incomplete canonical owner inventory", async () => {
    const { instances, owner } = await liveInstances();
    const w = workflow();
    const raw = commentBody();
    const result = await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      ownerOf: async () => ({ ok: false, reason: "incomplete" }),
      instances,
      commenterAuthorized: async () => true,
      workflow: w.sender,
      now: () => 1,
    });
    expect(result).toEqual({ status: 503, body: { error: "ownership_unavailable" } });
    expect(await instances.listEvents(owner)).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it.each([
    {
      owners: [
        { kind: "unit", instanceId: "runner-fixture", unit: "U10" },
        { kind: "unit", instanceId: "rival", unit: "U11" },
      ],
    },
    {
      owners: [
        { kind: "unit", instanceId: "runner-fixture", unit: "U10" },
        { kind: "run", runId: "rival" },
      ],
    },
    { owners: [{ kind: "effect", id: "held" }] },
  ])("does not choose a webhook destination from conflicting ownership: %j", async ({ owners }) => {
    const { instances, owner } = await liveInstances();
    const w = workflow();
    const raw = commentBody();
    const result = await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      ownerOf: async () => runnerPullOwnerOf({ ok: true, owners }),
      instances,
      commenterAuthorized: async () => true,
      workflow: w.sender,
      now: () => 1,
    });
    expect(result).toEqual({ status: 503, body: { error: "ownership_unavailable" } });
    expect(await instances.listEvents(owner)).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("atomically refuses an ordinary comment when the unit ends after its owner read", async () => {
    const { instances, owner } = await liveInstances();
    const w = workflow();
    const raw = commentBody();
    const result = await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      ownerOf: (repo, pr) => findRunnerPullOwner(instances, repo, pr),
      instances: {
        get: instances.get.bind(instances),
        listUnits: instances.listUnits.bind(instances),
        appendEvent: async (...args) => {
          const [row] = await instances.listUnits(owner.instanceId);
          await instances.putUnits([
            {
              ...row!,
              idle: undefined,
              ending: {
                kind: "refused",
                report: "ended",
                at: 2,
                outcome: { schemaVersion: 1, kind: "refused", reviewRounds: 0 },
              },
            },
          ]);
          return instances.appendEvent(...args);
        },
      },
      commenterAuthorized: async () => true,
      workflow: w.sender,
      now: () => 1,
    });
    expect(result).toEqual({ status: 200, body: { ok: true, ignored: "ended" } });
    expect(await instances.listEvents(owner)).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("keeps a recovery comment on its exact original unit and nudges its recovery Workflow", async () => {
    const { instances, owner, actionId: savedActionId } = await liveInstances(true);
    const actionId = savedActionId!;
    const w = workflow();
    const raw = commentBody();
    const deps = {
      secret: SECRET,
      ownerOf: (repo: string, pr: number) => findRunnerPullOwner(instances, repo, pr),
      instances,
      commenterAuthorized: async () => true,
      workflow: w.sender,
      now: () => 1,
    };
    expect(
      (await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, raw) }, raw, deps)).body,
    ).toMatchObject({ appended: true });
    expect(await instances.listEvents(owner)).toHaveLength(1);
    expect(w.sent).toEqual([{ instance: "recovery-original", type: unitNudgeEventType(owner), payload: {} }]);
    const event = (await instances.listEvents(owner))[0]!;
    for (const expected of [
      { actionId: "r_" + "b".repeat(64), workflowId: "recovery-original" },
      { actionId, workflowId: "recovery-successor" },
    ]) {
      expect(await instances.appendEvent(owner, event, true, undefined, expected)).toEqual({
        ok: false,
        reason: "stale",
      });
    }
    expect(
      await instances.appendEvent(owner, event, true, undefined, { actionId, workflowId: "recovery-original" }),
    ).toEqual({ ok: true, seq: 1 });
    expect(await instances.listEvents(owner)).toHaveLength(1);
  });

  it("a stopped recovery cannot use an old duplicate event to append or wake", async () => {
    const { instances, owner, actionId: savedActionId } = await liveInstances(true);
    const actionId = savedActionId!;
    const event = {
      id: "github:issue-comment:99",
      sender: "github:42",
      text: "Receipt",
      mode: "steer" as const,
      at: 1,
    };
    expect(
      await instances.appendEvent(owner, event, true, undefined, { actionId, workflowId: "recovery-original" }),
    ).toEqual({ ok: true, seq: 1 });
    await instances.markStopped(owner.instanceId, 3);
    expect(
      await instances.appendEvent(owner, event, true, undefined, { actionId, workflowId: "recovery-original" }),
    ).toEqual({ ok: false, reason: "ended" });
    expect(await instances.listEvents(owner)).toHaveLength(1);
  });

  it("a verified comment from the requester's bound GitHub account appends one attributed wake event and nudges the live idle unit", async () => {
    const { instances, owner } = await liveInstances();
    const w = workflow();
    const raw = commentBody();
    const result = await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      ownerOf: (repo, pr) => findRunnerPullOwner(instances, repo, pr),
      instances,
      commenterAuthorized: async (requester, author) =>
        requester === "slack:UALICE" && author.login === "alice" && author.id === 42,
      workflow: w.sender,
      now: () => 1,
    });
    expect(result).toEqual({ status: 200, body: { ok: true, appended: true, seq: 1, nudge: "sent" } });
    expect(await instances.listEvents(owner)).toEqual([
      expect.objectContaining({
        id: "github:issue-comment:99",
        sender: "github:42",
        senderName: "alice",
        text: "The independent reader supplied the receipt.",
        mode: "wake",
      }),
    ]);
    expect(w.sent).toEqual([{ instance: owner.instanceId, type: unitNudgeEventType(owner), payload: {} }]);
  });

  it("a comment from an account not bound to the requester cannot wake or steer the unit", async () => {
    const { instances, owner } = await liveInstances();
    const w = workflow();
    const raw = commentBody();
    const result = await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      ownerOf: (repo, pr) => findRunnerPullOwner(instances, repo, pr),
      instances,
      commenterAuthorized: async () => false,
      workflow: w.sender,
      now: () => 1,
    });
    expect(result).toEqual({ status: 200, body: { ok: true, ignored: "sender" } });
    expect(await instances.listEvents(owner)).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("a bot comment and an unowned pull request are acknowledged without appending", async () => {
    const instances = new InMemoryCoordinatorInstanceStore();
    const bot = commentBody("Bot");
    expect(
      (
        await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, bot) }, bot, {
          secret: SECRET,
          ownerOf: async () => ({ ok: true }),
          instances,
          commenterAuthorized: async () => false,
          workflow: undefined,
          now: () => 1,
        })
      ).body,
    ).toEqual({ ok: true, ignored: "sender" });
    const human = commentBody();
    expect(
      (
        await handleIssueCommentIntake({ event: "issue_comment", signature: await sign(SECRET, human) }, human, {
          secret: SECRET,
          ownerOf: async () => ({ ok: true }),
          instances,
          commenterAuthorized: async () => false,
          workflow: undefined,
          now: () => 1,
        })
      ).body,
    ).toEqual({ ok: true, ignored: "unowned" });
  });
});

describe("the merge-wait registry — who the settled head wakes", () => {
  it("notes waiters per head, answers them until the TTL passes, and never mixes heads", () => {
    const reg = createMergeWaitRegistry(10_000);
    reg.note("aaa111", "plan-x", 1_000);
    reg.note("aaa111", "plan-y", 2_000);
    reg.note("bbb222", "plan-z", 1_000);
    expect(reg.waitingAt("aaa111", 5_000).sort()).toEqual(["plan-x", "plan-y"]);
    expect(reg.waitingAt("bbb222", 5_000)).toEqual(["plan-z"]);
    expect(reg.waitingAt("ccc333", 5_000)).toEqual([]);
    // plan-x's entry expires; plan-y's stands.
    expect(reg.waitingAt("aaa111", 12_000)).toEqual(["plan-y"]);
    expect(reg.waitingAt("aaa111", 13_000)).toEqual([]);
  });
});

describe("the push-to-base intake — the merge watch's trigger (record 0071, mechanism three)", () => {
  const pushBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "octo/repo" }, ...over });

  function watch() {
    const pushes: Array<{ repo: string; base: string }> = [];
    return {
      pushes,
      watch: {
        async pushToBase(repo: string, base: string) {
          pushes.push({ repo, base });
          return [{ repo, number: 7, outcome: "resolver" as const }];
        },
      },
    };
  }

  it("verified: a branch push hands exactly the repo and branch to the watch, and answers what it did", async () => {
    const w = watch();
    const raw = pushBody();
    const res = await handlePushIntake({ event: "push", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      watch: w.watch,
    });
    expect(res).toEqual({
      status: 200,
      body: { ok: true, watched: 1, results: [{ repo: "octo/repo", number: 7, outcome: "resolver" }] },
    });
    expect(w.pushes).toEqual([{ repo: "octo/repo", base: "main" }]);
  });

  it("no secret is disabled, a bad signature is unauthorized, a non-push event and a tag push are ignored", async () => {
    const w = watch();
    const raw = pushBody();
    expect(
      (await handlePushIntake({ event: "push", signature: "sha256=x" }, raw, { secret: undefined, watch: w.watch }))
        .status,
    ).toBe(503);
    expect(
      (await handlePushIntake({ event: "push", signature: "sha256=deadbeef" }, raw, { secret: SECRET, watch: w.watch }))
        .status,
    ).toBe(401);
    const other = await handlePushIntake({ event: "ping", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      watch: w.watch,
    });
    expect(other.body).toEqual({ ok: true, ignored: "event" });
    const tag = pushBody({ ref: "refs/tags/v1.0.0" });
    const tagged = await handlePushIntake({ event: "push", signature: await sign(SECRET, tag) }, tag, {
      secret: SECRET,
      watch: w.watch,
    });
    expect(tagged.body).toEqual({ ok: true, ignored: "ref" });
    expect(w.pushes).toEqual([]);
  });

  it("without a wired watch the push is acknowledged and nothing runs; a malformed body is named", async () => {
    const raw = pushBody();
    const res = await handlePushIntake({ event: "push", signature: await sign(SECRET, raw) }, raw, {
      secret: SECRET,
      watch: undefined,
    });
    expect(res.body).toEqual({ ok: true, watched: 0 });
    const bad = "{not json";
    expect(
      (
        await handlePushIntake({ event: "push", signature: await sign(SECRET, bad) }, bad, {
          secret: SECRET,
          watch: undefined,
        })
      ).status,
    ).toBe(400);
    const missing = JSON.stringify({ repository: { full_name: "octo/repo" } });
    expect(
      (
        await handlePushIntake({ event: "push", signature: await sign(SECRET, missing) }, missing, {
          secret: SECRET,
          watch: undefined,
        })
      ).status,
    ).toBe(400);
  });
});
