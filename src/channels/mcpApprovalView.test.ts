import { describe, expect, it } from "vitest";
import { createMcpApprovalView } from "./mcpApprovalView.js";
import { InMemoryConfirmationStore } from "../core/confirmations.js";
import { CommandRegistry, bindCommands } from "../core/commandRegistry.js";
import { NO_GRANTS, type Actor } from "../core/authz/types.js";
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
  async function fixture() {
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
        risk: "destructive",
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
        grants: servicePermitted ? ALL_GRANTS : NO_GRANTS,
        self: ["mcp:personal:alice"],
        onBehalfOf: {
          kind: "user",
          id: "access:alice",
          grants: permitted ? ALL_GRANTS : NO_GRANTS,
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
