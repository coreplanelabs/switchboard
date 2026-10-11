import { describe, expect, it } from "vitest";
import type { ExternalIdentity, PersonId } from "../identity/contract.js";
import { resultSchema, streamEntrySchema } from "./contract.js";
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
    currentIdentityRead: async () => "allowed",
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
  it("projects only protected source authors and discards supplied read author stamps", async () => {
    const { service, store } = setup();
    const slack = { issuer: "https://slack.com", tenant: "workspace", subject: "UBOB" };
    await bind(store, [identity, slack]);
    const browserSource = {
      ...browser,
      sourceReference: {
        actorId: "access:alice",
        userId: "access:alice",
        channelId: "web:alice",
        threadKey: "web:alice:home",
      },
    };
    expect((await sendBrowser(service, browserSource)).status).toBe("receipt");
    expect(
      (
        await service.admit(
          {
            source: "slack",
            identity: slack,
            kind: "human",
            sourceReference: {
              actorId: "slack:UBOB",
              userId: "slack:UBOB",
              channelId: "slack:Dprivate",
              threadKey: "slack:Dprivate:home",
            },
          },
          input("peer"),
        )
      ).status,
    ).toBe("receipt");
    expect((await sendBrowser(service, browser, input("legacy-author"))).status).toBe("receipt");
    const addressed = await service.resolve(browserSource);
    if (!addressed?.actor.stream) throw new Error("Missing stream");
    const direct = await store.execute({
      action: "tail",
      ...addressed,
      stream: addressed.actor.stream,
      limit: 100,
      identities: [identity, slack],
    });
    expect(direct.status === "stream_tail" ? direct.entries.map((e) => e.content) : []).toEqual([
      "A private request",
      "A private request",
      "A private request",
    ]);
    expect(direct.status === "stream_tail" ? direct.entries : []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ authorId: expect.anything() })]),
    );
    const execute = store.execute.bind(store);
    store.execute = async (command) => {
      const result = await execute(command);
      return result.status === "stream" || result.status === "stream_tail"
        ? { ...result, entries: result.entries.map((entry) => ({ ...entry, authorId: "access:invented-viewer" })) }
        : result;
    };
    for (const result of [await service.stream(browserSource), await service.streamTail(browserSource)]) {
      expect(result).toMatchObject({
        entries: [
          { role: "user", authorId: "access:alice" },
          { role: "user", authorId: "slack:UBOB" },
          { role: "user" },
        ],
      });
      expect(resultSchema.safeParse(result).success).toBe(true);
      if (result.status !== "stream" && result.status !== "stream_tail") throw new Error("Missing authorized read");
      expect(streamEntrySchema.safeParse(result.entries[0]).success).toBe(false);
      expect(Object.hasOwn(result.entries[2]!, "authorId")).toBe(false);
    }
  });
  it("keeps unlinked delegation source-only and applies current authorization and native source proof", async () => {
    let allowed = true;
    let native: "allowed" | "denied" | "unavailable" = "allowed";
    const checked: OrganizationAuthorization[] = [];
    const store = new InMemoryOrganizationStore(() => 1);
    const service = new OrganizationService({
      store,
      directory: store.directory,
      mappings,
      limits,
      authorize: async (value) => {
        checked.push(value);
        return allowed;
      },
      currentIdentityRead: async () => native,
    });
    const auth: OrganizationAuthentication = {
      source: "mcp",
      identity: { issuer: "token:test", tenant: null, subject: "device" },
      kind: "service",
      organizations: ["org:test"],
      onBehalfOf: identity,
    };
    const admitted = await service.admit(auth, input("delegated-unlinked"));
    expect(admitted).toMatchObject({
      status: "receipt",
      receipt: {
        actor: {
          identity: auth.identity,
          kind: "service",
          stream: 'mcp:["token:test",null,"device"]',
          bindingRevision: 0,
          onBehalfOf: identity,
        },
      },
    });
    expect(await service.streamTail(auth)).toMatchObject({
      status: "stream_tail",
      entries: [{ content: "A private request", identity: auth.identity, onBehalfOf: identity }],
    });
    expect(
      checked.map((value) => ({
        action: value.action,
        actor: value.actor.identity,
        onBehalfOf: value.actor.onBehalfOf,
      })),
    ).toEqual([
      { action: "send", actor: auth.identity, onBehalfOf: identity },
      { action: "read", actor: auth.identity, onBehalfOf: identity },
    ]);
    native = "denied";
    expect(await service.streamTail(auth)).toMatchObject({ status: "stream_tail", entries: [] });
    native = "unavailable";
    expect(await service.streamTail(auth)).toEqual({ status: "unavailable" });
    allowed = false;
    expect(await service.admit(auth, input("after-policy-loss"))).toEqual({ status: "not_found" });
    expect(await service.streamTail(auth)).toEqual({ status: "not_found" });
  });
  it("keeps a freshly authenticated unlinked source usable while fencing its former joined owner", async () => {
    const { service, store } = setup();
    const slack = { issuer: "https://slack.com", tenant: "workspace", subject: "UALICE" };
    const personId = await bind(store, [identity, slack]);
    const old = await sendBrowser(service);
    expect(old).toMatchObject({ status: "receipt", receipt: { actor: { stream: personId, bindingRevision: 1 } } });
    await store.directory.change({
      action: "revoke",
      identity,
      personId,
      expectedRevision: 1,
      actor: identity,
      proof: { method: "authenticated-human", version: 1 },
    });
    expect(await service.resolve(browser)).toMatchObject({
      actor: {
        stream: 'browser:["access:test",null,"alice"]',
        bindingRevision: 2,
      },
    });
    expect(
      await sendBrowser(service, browser, { ...input("after-unlink"), content: "Only this source" }),
    ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    expect(await service.stream(browser)).toMatchObject({
      status: "stream",
      entries: [{ content: "A private request" }, { content: "Only this source" }],
    });
    expect(await service.streamForIdentities(browser, [identity, slack])).toMatchObject({
      status: "stream",
      entries: [{ content: "A private request" }, { content: "Only this source" }],
    });
    if (old.status !== "receipt") throw new Error("Missing original source receipt");
    expect(await service.delete({ source: "slack", identity: slack, kind: "human" }, old.receipt.id)).toEqual({
      status: "not_found",
    });
    expect(await service.delete(browser, old.receipt.id)).toEqual({ status: "ok", removed: 1 });
    expect(await service.stream({ source: "slack", identity: slack, kind: "human" })).toMatchObject({
      status: "stream",
      entries: [],
    });
    const lease = await store.execute({ action: "claim", organization: "org:test", owner: "worker", leaseMs: 100 });
    expect(lease.status).toBe("state");
    const pending = await store.execute({
      action: "pending",
      organization: "org:test",
      owner: "worker",
      generation: 1,
      limit: 10,
    });
    expect(pending).toMatchObject({ status: "pending", envelopes: [{ content: "Only this source" }] });
  });
  it("holds every private history path when original-source verification is absent", async () => {
    const store = new InMemoryOrganizationStore(() => 1);
    const options = { store, directory: store.directory, mappings, limits, authorize: async () => true };
    const missing = new OrganizationService(options);
    expect(await sendBrowser(missing)).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    for (const read of [
      await missing.stream(browser),
      await missing.streamTail(browser),
      await missing.streamForIdentities(browser, [identity]),
    ])
      expect(read).toEqual({ status: "unavailable" });
    const proved = new OrganizationService({ ...options, currentIdentityRead: async () => "allowed" });
    expect(await proved.stream(browser)).toMatchObject({
      status: "stream",
      entries: [{ content: "A private request" }],
    });
  });
  it("replays the original saved question and observed browser revision after the current question changes", async () => {
    const { service, store } = setup();
    const auth: OrganizationAuthentication = {
      ...browser,
      sourceReference: {
        actorId: "access:alice",
        userId: "access:alice",
        channelId: "http:home",
        threadKey: "unit:thread",
        browserRevision: 77,
      },
    };
    const issued = await service.issue(auth, 30);
    if (issued.status !== "key") throw new Error("not issued");
    await store.execute({ action: "observe", organization: "org:test", target: "question:old", revision: 1 });
    const body = {
      key: issued.key,
      content: "Raw API_TOKEN=abcd",
      context: [],
      destination: { kind: "thread" as const, thread: "unit:thread" },
      revision: 77,
    };
    const first = await service.admit(auth, {
      ...body,
      sourceEvent: "original-browser-event",
      workload: "act",
      target: { key: "question:old", revision: 1 },
    });
    expect(first).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    await store.execute({ action: "observe", organization: "org:test", target: "question:old", revision: 2 });
    expect(await service.replay(auth, body)).toEqual({ ...first, duplicate: true });
    expect(await service.replay(auth, { ...body, revision: 78 })).toEqual({ status: "conflict" });
    expect(await service.replay(auth, { ...body, content: "Raw API_TOKEN=wxyz" })).toEqual({ status: "conflict" });
    expect(await service.replay(auth, { ...body, key: "unknown" })).toBeUndefined();
  });
  it("takes replay identity lookup facts only from authentication and ignores forged body facts", async () => {
    const calls: OrganizationAuthorization[] = [];
    const { store, service } = setup(async (request) => {
      calls.push(request);
      return true;
    });
    const http: OrganizationAuthentication = {
      source: "http",
      identity: { issuer: "token:test", tenant: null, subject: "credential" },
      kind: "human",
      organizations: ["org:test"],
    };
    const forged = {
      ...input("source-forgery"),
      sourceReference: {
        actorId: "access:forged-admin",
        userId: "slack:forged",
        channelId: "slack:private",
        threadKey: "slack:private:1",
      },
    };
    const admitted = await service.admit(http, forged);
    expect(admitted).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    const lease = await store.execute({ action: "claim", organization: "org:test", owner: "process", leaseMs: 30 });
    if (lease.status !== "state" || !lease.state.lease) throw new Error("not claimed");
    const pending = await store.execute({
      action: "pending",
      organization: "org:test",
      owner: "process",
      generation: lease.state.lease.generation,
      limit: 10,
    });
    if (pending.status !== "pending") throw new Error("not pending");
    expect(pending.envelopes[0]?.sourceReference).toBeUndefined();
    expect(calls[0]).toMatchObject({ source: "http", actor: { identity: http.identity } });
    const trusted = {
      actorId: "http:credential",
      userId: "http:credential",
      channelId: "http:home",
      threadKey: "http:home:credential",
    };
    expect(
      await service.admit({ ...http, sourceReference: trusted }, { ...forged, key: "source-trusted" }),
    ).toMatchObject({ status: "receipt", receipt: { status: "pending" } });
    expect(calls.at(-1)?.sourceReference).toEqual(trusted);
  });
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
      currentIdentityRead: async () => "allowed",
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
    expect(await service.stream(browser)).toMatchObject({
      status: "stream",
      entries: [{ content: "A private request" }],
    });
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
  it("passes only retained server delegation to the current source read check", async () => {
    const store = new InMemoryOrganizationStore(() => 1);
    await bind(store, [identity]);
    const checked: unknown[] = [];
    const service = new OrganizationService({
      store,
      directory: store.directory,
      mappings,
      limits,
      authorize: async () => true,
      currentIdentityRead: async (source, reference, onBehalfOf) => {
        checked.push({ source, reference, onBehalfOf });
        return onBehalfOf?.subject === "alice" ? "allowed" : "denied";
      },
    });
    const delegated: OrganizationAuthentication = {
      source: "mcp",
      identity: { issuer: "token:test", tenant: null, subject: "job" },
      kind: "service",
      organizations: ["org:test"],
      onBehalfOf: identity,
      sourceReference: {
        actorId: "mcp:job",
        userId: "access:alice",
        authenticatedAs: "mcp:job",
        channelId: "mcp:home",
        threadKey: "mcp:home:alice",
        credentialDigest: "a".repeat(64),
      },
    };
    expect(
      (
        await sendBrowser(service, delegated, {
          ...input(),
          onBehalfOf: { ...identity, subject: "forged" },
        } as OrganizationAdmissionInput)
      ).status,
    ).toBe("receipt");
    const result = await service.streamTail(browser);
    expect(result).toMatchObject({
      status: "stream_tail",
      entries: [{ content: "A private request", authorId: "access:alice" }],
    });
    expect(checked).toEqual([
      { source: delegated.identity, reference: delegated.sourceReference, onBehalfOf: identity },
    ]);
  });
});
