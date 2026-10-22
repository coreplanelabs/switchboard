import { describe, expect, it, vi } from "vitest";
import {
  createOrganizationAuthentication,
  type NativeOrganizationProof,
  type OrganizationQuestionOwner,
} from "./organizationAuthentication.js";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { OrganizationService } from "../core/organization/service.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { NO_GRANTS } from "../core/authz/types.js";
import { authorize } from "../core/authz/authorize.js";
import { digestBearer, InMemoryPersonalTokenStore } from "../mcp/personalTokens.js";
import type { IngressConfig } from "./http.js";
import type { IncomingMessage } from "../core/types.js";
const organization = "Acme Team";
const accessIdentity = { issuer: "https://access.test", tenant: "app-aud", subject: "alice" };
const slackIdentity = { issuer: "https://slack.com", tenant: "workspace", subject: "UALICE" };
const grants = {
  actions: new Set(["organization:read", "organization:send", "agent:run:general"]),
  channels: new Set<string>(),
  repos: new Set<string>(),
  organizations: new Set([organization]),
};
function setup() {
  const store = new InMemoryOrganizationStore(() => 1),
    ledger = new InMemoryRunLedger(() => 1),
    tokens = new InMemoryPersonalTokenStore();
  let browser: NativeOrganizationProof = {
    status: "verified",
    identity: accessIdentity,
    actorId: "access:alice",
    kind: "human",
    organizationMember: true,
    privateSource: true,
    epoch: "access-live-1",
    access: { sub: "alice", email: "not-an-identity-proof@example.test" },
  };
  let slack: NativeOrganizationProof = {
    status: "verified",
    identity: slackIdentity,
    actorId: "slack:UALICE",
    kind: "human",
    organizationMember: true,
    privateSource: true,
    epoch: "slack-live-1",
  };
  const lookup = new Map([
    ["http:alice", grants],
    ["mcp:alice", grants],
    ["mcp:personal:alice", grants],
    ["access:alice", NO_GRANTS],
    ["slack:UALICE", NO_GRANTS],
  ]);
  const options = {
    organization,
    store,
    directory: store.directory,
    ledger,
    personalTokens: tokens,
    personalApproval: { issuer: accessIdentity.issuer, audience: "access-app" },
    mappings: [
      { source: "browser" as const, issuer: accessIdentity.issuer, tenant: accessIdentity.tenant, organization },
      { source: "slack" as const, issuer: slackIdentity.issuer, tenant: slackIdentity.tenant, organization },
      { source: "http" as const, issuer: "installation:http", tenant: null, organization },
      { source: "mcp" as const, issuer: "installation:mcp", tenant: null, organization },
      { source: "cli" as const, issuer: "installation:cli", tenant: null, organization },
    ],
    grantsFor: (id: string) => lookup.get(id) ?? NO_GRANTS,
    auth: (): IngressConfig => ({ tokens: { "first-key": { subject: "alice" }, "second-key": { subject: "alice" } } }),
    questionOwner: async (_unitKey: string): Promise<OrganizationQuestionOwner> => ({ status: "unavailable" }),
    currentBrowser: async () => browser,
    currentSlack: async () => slack,
    currentCli: async (identity: typeof accessIdentity) => ({
      status: "verified" as const,
      identity,
      actorId: "cli:local",
      kind: "service" as const,
      organizationMember: false,
      privateSource: true,
      epoch: "local-process-1",
    }),
    channelsOf: async () => new Set(["slack:DALICE"]),
  };
  const resolver = createOrganizationAuthentication(options);
  const msg = (userId: string): IncomingMessage => ({
    userId,
    channelId: "http:home",
    threadKey: "http:home:alice",
    messageId: "event-1",
    text: "fixture instruction",
  });
  return {
    store,
    ledger,
    tokens,
    resolver,
    lookup,
    options,
    msg,
    setBrowser: (proof: NativeOrganizationProof) => {
      browser = proof;
    },
    setSlack: (proof: NativeOrganizationProof) => {
      slack = proof;
    },
  };
}
describe("current organization authentication", () => {
  it("keeps metadata phase credential and native address proofs separate and rebuilds current policy", async () => {
    const s = setup();
    const first = digestBearer("first-personal-device"),
      second = digestBearer("second-personal-device");
    for (const digest of [first, second])
      await s.tokens.put({
        digest,
        subject: "personal:alice",
        userId: "access:alice",
        email: "display@example.test",
        createdAt: 1,
        approval: { version: 1, issuer: accessIdentity.issuer, audience: "access-app", organization, subject: "alice" },
      });
    s.lookup.set("access:alice", ALL_GRANTS);
    const native = await s.resolver.resolveNative(
      { ...s.msg("access:alice"), authenticatedAs: "mcp:personal:alice" },
      {
        source: "mcp",
        identity: { subject: "personal:alice" },
        credentialDigest: first,
      },
    );
    if (native.status !== "resolved") throw new Error("No native credential");
    const input = {
      organization,
      source: "mcp" as const,
      sourceReference: native.authentication.sourceReference!,
      actor: {
        identity: native.authentication.identity,
        kind: "service" as const,
        principal: "mcp:personal:alice",
        stream: null,
        bindingRevision: 0,
        onBehalfOf: null,
      },
      action: "read" as const,
      destination: { kind: "broad" as const },
      target: null,
      context: [],
    };
    const phase = s.resolver.metadataPhase();
    expect((await phase.resolveAuthorization(input)).status).toBe("resolved");
    await s.tokens.delete(second, "personal:alice");
    expect(
      await phase.resolveAuthorization({
        ...input,
        sourceReference: { ...input.sourceReference, credentialDigest: second },
      }),
    ).toEqual({ status: "fenced" });
    s.lookup.set("mcp:personal:alice", NO_GRANTS);
    expect(await phase.resolveAuthorization(input)).toEqual({ status: "fenced" });
    s.lookup.set("mcp:personal:alice", grants);
    await s.tokens.delete(first, "personal:alice");
    expect(await s.resolver.metadataPhase().resolveAuthorization(input)).toEqual({ status: "fenced" });
  });
  it("re-resolves the verified MCP requester profile and records lookup failure without storing it", async () => {
    const s = setup();
    s.lookup.set("access:alice", grants);
    const requesterProfileId = "slack:UALICE";
    const identity = { issuer: "installation:mcp", tenant: null, subject: "alice" };
    const access = { sub: "alice", email: "alice@example.test" };
    let lookupFails = false;
    let lookupMisses = false;
    const resolver = createOrganizationAuthentication({
      ...s.options,
      personByEmail: async (email) => {
        if (lookupFails) throw new Error("PRIVATE-PROFILE-LOOKUP");
        if (lookupMisses) return undefined;
        return email === access.email ? { id: requesterProfileId, name: "Alice" } : undefined;
      },
      currentMcp: async () => ({
        status: "verified",
        identity,
        actorId: "access:alice",
        kind: "human",
        organizationMember: true,
        privateSource: true,
        epoch: "mcp-sso-1",
        access,
      }),
    });
    const credentialDigest = digestBearer("mcp-sso-session");
    const mcpIdentity = { subject: "alice", session: access };
    const native = await resolver.resolveNative(
      {
        ...s.msg("access:alice"),
        channelId: "mcp:default",
        threadKey: "mcp:default:profile-roundtrip",
        authenticatedAs: "access:alice",
        approvalConnection: { id: credentialDigest, credentialId: "access:alice", requestHash: "a".repeat(64) },
        requesterProfileId,
      },
      { source: "mcp", identity: mcpIdentity, credentialDigest },
    );
    if (native.status !== "resolved") throw new Error("No current MCP credential");
    expect(native.authentication.sourceReference).not.toHaveProperty("requesterProfileId");
    const service = new OrganizationService({
      store: s.store,
      directory: s.store.directory,
      mappings: s.options.mappings,
      limits: {
        pendingPerActor: 5,
        pendingPerSource: 10,
        pendingPerOrganization: 20,
        reservedReconciliation: 1,
        contentTtlMs: 90,
        receiptTtlMs: 365,
      },
      authorize: async () => true,
    });
    const admitted = await service.admit(native.authentication, {
      sourceEvent: "profile-roundtrip",
      key: "profile-roundtrip",
      destination: { kind: "broad" },
      workload: "message",
      target: null,
      content: "Review the pull request",
      context: [],
    });
    if (admitted.status !== "receipt") throw new Error("MCP profile input was not saved");
    const addressed = await service.resolve(native.authentication);
    if (!addressed) throw new Error("No current saved source owner");
    const saved = await s.store.execute({
      action: "submission",
      ...addressed,
      source: "mcp",
      key: "profile-roundtrip",
    });
    if (saved.status !== "submission") throw new Error("No saved MCP source envelope");
    expect(JSON.stringify(saved.envelope)).not.toContain(requesterProfileId);
    const restored = await resolver.resolveEnvelope(saved.envelope);

    expect(restored).toMatchObject({
      status: "resolved",
      actor: { id: "access:alice" },
      msg: { userId: "access:alice", authenticatedAs: "access:alice", requesterProfileId },
    });
    lookupFails = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const degraded = await resolver.resolveEnvelope(saved.envelope);
      expect(degraded).toMatchObject({
        status: "resolved",
        actor: { id: "access:alice" },
        msg: { userId: "access:alice", userName: "alice@example.test", authenticatedAs: "access:alice" },
      });
      if (degraded.status !== "resolved") throw new Error("MCP restore did not resolve");
      expect(degraded.msg).not.toHaveProperty("requesterProfileId");
      expect(warning.mock.calls).toContainEqual([
        JSON.stringify({ event: "runs.requester_label.degraded", kind: "mcp", reason: "failed" }),
      ]);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("PRIVATE-PROFILE-LOOKUP");
    } finally {
      warning.mockRestore();
    }
    lookupFails = false;
    lookupMisses = true;
    const unmatched = await resolver.resolveEnvelope(saved.envelope);
    expect(unmatched).toMatchObject({
      status: "resolved",
      actor: { id: "access:alice" },
      msg: { userId: "access:alice", userName: "alice@example.test", authenticatedAs: "access:alice" },
    });
    if (unmatched.status !== "resolved") throw new Error("MCP restore did not resolve");
    expect(unmatched.msg).not.toHaveProperty("requesterProfileId");
  });
  it("restores a personal MCP profile from its approved credential without storing it in the source", async () => {
    const s = setup();
    s.lookup.set("access:alice", grants);
    const email = "display@example.test",
      requesterProfileId = "slack:UALICE",
      digest = digestBearer("approved-personal-mcp");
    const resolver = createOrganizationAuthentication({
      ...s.options,
      personByEmail: async (value) => (value === email ? { id: requesterProfileId, name: "Alice" } : undefined),
    });
    await s.tokens.put({
      digest,
      subject: "personal:alice",
      userId: "access:alice",
      email,
      createdAt: 1,
      approval: { version: 1, issuer: accessIdentity.issuer, audience: "access-app", organization, subject: "alice" },
    });
    const native = await resolver.resolveNative(
      {
        ...s.msg("access:alice"),
        channelId: "mcp:default",
        threadKey: "mcp:default:personal-profile-roundtrip",
        authenticatedAs: "mcp:personal:alice",
        approvalConnection: { id: digest, credentialId: "mcp:personal:alice", requestHash: "b".repeat(64) },
      },
      { source: "mcp", identity: { subject: "personal:alice" }, credentialDigest: digest },
    );
    if (native.status !== "resolved") throw new Error("No approved personal MCP credential");
    expect(native.msg).toMatchObject({ userId: "access:alice", requesterProfileId });
    expect(native.authentication.sourceReference).not.toHaveProperty("requesterProfileId");
    const service = new OrganizationService({
      store: s.store,
      directory: s.store.directory,
      mappings: s.options.mappings,
      limits: {
        pendingPerActor: 5,
        pendingPerSource: 10,
        pendingPerOrganization: 20,
        reservedReconciliation: 1,
        contentTtlMs: 90,
        receiptTtlMs: 365,
      },
      authorize: async () => true,
    });
    const admitted = await service.admit(native.authentication, {
      sourceEvent: "personal-profile-roundtrip",
      key: "personal-profile-roundtrip",
      destination: { kind: "broad" },
      workload: "message",
      target: null,
      content: "Review the pull request",
      context: [],
    });
    if (admitted.status !== "receipt") throw new Error("Personal MCP input was not saved");
    const addressed = await service.resolve(native.authentication);
    if (!addressed) throw new Error("No current personal MCP source owner");
    const saved = await s.store.execute({
      action: "submission",
      ...addressed,
      source: "mcp",
      key: "personal-profile-roundtrip",
    });
    if (saved.status !== "submission") throw new Error("No saved personal MCP source envelope");
    expect(JSON.stringify(saved.envelope)).not.toContain(requesterProfileId);
    const restored = await resolver.resolveEnvelope(saved.envelope);

    expect(restored).toMatchObject({
      status: "resolved",
      actor: { id: "mcp:personal:alice" },
      msg: { userId: "access:alice", authenticatedAs: "mcp:personal:alice", requesterProfileId },
    });
  });
  it("uses an active pinned personal delegation after browser proof expires and fences changed realms and revoked rights", async () => {
    const s = setup();
    const digest = digestBearer("pinned-device");
    await s.tokens.put({
      digest,
      subject: "personal:alice",
      userId: "access:alice",
      email: "display@example.test",
      createdAt: 1,
      approval: { version: 1, issuer: accessIdentity.issuer, audience: "access-app", organization, subject: "alice" },
    });
    s.setBrowser({ status: "unavailable" });
    s.lookup.set("access:alice", ALL_GRANTS);
    const msg = { ...s.msg("access:alice"), authenticatedAs: "mcp:personal:alice" };
    const evidence = { source: "mcp" as const, identity: { subject: "personal:alice" }, credentialDigest: digest };
    const value = await s.resolver.resolveNative(msg, evidence);
    expect(value.status).toBe("resolved");
    if (value.status !== "resolved") throw new Error("No current device delegation");
    expect(value.actor.id).toBe("mcp:personal:alice");
    expect(value.actor.self).toEqual(["mcp:personal:alice"]);
    expect(value.actor.onBehalfOf?.id).toBe("access:alice");
    expect(value.authentication.onBehalfOf).toEqual(accessIdentity);
    expect(authorize(value.actor, "repo:use", { type: "repo", owner: "sample", name: "api" }).allow).toBe(false);
    s.options.personalApproval.audience = "changed-app";
    expect(await s.resolver.resolveNative(msg, evidence)).toEqual({ status: "fenced" });
    s.options.personalApproval.audience = "access-app";
    s.options.personalApproval.issuer = "https://changed.test";
    expect(await s.resolver.resolveNative(msg, evidence)).toEqual({ status: "fenced" });
    s.options.personalApproval.issuer = accessIdentity.issuer;
    const withoutPin = createOrganizationAuthentication({ ...s.options, personalApproval: undefined });
    expect(await withoutPin.resolveNative(msg, evidence)).toEqual({ status: "fenced" });
    s.lookup.set("access:alice", NO_GRANTS);
    expect(await s.resolver.resolveNative(msg, evidence)).toEqual({ status: "fenced" });
    s.lookup.set("access:alice", { ...grants, actions: new Set(["organization:read", "organization:send"]) });
    const narrowed = await s.resolver.resolveNative(msg, evidence);
    expect(narrowed.status).toBe("resolved");
    if (narrowed.status !== "resolved") throw new Error("No current device delegation");
    expect(authorize(narrowed.actor, "agent:run:general", { type: "agent", name: "general" }).allow).toBe(false);
    s.lookup.set("mcp:personal:alice", NO_GRANTS);
    const denied = await s.resolver.resolveNative(msg, evidence);
    expect(denied.status).toBe("fenced");
    s.lookup.set("mcp:personal:alice", grants);
    await s.tokens.delete(digest, "personal:alice");
    expect(await s.resolver.resolveNative(msg, evidence)).toEqual({ status: "fenced" });
    expect(await s.resolver.resolveBrowser(accessIdentity, s.msg("access:alice"))).toEqual({ status: "unavailable" });
  });
  it("keeps the exact native user's own rights after unlink without lending its former peer's rights", async () => {
    const s = setup();
    const created = await s.store.directory.createPerson();
    if (created.status !== "created") throw new Error("No person");
    for (const identity of [accessIdentity, slackIdentity])
      expect(
        await s.store.directory.change({
          action: "link",
          identity,
          personId: created.person.id,
          expectedRevision: 0,
          actor: accessIdentity,
          proof: { method: "dual-authentication", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
    expect(
      await s.store.directory.change({
        action: "revoke",
        identity: accessIdentity,
        personId: created.person.id,
        expectedRevision: 1,
        actor: accessIdentity,
        proof: { method: "dual-authentication", version: 1 },
      }),
    ).toMatchObject({ status: "changed", binding: { state: "revoked", revision: 2 } });
    const result = await s.resolver.resolveBrowser(accessIdentity, s.msg("access:alice"));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("Lost independent source rights");
    expect(result.actor.id).toBe("access:alice");
    expect(result.actor.self).toEqual(["access:alice"]);
    expect(authorize(result.actor, "organization:send", { type: "organization", id: organization }).allow).toBe(true);
    expect(
      authorize(result.actor, "runs:read", {
        type: "run",
        id: "own",
        userId: "access:alice",
        channelId: "http:home",
        channelVisibility: "machine",
      }).allow,
    ).toBe(true);
    expect(
      authorize(result.actor, "runs:read", {
        type: "run",
        id: "peer",
        userId: "slack:UALICE",
        channelId: "slack:DOTHER",
        channelVisibility: "dm",
      }).allow,
    ).toBe(false);
    s.setBrowser({ status: "fenced" });
    expect(await s.resolver.resolveBrowser(accessIdentity, s.msg("access:alice"))).toEqual({ status: "fenced" });
  });
  it("uses verified browser issuer membership and never turns email into an ownership alias", async () => {
    const s = setup();
    const result = await s.resolver.resolveBrowser(accessIdentity, s.msg("access:alice"));
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("not resolved");
    expect(result.actor.id).toBe("access:alice");
    expect(result.actor.self).toEqual(["access:alice"]);
    expect(authorize(result.actor, "organization:send", { type: "organization", id: organization })).toEqual({
      allow: true,
    });
    expect(
      authorize(result.actor, "runs:read", {
        type: "run",
        id: "private",
        channelId: "slack:DOTHER",
        userId: "slack:UALICE",
        channelVisibility: "dm",
      }).allow,
    ).toBe(false);
    s.setBrowser({ status: "unavailable" });
    expect(await s.resolver.resolveBrowser(accessIdentity, s.msg("access:alice"))).toEqual({ status: "unavailable" });
  });
  it("keeps exact HTTP credentials separate even when subjects match", async () => {
    const s = setup();
    const evidence = {
      source: "http" as const,
      identity: { subject: "alice" },
      credentialDigest: digestBearer("first-key"),
    };
    const result = await s.resolver.resolveNative(s.msg("http:alice"), evidence);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("not resolved");
    expect(result.authentication.sourceReference?.credentialDigest).toBe(digestBearer("first-key"));
    s.options.auth = () => ({ tokens: { "second-key": { subject: "alice" } } });
    expect(await s.resolver.resolveNative(s.msg("http:alice"), evidence)).toEqual({ status: "fenced" });
    expect(
      (
        await s.resolver.resolveNative(s.msg("http:alice"), {
          ...evidence,
          credentialDigest: digestBearer("second-key"),
        })
      ).status,
    ).toBe("resolved");
  });
  it("revalidates the exact personal MCP metadata without lending another key authority", async () => {
    const s = setup();
    const first = digestBearer("personal-one"),
      second = digestBearer("personal-two");
    await s.tokens.put({
      digest: first,
      subject: "personal:alice",
      email: "ignored@example.test",
      userId: "access:alice",
      createdAt: 1,
    });
    await s.tokens.put({
      digest: second,
      subject: "personal:alice",
      email: "ignored@example.test",
      userId: "access:alice",
      createdAt: 1,
    });
    const msg = {
      ...s.msg("access:alice"),
      authenticatedAs: "mcp:personal:alice",
      approvalConnection: { id: first, credentialId: "mcp:personal:alice", requestHash: "a".repeat(64) },
    };
    const evidence = { source: "mcp" as const, identity: { subject: "personal:alice" }, credentialDigest: first };
    const result = await s.resolver.resolveNative(msg, evidence);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("not resolved");
    expect(result.actor.id).toBe("mcp:personal:alice");
    expect(result.actor.onBehalfOf?.id).toBe("access:alice");
    expect(authorize(result.actor, "organization:send", { type: "organization", id: organization })).toEqual({
      allow: true,
    });
    await s.tokens.delete(first, "personal:alice");
    expect(await s.resolver.resolveNative(msg, evidence)).toEqual({ status: "fenced" });
  });
  it("requires current native Slack facts and preserves the channel origin", async () => {
    const s = setup();
    const msg = { ...s.msg("slack:UALICE"), channelId: "slack:DALICE", threadKey: "slack:DALICE:1" };
    const result = await s.resolver.resolveNative(msg, { source: "slack", identity: slackIdentity });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("not resolved");
    expect(result.actor.origin).toEqual({ channelId: "slack:DALICE", threadKey: "slack:DALICE:1" });
    expect(result.actor.memberOf).toEqual(new Set(["slack:DALICE"]));
    s.setSlack({ status: "fenced" });
    expect(await s.resolver.resolveNative(msg, { source: "slack", identity: slackIdentity })).toEqual({
      status: "fenced",
    });
  });
  it("keeps local CLI authority explicit and rejects client-forged actor facts", async () => {
    const s = setup();
    const result = await s.resolver.resolveNative(s.msg("cli:local"), {
      source: "cli",
      identity: { issuer: "installation:cli", tenant: null, subject: "local" },
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("not resolved");
    expect(result.actor.grants).toEqual(ALL_GRANTS);
    expect(result.actor.standingConsent).toBe("all");
    expect(
      await s.resolver.resolveNative(
        { ...s.msg("http:admin"), authenticatedAs: "cli:local" },
        { source: "http", identity: { subject: "alice" }, credentialDigest: digestBearer("first-key") },
      ),
    ).toEqual({ status: "fenced" });
    expect(
      await s.resolver.resolveNative(s.msg("github:1"), {
        source: "github",
        identity: { issuer: "github", tenant: "app", subject: "1" },
      }),
    ).toEqual({ status: "fenced" });
  });
  it("fences original-run recovery when current source proof or durable provenance is unavailable", async () => {
    const s = setup();
    expect(await s.resolver.restoreOriginalRun("absent", false)).toEqual({ status: "legacy" });
    expect(await s.resolver.restoreOriginalRun("absent", true)).toEqual({ status: "fenced" });
  });
  it("filters retained sources with exact current provenance and never substitutes a matching subject key", async () => {
    const s = setup();
    const resolved = await s.resolver.resolveNative(s.msg("http:alice"), {
      source: "http",
      identity: { subject: "alice" },
      credentialDigest: digestBearer("first-key"),
    });
    if (resolved.status !== "resolved") throw new Error("not resolved");
    const identity = resolved.authentication.identity;
    expect(await s.resolver.evaluateSourceIdentity(identity)).toEqual({ status: "unavailable" });
    expect(await s.resolver.evaluateSourceIdentity(identity, resolved.authentication.sourceReference)).toMatchObject({
      status: "allowed",
    });
    s.options.auth = () => ({ tokens: { "second-key": { subject: "alice" } } });
    expect(await s.resolver.evaluateSourceIdentity(identity, resolved.authentication.sourceReference)).toEqual({
      status: "denied",
    });
    expect(await s.resolver.evaluateSourceIdentity(accessIdentity)).toEqual({ status: "unavailable" });
  });
  it("limits linked ownership to the proved unit and retains that scope after the question resolves", async () => {
    const s = setup();
    const person = await s.store.directory.createPerson();
    if (person.status !== "created") throw new Error("not created");
    for (const identity of [accessIdentity, slackIdentity])
      expect(
        (
          await s.store.directory.change({
            action: "link",
            identity,
            personId: person.person.id,
            expectedRevision: 0,
            actor: accessIdentity,
            proof: { method: "dual-authentication", version: 1 },
          })
        ).status,
      ).toBe("changed");
    for (const id of ["access:alice", "slack:UALICE"])
      s.lookup.set(id, { ...grants, actions: new Set(["steer:write"]), repos: new Set(["acme/app"]) });
    const digest = "a".repeat(64);
    let open = true;
    s.options.questionOwner = async (unitKey) =>
      unitKey === "pipeline:U101"
        ? {
            status: "proved",
            requester: slackIdentity,
            repo: "acme/app",
            sourceReference: {
              actorId: "slack:UALICE",
              userId: "slack:UALICE",
              channelId: "slack:DALICE",
              threadKey: "slack:DALICE:1",
            },
            ...(open ? { questionDigest: digest } : {}),
          }
        : { status: "fenced" };
    const current = await s.resolver.resolveBrowser(accessIdentity, s.msg("access:alice"));
    if (current.status !== "resolved") throw new Error("not resolved");
    const scoped = await s.resolver.resolveQuestion(current, "pipeline:U101", digest);
    expect(scoped.status).toBe("resolved");
    if (scoped.status !== "resolved") throw new Error("not scoped");
    expect(scoped.actor.id).toBe("access:alice");
    expect(scoped.actor.self).toEqual(["access:alice"]);
    expect(scoped.actor.onBehalfOf).toBeUndefined();
    expect(scoped.msg.userId).toBe("slack:UALICE");
    expect(scoped.msg.authenticatedAs).toBe("access:alice");
    expect(scoped.authentication.sourceReference?.questionOwnership).toEqual({
      unitKey: "pipeline:U101",
      questionDigest: digest,
      requester: slackIdentity,
    });
    expect(await s.resolver.resolveQuestion(current, "pipeline:U102", digest)).toEqual({ status: "fenced" });
    expect(await s.resolver.resolveQuestion(current, "pipeline:U101", "b".repeat(64))).toEqual({ status: "fenced" });
    open = false;
    const replay = await s.resolver.resolveAuthorization({
      action: "send",
      organization,
      actor: {
        identity: accessIdentity,
        kind: "human",
        principal: person.person.id,
        bindingRevision: 1,
        stream: person.person.id,
        onBehalfOf: null,
      },
      source: "browser",
      sourceReference: scoped.authentication.sourceReference,
      destination: { kind: "thread", thread: "pipeline:U101" },
      context: [],
      target: null,
    });
    expect(replay.status).toBe("resolved");
    s.lookup.set("access:alice", { ...grants, actions: new Set(["steer:write"]), repos: new Set() });
    expect(
      await s.resolver.resolveAuthorization({
        action: "send",
        organization,
        actor: {
          identity: accessIdentity,
          kind: "human",
          principal: person.person.id,
          bindingRevision: 1,
          stream: person.person.id,
          onBehalfOf: null,
        },
        source: "browser",
        sourceReference: scoped.authentication.sourceReference,
        destination: { kind: "thread", thread: "pipeline:U101" },
        context: [],
        target: null,
      }),
    ).toEqual({ status: "fenced" });
    s.lookup.set("access:alice", { ...grants, actions: new Set(["steer:write"]), repos: new Set(["acme/app"]) });
    expect(await s.resolver.resolveQuestion(current, "pipeline:U101", digest)).toEqual({ status: "fenced" });
    s.setSlack({ status: "unavailable" });
    expect(await s.resolver.resolveQuestion(current, "pipeline:U101", digest)).toEqual({ status: "fenced" });
    s.options.questionOwner = async () => ({
      status: "proved",
      requester: slackIdentity,
      repo: "acme/app",
      questionDigest: digest,
      sourceReference: {
        actorId: "slack:UALICE",
        userId: "slack:UALICE",
        channelId: "slack:DALICE",
        threadKey: "slack:DALICE:1",
      },
    });
    expect(await s.resolver.resolveQuestion(current, "pipeline:U101", digest)).toEqual({ status: "unavailable" });
    s.setSlack({
      status: "verified",
      identity: slackIdentity,
      actorId: "slack:UALICE",
      kind: "human",
      organizationMember: true,
      privateSource: true,
      epoch: "slack-live-2",
    });
    s.lookup.set("slack:UALICE", NO_GRANTS);
    expect(await s.resolver.resolveQuestion(current, "pipeline:U101", digest)).toEqual({ status: "fenced" });
    s.lookup.set("slack:UALICE", { ...grants, actions: new Set(["steer:write"]), repos: new Set(["acme/app"]) });
    expect(
      (
        await s.store.directory.change({
          action: "revoke",
          identity: slackIdentity,
          personId: person.person.id,
          expectedRevision: 1,
          actor: accessIdentity,
          proof: { method: "dual-authentication", version: 1 },
        })
      ).status,
    ).toBe("changed");
    expect(await s.resolver.resolveQuestion(current, "pipeline:U101", digest)).toEqual({ status: "fenced" });
  });
  it("restores the original owner from bodyless provenance with current policy and exact credential", async () => {
    const s = setup();
    const native = await s.resolver.resolveNative(s.msg("http:alice"), {
      source: "http",
      identity: { subject: "alice" },
      credentialDigest: digestBearer("first-key"),
    });
    if (native.status !== "resolved") throw new Error("not resolved");
    const origin = {
      version: 1 as const,
      organization,
      source: "http" as const,
      sourceEvent: "source-event",
      actor: {
        identity: native.authentication.identity,
        kind: "service" as const,
        principal: "http:alice",
        stream: null,
        bindingRevision: 0,
        onBehalfOf: null,
      },
      key: "submission",
      digest: "a".repeat(64),
      destination: { kind: "broad" as const },
      workload: "message" as const,
      target: null,
      content: "",
      context: [],
      sourceReference: native.authentication.sourceReference,
    };
    const claim = await s.ledger.consumeIngress({
      effectKey: "effect",
      digest: origin.digest,
      requester: "http:alice",
      threadKey: "http:home:alice",
      request: { text: "original" },
      contentExpiresAt: 90,
      origin,
      originExpiresAt: 365,
      receiptId: "receipt",
    });
    if (claim.status !== "claimed") throw new Error("not claimed");
    await s.ledger.clearIngressContent("effect");
    const restored = await s.resolver.restoreOriginalRun(claim.record.runId);
    expect(restored.status).toBe("resolved");
    if (restored.status !== "resolved") throw new Error("not restored");
    expect(restored.msg.text).toBe("");
    expect(restored.actor.id).toBe("http:alice");
    s.lookup.set("http:alice", NO_GRANTS);
    const narrowed = await s.resolver.restoreOriginalRun(claim.record.runId);
    expect(narrowed.status).toBe("resolved");
    if (narrowed.status !== "resolved") throw new Error("not restored");
    expect(authorize(narrowed.actor, "organization:send", { type: "organization", id: organization }).allow).toBe(
      false,
    );
    s.options.auth = () => ({ tokens: { "second-key": { subject: "alice" } } });
    expect(await s.resolver.restoreOriginalRun(claim.record.runId)).toEqual({ status: "fenced" });
  });
  it("allows an unlinked person's exact native original question without inventing a cross-source link", async () => {
    const s = setup();
    s.lookup.set("access:alice", { ...grants, actions: new Set(["steer:write"]), repos: new Set(["acme/app"]) });
    const digest = "a".repeat(64);
    s.options.questionOwner = async () => ({
      status: "proved",
      requester: accessIdentity,
      repo: "acme/app",
      questionDigest: digest,
      sourceReference: {
        actorId: "access:alice",
        userId: "access:alice",
        channelId: "http:home",
        threadKey: "http:home:alice",
      },
    });
    const current = await s.resolver.resolveBrowser(accessIdentity, s.msg("access:alice"));
    if (current.status !== "resolved") throw new Error("not resolved");
    expect(await s.store.directory.resolve(accessIdentity)).toEqual({ status: "unknown" });
    const answer = await s.resolver.resolveQuestion(current, "pipeline:U101", digest);
    expect(answer.status).toBe("resolved");
    if (answer.status !== "resolved") throw new Error("not resolved");
    expect(answer.actor.self).toEqual(["access:alice"]);
    expect(answer.msg.userId).toBe("access:alice");
    s.options.questionOwner = async () => ({
      status: "proved",
      requester: slackIdentity,
      repo: "acme/app",
      questionDigest: digest,
      sourceReference: {
        actorId: "slack:UALICE",
        userId: "slack:UALICE",
        channelId: "slack:DALICE",
        threadKey: "slack:DALICE:1",
      },
    });
    expect(await s.resolver.resolveQuestion(current, "pipeline:U101", digest)).toEqual({ status: "fenced" });
  });
});
