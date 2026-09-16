import { describe, expect, it } from "vitest";
import { boundRequester, type PersonLookup } from "./requester.js";

// Feature: docs/reference/specs/authorization.md item 15 — a credential bound to a
// person by email sends the person's request; the credential rides beside it
// as `authenticatedAs`. Identity, never authority.

const alice = { id: "slack:U0ALICE", name: "alice" };
const found: PersonLookup = async () => alice;

describe("boundRequester", () => {
  it("a bound credential whose email names a person → the person's id and name, the credential as authenticatedAs", async () => {
    await expect(boundRequester("http:alice-ingress", "alice@example.com", found)).resolves.toEqual({
      userId: "slack:U0ALICE",
      userName: "alice",
      authenticatedAs: "http:alice-ingress",
    });
    // A person without a display name still binds; `userName` is simply absent.
    await expect(
      boundRequester("mcp:alice-mcp", "alice@example.com", async () => ({ id: "slack:U0ALICE" })),
    ).resolves.toEqual({
      userId: "slack:U0ALICE",
      authenticatedAs: "mcp:alice-mcp",
    });
  });

  it("fail-open to the credential alone: no email, no lookup, no match, a non-Slack answer, a throwing lookup", async () => {
    const asIs = { userId: "http:ci" };
    await expect(boundRequester("http:ci", undefined, found)).resolves.toEqual(asIs);
    await expect(boundRequester("http:ci", "", found)).resolves.toEqual(asIs);
    await expect(boundRequester("http:ci", "ci@example.com", undefined)).resolves.toEqual(asIs);
    await expect(boundRequester("http:ci", "ci@example.com", async () => undefined)).resolves.toEqual(asIs);
    await expect(boundRequester("http:ci", "ci@example.com", async () => ({ id: "access:abc" }))).resolves.toEqual(
      asIs,
    );
    await expect(
      boundRequester("http:ci", "ci@example.com", async () => {
        throw new Error("slack down");
      }),
    ).resolves.toEqual(asIs);
    // Never `authenticatedAs` without a person: the field means "the sender is not the credential".
    for (const r of [await boundRequester("http:ci", undefined, found)]) expect("authenticatedAs" in r).toBe(false);
  });

  it("the lookup is asked with the email exactly as the token entry carries it", async () => {
    const asked: string[] = [];
    await boundRequester("cli:local", "alice@example.com", async (e) => {
      asked.push(e);
      return alice;
    });
    expect(asked).toEqual(["alice@example.com"]);
  });
});
