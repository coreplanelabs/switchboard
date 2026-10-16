import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createGithubWebhookHandler } from "./githubWebhook.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { findRunnerPullOwner } from "../core/runnerOwnership.js";
import { findGithubCommentReplay, verifyGithubQuestionAnswer } from "../core/coordinator/checksIntake.js";

// Feature: docs/reference/specs/http-ingress.md — authenticated native delivery identity.
describe("GitHub native push delivery source", () => {
  it("carries the authenticated delivery header rather than payload text and refuses missing or unsigned source", async () => {
    const secret = "local-webhook-fixture";
    const watch = { pushToBase: vi.fn(async (_repo: string, _base: string, _eventId?: string) => []) };
    const handler = createGithubWebhookHandler({
      secret,
      watch,
      checksSettled: async () => false,
      instancesWaitingAt: async () => [],
      workflow: undefined,
      now: () => 1,
    });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "acme/api" },
        delivery: "payload-is-not-the-source",
      });
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      const post = (headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: "POST",
          headers: { "x-github-event": "push", "x-hub-signature-256": signature, ...headers },
          body,
        });
      const admitted = await post({ "x-github-delivery": "actual-native-delivery" });
      expect(admitted.status).toBe(200);
      await admitted.json();
      expect(watch.pushToBase).toHaveBeenCalledWith("acme/api", "main", "github:actual-native-delivery");
      const missing = await post({});
      expect(missing.status).toBe(400);
      await missing.json();
      const unsigned = await post({ "x-github-delivery": "fake-delivery", "x-hub-signature-256": "sha256=bad" });
      expect(unsigned.status).toBe(401);
      await unsigned.json();
      expect(watch.pushToBase).toHaveBeenCalledTimes(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("GitHub native question answers", () => {
  it("keeps signed installation and human comment provenance while crediting only the bound canonical assignee", async () => {
    const secret = "question-webhook-fixture";
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const owner = { instanceId: "signed-question", unit: "question" };
    await instances.put({
      id: owner.instanceId,
      kind: "ship",
      userId: "slack:owner",
      channelId: "slack:private",
      threadKey: "slack:private:1",
      repo: "example/app",
      branch: "work",
      createdAt: 1,
    });
    await instances.putUnits([
      {
        ...owner,
        slug: "question",
        branch: "work/question",
        dependsOn: [],
        rounds: [],
        pr: { number: 12, url: "https://github.com/example/app/pull/12" },
        idle: {
          why: "held",
          at: 2,
          spendUsd: 0,
          renewalsLeft: 0,
          wakes: 0,
          humanGate: {
            pr: { number: 12, url: "https://github.com/example/app/pull/12" },
            round: 1,
            verdict: "request_changes",
            askedAt: 2,
            assignedTo: "slack:owner",
            findings: [{ id: "F1", severity: "minor", file: "app.ts", title: "Choose behavior", humanGated: true }],
          },
        },
      },
    ]);
    const handler = createGithubWebhookHandler({
      secret,
      instances,
      ownerOf: (repo, pr) => findRunnerPullOwner(instances, repo, pr),
      replayOwnerOf: (repo, pr, id) => findGithubCommentReplay(instances, repo, pr, id),
      commenterAuthorized: async () => false,
      verifyQuestionAnswer: async (input) =>
        verifyGithubQuestionAnswer(input, {
          organization: "example",
          installationId: 17,
          binding: { login: "owner", id: 42 },
          requester: {
            status: "resolved",
            actor: {
              kind: "user",
              id: "slack:owner",
              memberOfOrganizations: new Set(["example"]),
              grants: { actions: new Set(["steer:write"]), channels: new Set(), repos: new Set(["example/app"]) },
            },
          },
        }),
      checksSettled: async () => false,
      instancesWaitingAt: async () => [],
      workflow: undefined,
      now: () => 4,
    });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const body = JSON.stringify({
        action: "created",
        installation: { id: 17 },
        repository: { full_name: "example/app" },
        issue: { number: 12, pull_request: {} },
        comment: {
          id: 99,
          body: "Keep the documented behavior",
          created_at: new Date(1000).toISOString(),
          user: { id: 42, login: "owner", type: "User" },
        },
        requester: "slack:someone-else",
        actor: { id: "slack:someone-else", grants: "all" },
      });
      const post = (signature: string) =>
        fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/github`, {
          method: "POST",
          headers: { "x-github-event": "issue_comment", "x-hub-signature-256": signature },
          body,
        });
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      const accepted = await post(signature);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ ok: true, appended: true, seq: 1, nudge: "no-binding" });
      expect(await instances.listEvents(owner)).toEqual([
        expect.objectContaining({
          seq: 1,
          id: "github:issue-comment:99",
          sender: "slack:owner",
          authenticatedAs: "github:42",
          postedBy: "github:installation:17",
          senderName: "owner",
          text: "Keep the documented behavior",
          mode: "wake",
          at: 1000,
        }),
      ]);
      const unsigned = await post("sha256=bad");
      expect(unsigned.status).toBe(401);
      expect(await unsigned.json()).toEqual({ error: "unauthorized" });
      expect((await instances.listEvents(owner)).map((event) => event.seq)).toEqual([1]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
