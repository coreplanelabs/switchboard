import { describe, expect, it } from "vitest";
import type { ExternalIdentity, PersonId } from "../identity/contract.js";
import { InMemoryOrganizationStore } from "./memory.js";
import {
  OrganizationService,
  type OrganizationAdmissionInput,
  type OrganizationAuthentication,
  type OrganizationAuthorization,
  type OrganizationMapping,
} from "./service.js";
const identity = { issuer: "access:test", tenant: null, subject: "alice" };
const browser: OrganizationAuthentication = { source: "browser", identity, kind: "human" };
const mappings: OrganizationMapping[] = [
  { source: "browser", issuer: "access:test", tenant: null, organization: "org:test" },
  { source: "slack", issuer: "https://slack.com", tenant: "workspace", organization: "org:test" },
  { source: "github", issuer: "github:test", tenant: "installation", organization: "org:test" },
  ...(["cli", "http", "mcp"] as const).map((source) => ({
    source,
    issuer: "token:test",
    tenant: null,
    organization: "org:test",
  })),
];
const limits = {
  pendingPerActor: 3,
  pendingPerSource: 10,
  pendingPerOrganization: 20,
  reservedReconciliation: 1,
  contentTtlMs: 90,
  receiptTtlMs: 365,
};
const input = (key = "event-1"): OrganizationAdmissionInput => ({
  sourceEvent: key,
  key,
  destination: { kind: "broad" },
  workload: "message",
  target: null,
  content: "A private request",
  context: [],
});
function setup(
  authorize: (request: OrganizationAuthorization) => Promise<boolean> = async () => true,
  suppliedMappings = mappings,
) {
  const store = new InMemoryOrganizationStore(() => 1);
  const service = new OrganizationService({
    store,
    directory: store.directory,
    mappings: suppliedMappings,
    limits,
    authorize,
  });
  return { store, service };
}
async function bind(store: InMemoryOrganizationStore, identities: ExternalIdentity[]): Promise<PersonId> {
  const person = await store.directory.createPerson();
  if (person.status !== "created") throw new Error("person unavailable");
  for (const identity of identities)
    expect(
      await store.directory.change({
        action: "link",
        identity,
        personId: person.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      }),
    ).toMatchObject({ status: "changed" });
  return person.person.id;
}
async function sendBrowser(service: OrganizationService, authentication = browser, request = input()) {
  const key = await service.issue(authentication, 30);
  if (key.status !== "key") throw new Error("key unavailable");
  return service.admit(authentication, { ...request, key: key.key });
}

