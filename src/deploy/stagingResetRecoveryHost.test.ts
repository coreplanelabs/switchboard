import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { profileSchema } from "./profile.js";
import { installationResetPlan, resetDigest } from "./installationReset.js";
import { resetHostingSettings } from "./resetCloudflare.js";
import { resetEndpointSettings } from "./resetHosting.js";
import { importCredentialKey, sealCredential } from "../mcp/sealed.js";
import { runStagingResetRecovery, type StagingResetRecoveryRequest } from "./stagingResetRecovery.js";
import { createStagingResetRecoveryIO } from "./stagingResetRecoveryHost.js";

const account = "a".repeat(32);
const source = "b".repeat(40);
const live = "c".repeat(40);
const tokenId = "d".repeat(32);
const operation = "11111111-1111-4111-8111-111111111111";
const recoveryId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture() {
  const profile = profileSchema.parse({
    account,
    zone: "staging.example.test",
    configSource: `github://example/infra/staging/config.yaml@${source}`,
    workers: Object.fromEntries(
      ["memory", "resident", "bot", "sandbox"].map((k) => [
        k,
        { script: `gateway-staging-${k}`, hostname: `${k}.staging.example.test` },
      ]),
    ),
    artifacts: { bucket: "gateway-staging-artifacts" },
  });
  const workers = Object.values(profile.workers);
  const secrets = {
    MEMORY_TOKEN: "private-memory-bearer",
    RESIDENT_ADMIN_TOKEN: "private-resident-bearer",
    SANDBOX_TOKEN: "private-sandbox-bearer",
    MCP_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
  const key = importCredentialKey(secrets.MCP_CREDENTIAL_KEY);
  const domains = workers.map((w) => ({
    hostname: w.hostname,
    service: w.script,
    zone_name: profile.zone,
    zone_id: "4".repeat(32),
    environment: "production",
    enabled: true,
    previews_enabled: false,
  }));
  const workerSettings = Object.fromEntries(workers.map((w) => [w.script, { bindings: [], usage_model: "standard" }]));
  const apps = ["bot", "resident", "sandbox"].map((k) => ({
    id: `old-${k}`,
    name: `gateway-staging-${k}-app`,
    configuration: { image: "old-image", memory_mib: 512 },
  }));
  const newApps = apps.map((a) => ({
    ...a,
    id: `new-${a.id}`,
    configuration: { ...a.configuration, image: "new-image" },
  }));
  const endpoints = Object.fromEntries(
    workers.map((w) => [
      w.script,
      {
        domains: domains.filter((d) => d.service === w.script),
        schedules: [],
        subdomain: { enabled: false, previews_enabled: false },
      },
    ]),
  );
  const episode = {
    id: episodeId,
    phase: "active",
    scopes: ["all"],
    reason: "Isolated staging reset validation",
    channel: "staging-reset-fixture",
    timing: "in a few minutes",
    actor: "reset-controller:operator",
    updatedAt: 1,
    notice: { status: "unverified" },
  };
  const settings = {
    schema: 1,
    config: {
      schema: 1,
      kind: "config",
      tables: {
        documents: [
          { key: "maintenance", version: 3, body: JSON.stringify({ episode }), updated_at: 1 },
          { key: "saved", version: 1, body: "private saved settings", updated_at: 1 },
        ],
        secrets: [],
        personal_tokens: [],
      },
    },
    installations: ["example"],
    organizations: [
      {
        schema: 1,
        kind: "organization",
        tables: {
          directory_people: [{ id: "private-person", created_at: 1 }],
          person_bindings: [],
          person_binding_receipts: [],
          organization_rows: [],
        },
      },
    ],
  };
  const repositories = { schema: 1, records: [{ resource: "repo:example/gateway", noResident: true }] };
  const oldNamespaces = [{ id: "5".repeat(32), script: profile.workers.memory!.script }];
  const native = {
    schema: 1 as const,
    account,
    deletions: apps.map((a) => ({
      kind: "application" as const,
      name: a.name,
      path: `/accounts/${account}/containers/applications/${a.id}`,
    })),
    evidence: { profile, source: { commit: "f".repeat(40) }, namespaces: oldNamespaces, applications: apps },
    sha256: "6".repeat(64),
  };
  const plan = installationResetPlan({
    native,
    settingsSha256: resetDigest({ settings, repositories }),
    hostingSha256: resetDigest({
      ...resetHostingSettings(workerSettings, apps),
      endpoints: resetEndpointSettings(endpoints),
    }),
    journalBucket: "gateway-staging-memory-reset-journal",
    buckets: [profile.artifacts!.bucket, `${profile.workers.resident!.script}-cache`].map((name) => ({
      name,
      objects: [{ key: "old-object", size: 1, etag: "original" }],
    })),
  });
  const request: StagingResetRecoveryRequest = {
    schema: 1,
    originalRun: 100,
    originalCommit: "f".repeat(40),
    operation,
    recoveryId,
    planSha256: plan.sha256,
    heldSequence: 26,
    maintenance: { id: episodeId, version: 3, actor: "reset-controller:operator" },
    profileRef: `github://example/infra/staging/profile.json@${source}`,
    liveCommit: live,
    credentialKind: "user",
    priorWrites: [
      {
        sequence: 1,
        phase: "verification-intent",
        outcome: "unknown",
        intentSha256: "7".repeat(64),
        response: { httpStatus: null, requestId: null },
      },
      {
        sequence: 2,
        phase: "original-intent-observed",
        outcome: "unknown",
        intentSha256: "8".repeat(64),
        response: { httpStatus: 403, requestId: "0123456789abcdef-SJC" },
      },
    ],
  };
  const prefix = `runs/100/${operation}`;
  const objects = new Map<string, string>();
  const seal = async (id: string, value: unknown) =>
    JSON.stringify(await sealCredential(key, id, JSON.stringify(value), 1)) + "\n";
  objects.set(
    "owner.sealed.json",
    await seal(`installation-reset:${account}:journal:${plan.journalBucket}`, {
      schema: 1,
      account,
      workers: workers.map((w) => w.script).sort(),
    }),
  );
  objects.set(
    `${prefix}/settings.sealed.json`,
    await seal(`installation-reset:${account}:${operation}:${plan.sha256}`, {
      operation,
      plan,
      settings,
      repositories,
      hosting: { settings: workerSettings, applications: apps, endpoints },
    }),
  );
  for (let i = 1; i <= 26; i++)
    objects.set(`${prefix}/journal/${String(i).padStart(8, "0")}.sealed.json`, "opaque original entry");
  objects.set(
    `${prefix}/journal/00000026.sealed.json`,
    await seal(`installation-reset:${account}:${operation}:${plan.sha256}:journal:26`, {
      entry: {
        operation,
        planSha256: plan.sha256,
        sequence: 26,
        phase: "held",
        resetOutcome: "unknown",
        maintenance: "retained",
        controller: { run: "100", commit: "f".repeat(40) },
      },
      journal: "private original journal",
    }),
  );
  const state = {
    phase: "restoring",
    maintenance: { version: 3, document: { episode } },
    settings: structuredClone(settings),
    tokenHttp: 200,
    unknownWork: 0,
    previewCommit: source,
    journalFailure: undefined as "absence" | "put" | "readback" | undefined,
    endBoundary: undefined as "read" | "write" | undefined,
    historyReads: 0,
    hideHistoryUntil: 0,
    incompleteHistoryUntil: 0,
    otherContinuation: false,
    clock: 1,
  };
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const page = (result: unknown) => Response.json({ success: true, result });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" && !url.pathname.includes("/objects/") ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.href, method, body });
    if (url.origin === "https://api.github.com") {
      if (url.pathname.endsWith("/actions/runs/100"))
        return Response.json({
          id: 100,
          path: ".github/workflows/deploy-staging.yml",
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "failure",
          head_sha: "f".repeat(40),
          run_attempt: 1,
          actor: { id: 42, login: "operator" },
        });
      if (url.pathname.endsWith("/actions/runs/199"))
        return Response.json({
          id: 199,
          head_sha: state.previewCommit,
          actor: { id: 42 },
          path: ".github/workflows/recover-staging-reset.yml",
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
          display_title: `staging reset recovery preview ${operation} ${recoveryId}`,
        });
      if (url.pathname.endsWith("/recover-staging-reset.yml/runs")) {
        state.historyReads++;
        const current =
          state.historyReads <= state.hideHistoryUntil
            ? []
            : [
                {
                  id: 200,
                  display_title: `staging reset recovery continue ${operation} ${recoveryId}`,
                  run_attempt: 1,
                },
              ];
        const other = state.otherContinuation
          ? [
              {
                id: 201,
                display_title: `staging reset recovery continue ${operation} 44444444-4444-4444-8444-444444444444`,
                run_attempt: 1,
              },
            ]
          : [];
        return Response.json({
          total_count: state.historyReads <= state.incompleteHistoryUntil ? 2 : current.length + other.length,
          workflow_runs: [...current, ...other],
        });
      }
    }
    if (url.origin === "https://api.cloudflare.com") {
      if (url.pathname.endsWith("/tokens/verify"))
        return state.tokenHttp === 200
          ? page({ id: tokenId, status: "active" })
          : Response.json(
              { errors: [{ message: "private provider body" }] },
              { status: state.tokenHttp, headers: { "cf-ray": "0123456789abcdef-SJC", "x-private": "private value" } },
            );
      if (url.pathname.includes(`/r2/buckets/${plan.journalBucket}`)) {
        const root = `/client/v4/accounts/${account}/r2/buckets/${plan.journalBucket}`;
        if (url.pathname === root) return page({ name: plan.journalBucket });
        if (url.pathname.endsWith("/domains/managed")) return page({ enabled: false });
        if (url.pathname.endsWith("/domains/custom")) return page({ domains: [] });
        if (url.pathname.endsWith("/lifecycle")) return page({ rules: [] });
        if (url.pathname.endsWith("/objects"))
          return page([...objects].map(([key, text]) => ({ key, size: Buffer.byteLength(text), etag: "saved" })));
        const name = url.pathname.slice(root.length + "/objects/".length);
        if (name.endsWith("03-verification-intent.sealed.json")) {
          const failure = new Response("private provider response", {
            status: 503,
            headers: { "cf-ray": "0123456789abcdef-SJC" },
          });
          if (
            (method === "PUT" && state.journalFailure === "put") ||
            (method === "GET" && state.journalFailure === "absence" && !objects.has(name)) ||
            (method === "GET" && state.journalFailure === "readback" && objects.has(name))
          )
            return failure;
        }
        if (method === "PUT") {
          objects.set(name, String(init?.body));
          return page({ key: name });
        }
        return objects.has(name) ? new Response(objects.get(name)) : new Response(null, { status: 404 });
      }
      if (url.pathname.includes("/r2/buckets/") && url.pathname.endsWith("/objects")) return page([]);
      if (url.pathname.endsWith("/workers/scripts")) return page(workers.map((w) => ({ id: w.script })));
      if (url.pathname.endsWith("/containers/applications")) return page(newApps);
      if (url.pathname.endsWith("/workers/durable_objects/namespaces")) return page([{ id: "9".repeat(32) }]);
      if (url.pathname.endsWith("/workflows")) return page([]);
      if (url.pathname.endsWith("/workers/domains")) return page(domains);
      if (url.pathname.endsWith("/workers/routes")) return page([]);
      if (url.pathname.includes("/workers/tails/by-consumer/")) return page([]);
      const worker = workers.find((w) => url.pathname.includes(`/workers/scripts/${w.script}/`));
      if (worker) {
        if (url.pathname.endsWith("/settings")) return page(workerSettings[worker.script]);
        if (url.pathname.endsWith("/references"))
          return page({ domains: domains.filter((d) => d.service === worker.script) });
        if (url.pathname.endsWith("/schedules")) return page({ schedules: [] });
        if (url.pathname.endsWith("/subdomain")) return page({ enabled: false, previews_enabled: false });
      }
    }
    const kind = Object.entries(profile.workers).find(([, w]) => url.hostname === w.hostname)?.[0];
    if (kind) {
      if (url.pathname === "/healthz")
        return Response.json({
          ok: true,
          build: { commit: live },
          ...(kind === "bot" ? { inFlight: 0, draining: false } : {}),
        });
      if (url.pathname === "/installation-reset/settings") {
        if (kind === "resident") return Response.json(repositories);
        if (body.action === "preview") return Response.json(state.settings);
        if (body.action === "verify") {
          sameBody(body, { action: "verify", operation, installations: ["example"] });
          state.phase = "verified";
        }
        return Response.json({
          schema: 1,
          config: { operation, phase: state.phase },
          organizations: [{ operation, phase: state.phase }],
          installations: ["example"],
        });
      }
      if (url.pathname === "/config/get") {
        if (
          state.endBoundary === "read" &&
          [...objects.keys()].some((k) => k.endsWith("05-maintenance-end-intent.sealed.json"))
        )
          return new Response("private provider response", {
            status: 503,
            headers: { "cf-ray": "0123456789abcdef-SJC" },
          });
        return Response.json(state.maintenance);
      }
      if (url.pathname === "/config/put") {
        if (state.endBoundary === "write")
          return new Response("private provider response", {
            status: 503,
            headers: { "cf-ray": "0123456789abcdef-SJC" },
          });
        sameBody(body.expectedVersion, 3);
        state.maintenance = { version: 4, document: body.document };
        state.settings.config.tables.documents[0] = {
          key: "maintenance",
          version: 4,
          body: JSON.stringify(body.document),
          updated_at: 2,
        };
        return Response.json({ ok: true, version: 4 });
      }
      if (url.pathname === "/runs/live" || url.pathname === "/runs/list") {
        sameBody(body.storeKey, "runs:default");
        return Response.json(url.pathname.endsWith("live") ? { runs: [] } : { items: [] });
      }
      if (url.pathname === "/residents")
        return Response.json({
          count: 0,
          residents: [],
          inFlight: 0,
          inFlightUnknown: state.unknownWork,
          reservedCount: 0,
          pendingReplicas: 0,
          draining: null,
          stagingMaintenance: null,
        });
      if (url.pathname === "/deploy-admissions") return Response.json({ admissions: [] });
    }
    throw new Error(`unexpected fixture request ${method} ${url.origin}${url.pathname}`);
  };
  const makeIO = (previewText?: string) =>
    createStagingResetRecoveryIO({
      request,
      profile,
      repository: "example/gateway",
      stagingAccount: account,
      productionAccount: "8".repeat(32),
      cloudflareToken: "private-cloudflare-bearer",
      githubToken: "private-github-bearer",
      secrets,
      previewText,
      receipt: () => {},
      fetch: fetcher,
      now: () => state.clock,
      sleep: async (ms: number) => {
        state.clock += ms;
      },
    });
  const context = (mode: string) => ({
    mode,
    repository: "example/gateway",
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    workflowRef: "example/gateway/.github/workflows/recover-staging-reset.yml@refs/heads/main",
    workflowSha: source,
    checkoutSha: source,
    clean: true,
    runId: mode === "preview" ? 199 : 200,
    runAttempt: 1,
    actorId: 42,
    actor: "operator",
    stagingAccount: account,
    productionAccount: "8".repeat(32),
    recoveryId,
    operation,
    configRepository: "example/infra",
  });
  return { request, calls, state, objects, makeIO, context };
}
function sameBody(actual: unknown, expected: unknown) {
  expect(actual).toEqual(expected);
}

