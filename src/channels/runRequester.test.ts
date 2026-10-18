import { describe, expect, it, vi } from "vitest";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import type { ExternalIdentity } from "../core/identity/contract.js";
import { requesterName, readRequesterName } from "./runRequester.js";

const browser: ExternalIdentity = { issuer: "https://team.example.test", tenant: null, subject: "account-1" };
const slack: ExternalIdentity = { issuer: "https://slack.com", tenant: "T1", subject: "UALICE" };
async function fixture() {
  const store = new InMemoryOrganizationStore(() => 1000);
  const created = await store.directory.createPerson();
  if (created.status !== "created") throw new Error("fixture");
  for (const identity of [browser, slack]) {
    await store.directory.change({
      action: "link",
      identity,
      personId: created.person.id,
      expectedRevision: 0,
      actor: identity,
      proof: { method: "dual-authentication", version: 1 },
    });
  }
  return {
    store,
    options: {
      organization: "test",
      store,
      browserIssuer: browser.issuer,
      mcpIssuer: "installation:test:mcp:sso",
      slackTeam: "T1",
      name: async (id: string) => (id === "slack:UALICE" ? "Alice Chen" : undefined),
      tokens: {},
      personByEmail: async () => undefined,
    },
  };
}

describe("requesterName", () => {
  it("gives linked browser and Slack identities the same profile label without changing attribution", async () => {
    const { options } = await fixture();
    expect(await requesterName("access:account-1", options)).toBe("Alice Chen");
    expect(await requesterName("slack:UALICE", options)).toBe("Alice Chen");
    expect(await requesterName("access:unlinked", options)).toBeUndefined();
  });

  it("does not use revoked or foreign-workspace profile links", async () => {
    const { store, options } = await fixture();
    expect(await requesterName("access:account-1", { ...options, slackTeam: "T2" })).toBeUndefined();
    const bound = await store.directory.resolve(slack);
    if (bound.status !== "bound") throw new Error("fixture");
    await store.directory.change({
      action: "revoke",
      identity: slack,
      personId: bound.binding.personId,
      expectedRevision: 1,
      actor: slack,
      proof: { method: "authenticated-human", version: 1 },
    });
    expect(await requesterName("access:account-1", options)).toBeUndefined();
    expect(await requesterName("slack:UALICE", options)).toBe("Alice Chen");
  });

  it("names an ingress credential only when its configured email maps to one person", async () => {
    const { options } = await fixture();
    const configured = {
      ...options,
      tokens: { a: { subject: "ingress", email: "alice@example.test" } },
      personByEmail: async () => ({ id: "slack:UALICE", name: "Alice Chen" }),
    };
    expect(await requesterName("http:ingress", configured)).toBe("Alice Chen");
    expect(await requesterName("mcp:ingress", configured)).toBe("Alice Chen");
    expect(await requesterName("http:other", configured)).toBeUndefined();
    expect(
      await requesterName("http:ingress", {
        ...configured,
        tokens: { ...configured.tokens, b: { subject: "ingress", email: "other@example.test" } },
      }),
    ).toBeUndefined();
  });
});

describe("requester label diagnostics", () => {
  it("reports a failed lookup without exposing requester or error text", async () => {
    const { options } = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failed = await readRequesterName(
        (id) =>
          requesterName(id, {
            ...options,
            name: async () => {
              throw new Error("private bearer and email");
            },
          }),
        "slack:UPRIVATE",
      );
      expect({ label: failed, warnings: warn.mock.calls }).toEqual({
        label: undefined,
        warnings: [[JSON.stringify({ event: "runs.requester_label.degraded", kind: "slack", reason: "failed" })]],
      });
      expect(await readRequesterName(async () => "Alice Chen", "slack:UALICE")).toBe("Alice Chen");
    } finally {
      warn.mockRestore();
    }
  });

  it("reports a deadline expiry once with a fixed kind for unknown sources", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pending = readRequesterName(async () => new Promise<string>(() => {}), "private@example.test");
      await vi.advanceTimersByTimeAsync(1500);
      expect({ label: await pending, warnings: warn.mock.calls }).toEqual({
        label: undefined,
        warnings: [[JSON.stringify({ event: "runs.requester_label.degraded", kind: "unknown", reason: "timeout" })]],
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(warn.mock.calls).toEqual([
        [JSON.stringify({ event: "runs.requester_label.degraded", kind: "unknown", reason: "timeout" })],
      ]);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("distinguishes an unavailable directory from a missing account link", async () => {
    const { options, store } = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await requesterName("access:unlinked", options)).toBeUndefined();
      const original = store.directory.resolve;
      store.directory.resolve = async () => ({ status: "unavailable" });
      const failed = await requesterName("access:account-1", options);
      store.directory.resolve = original;
      expect({ label: failed, warnings: warn.mock.calls }).toEqual({
        label: undefined,
        warnings: [[JSON.stringify({ event: "runs.requester_label.degraded", kind: "access", reason: "unavailable" })]],
      });
      expect(await requesterName("access:account-1", options)).toBe("Alice Chen");
    } finally {
      warn.mockRestore();
    }
  });
});
