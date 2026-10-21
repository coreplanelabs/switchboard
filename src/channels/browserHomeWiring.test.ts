// Feature: docs/reference/specs/browser-home.md — native authority and durable production readiness.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createMcpApprovalView } from "./mcpApprovalView.js";
import { InMemoryConfirmationStore } from "../core/confirmations.js";
import { runsStop } from "../core/commands/runs.js";
import type { Actor } from "../core/authz/types.js";
import type { Confirmation } from "../core/confirmations.js";
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
import { analyzeRunFriction } from "../core/runFriction.js";
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
import { tokenVerifier, type DashboardVerifier } from "./dashboardAuth.js";
import { createLiveViewHandler } from "./liveView.js";
import { receiveSlackSourceDeletion } from "./slack.js";
import { withWorkViewScope, workViewScopeOf } from "./workViewScope.js";
import { createHomeService } from "../core/home/service.js";
import { createHomeConditionReader } from "../core/home/conditions.js";
import { readableRuns } from "./liveView/viewer.js";
import { matchesPredicate } from "../core/authz/predicate.js";
import { NO_GRANTS } from "../core/authz/types.js";
import { RestGithubApi, InMemoryGithubApi } from "../execution/githubApi.js";
import { seedCoordinatorInstance, seedCoordinatorUnit } from "../core/testing/coordinatorInstance.js";
import type { HomeSession } from "./homeSeed.js";
import { handleIngressRequest, type HttpIO, type IngressConfig } from "./http.js";
import { handleMcpRequest } from "./mcp.js";
import { registerRunsCommands, type RunsCommandDeps } from "../core/commands/runs.js";
import { agentSmokeTransport, runAgentSmoke } from "../deploy/agentSmoke.js";
import { nullChannelIO } from "../core/nullChannelIo.js";
import { createLedgerWriteThrough } from "../core/runLedger/writeThrough.js";
import { createRunHistoryWriter } from "../core/runHistoryWriter.js";
import { HarnessRegistry } from "../core/harness/pi/relay.js";
import { PiHarness } from "../core/harness/pi/piHarness.js";
import { OpenCodeHarness } from "../core/harness/opencode/harness.js";
import { FakeHarnessContainer } from "../core/harness/testing/fakeContainer.js";
import { scriptPiFromProvider } from "../core/harness/pi/testing/providerPi.js";
import { RunBearerStore } from "../core/modelProxy/runBearers.js";
import { GitBindings } from "../core/modelProxy/gitBindings.js";
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
  dashboard?: DashboardVerifier,
  native = false,
  emailOwners: Pick<
    Parameters<typeof createBrowserHomeWiring>[0],
    "personByEmail" | "emailOf" | "onWorkViewResolved" | "requesterProfile"
  > & { now?: () => number } = {},
  defaultGithub = false,
) {
  const dir = mkdtempSync(join(tmpdir(), "home-wiring-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "config.yaml"),
    `organization: fixture\nproviders:\n  anthropic: { type: anthropic, apiKeyEnv: UNSET_FIXTURE_PROVIDER }\ndefaults:\n  agent: general\n  models: { general: anthropic/general-model, coding: anthropic/coding-model }\ngrants:\n  "access:opaque": { actions: all, channels: all, repos: all, organizations: all }\n  "slack:UALICE": { actions: all, channels: all, repos: all, organizations: all }\n${native ? '  "http:bot": { actions: all, channels: all, repos: all, organizations: [fixture] }\n  "mcp:bot": { actions: [runs:read], channels: [http:default] }\n' : ""}routing: { operator: off }\nchannels:\n  "slack:D1": { repo: sample/api }\nrunHistory:\n  worker: { baseUrl: https://store.fixture.test, tokenEnv: MEMORY_TOKEN }\n  retentionDays: 30\nworkspaceDir: ${dir}/workspaces\n`,
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
    coordinator = new InMemoryCoordinatorInstanceStore(),
    ledger = new InMemoryRunLedger(() => 1000);
  const runs = createRunsService({ registry, store: runStore, units: coordinator });
  if (native) {
    const read = runStore.get.bind(runStore);
    const summary = runStore.getSummary.bind(runStore);
    runStore.get = async (id) => (ledger.finished.has(id) ? structuredClone(ledger.finished.get(id)!) : read(id));
    runStore.getSummary = async (id) =>
      ledger.finished.has(id) ? structuredClone(ledger.finished.get(id)!) : summary(id);
  }
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
    githubApi: defaultGithub
      ? undefined
      : new InMemoryGithubApi({ "sample/api": { private: false }, "sample/web": { private: false } }),
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
  const ingressTokens: IngressConfig["tokens"] = native
    ? { "native-token": { subject: "bot", channel: "default" } }
    : {};
  const wiring = createBrowserHomeWiring({
    ...(merge ?? {}),
    ...emailOwners,
    config,
    dashboard: dashboard ?? {
      mode: "access",
      describe: () => "fixture",
      verify: async () => ({ ok: true, identity: credential }),
    },
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
    ledger,
    core,
    runs,
    commands,
    auth: (): IngressConfig => ({ tokens: ingressTokens }),
    personalTokens: new InMemoryPersonalTokenStore(),
    readSecret: () => (secret ? "fixture-token" : undefined),
    emojiDirectory: join(dir, "emoji"),
    page: (_req, _res, _status, _actor, _title, seed) => {
      sent = seed;
    },
    people: () => people,
    channelsOf: async () => "unknown",
    now: emailOwners.now ?? (() => 1000),
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
    nativeIo: (request) =>
      native
        ? nullChannelIO(request.msg.threadKey, () => {})
        : {
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
          },
    publicBaseUrl: "https://dashboard.fixture.test",
  });
  const request = (cookie = "") =>
    ({
      headers: { cookie, "cf-access-jwt-assertion": "fixture-proof" },
      socket: { remoteAddress: "127.0.0.1" },
    }) as unknown as IncomingMessage;
  return {
    wiring,
    config,
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
    runStore,
    ledger,
    registry,
    runs,
    ingressTokens,
    restoreSlack: () => {
      slackReady = true;
    },
    share: () => {
      shared = true;
    },
  };
}
describe("browser production wiring", () => {
  it("labels an unlinked Access run from only its current verified browser session", async () => {
    const profile = { name: "Alice", avatarUrl: "https://avatars.slack-edge.com/alice.jpg" };
    const s = await fixture(true, true, undefined, undefined, undefined, false, {
      personByEmail: async (email) =>
        email === "same-address@example.test" ? { id: "slack:UALICE", name: "Alice" } : undefined,
      requesterProfile: async (id) => (id === "slack:UALICE" ? profile : undefined),
    });
    await s.wiring.initialize();
    expect(await s.wiring.requesterProfile("access:opaque")).toBeUndefined();
    await s.wiring.context(s.request(), s.credential);
    expect(await s.wiring.requesterProfile("access:opaque")).toEqual(profile);
    expect(await s.wiring.requesterProfile("access:foreign")).toBeUndefined();
  });

  it("keeps the actual person's linked profile when another person's work is selected", async () => {
    const profile = { name: "Alice", avatarUrl: "https://avatars.slack-edge.com/alice.jpg" };
    const s = await fixture(true, true, undefined, undefined, undefined, false, {
      requesterProfile: async (id) => (id === "slack:UALICE" ? profile : undefined),
    });
    s.people.push({ id: "access:bob", name: "Bob" });
    await s.wiring.initialize();
    const browser = s.wiring.native()!.browserIdentity(s.credential);
    const created = await s.backing.directory.createPerson();
    if (created.status !== "created") throw new Error("Missing test person");
    for (const identity of [browser, { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" }]) {
      await s.backing.directory.change({
        action: "link",
        identity,
        personId: created.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      });
    }
    const context = await s.wiring.context(s.request("sb-view-as=access%3Abob"), s.credential);
    expect(context?.actor.viewingAs?.id).toBe("access:bob");
    expect(s.wiring.viewerProfile(context!.actor)).toEqual(profile);
  });

  it("loads repository choices with the default GitHub client used by production", async () => {
    const repos = vi.spyOn(RestGithubApi.prototype, "listRepos").mockResolvedValue([
      { fullName: "sample/api", private: false, defaultBranch: "main", description: null },
      { fullName: "sample/private", private: true, defaultBranch: "main", description: null },
    ]);
    try {
      const s = await fixture(true, true, undefined, undefined, undefined, false, {}, true);
      await s.wiring.initialize();
      const context = await s.wiring.context(s.request(), s.credential);
      const req = s.request();
      req.url = "/home/session";
      req.method = "GET";
      let body = "";
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const res = {
        setHeader() {},
        writeHead() {},
        end(value: string) {
          body = value;
          finish();
        },
      } as unknown as ServerResponse;
      expect(s.wiring.current()!.handler(req, res, context!)).toBe(true);
      await done;
      expect(JSON.parse(body).repositories).toEqual({ status: "complete", repositories: [{ repo: "sample/api" }] });
    } finally {
      repos.mockRestore();
    }
  });

  async function accessOffer(command: "runs.stop" | "repo.offboard" = "runs.stop") {
    let currentPerson = "slack:UALICE",
      sessionValid = true,
      sessionUnavailable = false;
    const personByEmail = async () => ({ id: currentPerson, name: "Alice" });
    const identity: AccessIdentity = { sub: "opaque", email: "same-address@example.test" };
    const dashboard: DashboardVerifier = {
      mode: "access",
      describe: () => "fixture",
      verify: async () =>
        sessionUnavailable
          ? { ok: false, status: 503, body: "Source unavailable" }
          : sessionValid
            ? { ok: true, identity }
            : { ok: false, status: 403, body: "Session unavailable" },
    };
    const s = await fixture(true, true, undefined, undefined, dashboard, false, { personByEmail });
    await s.wiring.initialize();
    const home = await s.wiring.context(s.request(), s.credential);
    if (!home) throw new Error("Expected the verified browser owner");
    s.core.clock = () => 1000;
    const confirmations = new InMemoryConfirmationStore({ clock: () => 1000 });
    s.core.confirmations = confirmations;
    const executions: unknown[] = [];
    s.registry.create(
      "Original fixture review",
      {
        agent: "review",
        userId: "slack:UALICE",
        channelId: "slack:C1",
        threadKey: "slack:C1:original",
        channelVisibility: "public",
        repo: "sample/api",
      },
      { id: "original-review" },
    );
    const stopRun: typeof s.runs.stopRun = async (id, mode, actor, opts) => {
      executions.push({ id, mode, actor, opts });
      return { ok: true, value: { id, mode, state: "stopped" } };
    };
    const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
    registry.register(runsStop);
    registry.register({
      id: "repo.offboard",
      action: "repo:write",
      effect: "write",
      annotations: { destructive: true },
      describe: "Owned fixture action",
      handler: async () => {
        executions.push({ command: "repo.offboard" });
        return {};
      },
    });
    const commands = bindCommands(registry, { runs: async () => ({ ...s.runs, stopRun }) });
    s.core.commands = commands;
    const options = {
      auth: { tokens: {} },
      sso: dashboard,
      personByEmail,
      commands,
      approvalsEnabled: true,
      publicBaseUrl: "https://dashboard.fixture.test",
    };
    const rpc = (name: string, args: unknown) =>
      handleMcpRequest(
        {
          method: "POST",
          headers: { authorization: "Bearer fixture-access-session", origin: options.publicBaseUrl },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "offer-request",
            method: "tools/call",
            params: { name, arguments: args },
          }),
        },
        s.core,
        options,
      );
    const result = await rpc(
      command === "runs.stop" ? "runs_stop" : "repo_offboard",
      command === "runs.stop" ? { id: "original-review", mode: "hard" } : {},
    );
    expect(result.status).toBe(200);
    const saved = structuredClone([...confirmations.rows.values()][0]);
    if (!saved || saved.kind !== "run") throw new Error("Expected the direct registry offer");
    expect(saved).toMatchObject({
      kind: "run",
      command,
      message: {
        userId: "slack:UALICE",
        authenticatedAs: "access:opaque",
        approvalConnection: { credentialId: "access:opaque" },
      },
      caller: { kind: "access", id: "access:opaque" },
    });
    expect(saved.originalOrganization).toBeUndefined();
    expect(executions).toEqual([]);
    const file = ts.createSourceFile(
      "index.ts",
      readFileSync(new URL("../index.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(file) === "mcpApproval" &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
      ) {
        const options = node.initializer.arguments[1];
        if (options && ts.isObjectLiteralExpression(options))
          for (const property of options.properties)
            if (ts.isPropertyAssignment(property) && property.name.getText(file) === "resolveApprovalSource")
              expression = property.initializer;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!expression) throw new Error("Expected the production approval source binding");
    const actors = new WeakMap<object, Actor>();
    const code = ts.transpileModule(`const resolve = ${expression.getText(file)}; resolve`, {
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    }).outputText;
    const resolveApprovalSource = runInNewContext(code, { browserWiring: s.wiring, verifiedPageActors: actors }) as (
      identity: AccessIdentity,
      row: Confirmation,
    ) => Promise<import("../core/confirmations.js").ConfirmationSource | undefined>;
    const page = (action?: string, beforeBody?: () => void, browser = s.credential, viewer = home.actor) =>
      new Promise<{ status: number; text: string }>((resolve) => {
        let status = 0;
        actors.set(browser, viewer);
        async function* chunks() {
          beforeBody?.();
          if (action) yield Buffer.from(`action=${action}`);
        }
        const req = Object.assign(chunks(), {
          url: `/settings/approve?id=${saved.id}`,
          method: action ? "POST" : "GET",
          headers: {
            origin: options.publicBaseUrl,
            "sec-fetch-site": "same-origin",
            "content-type": "application/x-www-form-urlencoded",
          },
        });
        createMcpApprovalView(s.core, { ...options, resolveApprovalSource })(
          req as never,
          {
            writeHead: (value: number) => {
              status = value;
            },
            end: (text: string) => resolve({ status, text }),
          } as unknown as ServerResponse,
          browser,
          viewer,
        );
      });
    return {
      ...s,
      home,
      page,
      saved,
      confirmations,
      executions,
      rpc,
      revokeSession: () => {
        sessionValid = false;
      },
      sourceOutage: () => {
        sessionUnavailable = true;
      },
      changeRequester: () => {
        currentPerson = "slack:UBOB";
      },
    };
  }

  it("shows a direct Access MCP offer through the production browser source resolver without executing it", async () => {
    const s = await accessOffer();
    const shown = await s.page();
    expect({ status: shown.status, executions: s.executions.length }).toEqual({ status: 200, executions: 0 });
    expect(shown.text).toContain("Confirm saved action");
    expect(await s.confirmations.get(s.saved.id)).toEqual(s.saved);
    expect((await s.page("approve")).status).toBe(200);
    expect(await s.confirmations.get(s.saved.id)).toMatchObject({
      approvedBy: "browser",
      browserApproved: true,
      message: s.saved.message,
      input: s.saved.input,
      parsedInput: s.saved.kind === "run" ? s.saved.parsedInput : undefined,
    });
    expect(s.executions).toEqual([]);
    const resumed = await s.rpc("approval_resume", { id: s.saved.id });
    expect(resumed.body).not.toHaveProperty("error");
    expect(s.executions).toEqual([
      { id: "original-review", mode: "hard", actor: { kind: "access", id: "access:opaque" }, opts: undefined },
    ]);
    const repeated = await s.rpc("approval_resume", { id: s.saved.id });
    expect(repeated.body).toHaveProperty("error");
    expect(s.executions).toEqual([
      { id: "original-review", mode: "hard", actor: { kind: "access", id: "access:opaque" }, opts: undefined },
    ]);
  });

  it.each([
    "foreign-session",
    "changed-requester",
    "tampered-caller",
    "Person-view",
    "posted-by",
    "derived",
    "protected-source",
    "expired",
    "grant-loss",
    "revoked-session",
    "source-outage",
  ] as const)("holds a direct Access offer with %s without changing it or executing", async (cause) => {
    const s = await accessOffer(cause === "grant-loss" ? "repo.offboard" : "runs.stop");
    const row = s.confirmations.rows.get(s.saved.id)!;
    if (row.kind !== "run") throw new Error("Expected the original direct offer");
    let browser = s.credential,
      viewer = s.home.actor;
    if (cause === "foreign-session") browser = { ...browser, sub: "another" };
    if (cause === "changed-requester") s.changeRequester();
    if (cause === "tampered-caller") row.caller = { kind: "access", id: "access:another" };
    if (cause === "Person-view") viewer = { ...viewer, viewingAs: { id: "access:another" } };
    if (cause === "posted-by") row.message.postedBy = "app:another";
    if (cause === "derived")
      row.derivation = {
        kind: "operator",
        context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
      };
    if (cause === "protected-source")
      row.originalOrganization = { ingressRunId: "unproved-original", organizationSequence: 1 };
    if (cause === "expired") s.core.clock = () => s.saved.expiresAt;
    if (cause === "grant-loss") {
      const original = s.config.grantsFor.bind(s.config);
      vi.spyOn(s.config, "grantsFor").mockImplementation((id) => (id === "access:opaque" ? NO_GRANTS : original(id)));
    }
    if (cause === "revoked-session") s.revokeSession();
    if (cause === "source-outage") s.sourceOutage();
    const expected = structuredClone(row);
    const shown = await s.page(undefined, undefined, browser, viewer);
    expect(shown.status).toBe(
      cause === "expired" ? 410 : cause === "source-outage" ? 503 : cause === "grant-loss" ? 403 : 404,
    );
    expect(await s.confirmations.get(s.saved.id)).toEqual(expected);
    expect(s.executions).toEqual([]);
  });

  it.each(["session", "requester", "grants"] as const)("rechecks Access %s after the approval body", async (cause) => {
    const s = await accessOffer(cause === "grants" ? "repo.offboard" : "runs.stop");
    expect((await s.page()).status).toBe(200);
    const shown = await s.page("approve", () => {
      if (cause === "session") s.revokeSession();
      if (cause === "requester") s.changeRequester();
      if (cause === "grants") {
        const original = s.config.grantsFor.bind(s.config);
        vi.spyOn(s.config, "grantsFor").mockImplementation((id) => (id === "access:opaque" ? NO_GRANTS : original(id)));
      }
    });
    expect(shown.status).toBe(403);
    expect(await s.confirmations.get(s.saved.id)).toEqual(s.saved);
    expect(s.executions).toEqual([]);
  });

  it.each(["slack proof", "email lookup", "profile email"] as const)(
    "returns independently proved owners within 1500 ms when optional %s stalls",
    async (stalled) => {
      const pending = new Promise<never>(() => {});
      const diagnostics: { slackEmailLookup: string }[] = [];
      const s = await fixture(true, true, undefined, undefined, undefined, false, {
        personByEmail: () => (stalled === "email lookup" ? pending : Promise.resolve({ id: "slack:UALICE" })),
        emailOf: () => (stalled === "profile email" ? pending : Promise.resolve("same-address@example.test")),
        onWorkViewResolved: (diagnostic) => diagnostics.push(diagnostic),
      });
      await s.wiring.initialize();
      if (stalled === "slack proof") vi.spyOn(s.wiring.native()!, "currentSlack").mockReturnValue(pending);
      vi.useFakeTimers();
      try {
        let context: Awaited<ReturnType<typeof s.wiring.context>>;
        const read = s.wiring
          .context(s.request(stalled === "profile email" ? "sb-view-as=slack%3AUALICE" : ""), s.credential)
          .then((value) => {
            context = value;
          });
        await vi.advanceTimersByTimeAsync(1500);
        expect(context && workViewScopeOf(context.actor).ownerIds).toEqual([
          stalled === "profile email" ? "slack:UALICE" : "access:opaque",
        ]);
        expect(diagnostics.map((diagnostic) => diagnostic.slackEmailLookup)).toEqual(["timed_out"]);
        await read;
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("does not wait for optional Slack enrichment when All people is selected", async () => {
    const pending = new Promise<never>(() => {});
    const s = await fixture(true, true, undefined, undefined, undefined, false, { personByEmail: () => pending });
    await s.wiring.initialize();
    vi.useFakeTimers();
    try {
      let context: Awaited<ReturnType<typeof s.wiring.context>>;
      const read = s.wiring.context(s.request("sb-data-view=everyone"), s.credential).then((value) => {
        context = value;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(context && workViewScopeOf(context.actor)).toMatchObject({ mode: "everyone", canEveryone: true });
      await read;
    } finally {
      vi.useRealTimers();
    }
  });
  it("shares optional Slack verification across refreshes without mutating timed-out scopes", async () => {
    let now = 1000;
    const s = await fixture(true, true, undefined, undefined, undefined, false, {
      personByEmail: async () => ({ id: "slack:UALICE" }),
      now: () => now,
    });
    await s.wiring.initialize();
    const original = s.wiring.native()!.currentSlack;
    const good = await original({ issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" });
    let finish!: (value: typeof good) => void;
    const pending = new Promise<typeof good>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(s.wiring.native()!, "currentSlack").mockReturnValueOnce(pending).mockResolvedValue({ status: "fenced" });
    vi.useFakeTimers();
    try {
      const contexts: NonNullable<Awaited<ReturnType<typeof s.wiring.context>>>[] = [];
      const reads = [s.wiring.context(s.request(), s.credential), s.wiring.context(s.request(), s.credential)].map(
        (read) =>
          read.then((context) => {
            if (context) contexts.push(context);
          }),
      );
      await vi.advanceTimersByTimeAsync(1500);
      expect(contexts.map((context) => workViewScopeOf(context.actor).ownerIds)).toEqual([
        ["access:opaque"],
        ["access:opaque"],
      ]);
      await Promise.all(reads);
      finish(good);
      await vi.advanceTimersByTimeAsync(0);
      const refreshed = await s.wiring.current()!.host.refresh(contexts[0]);
      expect(workViewScopeOf(refreshed!.actor).ownerIds).toEqual(["access:opaque", "slack:UALICE"]);
      expect(contexts.map((context) => workViewScopeOf(context.actor).ownerIds)).toEqual([
        ["access:opaque"],
        ["access:opaque"],
      ]);
      expect(await s.wiring.owners(refreshed!)).toEqual(["access:opaque"]);
      now += 30_001;
      const expired = await s.wiring.context(s.request(), s.credential);
      expect(workViewScopeOf(expired!.actor).ownerIds).toEqual(["access:opaque"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("includes retained runs across email-matched browser, Slack and ingress identities in Mine", async () => {
    const diagnostics: unknown[] = [];
    const s = await fixture(true, true, undefined, undefined, undefined, false, {
      personByEmail: async (email) => (email === "same-address@example.test" ? { id: "slack:UALICE" } : undefined),
      emailOf: async (id) => (id === "slack:UALICE" ? "Same-Address@Example.Test" : undefined),
      onWorkViewResolved: (diagnostic) => diagnostics.push(diagnostic),
    });
    s.credential.email = " Same-Address@Example.Test ";
    s.ingressTokens["alice-token"] = { subject: "alice-device", email: "same-address@example.test" };
    s.ingressTokens["bob-token"] = { subject: "bob-device", email: "bob@example.test" };
    s.ingressTokens["ambiguous-a"] = { subject: "shared-device", email: "same-address@example.test" };
    s.ingressTokens["ambiguous-b"] = { subject: "shared-device", email: "bob@example.test" };
    await s.wiring.initialize();
    for (const [id, userId] of [
      ["browser", "access:opaque"],
      ["slack", "slack:UALICE"],
      ["http", "http:alice-device"],
      ["mcp", "mcp:alice-device"],
      ["bob", "slack:UBOB"],
      ["bob-device", "mcp:bob-device"],
      ["shared", "http:shared-device"],
    ]) {
      await s.runStore.put({
        id,
        userId,
        label: id,
        channelId: "slack:C1",
        threadKey: `slack:C1:${id}`,
        channelVisibility: "public",
        startedAt: 1,
        finishedAt: 2,
        status: "completed",
        eventCount: 0,
        storedEventCount: 0,
        truncated: false,
        events: [],
        diagnosis: analyzeRunFriction([]),
      });
    }
    const context = await s.wiring.context(s.request(), s.credential);
    if (!context) throw new Error("No authenticated browser context");
    const result = await s.runs.listRuns({ status: "all", visibleTo: readableRuns(context.actor) });
    expect(result.runs.map((run) => run.id).sort()).toEqual(["browser", "http", "mcp", "slack"]);
    expect(diagnostics[0]).toEqual({
      event: "dashboard.work_view.resolved",
      mode: "mine",
      slackEmailLookup: "matched",
      ownerCount: 4,
      allActions: true,
      allChannels: true,
      allRepositories: true,
      canViewEveryone: true,
    });
    let page: PageSeed | undefined;
    const handler = createLiveViewHandler({
      service: s.runs,
      index: s.registry,
      retention: null,
      page: (_req, _res, _code, _actor, _title, seed) => {
        page = seed;
      },
    });
    expect(
      handler(
        { ...s.request(), method: "GET", url: "/runs?all=1" } as IncomingMessage,
        { writeHead() {}, end() {} } as unknown as ServerResponse,
        { actor: context.actor },
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(page?.page).toBe("runs"));
    if (page?.page !== "runs") throw new Error("No run index seed");
    expect(page.rows.map((run) => run.id).sort()).toEqual(["browser", "http", "mcp", "slack"]);
    expect(context.actor.id).toBe("access:opaque");
    expect(context.actor.self).toEqual(["access:opaque"]);
    expect(await s.wiring.owners(context)).toEqual(["access:opaque"]);
    expect(context.authentication.sourceReference).toMatchObject({ actorId: "access:opaque", userId: "access:opaque" });
    const viewed = await s.wiring.context(s.request("sb-view-as=slack%3AUALICE"), s.credential);
    expect(workViewScopeOf(viewed!.actor).ownerIds).toEqual(["slack:UALICE", "http:alice-device", "mcp:alice-device"]);
    const refreshed = await s.wiring.current()!.host.refresh(context);
    expect(
      (await s.runs.listRuns({ status: "all", visibleTo: readableRuns(refreshed!.actor) })).runs
        .map((run) => run.id)
        .sort(),
    ).toEqual(["browser", "http", "mcp", "slack"]);
    s.credential.email = "other@example.test";
    const changed = await s.wiring.context(s.request(), s.credential);
    expect(workViewScopeOf(changed!.actor).ownerIds).toEqual(["access:opaque"]);
  });

  it("keeps unknown email matches unclaimed and never adds read permission or source authority", async () => {
    const diagnostics: { slackEmailLookup: string }[] = [];
    const lookup = vi.fn(async () => ({ id: "slack:UALICE" }));
    const s = await fixture(true, true, undefined, undefined, undefined, false, {
      personByEmail: lookup,
      onWorkViewResolved: (diagnostic) => diagnostics.push(diagnostic),
    });
    await s.wiring.initialize();
    const context = await s.wiring.context(s.request(), s.credential);
    const actor = withWorkViewScope(
      { ...context!.actor, grants: { ...NO_GRANTS, actions: new Set(["runs:read"]), repos: "all" } },
      workViewScopeOf(context!.actor),
    );
    const predicate = readableRuns(actor);
    expect(
      matchesPredicate(predicate, { userId: "slack:UALICE", channelId: "slack:C1", channelVisibility: "public" }),
    ).toBe(true);
    expect(
      matchesPredicate(predicate, {
        userId: "slack:UALICE",
        channelId: "slack:GPRIVATE",
        channelVisibility: "private",
      }),
    ).toBe(false);
    expect(workViewScopeOf(context!.actor).ownerIds).toEqual(["access:opaque", "slack:UALICE"]);
    lookup.mockRejectedValueOnce(new Error("directory unavailable"));
    const unavailable = await s.wiring.context(s.request(), s.credential);
    expect(workViewScopeOf(unavailable!.actor).ownerIds).toEqual(["access:opaque"]);
    delete s.credential.email;
    const missing = await s.wiring.context(s.request(), s.credential);
    expect(workViewScopeOf(missing!.actor).ownerIds).toEqual(["access:opaque"]);
    expect(diagnostics.map((diagnostic) => diagnostic.slackEmailLookup)).toEqual([
      "matched",
      "no_match_or_unavailable",
      "missing",
    ]);
  });
  it("keeps matched history available when the work-view diagnostic sink throws", async () => {
    const s = await fixture(true, true, undefined, undefined, undefined, false, {
      personByEmail: async () => ({ id: "slack:UALICE" }),
      onWorkViewResolved: () => {
        throw new Error("Private sink failure must not enter the response");
      },
    });
    await s.wiring.initialize();
    const context = await s.wiring.context(s.request(), s.credential);
    expect(workViewScopeOf(context!.actor).ownerIds).toEqual(["access:opaque", "slack:UALICE"]);
  });
  it.each(["allowed", "revoked", "queued"] as const)(
    "verifies native async output through authenticated original run readback without claiming null-channel delivery: %s",
    async (access) => {
      const s = await fixture(true, true, undefined, undefined, undefined, true);
      const calls: unknown[] = [];
      const provider = {
        name: "fixture",
        complete: async (request: import("../core/provider.js").CompletionRequest) => {
          calls.push(structuredClone(request));
          return {
            content: [{ type: "text" as const, text: "4" }],
            stopReason: "end_turn" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      vi.spyOn(s.core.completions, "get").mockReturnValue(provider);
      s.core.clock = () => 1000;
      s.core.build = { commit: "a".repeat(40), version: "fixture" };
      const harnesses = new HarnessRegistry();
      const bearers = new RunBearerStore({ clock: () => 1000 });
      s.core.runBearers = bearers;
      s.core.githubDoor = { baseUrl: "https://git.fixture.test" };
      s.core.githubBindings = new GitBindings();
      s.core.harness = {
        harnesses: { pi: new PiHarness(), opencode: new OpenCodeHarness() },
        registry: harnesses,
        harnessUrl: "https://bot.fixture.test",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => {
          const container = new FakeHarnessContainer();
          scriptPiFromProvider(container, { provider, registry: harnesses, bearers });
          return container;
        },
        pollMs: 1,
        tickMs: 5,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      };
      s.core.runLedger = createLedgerWriteThrough({
        ledger: s.ledger,
        gen: "native-answer",
        fallback: s.runStore,
        warn: () => {},
      });
      s.core.runHistoryWriter = createRunHistoryWriter({
        store: s.runStore,
        onPersisted: (id) => s.registry.markPersisted(id),
        warn: () => {},
        sleep: async () => {},
      });
      await s.wiring.initialize();
      const adapterIos: HttpIO[] = [];
      const registry = new CommandRegistry<RunsCommandDeps>();
      registerRunsCommands(registry);
      const commands = bindCommands(registry, { runs: async () => s.runs });
      const mcpReads: string[] = [];
      let queuedReady!: () => void;
      const queuedPage = new Promise<void>((resolve) => {
        queuedReady = resolve;
      });
      const smokeConfig = {
        model: "anthropic/claude-opus-4-6",
        disposable: true,
        channel: "default",
        subject: "bot",
        repo: "sample/api",
        workspace: { path: "SMOKE.md", answer: "fixture" },
        review: { number: 42, head: "b".repeat(40) },
        maxObservedUsd: 1,
      };
      const transport = agentSmokeTransport({
        origin: "https://bot.fixture.test",
        healthUrl: "https://bot.fixture.test/healthz",
        token: "native-token",
        config: smokeConfig,
        fetch: async (url, init) => {
          if (String(url).endsWith("/healthz")) return Response.json({ ok: true, build: s.core.build });
          const body = String(init?.body);
          if (String(url).endsWith("/ingress")) {
            if (JSON.parse(body).text.includes("agent:explore")) return Response.json({});
            const result = await handleIngressRequest(
              { method: "POST", headers: { authorization: "Bearer native-token" }, body },
              s.core,
              {
                auth: { tokens: { "native-token": { subject: "bot", channel: "default" } } },
                admit: (msg, io, evidence, continuation) => {
                  adapterIos.push(io as HttpIO);
                  return s.wiring.admit(msg, io, evidence, continuation);
                },
              },
            );
            expect(result.status).toBe(202);
            expect(s.tasks).toHaveLength(1);
            if (access !== "queued") {
              await s.tasks.shift()!();
              await s.core.runHistoryWriter.settled();
            }
            return Response.json(result.body, { status: result.status });
          }
          const message = JSON.parse(body);
          if (message.method === "tools/call") {
            mcpReads.push(message.params.name);
            if (access === "revoked" && message.params.name === "runs_get") {
              const original = s.core.config.grantsFor.bind(s.core.config);
              vi.spyOn(s.core.config, "grantsFor").mockImplementation((id) =>
                id === "mcp:bot" ? NO_GRANTS : original(id),
              );
            }
          }
          const result = await handleMcpRequest(
            { method: "POST", headers: { authorization: "Bearer native-token" }, body },
            s.core,
            { auth: { tokens: { "native-token": { subject: "bot", channel: "default" } } }, commands },
          );
          if (
            access === "queued" &&
            message.method === "tools/call" &&
            message.params.name === "runs_list" &&
            message.params.arguments.thread &&
            s.tasks.length
          ) {
            // Keep the first authorized page empty, then materialize the original owner.
            await s.tasks.shift()!();
            await s.core.runHistoryWriter.settled();
            vi.useFakeTimers();
            queuedReady();
          }
          return Response.json(result.body, { status: result.status });
        },
      });
      const smoke = () =>
        runAgentSmoke({
          config: smokeConfig,
          expectedCommit: "a".repeat(40),
          thread: "native-answer",
          transport,
        });
      const receipt =
        access === "queued"
          ? await (async () => {
              try {
                const pending = smoke();
                await queuedPage;
                await vi.runAllTimersAsync();
                return await pending;
              } finally {
                vi.useRealTimers();
              }
            })()
          : await smoke();
      const answer = receipt.scenarios[0]!;
      if (access === "revoked") {
        expect(answer).toMatchObject({
          outcome: "incomplete",
          reason: "run_record_unproven",
          admissionStatus: "accepted",
        });
        expect(answer.runId).toBeTruthy();
        expect(answer.outputReadback).toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(adapterIos).toHaveLength(1);
        return;
      }
      expect(answer).toMatchObject({
        outcome: "passed",
        reason: "accepted",
        admissionStatus: "accepted",
        outputReadback: {
          kind: "native-persisted-run",
          runId: answer.runId,
          receiptId: answer.receiptId,
          utf8Bytes: 1,
        },
      });
      expect(mcpReads).toContain("runs_list");
      expect(mcpReads).toContain("runs_get");
      expect(calls).toHaveLength(1);
      expect(adapterIos[0]!.collected()).toBe("");
      expect(await s.runStore.get(answer.runId!)).toMatchObject({
        id: answer.runId,
        organizationIngressRunId: answer.runId,
        userId: "http:bot",
        channelId: "http:default",
        status: "completed",
        replyOk: false,
        answerOutcome: { ending: "answered", output: "unknown" },
      });
      expect((answer.evidence!.record as { events: unknown[] }).events).toContainEqual(
        expect.objectContaining({ type: "answer", text: expect.stringContaining("4") }),
      );
      expect(await s.ledger.readIngressByRun(answer.runId!)).toMatchObject({
        status: "record",
        record: { runId: answer.runId, receiptId: answer.receiptId, status: "completed" },
      });
    },
  );
  it("keeps token private Home fenced and rechecks the original credential for later report reads", async () => {
    const dashboard = tokenVerifier({ token: "dashboard-fixture", env: "DASHBOARD_TOKEN", subject: "opaque" });
    const s = await fixture(true, false, undefined, undefined, dashboard);
    await s.wiring.initialize();
    const req = { ...s.request(), headers: { authorization: "Bearer dashboard-fixture" } } as IncomingMessage;
    const gate = await dashboard.verify(req);
    if (!gate.ok) throw new Error("valid fixture token was refused");
    const current = await s.wiring.currentTokenPageActor(req, gate.identity);
    expect(current).toMatchObject({ id: "access:opaque", kind: "service", self: ["access:opaque"] });
    expect(await s.wiring.context(req, gate.identity)).toBeUndefined();
    req.headers.authorization = "Bearer revoked";
    expect(await s.wiring.currentTokenPageActor(req, gate.identity)).toBeUndefined();
    req.headers.authorization = "Bearer dashboard-fixture";
    expect(await s.wiring.currentTokenPageActor(req, { sub: "another-caller" })).toBeUndefined();
    const access = await fixture();
    await access.wiring.initialize();
    expect(await access.wiring.context(access.request(), access.credential)).toMatchObject({
      actor: { id: "access:opaque" },
    });
    expect(access.wiring.tokenPageActor(access.credential)).toBeUndefined();
    expect(s.effects).toEqual([]);
    expect(s.tasks).toEqual([]);
  });
  it("serves the configured token caller's run page without inventing a private human Home source", async () => {
    const dashboard = tokenVerifier({ token: "dashboard-fixture", env: "DASHBOARD_TOKEN", subject: "opaque" });
    const s = await fixture(false, false, undefined, undefined, dashboard);
    const req = {
      ...s.request(),
      method: "GET",
      url: "/runs",
      headers: { authorization: "Bearer dashboard-fixture" },
    } as IncomingMessage;
    const gate = await dashboard.verify(req);
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error("valid fixture token was refused");
    const actor = s.wiring.tokenPageActor(gate.identity);
    expect(actor).toMatchObject({ id: "access:opaque", kind: "service", self: ["access:opaque"] });
    if (!actor) throw new Error("no token page actor");
    expect(workViewScopeOf(actor)).toEqual({ mode: "mine", ownerIds: ["access:opaque"], canEveryone: false });
    expect(await s.wiring.context(req, gate.identity)).toBeUndefined();
    const registry = s.core.runRegistry!;
    registry.create("my run", {
      userId: "access:opaque",
      channelId: "http:ops",
      threadKey: "http:ops:1",
      channelVisibility: "public",
    });
    registry.create("someone else's run", {
      userId: "slack:UALICE",
      channelId: "slack:PUBLIC",
      threadKey: "slack:PUBLIC:1",
      channelVisibility: "public",
    });
    let status = 0;
    let sent: PageSeed | undefined;
    const handler = createLiveViewHandler({
      service: createRunsService({ registry, store: null }),
      index: registry,
      retention: null,
      page: (_req, _res, code, _actor, _title, seed) => {
        status = code;
        sent = seed;
      },
    });
    const res = {
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end() {},
    } as unknown as ServerResponse;
    expect(handler(req, res, { actor })).toBe(true);
    await vi.waitFor(() => expect(status).toBe(200));
    expect(sent?.page).toBe("runs");
    if (sent?.page !== "runs") throw new Error("no run index seed");
    expect(sent.rows.map((row) => row.label)).toEqual(["my run"]);
    expect(await dashboard.verify({ headers: { authorization: "Bearer wrong" } })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(s.wiring.tokenPageActor({ sub: "", commonName: "service" })).toBeUndefined();
    expect(s.effects).toEqual([]);
    expect(s.tasks).toEqual([]);
  });
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
  it("seeds All people for a repository-limited operator without offering person impersonation", async () => {
    const diagnostics: unknown[] = [];
    const s = await fixture(true, true, undefined, undefined, undefined, false, {
      onWorkViewResolved: (diagnostic) => diagnostics.push(diagnostic),
    });
    const lookup = s.core.config.grantsFor.bind(s.core.config);
    s.core.config.grantsFor = (id) =>
      id === "access:opaque"
        ? { ...lookup(id), repos: new Set(["sample/api"]), repoAccess: new Set(["sample/api"]) }
        : lookup(id);
    await s.wiring.initialize();
    const context = await s.wiring.context(s.request("sb-data-view=everyone"), s.credential);
    s.wiring.page(s.request(), {} as ServerResponse, 200, context!.actor, "Run details", {
      page: "runs",
      all: true,
      mine: false,
      rows: [],
      now: 1000,
      retentionDays: 30,
    });
    expect(s.sent().dataView).toEqual({ mode: "everyone", canViewEveryone: true });
    expect(s.sent().viewAs).toBeUndefined();
    expect(context!.actor.grants.repos).toEqual(new Set(["sample/api"]));
    expect(diagnostics[0]).toEqual({
      event: "dashboard.work_view.resolved",
      mode: "everyone",
      slackEmailLookup: "not_needed",
      ownerCount: 1,
      allActions: true,
      allChannels: true,
      allRepositories: false,
      canViewEveryone: true,
    });
    const refreshed = await s.wiring.current()!.host.refresh(context!);
    expect(workViewScopeOf(refreshed!.actor)).toMatchObject({ mode: "everyone", canEveryone: true });
  });
});