describe("staging reset recovery native boundary", () => {
  it("keeps credentials on the serialized manual staging controller and uploads only the bounded receipt", () => {
    const workflow = parseYaml(
      readFileSync(new URL("../../.github/workflows/recover-staging-reset.yml", import.meta.url), "utf8"),
    );
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
    const job = workflow.jobs.recover;
    expect(job.environment).toBe("staging");
    expect(job.if).toBe(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.run_attempt == 1",
    );
    expect(job.concurrency).toEqual({ group: "deploy-staging", queue: "max", "cancel-in-progress": false });
    const configurationApp = job.steps.find((step: any) => step.uses?.startsWith("actions/create-github-app-token@"));
    expect([configurationApp.with["client-id"], configurationApp.with["private-key"]]).toEqual([
      "${{ secrets.STAGING_CONFIG_REPO_APP_CLIENT_ID }}",
      "${{ secrets.STAGING_CONFIG_REPO_APP_PRIVATE_KEY }}",
    ]);
    const credentialSteps = job.steps.filter((step: any) => step.env?.CLOUDFLARE_API_TOKEN);
    expect(
      credentialSteps.map((step: any) => ({
        token: step.env.CLOUDFLARE_API_TOKEN,
        command: step.run.split("\n").find((line: string) => line.includes("npm run")),
      })),
    ).toEqual([
      {
        token: "${{ secrets.STAGING_CLOUDFLARE_DEPLOY_TOKEN }}",
        command: 'npm run --silent staging:recover -- "${args[@]}"',
      },
    ]);
    expect(job.steps.at(-1).with.path).toBe("${{ runner.temp }}/staging-reset-recovery/receipt.json");
  });
  it("previews authenticated original custody and canonical run state without native or service writes", async () => {
    const f = await fixture();
    const preview = await runStagingResetRecovery(f.request, f.context("preview"), f.makeIO());
    expect(preview).toMatchObject({
      outcome: "previewed",
      token: { id: tokenId },
      evidence: { originalNativeIdsAndKeysAbsent: true, resetPhase: "restoring", idleBeforeAccess: true },
    });
    expect(
      f.calls.filter((c) => c.method !== "GET").map((c) => [new URL(c.url).pathname, c.body?.action ?? "read"]),
    ).toEqual([
      ["/installation-reset/settings", "preview"],
      ["/installation-reset/settings", "preview"],
      ["/installation-reset/settings", "status"],
      ["/config/get", "read"],
      ["/runs/live", "read"],
      ["/runs/list", "read"],
    ]);
    expect(JSON.stringify(preview)).not.toMatch(/private|bearer|personal_tokens|directory_people/);
    expect(f.state.maintenance).toMatchObject({ version: 3, document: { episode: { phase: "active" } } });
  });
  it("continues through the real journal and maintenance boundaries without reset or deployment", async () => {
    const f = await fixture();
    const preview = await runStagingResetRecovery(f.request, f.context("preview"), f.makeIO());
    const text = JSON.stringify(preview);
    f.request.expectedTokenId = tokenId;
    f.request.preview = { run: 199, sha256: hash(text) };
    const result = await runStagingResetRecovery(f.request, f.context("continue"), f.makeIO(text));
    expect(result).toMatchObject({
      outcome: "recovered",
      originalWorkflowOutcome: "failed",
      originalRestartOutcome: "unknown",
      priorWriteOutcomes: ["unknown", "unknown"],
      qualification: "unproved",
    });
    expect(f.calls.filter((c) => c.method === "PUT").map((c) => new URL(c.url).pathname.split("/").at(-1))).toEqual([
      "03-verification-intent.sealed.json",
      "04-verification-observed.sealed.json",
      "05-maintenance-end-intent.sealed.json",
      "06-recovery-observed.sealed.json",
    ]);
    expect(f.calls.filter((c) => c.method === "POST" && c.body?.action === "verify")).toHaveLength(1);
    expect(f.state.maintenance).toMatchObject({ version: 4, document: { episode: { id: episodeId, phase: "ended" } } });
    expect(
      f.calls.some(
        (c) =>
          c.method === "DELETE" ||
          (c.method !== "GET" && /ingress|restart|deploy|register/.test(new URL(c.url).pathname)),
      ),
    ).toBe(false);
  });
  it.each(["absence", "put", "readback"] as const)(
    "identifies the exact journal %s failure and never advances or repeats",
    async (boundary) => {
      const f = await fixture();
      const preview = await runStagingResetRecovery(f.request, f.context("preview"), f.makeIO());
      const text = JSON.stringify(preview);
      f.request.expectedTokenId = tokenId;
      f.request.preview = { run: 199, sha256: hash(text) };
      f.state.journalFailure = boundary;
      await expect(runStagingResetRecovery(f.request, f.context("continue"), f.makeIO(text))).rejects.toMatchObject({
        diagnostic: {
          stage: `journal-${boundary}`,
          httpStatus: 503,
          requestId: "0123456789abcdef-SJC",
          keySha256: hash(`runs/100/${operation}/recovery/${recoveryId}/03-verification-intent.sealed.json`),
        },
      });
      expect(f.state.phase).toBe("restoring");
      expect(f.state.maintenance.version).toBe(3);
      expect(f.calls.filter((c) => c.method === "PUT")).toHaveLength(boundary === "absence" ? 0 : 1);
    },
  );
  it.each(["read", "write"] as const)(
    "distinguishes a maintenance-end %s failure from the other boundary",
    async (boundary) => {
      const f = await fixture();
      const preview = await runStagingResetRecovery(f.request, f.context("preview"), f.makeIO());
      const text = JSON.stringify(preview);
      f.request.expectedTokenId = tokenId;
      f.request.preview = { run: 199, sha256: hash(text) };
      f.state.endBoundary = boundary;
      await expect(runStagingResetRecovery(f.request, f.context("continue"), f.makeIO(text))).rejects.toMatchObject({
        diagnostic: { stage: `maintenance-end-${boundary}`, httpStatus: 503, requestId: "0123456789abcdef-SJC" },
      });
      expect(f.state.phase).toBe("verified");
      expect(f.state.maintenance.version).toBe(3);
      expect(f.calls.filter((c) => new URL(c.url).pathname === "/config/put")).toHaveLength(
        boundary === "read" ? 0 : 1,
      );
    },
  );
  it("waits for a delayed current run and two complete stable histories before writing", async () => {
    const f = await fixture();
    const preview = await runStagingResetRecovery(f.request, f.context("preview"), f.makeIO());
    const text = JSON.stringify(preview);
    f.request.expectedTokenId = tokenId;
    f.request.preview = { run: 199, sha256: hash(text) };
    f.state.hideHistoryUntil = 1;
    await expect(runStagingResetRecovery(f.request, f.context("continue"), f.makeIO(text))).resolves.toMatchObject({
      outcome: "recovered",
    });
    expect(f.state.historyReads).toBe(3);
    expect(f.calls.filter((c) => c.method === "PUT")).toHaveLength(4);
  });
  it("retries an incomplete history without weakening duplicate detection", async () => {
    const f = await fixture();
    f.state.incompleteHistoryUntil = 1;
    await expect(f.makeIO().history(200)).resolves.toEqual([
      { id: 200, display_title: `staging reset recovery continue ${operation} ${recoveryId}`, run_attempt: 1 },
    ]);
    expect(f.state.historyReads).toBe(3);
    const duplicate = await fixture();
    duplicate.state.hideHistoryUntil = 1;
    duplicate.state.otherContinuation = true;
    await expect(duplicate.makeIO().history(200)).rejects.toThrow("already requested");
    expect(duplicate.state.historyReads).toBe(1);
  });
  it("bounds an absent-history wait without a journal or service write", async () => {
    const f = await fixture();
    f.state.hideHistoryUntil = 1000;
    await expect(f.makeIO().history(200)).rejects.toThrow("did not stabilize");
    expect(f.state.clock).toBeGreaterThan(1);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(f.state.maintenance.version).toBe(3);
  });
  it("retains a denied identity response and never switches identity endpoints", async () => {
    const f = await fixture();
    f.state.tokenHttp = 403;
    await expect(runStagingResetRecovery(f.request, f.context("preview"), f.makeIO())).rejects.toMatchObject({
      diagnostic: { stage: "token-identity", httpStatus: 403, requestId: "0123456789abcdef-SJC" },
    });
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/client/v4/user/tokens/verify"]);
    expect(f.state.maintenance.version).toBe(3);
  });
  it("refuses a preview artifact whose GitHub source differs from its claimed controller", async () => {
    const f = await fixture();
    const preview = await runStagingResetRecovery(f.request, f.context("preview"), f.makeIO());
    const text = JSON.stringify(preview);
    f.request.expectedTokenId = tokenId;
    f.request.preview = { run: 199, sha256: hash(text) };
    f.state.previewCommit = "e".repeat(40);
    await expect(runStagingResetRecovery(f.request, f.context("continue"), f.makeIO(text))).rejects.toThrow(
      "artifact metadata differs",
    );
    expect(f.calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect(f.state.phase).toBe("restoring");
  });
  it("holds uncertain native work before the first encrypted recovery intent", async () => {
    const f = await fixture();
    f.state.unknownWork = 1;
    await expect(runStagingResetRecovery(f.request, f.context("preview"), f.makeIO())).rejects.toThrow(
      "absent active and uncertain work",
    );
    expect([...f.objects.keys()].filter((k) => k.includes("/recovery/"))).toEqual([]);
    expect(f.state.phase).toBe("restoring");
  });
});
