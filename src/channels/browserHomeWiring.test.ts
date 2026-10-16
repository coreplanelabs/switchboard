// Feature: docs/reference/specs/browser-home.md — native authority and durable production readiness.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config.js";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { executeDirectory } from "../core/organization/directoryTransport.js";
import type { OrganizationCommand } from "../core/organization/contract.js";
import type { DirectoryCommand } from "../core/organization/directoryTransport.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { NullLedgerWriteThrough } from "../core/runLedger/writeThrough.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { NullRunHistoryWriter } from "../core/runHistoryWriter.js";
import { RunRegistry } from "../core/runRegistry.js";
import { createRunsService } from "../core/runsService.js";
import { CommandRegistry, bindCommands } from "../core/commandRegistry.js";
import { NullMemoryStore } from "../core/memory/stores.js";
import { NullMcpToolSource } from "../mcp/source.js";
import { NO_FLEET } from "../core/residentFleet.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { ThreadsElsewhere } from "../core/runLedger/threadsElsewhere.js";
import { InMemoryPersonalTokenStore } from "../mcp/personalTokens.js";
import type { CoreDeps } from "../core/dispatcher.js";
import type { PageSeed, WebSeed } from "./webSeed.js";
import type { AccessIdentity } from "./accessAuth.js";
import { DAY_MS } from "../core/budgets.js";
import { createBrowserHomeWiring } from "./browserHomeWiring.js";
import { receiveSlackSourceDeletion } from "./slack.js";
import { workViewScopeOf } from "./workViewScope.js";
import { createHomeService } from "../core/home/service.js";
import { createHomeConditionReader } from "../core/home/conditions.js";
import { readableRuns } from "./liveView/viewer.js";
import { matchesPredicate } from "../core/authz/predicate.js";
import { NO_GRANTS } from "../core/authz/types.js";
import { InMemoryGithubApi } from "../execution/githubApi.js";
import { seedCoordinatorInstance, seedCoordinatorUnit } from "../core/testing/coordinatorInstance.js";
import type { HomeSession } from "./homeSeed.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const fn of cleanup.splice(0)) fn();
});
async function fixture(
  secret = true,
  initialSlackReady = true,
  pendingRealm?: Promise<string | undefined>,
  merge?: Pick<Parameters<typeof createBrowserHomeWiring>[0], "mergeLogin" | "mergeFacts">,
) {
  const dir = mkdtempSync(join(tmpdir(), "home-wiring-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "config.yaml"),
    `organization: fixture\nproviders:\n  anthropic: { type: anthropic, apiKeyEnv: UNSET_FIXTURE_PROVIDER }\ndefaults:\n  agent: general\n  models: { general: anthropic/general-model, coding: anthropic/coding-model }\ngrants:\n  "access:opaque": { actions: all, channels: all, repos: all, organizations: all }\n  "slack:UALICE": { actions: all, channels: all, repos: all, organizations: all }\nrouting: { operator: off }\nchannels:\n  "slack:D1": { repo: sample/api }\nrunHistory:\n  worker: { baseUrl: https://store.fixture.test, tokenEnv: MEMORY_TOKEN }\n  retentionDays: 30\nworkspaceDir: ${dir}/workspaces\n`,
  );
  const config = new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"), {
    commandGroups: ["runs", "memory"],
  });
  const backing = new InMemoryOrganizationStore(() => 1000);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as {
      installation: string;
      command: OrganizationCommand & DirectoryCommand;
    };
    expect(payload.installation).toBe("fixture");
    expect(init.headers).toMatchObject({ authorization: "Bearer fixture-token" });
    const value = String(url).endsWith("/organization/directory")
      ? await executeDirectory(backing.directory, payload.command)
      : await backing.execute(payload.command);
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  });
  const registry = new RunRegistry({ now: () => 1000 }),
    runStore = new InMemoryRunStore({ now: () => 1000 }),
    coordinator = new InMemoryCoordinatorInstanceStore();
  const effects: string[] = [],
    replies: { thread: string; text: string }[] = [],
    tasks: (() => Promise<void>)[] = [];
  const registryCommands = new CommandRegistry<null>({ audit: () => {} });
  registryCommands.register({
    id: "memory.forget",
    action: "memory:read",
    effect: "read",
    describe: "Read-only fixture command",
    handler: async ({ caller }) => {
      effects.push(caller.actor.id);
      return { text: "Native command completed." };
    },
    render: (value) => (value as { text: string }).text,
  });
  const commands = bindCommands(registryCommands, null);
  const core: CoreDeps = {
    config,
    runRegistry: registry,
    runStore,
    coordinatorInstances: coordinator,
    commands,
    githubApi: new InMemoryGithubApi({ "sample/api": { private: false }, "sample/web": { private: false } }),
    runLedger: new NullLedgerWriteThrough("fixture", runStore),
    runHistoryWriter: new NullRunHistoryWriter(),
    completions: {
      get: () => {
        throw new Error("No model is invoked by readiness or projection.");
      },
    },
    memory: new NullMemoryStore(),
    mcp: new NullMcpToolSource(),
    residentFleet: NO_FLEET,
    capabilities: ALL_CAPABILITIES,
    threadsElsewhere: new ThreadsElsewhere(),
  };
  const credential: AccessIdentity = { sub: "opaque", email: "same-address@example.test" };
  const people = [{ id: "slack:UALICE", name: "Alice" }];
  let sent: PageSeed | undefined;
  let shared = false;
  let slackReady = initialSlackReady;
  const wiring = createBrowserHomeWiring({
    ...(merge ?? {}),
    config,
    dashboard: { mode: "access", describe: () => "fixture", verify: async () => ({ ok: true, identity: credential }) },
    access: { teamDomain: "access.fixture.test", aud: "fixture-audience" },
    slack: {
      auth: {
        test: async () => {
          if (!slackReady) throw new Error("Slack unavailable");
          return { team_id: "fixture-team" };
        },
      },
      users: { info: async () => ({ user: { team_id: "fixture-team", is_bot: false } }) },
      conversations: {
        info: async () => ({ channel: { user: "UALICE", is_im: true, is_org_shared: false, is_shared: shared } }),
      },
      emoji: { list: async () => ({ ok: true, emoji: {} }) },
    },
    team: async () => pendingRealm ?? (slackReady ? "fixture-team" : undefined),
    ledger: new InMemoryRunLedger(() => 1000),
    core,
    runs: createRunsService({ registry, store: runStore, units: coordinator }),
    commands,
    auth: () => ({ tokens: {} }),
    personalTokens: new InMemoryPersonalTokenStore(),
    readSecret: () => (secret ? "fixture-token" : undefined),
    emojiDirectory: join(dir, "emoji"),
    page: (_req, _res, _status, _actor, _title, seed) => {
      sent = seed;
    },
    people: () => people,
    channelsOf: async () => "unknown",
    now: () => 1000,
    owner: "fixture-process",
    limits: {
      pendingPerActor: 10,
      pendingPerSource: 20,
      pendingPerOrganization: 30,
      reservedReconciliation: 1,
      contentTtlMs: DAY_MS,
      receiptTtlMs: DAY_MS,
    },
    launch: (task) => tasks.push(task),
    nativeIo: (request) => ({
      reply: async (text) => {
        replies.push({ thread: request.msg.threadKey, text });
      },
      history: async () => [{ role: "user", text: "Erased raw source history must not reappear" }],
      status: async () => ({ update() {}, done: async () => {} }),
      ...(request.msg.directAudience
        ? {
            directAudience: () => request.msg.directAudience,
            verifyDirectAudience: async () => ({ ok: true as const }),
          }
        : {}),
    }),
    publicBaseUrl: "https://dashboard.fixture.test",
  });
  const request = (cookie = "") =>
    ({
      headers: { cookie, "cf-access-jwt-assertion": "fixture-proof" },
      socket: { remoteAddress: "127.0.0.1" },
    }) as unknown as IncomingMessage;
  return {
    wiring,
    credential,
    people,
    request,
    sent: () => sent as unknown as WebSeed,
    backing,
    core,
    coordinator,
    effects,
    replies,
    tasks,
    restoreSlack: () => {
      slackReady = true;
    },
    share: () => {
      shared = true;
    },
  };
}
describe("browser production wiring", () => {
  it("erases the verified native Slack source through the production callback without rehosting its copied input", async () => {
    const s = await fixture();
    await s.wiring.initialize();
    const msg = {
      channelId: "slack:D1",
      userId: "slack:UALICE",
      threadKey: "slack:D1:1",
      messageId: "1000.1",
      text: "memory forget",
      directAudience: {
        kind: "slack-unshared-im" as const,
        channelId: "slack:D1",
        userId: "slack:UALICE",
        threadKey: "slack:D1:1",
      },
    };
    const io = {
      reply: async () => {},
      history: async () => [],
      status: async () => ({ update() {}, done: async () => {} }),
    };
    expect(await s.wiring.dispatchSlack(s.core, msg, io)).toMatchObject({
      status: "completed",
      inputQueued: { runId: expect.any(String) },
    });
    const native = await s.wiring.authentication()!.resolveNative(msg, {
      source: "slack",
      identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" },
    });
    if (native.status !== "resolved") throw new Error("native source unavailable");
    const installation = s.wiring.current()!;
    expect(await installation.organization.streamTail(native.authentication, undefined, 100)).toMatchObject({
      status: "stream_tail",
      entries: [{ content: "memory forget" }],
    });
    const address = {
      source: "slack" as const,
      issuer: "https://slack.com",
      tenant: "fixture-team",
      channelId: msg.channelId,
      messageId: msg.messageId,
    };
    expect(await s.wiring.deleteSlackSource({ ...address, tenant: "foreign-team" })).toEqual({ status: "fenced" });
    let acknowledgments = 0;
    expect(
      await receiveSlackSourceDeletion(
        {
          body: {
            type: "event_callback",
            team_id: "fixture-team",
            event: { type: "message", subtype: "message_deleted", channel: "D1", deleted_ts: "1000.1" },
          },
          ack: async () => {
            acknowledgments++;
          },
        },
        { auth: { test: async () => ({ team_id: "fixture-team" }) } },
        s.wiring.deleteSlackSource,
      ),
    ).toBe(true);
    expect(acknowledgments).toBe(1);
    expect(await installation.organization.streamTail(native.authentication, undefined, 100)).toMatchObject({
      status: "stream_tail",
      entries: [],
    });
    const current = await installation.organization.resolve(native.authentication);
    if (!current) throw new Error("native source unavailable");
    const receipt = await s.backing.execute({
      action: "submission",
      ...current,
      source: "slack",
      key: "slack:D1:1000.1",
    });
    expect(receipt).toMatchObject({
      status: "submission",
      receipt: { status: "accepted", ownerRunId: expect.any(String) },
    });
    if (receipt.status !== "submission" || !receipt.receipt.ownerRunId) throw new Error("receipt unavailable");
    expect(await s.wiring.originalBinding(receipt.receipt.ownerRunId)).toBeUndefined();
    await s.tasks.shift()!();
    expect(s.effects).toEqual([]);
    expect(s.replies).toEqual([]);
  });
  it("offers an owned reviewed-head merge and observes native completion through installation callbacks without a model", async () => {
    const callers: string[] = [],
      reads: { repo: string; unit: string; number?: number }[] = [];
    const s = await fixture(true, true, undefined, {
      mergeLogin: async (id) => {
        callers.push(id);
        return "bound-viewer";
      },
      mergeFacts: async (_context, instance, unit) => {
        reads.push({ repo: instance.repo, unit: unit.unit, number: unit.pr?.number });
        return { headSha: "a".repeat(40), mergeCommitSha: "b".repeat(40), mergedAt: 900 };
      },
    });
    await s.wiring.initialize();
    const context = await s.wiring.context(s.request(), s.credential);
    if (!context) throw new Error("No current browser context");
    seedCoordinatorInstance(s.coordinator, {
      id: "merge-work",
      kind: "ship",
      userId: "access:opaque",
      channelId: "web:opaque",
      threadKey: "web:opaque:original",
      repo: "sample/api",
      branch: "work",
      createdAt: 1,
    });
    const pr = { number: 42, url: "https://github.com/sample/api/pull/42" };
    seedCoordinatorUnit(s.coordinator, {
      instanceId: "merge-work",
      unit: "original",
      slug: "original",
      branch: "work",
      dependsOn: [],
      rounds: [],
      pr,
      lastPush: "a".repeat(40),
      ending: { kind: "merge_ready", report: "Original reviewed-head report.", at: 800 },
      mergeAttention: { assignedTo: "access:opaque", pr, headSha: "a".repeat(40), at: 800 },
    });
    const service = createHomeService({
      organizationId: "fixture",
      instances: s.coordinator,
      conditions: createHomeConditionReader(s.coordinator),
    });
    const reader = { actorId: context.actor.id, visibleTo: readableRuns(context.actor) };
    const snapshot = await service.snapshot(reader);
    const installed = s.wiring.current()!;
    expect(await installed.mergeActions(context, snapshot.needsYou)).toEqual({
      "merge-work:original": { kind: "merge", pr: "sample/api#42", head: "a".repeat(40) },
    });
    expect(callers).toEqual(["access:opaque"]);
    const before = s.tasks.length;
    installed.queueMergeObservations(context, snapshot.needsYou);
    expect(s.tasks).toHaveLength(before + 1);
    await s.tasks.at(-1)!();
    expect(reads).toEqual([{ repo: "sample/api", unit: "original", number: 42 }]);
    expect((await service.snapshot(reader)).needsYou).toEqual([]);
    expect((await service.history(reader)).units[0]?.unit).toMatchObject({
      mergeCompletion: { at: 900, sha: "b".repeat(40) },
      ending: { kind: "merge_ready", report: "Original reviewed-head report.", at: 800 },
    });
    expect(s.effects).toEqual([]);
  });
  it("keeps a freshly signed-in account usable after unlinking without restoring its former peer", async () => {
    const s = await fixture();
    await s.wiring.initialize();
    const identity = s.wiring.native()!.browserIdentity(s.credential);
    const directory = s.backing.directory;
    const person = await directory.createPerson();
    if (person.status !== "created") throw new Error("No person");
    const peer = { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" };
    for (const account of [identity, peer])
      expect(
        await directory.change({
          action: "link",
          identity: account,
          personId: person.person.id,
          expectedRevision: 0,
          actor: identity,
          proof: { method: "dual-authentication", version: 1 },
        }),
      ).toMatchObject({ status: "changed" });
    expect((await s.wiring.context(s.request(), s.credential))?.actor.id).toBe("access:opaque");
    expect(
      await directory.change({
        action: "revoke",
        identity,
        personId: person.person.id,
        expectedRevision: 1,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      }),
    ).toMatchObject({ status: "changed" });
    const current = await s.wiring.context(s.request(), s.credential);
    expect(current?.actor.id).toBe("access:opaque");
    expect(current?.actor.self).toEqual(["access:opaque"]);
    expect(workViewScopeOf(current!.actor).ownerIds).toEqual(["access:opaque"]);
    expect(await s.wiring.current()!.organization.resolve(current!.authentication)).toMatchObject({
      actor: {
        bindingRevision: 2,
        stream: `browser:${JSON.stringify([identity.issuer, identity.tenant, identity.subject])}`,
      },
    });
  });
  it("serves the browser while Slack realm verification is still pending", async () => {
    let finishRealm!: (realm: string | undefined) => void;
    const realm = new Promise<string | undefined>((resolve) => {
      finishRealm = resolve;
    });
    const s = await fixture(true, true, realm);
    try {
      await s.wiring.initialize();
      const context = await s.wiring.context(s.request(), s.credential);
      expect(context?.actor.id).toBe("access:opaque");
      expect(
        await s.wiring
          .native()!
          .currentSlack({ issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" }),
      ).toEqual({ status: "unavailable" });
      finishRealm("fixture-team");
      await s.wiring.refreshNativeSources();
      expect(
        await s.wiring
          .native()!
          .currentSlack({ issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" }),
      ).toMatchObject({ status: "verified", actorId: "slack:UALICE" });
    } finally {
      finishRealm(undefined);
    }
  });
  it("keeps signed browser work ready during Slack outage and restores the verified Slack realm without replacing ownership", async () => {
    const s = await fixture(true, false);
    await s.wiring.initialize();
    const context = await s.wiring.context(s.request(), s.credential);
    expect(context?.actor.id).toBe("access:opaque");
    const installation = s.wiring.current();
    if (!context || !installation) throw new Error("No independent browser installation");
    const identity = { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" };
    expect(await s.wiring.native()!.currentSlack(identity)).toEqual({ status: "unavailable" });
    const epoch = await installation.host.currentEpoch(context);
    s.restoreSlack();
    await s.wiring.refreshNativeSources();
    expect(s.wiring.current()).toBe(installation);
    expect(await s.wiring.native()!.currentSlack(identity)).toMatchObject({
      status: "verified",
      actorId: "slack:UALICE",
      kind: "human",
    });
    const fresh = await s.wiring.context(s.request(), s.credential);
    expect(fresh?.actor.id).toBe("access:opaque");
    expect(await installation.host.currentEpoch(fresh!)).toBe(epoch);
  });
  it("keeps another repository's readable unit as broad context without rejecting or retargeting the selected repository", async () => {
    const s = await fixture();
    const coordinator = s.core.coordinatorInstances as InMemoryCoordinatorInstanceStore;
    seedCoordinatorInstance(coordinator, {
      id: "evidence",
      kind: "ship",
      userId: "access:opaque",
      channelId: "web:opaque",
      threadKey: "web:opaque:organization",
      repo: "sample/api",
      branch: "evidence",
      createdAt: 1000,
    });
    seedCoordinatorUnit(coordinator, {
      instanceId: "evidence",
      unit: "original",
      slug: "evidence",
      branch: "evidence/original",
      dependsOn: [],
      rounds: [],
    });
    await s.wiring.initialize();
    const context = await s.wiring.context(s.request(), s.credential);
    if (!context) throw new Error("No current browser actor");
    const call = async (method: string, url: string, input?: unknown) => {
      const req = Readable.from(input ? [JSON.stringify(input)] : []) as IncomingMessage;
      Object.assign(req, {
        method,
        url,
        headers: {
          host: "dashboard.fixture.test",
          origin: "https://dashboard.fixture.test",
          "content-type": "application/json",
        },
      });
      let status = 0;
      const output = new Promise<{ status: number; body: HomeSession }>((resolve) => {
        const res = {
          writeHead(value: number) {
            status = value;
          },
          setHeader() {},
          end(text: string) {
            resolve({ status, body: JSON.parse(text) });
          },
        } as unknown as ServerResponse;
        expect(s.wiring.current()!.handler(req, res, context)).toBe(true);
      });
      return output;
    };
    const session = await call("GET", "/home/session");
    const result = await call("POST", "/home/send", {
      key: session.body.submissionKey,
      revision: session.body.destination.revision,
      destination: { kind: "broad" },
      text: "memory forget",
      context: [
        { kind: "unit", key: "evidence:original" },
        { kind: "repository", key: "sample/web" },
      ],
    });
    expect(result.status).toBe(200);
    const resolved = await s.wiring.current()!.organization.resolve(context.authentication);
    if (!resolved) throw new Error("No current organization");
    expect(
      await s.backing.execute({
        action: "submission",
        ...resolved,
        source: "browser",
        key: session.body.submissionKey,
      }),
    ).toMatchObject({
      status: "submission",
      envelope: {
        destination: { kind: "broad" },
        sourceReference: { sourceRepository: "sample/web" },
        context: [
          { kind: "unit", key: "evidence:original" },
          { kind: "repository", key: "sample/web" },
        ],
      },
    });
  });
  it("keeps shared Slack threads local and admits a proved private DM with its configured repository and exact native address", async () => {
    const s = await fixture();
    const local: string[] = [];
    const io = {
      reply: async (text: string) => {
        local.push(text);
      },
      history: async () => [],
      status: async () => ({ update() {}, done: async () => {} }),
    };
    await s.wiring.dispatchSlack(
      s.core,
      {
        channelId: "slack:C1",
        userId: "slack:UALICE",
        threadKey: "slack:C1:1",
        messageId: "1000.0",
        text: "memory forget",
      },
      io,
    );
    expect(local).toEqual(["Native command completed."]);
    expect(s.effects).toEqual(["slack:UALICE"]);
    await s.wiring.initialize();
    const msg = {
      channelId: "slack:D1",
      userId: "slack:UALICE",
      threadKey: "slack:D1:1",
      messageId: "1000.1",
      text: "memory forget",
      directAudience: {
        kind: "slack-unshared-im" as const,
        channelId: "slack:D1",
        userId: "slack:UALICE",
        threadKey: "slack:D1:1",
      },
    };
    expect(await s.wiring.dispatchSlack(s.core, msg, io)).toMatchObject({
      status: "completed",
      inputQueued: { runId: expect.any(String) },
    });
    const task = s.tasks.shift();
    if (!task) throw new Error("No original native owner");
    await task();
    expect(s.replies).toEqual([{ thread: "slack:D1:1", text: "Native command completed." }]);
    expect(s.effects).toEqual(["slack:UALICE", "slack:UALICE"]);
    const resolved = await s.wiring.authentication()!.resolveNative(msg, {
      source: "slack",
      identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" },
    });
    if (resolved.status !== "resolved") throw new Error("No current native proof");
    const org = await s.wiring.current()!.organization.resolve(resolved.authentication);
    if (!org) throw new Error("No native organization");
    const saved = await s.backing.execute({ action: "submission", ...org, source: "slack", key: "slack:D1:1000.1" });
    expect(saved).toMatchObject({
      status: "submission",
      envelope: {
        destination: { kind: "broad" },
        sourceReference: {
          channelId: "slack:D1",
          userId: "slack:UALICE",
          sourceRepository: "sample/api",
          privateSource: true,
          capturedPrivateEpoch: expect.any(String),
        },
      },
    });
    if (saved.status !== "submission") throw new Error("No protected original receipt");
    const original = await s.wiring.originalBinding(saved.receipt.ownerRunId!);
    expect(original?.msg.text).toBe("memory forget");
    expect(original?.msg.userId).toBe("slack:UALICE");
    expect(original?.runId).toBe(saved.receipt.ownerRunId);
    s.share();
    expect(await s.wiring.dispatchSlack(s.core, { ...msg, messageId: "1000.2" }, io)).toMatchObject({
      status: "refused",
    });
    expect(local).toEqual(["Native command completed.", "This private request is unavailable. No new work started."]);
    expect(s.effects).toEqual(["slack:UALICE", "slack:UALICE"]);
  });
  it("uses the verified opaque subject without correlating an email and stamps global scope on every green seed", async () => {
    const s = await fixture();
    await s.wiring.initialize();
    const context = await s.wiring.context(s.request(), s.credential);
    expect(context?.actor.id).toBe("access:opaque");
    expect(context?.actor.self).toEqual(["access:opaque"]);
    expect(workViewScopeOf(context!.actor).ownerIds).toEqual(["access:opaque"]);
    s.wiring.page(s.request(), {} as ServerResponse, 200, context!.actor, "Missing page", {
      page: "runNotFound",
      retentionDays: null,
    });
    expect(s.sent()).toMatchObject({
      dataView: { mode: "mine", canViewEveryone: true },
      asUser: { id: "access:opaque", name: "same-address@example.test" },
      viewAs: { people: [{ id: "slack:UALICE", name: "Alice" }] },
      emoji: {},
    });
    expect(s.wiring.identity()?.unavailable).toBe("This installation has not configured account verification.");
  });
  it("holds readiness when durable credentials are missing instead of creating a memory organization", async () => {
    const s = await fixture(false);
    await s.wiring.initialize();
    expect(s.wiring.current()).toBeUndefined();
    expect(await s.wiring.context(s.request(), s.credential)).toBeUndefined();
    expect(s.wiring.unavailable()).toBe("Organization storage or current source proof is unavailable.");
  });
  it("projects a known person's work without their browser proof or changing the actual authentication", async () => {
    const s = await fixture();
    s.people.push({ id: "access:bob", name: "Bob" });
    await s.wiring.initialize();
    const context = await s.wiring.context(s.request("sb-view-as=access%3Abob"), s.credential);
    expect(context?.actor).toMatchObject({
      id: "access:opaque",
      self: ["access:opaque"],
      viewingAs: { id: "access:bob" },
      onBehalfOf: { id: "access:bob" },
    });
    expect(context?.authentication).toMatchObject({
      identity: { subject: "opaque" },
      sourceReference: { actorId: "access:opaque", userId: "access:opaque" },
    });
    expect(context?.authentication.onBehalfOf).toBeUndefined();
    const home = s.wiring.current()!;
    const owner = {
      id: "bob-work",
      kind: "ship" as const,
      userId: "access:bob",
      channelId: "web:bob",
      threadKey: "web:bob:asking",
      repo: "sample/api",
      branch: "codex/bob",
      createdAt: 1000,
    };
    const row = {
      instanceId: owner.id,
      unit: "original",
      slug: "bob",
      title: "Bob's private work",
      branch: owner.branch,
      dependsOn: [],
      rounds: [],
      threadKey: "worker:bob-work:original",
      workBrief: {
        requesterId: owner.userId,
        mainThreadKey: owner.threadKey,
        actId: "bob-act",
        repo: owner.repo,
        base: "main",
        question: "PRIVATE_BOB_CHAT",
        findings: [],
        requestedChange: "Bob's requested change",
      },
      idle: {
        why: "human_gated" as const,
        at: 1000,
        renewalsLeft: 1,
        wakes: 0,
        spendUsd: null,
        humanGate: {
          assignedTo: "access:bob",
          pr: { number: 42, url: "https://github.com/sample/api/pull/42" },
          round: 1,
          verdict: "approve" as const,
          findings: [
            {
              id: "F1",
              severity: "minor" as const,
              file: "app.ts",
              title: "Bob's recorded question",
              humanGated: true as const,
            },
          ],
          askedAt: 1000,
        },
      },
    };
    seedCoordinatorInstance(s.coordinator, owner);
    seedCoordinatorUnit(s.coordinator, row);
    const service = createHomeService({
      organizationId: "fixture",
      instances: s.coordinator,
      conditions: createHomeConditionReader(s.coordinator),
    });
    const snapshot = (viewer: NonNullable<typeof context>) =>
      service.snapshot({
        actorId: viewer.actor.viewingAs?.id ?? viewer.actor.id,
        attentionRecipients:
          workViewScopeOf(viewer.actor).mode === "everyone"
            ? [viewer.actor.id]
            : workViewScopeOf(viewer.actor).ownerIds,
        visibleTo: readableRuns(viewer.actor),
        readPrivateUnit: (instance, unit) => home.canReadPrivateUnit(viewer, instance, unit),
      });
    const all = await s.wiring.context(s.request("sb-data-view=everyone"), s.credential);
    const allRows = await snapshot(all!);
    expect(allRows.waiting).toMatchObject([
      {
        unit: { title: "Bob's private work", threads: { coding: "worker:bob-work:original" } },
        conditions: [{ owner: { kind: "person", id: "access:bob" }, summary: "F1: Bob's recorded question" }],
      },
    ]);
    expect(allRows.needsYou).toEqual([]);
    expect(await s.wiring.attentionRecipients(all!)).toEqual(["access:opaque"]);
    const selectedRows = await snapshot(context!);
    expect(selectedRows.needsYou).toMatchObject([
      { unit: { title: "Bob's private work" }, conditions: [{ owner: { kind: "person", id: "access:bob" } }] },
    ]);
    expect(JSON.stringify(selectedRows)).not.toContain("PRIVATE_BOB_CHAT");
    expect(await home.readThread(all!, row.threadKey)).toBeUndefined();
    expect(await home.readThread(context!, row.threadKey)).toBeUndefined();
    expect(await home.answers(context!, selectedRows.needsYou)).toEqual({});
    const refusal = async (method: string, url: string, input?: unknown) => {
      const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]) as IncomingMessage;
      Object.assign(req, {
        method,
        url,
        headers: {
          host: "dashboard.fixture.test",
          origin: "https://dashboard.fixture.test",
          "content-type": "application/json",
        },
      });
      let status = 0;
      let completed!: () => void;
      const done = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const res = {
        setHeader() {},
        writeHead(code: number) {
          status = code;
        },
        end() {
          completed();
        },
      } as unknown as ServerResponse;
      expect(home.handler(req, res, context!)).toBe(true);
      await done;
      return status;
    };
    expect(await refusal("GET", "/home/session")).toBe(404);
    expect(await refusal("POST", "/home/focus", { thread: row.threadKey })).toBe(403);
    expect(await refusal("POST", "/home/send", { text: "Forged person answer" })).toBe(403);
    expect(await s.coordinator.listEvents({ instanceId: owner.id, unit: row.unit })).toEqual([]);
    const refreshed = await home.host.refresh(context!);
    expect(workViewScopeOf(refreshed!.actor)).toMatchObject({ mode: "person", ownerIds: ["access:bob"] });
    expect(
      matchesPredicate(readableRuns(refreshed!.actor), {
        userId: "access:bob",
        channelId: "web:bob",
        repo: "sample/api",
        channelVisibility: "unknown",
      }),
    ).toBe(true);
    expect(
      matchesPredicate(readableRuns(refreshed!.actor), {
        userId: "access:opaque",
        channelId: "web:opaque",
        repo: "sample/api",
        channelVisibility: "unknown",
      }),
    ).toBe(false);
    const lookup = s.core.config.grantsFor.bind(s.core.config);
    vi.spyOn(s.core.config, "grantsFor").mockImplementation((id) => (id === "access:bob" ? NO_GRANTS : lookup(id)));
    const reduced = await s.wiring.current()!.host.refresh(context!);
    expect(readableRuns(reduced!.actor)).toEqual({ kind: "none" });
    expect(await home.canReadPrivateUnit(context!, owner, row)).toBe(false);
    vi.mocked(s.core.config.grantsFor).mockImplementation((id) =>
      id === "access:opaque" || id === "access:bob" ? NO_GRANTS : lookup(id),
    );
    expect(await home.host.refresh(context!)).toBeUndefined();
    expect(await home.canReadPrivateUnit(all!, owner, row)).toBe(false);
    expect(s.effects).toEqual([]);
  });
  it("preserves trusted All people scope and the actual viewer's broad work choices through fresh projection", async () => {
    const s = await fixture();
    await s.wiring.initialize();
    const context = await s.wiring.context(s.request("sb-data-view=everyone"), s.credential);
    expect(workViewScopeOf(context!.actor)).toMatchObject({ mode: "everyone", ownerIds: [], canEveryone: true });
    const refreshed = await s.wiring.current()!.host.refresh(context!);
    expect(workViewScopeOf(refreshed!.actor)).toMatchObject({ mode: "everyone", ownerIds: [] });
    const req = Readable.from([]) as IncomingMessage;
    Object.assign(req, { method: "GET", url: "/home/session", headers: {} });
    let status = 0,
      body = "",
      finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const res = {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
        finish();
      },
    } as unknown as ServerResponse;
    expect(s.wiring.current()!.handler(req, res, context!)).toBe(true);
    await done;
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      actor: "access:opaque",
      destination: { kind: "broad", canWrite: true },
      repositories: { status: "complete", repositories: [{ repo: "sample/api" }, { repo: "sample/web" }] },
    });
    expect(
      await s.wiring.originalIO("unknown-original", { threadKey: "web:opaque:original", userId: "access:opaque" }),
    ).toBeUndefined();
  });
});