describe("organization authenticated service", () => {
  it("resolves every supported source from authenticated scope and requires caller organization grants", async () => {
    const { service } = setup();
    expect(await service.resolve(browser)).toMatchObject({
      organization: "org:test",
      actor: { identity, kind: "human", bindingRevision: 0 },
    });
    expect(
      await service.resolve({
        source: "slack",
        identity: { issuer: "https://slack.com", tenant: "workspace", subject: "user" },
        kind: "human",
      }),
    ).toMatchObject({ organization: "org:test", actor: { identity: { tenant: "workspace", subject: "user" } } });
    expect(
      await service.resolve({
        source: "github",
        identity: { issuer: "github:test", tenant: "installation", subject: "sender" },
        kind: "human",
      }),
    ).toMatchObject({ organization: "org:test" });
    for (const source of ["cli", "http", "mcp"] as const) {
      const authentication = {
        source,
        identity: { issuer: "token:test", tenant: null, subject: "caller" },
        kind: "service" as const,
      };
      expect(await service.resolve(authentication)).toBeUndefined();
      expect(await service.resolve({ ...authentication, organizations: ["org:test"] })).toMatchObject({
        organization: "org:test",
        actor: { kind: "service", stream: null },
      });
    }
    expect(await service.resolve({ ...browser, identity: { ...identity, issuer: "email:test" } })).toBeUndefined();
    const ambiguous = setup(async () => true, [...mappings, { ...mappings[0], organization: "org:other" }]);
    expect(await ambiguous.service.admit(browser, input())).toEqual({ status: "not_found" });
  });
  it("joins only proved identities and preserves historical source attribution", async () => {
    const { service, store } = setup();
    const slackIdentity = { issuer: "https://slack.com", tenant: "workspace", subject: "slack-alice" };
    const personId = await bind(store, [identity, slackIdentity]);
    expect(await sendBrowser(service)).toMatchObject({
      status: "receipt",
      receipt: { actor: { identity, stream: personId, bindingRevision: 1 }, status: "pending" },
    });
    expect(
      await service.admit(
        { source: "slack", identity: slackIdentity, kind: "human" },
        { ...input("slack-event"), content: "A Slack request" },
      ),
    ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    expect(await service.stream(browser)).toMatchObject({
      status: "stream",
      entries: [
        { identity, content: "A private request" },
        { identity: slackIdentity, content: "A Slack request" },
      ],
    });
    const other = { ...browser, identity: { ...identity, subject: "other" } };
    expect(
      await sendBrowser(service, other, { ...input("other-event"), content: "Other person's request" }),
    ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    expect(await service.stream(other)).toMatchObject({
      status: "stream",
      entries: [{ content: "Other person's request" }],
    });
    expect(await service.stream(browser)).toMatchObject({
      status: "stream",
      entries: [{ content: "A private request" }, { content: "A Slack request" }],
    });
  });
  it("rejects unknown and denied work through the same permission-safe result", async () => {
    const denied = setup(async () => false);
    expect(await denied.service.admit(browser, input())).toEqual({ status: "not_found" });
    expect(await denied.service.stream(browser)).toEqual({ status: "not_found" });
    expect(await denied.service.issue(browser, 30)).toEqual({ status: "not_found" });
    expect(await denied.service.admit({ ...browser, identity: { ...identity, issuer: "unknown" } }, input())).toEqual({
      status: "not_found",
    });
    const permitted = setup();
    expect(await sendBrowser(permitted.service)).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
  });
  it("fences a caller revoked after authorization and before its transcript transaction", async () => {
    let revoke = false;
    const store = new InMemoryOrganizationStore(() => 1);
    const personId = await bind(store, [identity]);
    const service = new OrganizationService({
      store,
      directory: store.directory,
      mappings,
      limits,
      authorize: async (request) => {
        if (revoke && request.action === "read")
          await store.directory.change({
            action: "revoke",
            identity,
            personId,
            expectedRevision: 1,
            actor: identity,
            proof: { method: "authenticated-human", version: 1 },
          });
        return true;
      },
    });
    expect(await sendBrowser(service)).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    expect(await service.stream(browser)).toMatchObject({
      status: "stream",
      entries: [{ content: "A private request" }],
    });
    revoke = true;
    expect(await service.stream(browser)).toEqual({ status: "fenced" });
    expect(await service.stream(browser)).toEqual({ status: "not_found" });
  });
  it("revalidates a preserved actor after pending selection and before its effect", async () => {
    const { service, store } = setup();
    const personId = await bind(store, [identity]);
    await sendBrowser(service);
    await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 });
    const pending = await store.execute({
      action: "pending",
      organization: "org:test",
      owner: "worker",
      generation: 1,
      limit: 10,
    });
    if (pending.status !== "pending") throw new Error("pending unavailable");
    expect(await service.authorizeEffect(pending.envelopes[0], { owner: "worker", generation: 1 })).toBe(true);
    await store.directory.change({
      action: "revoke",
      identity,
      personId,
      expectedRevision: 1,
      actor: identity,
      proof: { method: "authenticated-human", version: 1 },
    });
    expect(await service.authorizeEffect(pending.envelopes[0], { owner: "worker", generation: 1 })).toBe(false);
  });
  it("admits GitHub only as a proved human answer to an observed unit question", async () => {
    const { service, store } = setup();
    const githubIdentity = { issuer: "github:test", tenant: "installation", subject: "sender" };
    const authentication: OrganizationAuthentication = { source: "github", identity: githubIdentity, kind: "human" };
    const answer = {
      ...input("delivery-comment-1"),
      destination: { kind: "thread" as const, thread: "unit:thread" },
      target: { key: "unit:question", revision: 7 },
    };
    expect(await service.admit(authentication, answer)).toEqual({ status: "not_found" });
    await bind(store, [githubIdentity]);
    expect(await service.admit(authentication, input())).toEqual({ status: "not_found" });
    await store.execute({ action: "observe", organization: "org:test", target: "unit:question", revision: 7 });
    expect(await service.admit(authentication, answer)).toMatchObject({
      status: "receipt",
      receipt: { status: "pending", currentRevision: 7 },
    });
    expect(await service.admit(authentication, answer)).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { status: "pending" },
    });
  });
  it("redacts durable message content while distinct raw payloads still conflict", async () => {
    const { service } = setup();
    const key = await service.issue(browser, 30);
    if (key.status !== "key") throw new Error("key unavailable");
    const request = { ...input(), key: key.key, content: "API_TOKEN=private-value" };
    expect(await service.admit(browser, request)).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    expect(await service.stream(browser)).toMatchObject({
      status: "stream",
      entries: [{ content: "API_TOKEN=«redacted»" }],
    });
    expect(await service.admit(browser, { ...request, content: "API_TOKEN=other-private-value" })).toEqual({
      status: "conflict",
    });
  });
  it("does not let caller payloads consume the reserved reconciliation lane", async () => {
    const { service } = setup();
    const key = await service.issue(browser, 30);
    if (key.status !== "key") throw new Error("key unavailable");
    expect(await service.admit(browser, { ...input(), key: key.key, workload: "reconciliation" })).toEqual({
      status: "invalid",
    });
    const machine: OrganizationAuthentication = {
      source: "mcp",
      identity: { issuer: "token:test", tenant: null, subject: "machine" },
      kind: "service",
      organizations: ["org:test"],
    };
    expect(await service.admit(machine, { ...input(), workload: "reconciliation" })).toEqual({ status: "invalid" });
    expect(await service.admit(browser, { ...input(), key: key.key })).toMatchObject({
      status: "receipt",
      receipt: { status: "pending" },
    });
  });
  it("refuses source revocation after selection before an effect", async () => {
    const { service, store } = setup();
    await sendBrowser(service);
    await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 });
    const pending = await store.execute({
      action: "pending",
      organization: "org:test",
      owner: "worker",
      generation: 1,
      limit: 10,
    });
    if (pending.status !== "pending") throw new Error("pending unavailable");
    expect(await service.authorizeEffect(pending.envelopes[0], { owner: "worker", generation: 1 })).toBe(true);
    await store.execute({ action: "access", organization: "org:test", identity, allowed: false });
    expect(await service.authorizeEffect(pending.envelopes[0], { owner: "worker", generation: 1 })).toBe(false);
  });
  it("rejects expanded sanitized input before an unavailable store can affect admission", async () => {
    const { store } = setup();
    const service = new OrganizationService({
      store: { execute: async () => ({ status: "unavailable" }) },
      directory: store.directory,
      mappings,
      limits,
      authorize: async () => true,
    });
    expect(await service.admit(browser, { ...input(), content: "API_TOKEN=abcd\n".repeat(2000) })).toEqual({
      status: "invalid",
    });
    expect(await service.admit(browser, input())).toEqual({ status: "unavailable" });
  });
  it("replays equivalent validated payloads regardless of property order while preserving array order", async () => {
    const { service, store } = setup();
    const issued = await service.issue(browser, 30);
    if (issued.status !== "key") throw new Error("key unavailable");
    await store.execute({ action: "observe", organization: "org:test", target: "question:one", revision: 7 });
    const first: OrganizationAdmissionInput = {
      sourceEvent: "ordered-event",
      key: issued.key,
      destination: { kind: "thread", thread: "unit:thread" },
      workload: "message",
      target: { key: "question:one", revision: 7 },
      content: "Raw API_TOKEN=abcd",
      context: [
        { kind: "unit", key: "unit:one" },
        { kind: "run", key: "run:one" },
      ],
    };
    const receipt = await service.admit(browser, first);
    expect(receipt).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    const reordered: OrganizationAdmissionInput = {
      context: [
        { key: "unit:one", kind: "unit" },
        { key: "run:one", kind: "run" },
      ],
      content: "Raw API_TOKEN=abcd",
      target: { revision: 7, key: "question:one" },
      workload: "message",
      destination: { thread: "unit:thread", kind: "thread" },
      key: issued.key,
      sourceEvent: "ordered-event",
    };
    expect(
      await service.admit(
        { ...browser, identity: { subject: "alice", tenant: null, issuer: "access:test" } },
        reordered,
      ),
    ).toEqual({ ...receipt, duplicate: true });
    await bind(store, [identity]);
    expect(await service.admit(browser, reordered)).toEqual({ ...receipt, duplicate: true });
    expect(await service.admit(browser, { ...reordered, context: [...reordered.context].reverse() })).toEqual({
      status: "conflict",
    });
    expect(await service.admit(browser, { ...reordered, content: "Raw API_TOKEN=wxyz" })).toEqual({
      status: "conflict",
    });
  });
});
