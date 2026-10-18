import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpApprovalView } from "./mcpApprovalView.js";
import { InMemoryConfirmationStore } from "../core/confirmations.js";
import { CommandRegistry, bindCommands } from "../core/commandRegistry.js";
import { NO_GRANTS, type Actor, type Grants } from "../core/authz/types.js";
import { RunRegistry } from "../core/runRegistry.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { InMemoryPersonalTokenStore } from "../mcp/personalTokens.js";
import { SingleShotIO } from "./singleShotDispatch.js";
import { withOriginalOrganizationDispatch } from "../core/dispatch/originalOrganizationInput.js";
import type { CoreDeps } from "../core/dispatcher.js";
import type { McpOptions } from "./mcp.js";
import type { AccessIdentity } from "./accessAuth.js";
import type { Confirmation, ConfirmationSource } from "../core/confirmations.js";

// Feature: docs/reference/specs/mcp-ingress.md — browser consent reads current
// original-source proof and leaves execution with the existing MCP owner.
describe("browser approval current source", () => {
  async function fixture(risk = "destructive", grants: Grants = ALL_GRANTS, credentialGrants: Grants = ALL_GRANTS) {
    const connection = "a".repeat(64);
    const tokens = new InMemoryPersonalTokenStore();
    await tokens.put({
      digest: connection,
      subject: "personal:alice",
      userId: "access:alice",
      email: "unused@example.test",
      createdAt: 1,
    });
    const store = new InMemoryConfirmationStore({ clock: () => 10 });
    const registry = new CommandRegistry({ audit: () => {} });
    registry.register({
      id: "repo.offboard",
      action: "repo:write",
      effect: "write",
      describe: "Remove a repository",
      handler: async () => ({ removed: true }),
    });
    const commands = bindCommands(registry, {});
    const saved = await store.put(
      {
        kind: "run",
        id: "offer-original",
        message: withOriginalOrganizationDispatch(
          {
            userId: "access:alice",
            authenticatedAs: "mcp:personal:alice",
            channelId: "mcp:default",
            threadKey: "mcp:default:original",
            text: "remove the repository",
            approvalConnection: { id: connection, credentialId: "mcp:personal:alice", requestHash: "b".repeat(64) },
          },
          { ingressRunId: "original-owner", organizationSequence: 1 },
        ),
        command: "repo.offboard",
        input: { args: [], options: {} },
        receipt: "Remove the registered repository",
        risk,
        model: "fixture/model",
      },
      1000,
    );
    let available = true,
      permitted = true,
      servicePermitted = true,
      foreign = false,
      outage = false;
    const source = async (identity: AccessIdentity, _row: Confirmation): Promise<ConfirmationSource | undefined> => {
      if (outage) throw new Error("current source unavailable");
      if (!available || identity.sub !== "alice") return;
      const actor: Actor = {
        kind: "service",
        id: foreign ? "mcp:personal:bob" : "mcp:personal:alice",
        grants: servicePermitted ? credentialGrants : NO_GRANTS,
        self: ["mcp:personal:alice"],
        onBehalfOf: {
          kind: "user",
          id: "access:alice",
          grants: permitted ? grants : NO_GRANTS,
          self: ["access:alice"],
        },
      };
      return { actor, io: new SingleShotIO([], saved.message.threadKey) };
    };
    const core = {
      config: { grantsFor: () => ALL_GRANTS },
      confirmations: store,
      clock: () => 10,
    } as unknown as CoreDeps;
    const options = {
      stylesheets: ["/assets/green-fixture.css"],
      auth: { tokens: {} },
      personalTokens: tokens,
      commands,
      publicBaseUrl: "https://bot.example",
      resolveApprovalSource: source,
    };
    const page = (
      action?: string,
      beforeBody?: () => Promise<void> | void,
      supplied = options,
      sub = "alice",
      origin: string | undefined = "https://bot.example",
      viewer?: Actor,
    ) =>
      new Promise<{ status: number; text: string }>((resolve) => {
        async function* chunks() {
          await beforeBody?.();
          yield Buffer.from(`action=${action}`);
        }
        const req = Object.assign(chunks(), {
          url: "/settings/approve?id=offer-original",
          method: action ? "POST" : "GET",
          headers: {
            ...(origin ? { origin } : {}),
            "sec-fetch-site": "same-origin",
            "content-type": "application/x-www-form-urlencoded",
          },
        });
        let status = 0;
        const res = {
          writeHead: (s: number) => {
            status = s;
          },
          end: (text: string) => resolve({ status, text }),
        };
        createMcpApprovalView(core, supplied as McpOptions)(req as never, res as never, { sub }, viewer);
      });
    return {
      core,
      registry,
      store,
      saved,
      tokens,
      connection,
      page,
      options,
      loseProof: () => {
        available = false;
      },
      losePermission: () => {
        permitted = false;
      },
      loseServicePermission: () => {
        servicePermitted = false;
      },
      useForeign: () => {
        foreign = true;
      },
      sourceOutage: (value: boolean) => {
        outage = value;
      },
    };
  }

  async function runFixture(grants: Grants = ALL_GRANTS, command = "runs.stop", credentialGrants = ALL_GRANTS) {
    const f = await fixture("Ends the current turn.", grants, credentialGrants);
    f.registry.register({
      id: command,
      args: [{ name: "id", schema: z.string(), describe: "Run to stop" }],
      action: "stop:write",
      effect: "write",
      describe: "Stop the run",
      handler: async () => ({ stopped: true }),
    });
    const runs = new RunRegistry({ now: () => 10 });
    const target = runs.create(
      "Review the <retry> fix",
      {
        agent: "review",
        repo: "acme/app",
        channelId: "mcp:default",
        userId: "access:bob",
        threadKey: "mcp:default:target",
        channelVisibility: "machine",
      },
      { id: "target-run" },
    );
    runs.publish(target.id, { type: "run_meta", agent: "review", repo: "acme/app", pr: 42 });
    f.core.runRegistry = runs;
    f.core.runs = {
      getRun: () => {
        throw new Error("Run storage must not be read for display context");
      },
    } as unknown as NonNullable<CoreDeps["runs"]>;
    if (f.saved.kind !== "run") throw new Error("Expected a saved command");
    await f.store.put({ ...f.saved, command, input: { args: [target.id], options: {} } }, 1000);
    return { ...f, runs, target };
  }

  it("leaves saved consent unchanged in a trusted Person view before buffering its body", async () => {
    const f = await fixture();
    let read = false;
    for (const action of ["approve", "cancel"]) {
      const result = await f.page(
        action,
        () => {
          read = true;
        },
        f.options,
        "alice",
        "https://bot.example",
        {
          kind: "user",
          id: "access:alice",
          grants: ALL_GRANTS,
          viewingAs: { id: "access:bob" },
        },
      );
      expect(result.status).toBe(403);
      expect(read).toBe(false);
      expect(await f.store.get(f.saved.id)).not.toHaveProperty("browserApproved");
    }
  });

  it("uses the exact signed-in subject and current delegated credential without email, recording consent but not consuming its owner", async () => {
    const f = await fixture();
    const shown = await f.page();
    expect(shown.status).toBe(200);
    expect(shown.text).toContain("Confirm saved action");
    expect((await f.page("approve")).status).toBe(200);
    expect(await f.store.get(f.saved.id)).toMatchObject({
      command: "repo.offboard",
      browserApproved: true,
      approvedBy: "browser",
      originalOrganization: { ingressRunId: "original-owner", organizationSequence: 1 },
    });
    expect((await f.page(undefined, undefined, f.options, "bob")).status).toBe(404);
  });

  it("shows the saved action, escaped risk and Pacific expiry in a native approval form", async () => {
    const f = await fixture('<script>alert("risk")</script>\nDeletes the repository.');
    const shown = await f.page();
    expect(shown.status).toBe(200);
    expect(shown.text).toContain('<link rel="stylesheet" href="/assets/green-fixture.css">');
    expect(shown.text).toContain("<code>repo offboard</code>");
    expect(shown.text).toContain("&lt;script&gt;alert(&quot;risk&quot;)&lt;/script&gt;\nDeletes the repository.");
    expect(shown.text).toContain('<time datetime="1970-01-01T00:00:01.010Z">Dec 31, 1969, 4:00:01 PM PST</time>');
    expect(shown.text).toContain('<form method="post" action="/settings/approve?id=offer-original">');
    expect(shown.text).not.toContain('<script>alert("risk")</script>');
    const approved = await f.page("approve");
    expect(approved.status).toBe(200);
    expect(approved.text).toContain("Approval status");
    expect(approved.text).toContain("Approved. Return to your MCP client to complete the saved action once.");
    expect(approved.text).not.toContain("<form");
    expect(await f.store.get(f.saved.id)).toMatchObject({ browserApproved: true });
  });

  it.each(["runs.stop", "runs.kill"])(
    "shows cached run context for %s without reading run storage or changing the saved action",
    async (command) => {
      const f = await runFixture(ALL_GRANTS, command);
      const shown = await f.page();
      expect(shown.status).toBe(200);
      expect(shown.text).toContain('<p class="approval-run-label">Review the &lt;retry&gt; fix</p>');
      expect(shown.text).not.toContain('<a href="/runs/');
      expect(shown.text).toContain("<dt>Pull request</dt><dd>acme/app#42</dd>");
      expect(shown.text).toContain("<dt>Agent</dt><dd>review</dd>");
      expect(shown.text).not.toContain(f.target.token);
      expect(await f.store.get(f.saved.id)).toMatchObject({ command, input: { args: ["target-run"], options: {} } });
    },
  );

  it.each(["person", "credential"])(
    "keeps consent available without run details when the %s lacks the run-read grant",
    async (limited) => {
      const noRead = { ...ALL_GRANTS, actions: new Set(["dispatch", "stop:write"]) };
      const f = await runFixture(
        limited === "person" ? noRead : ALL_GRANTS,
        "runs.stop",
        limited === "credential" ? noRead : ALL_GRANTS,
      );
      const shown = await f.page();
      expect(shown.status).toBe(200);
      expect(shown.text).toContain("Confirm saved action");
      expect(shown.text).toContain("<code>runs stop target-run</code>");
      expect(shown.text).not.toContain("acme/app");
      expect(shown.text).not.toContain("Review the &lt;retry&gt; fix");
      expect((await f.page("approve")).status).toBe(200);
      expect(await f.store.get(f.saved.id)).toMatchObject({ browserApproved: true, command: "runs.stop" });
    },
  );

  it("omits unreadable or uncached context while keeping the saved approval available", async () => {
    const f = await runFixture({ ...ALL_GRANTS, channels: new Set() });
    const unreadable = await f.page();
    expect(unreadable.status).toBe(200);
    expect(unreadable.text).toContain("Confirm saved action");
    expect(unreadable.text).not.toContain("acme/app");
    expect(unreadable.text).not.toContain("Review the &lt;retry&gt; fix");
    const readable = await runFixture();
    expect((await readable.page()).text).toContain("acme/app#42");
    readable.core.runRegistry = new RunRegistry();
    const uncached = await readable.page();
    expect(uncached.status).toBe(200);
    expect(uncached.text).toContain("Confirm saved action");
    expect(uncached.text).not.toContain("acme/app");
  });

  it("omits private worker context and absent metadata without blocking the form", async () => {
    const f = await runFixture();
    f.runs.create(
      "Private worker details",
      { threadKey: "worker:private:unit", channelId: "mcp:default", userId: "access:bob" },
      { id: "target-run" },
    );
    const hidden = await f.page();
    expect(hidden.status).toBe(200);
    expect(hidden.text).toContain("Confirm saved action");
    expect(hidden.text).not.toContain("Private worker details");
    f.runs.create(undefined, undefined, { id: "target-run" });
    const minimal = await f.page();
    expect(minimal.status).toBe(200);
    expect(minimal.text).toContain("Confirm saved action");
    expect(minimal.text).not.toContain('class="approval-context"');
    expect(minimal.text).not.toContain("<dt>Pull request</dt>");
    expect(minimal.text).not.toContain("<dt>Agent</dt>");
  });

  it.each(["approve", "cancel"])(
    "holds the original offer when its source changes while %s body is read",
    async (action) => {
      const f = await fixture();
      expect((await f.page()).status).toBe(200);
      const answer = await f.page(action, f.loseProof);
      expect(answer.status).toBe(403);
      expect(answer.text).toContain("The saved source changed; nothing ran.");
      expect(await f.store.get(f.saved.id)).toEqual(f.saved);
    },
  );

  it("retains the original offer through a temporary current-source lookup outage", async () => {
    const f = await fixture();
    expect((await f.page()).status).toBe(200);
    expect((await f.page("approve", () => f.sourceOutage(true))).status).toBe(503);
    expect(await f.store.get(f.saved.id)).toEqual(f.saved);
    f.sourceOutage(false);
    expect((await f.page("approve")).status).toBe(200);
    expect(await f.store.get(f.saved.id)).toMatchObject({
      approvedBy: "browser",
      originalOrganization: { ingressRunId: "original-owner" },
    });
  });

  it("rechecks the exact connection and both current policy ceilings after the form body", async () => {
    for (const loss of ["credential", "person", "service"] as const) {
      const f = await fixture();
      expect((await f.page()).status).toBe(200);
      const result = await f.page("approve", async () => {
        if (loss === "credential") await f.tokens.delete(f.connection, "personal:alice");
        else if (loss === "person") f.losePermission();
        else f.loseServicePermission();
      });
      expect(result.status).toBe(403);
      expect(await f.store.get(f.saved.id)).toEqual(f.saved);
    }
  });

  it("does not use legacy identity fallback for protected offers or borrow a different source actor", async () => {
    const f = await fixture();
    expect((await f.page()).status).toBe(200);
    const { resolveApprovalSource: _resolver, ...legacy } = f.options;
    expect((await f.page(undefined, undefined, legacy as typeof f.options)).status).toBe(404);
    f.useForeign();
    expect((await f.page()).status).toBe(404);
    expect(await f.store.get(f.saved.id)).toEqual(f.saved);
  });

  it("requires a same-origin form even when current source proof is available", async () => {
    const f = await fixture();
    expect((await f.page()).status).toBe(200);
    for (const origin of ["", "https://foreign.example"])
      expect((await f.page("approve", undefined, f.options, "alice", origin)).status).toBe(403);
    expect(await f.store.get(f.saved.id)).toEqual(f.saved);
  });
});
