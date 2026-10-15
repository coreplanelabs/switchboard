import { residentAddress } from "../../src/execution/residentMembers";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { sanitizeResidentBody } from "../../src/execution/residentText.js";
import { admissionRecordHash, recoveryEvidenceUrl, recoveryQuote, recoveryViewsAreIdle } from "./admissionRecovery";
import {
  DRAIN_DEFAULT_MINUTES,
  DRAIN_MAX_MINUTES,
  HOLD_CYCLE_BOUND_MINUTES,
  deployFenceReady,
  drainRefusal,
  holdDrain,
  liftDrain,
  liveDrain,
  parseDrainRequest,
  postUploadVersion,
  reportImageCurrent,
  staleHolds,
} from "./drain";
import { DRAIN } from "../../src/core/budgets";
import { methodOf, readSource } from "./testing/sourceScan";
import { TEST_MAINTENANCE } from "../../src/deploy/testing/profile.js";
import { buildId, resolveBuildStamp, type BuildStamp } from "../../src/deploy/buildStamp.js";
import { buildStamp } from "../bin/build-stamp.mjs";
import {
  deployObligations,
  liveMaintenanceWindow,
  maintenanceRecordSchema,
  releaseWindowSchema,
  stagingMaintenanceSchema,
  stagingAttemptSchema,
  selectedStagingAttempt,
  stagingAttemptMatches,
  abandonmentAuditSchema,
  type StagingMaintenancePolicy,
  residentImageTargetSchema,
} from "./admissionRisk.js";

describe("global deploy admission evidence", () => {
  function fixture(
    options: { stamp?: BuildStamp; policy?: StagingMaintenancePolicy; rows?: Map<string, unknown> } = {},
  ) {
    const source = readSource("worker.ts");
    const registry = source.slice(
      source.indexOf("export class ResidentRegistryDO"),
      source.indexOf("export class ResidentDO"),
    );
    const ast = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true);
    const helpers = ast.statements
      .filter(
        (node) =>
          ts.isFunctionDeclaration(node) &&
          [
            "deployAdmissionOrigin",
            "emitDeployAdmission",
            "workerVersionId",
            "validDeployAdmissionIdentity",
            "validDeployReleaseReceipts",
            "beginTrackedDeployAdmission",
            "endTrackedDeployAdmission",
            "workerVersionTimestamp",
            "handleDeployFence",
            "handleRecoverAdmission",
            "handleStagingAbandonment",
            "handleStagingMaintenanceRelease",
            "handleDeployAdmissions",
            "handleDrain",
            "handleReconcile",
            "bearerToken",
            "timingSafeEqual",
            "tokenScope",
            "hasScope",
            "json",
          ].includes(node.name?.text ?? ""),
      )
      .map((node) => node.getText(ast));
    const routeDeclaration = ast.statements.find(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === "ROUTES"),
    )!;
    const workerExport = ast.statements.find(ts.isExportAssignment)!;
    let workerObject = workerExport.expression;
    while (
      ts.isSatisfiesExpression(workerObject) ||
      ts.isAsExpression(workerObject) ||
      ts.isParenthesizedExpression(workerObject)
    )
      workerObject = workerObject.expression;
    const fetchMethod = (workerObject as ts.ObjectLiteralExpression).properties.find(
      (node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === "fetch",
    )!;
    const methods = [
      "constructor",
      "initializeStagingMaintenance",
      "abandonStagingAdmission",
      "readStagingAbandonmentReceipt",
      "getStagingMaintenance",
      "getDeployObligations",
      "getStagingMaintenanceReadback",
      "releaseStagingMaintenance",
      "readStagingReleaseReceipt",
      "sealStagingWindow",
      "setDrain",
      "clearDrain",
      "reportContainerImageCurrent",
      "alarm",
      "beginDeployAdmission",
      "beginDeployReconcileAdmission",
      "endDeployAdmission",
      "readDeployAdmissionReceipt",
      "listDeployAdmissions",
      "getDeployAdmissionReadback",
      "recordDeployAdmissionResource",
      "verifyDeployFence",
      "activeDeployAdmissions",
      "setDeployFence",
      "clearDeployFence",
      "recoverDeployAdmission",
      "recoverQuotedDeployAdmission",
      "getDeployAdmissionRecoveryQuote",
      "readDeployAdmissionRecoveryReceipt",
    ]
      .map((name) => methodOf(registry, name) ?? "")
      .join("\n");
    const buildDeclarations = ast.statements
      .filter(
        (node) =>
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((declaration) =>
            ["BUILD", "BUILD_ID"].includes(declaration.name.getText(ast)),
          ),
      )
      .map((node) => node.getText(ast));
    const compiled = ts.transpileModule(
      buildDeclarations.join("\n") +
        "\n" +
        helpers.join("\n") +
        "\n" +
        routeDeclaration.getText(ast) +
        `\nconst Worker = { ${fetchMethod.getText(ast)} };` +
        `\nclass Registry extends DurableObject { ${methods} } class Resident { ${methodOf(source.slice(source.indexOf("export class ResidentDO")), "withDeployAdmission")} }`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText;
    const rows = options.rows ?? new Map<string, unknown>();
    const stamp = options.stamp ?? resolveBuildStamp("a".repeat(40), undefined);
    let initialization = Promise.resolve();
    const events: Array<Record<string, unknown>> = [];
    let now = 1000,
      failDelete = false,
      loseDeleteAck = false,
      failOrigin = false,
      loseRecoveryAck = false,
      failAuditWrite = false;
    let onRecoveryProbe = () => {};
    let recoveryView = { state: "warm", executingRuns: 0, unknownRuns: 0 };
    const storage = {
      setAlarm: async (_at: number) => {},
      get: async (key: string) => rows.get(key),
      put: async (key: string, value: unknown) => {
        if (failOrigin) throw new Error("private-origin-error");
        if (failAuditWrite && key.startsWith("deploy:recovered:")) throw new Error("audit-write-failed");
        rows.set(key, value);
      },
      delete: async (key: string) => {
        if (failDelete) throw new Error("private-delete-error");
        const deleted = rows.delete(key);

        return deleted;
      },
      list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
      transaction: async <T>(fn: (store: unknown) => Promise<T>): Promise<T> => {
        const before = new Map(rows);
        let value: T;
        try {
          value = await fn(storage);
        } catch (error) {
          rows.clear();
          for (const [key, row] of before) rows.set(key, row);
          throw error;
        }
        if (loseDeleteAck) {
          loseDeleteAck = false;
          throw new Error("private-delete-ack-error");
        }
        if (loseRecoveryAck && [...rows.keys()].some((key) => key.startsWith("deploy:recovered:"))) {
          loseRecoveryAck = false;
          throw new Error("lost-recovery-commit-reply");
        }
        return value;
      },
    };
    const {
      Registry,
      Resident,
      beginTracked,
      endTracked,
      fenceHandler,
      recoveryHandler,
      inventoryHandler,
      Worker,
      routes,
    } = runInNewContext(
      compiled +
        "\n({Registry, Resident, Worker, routes: ROUTES, beginTracked: typeof beginTrackedDeployAdmission === 'function' ? beginTrackedDeployAdmission : null, endTracked: typeof endTrackedDeployAdmission === 'function' ? endTrackedDeployAdmission : null, fenceHandler: handleDeployFence, recoveryHandler: handleRecoverAdmission, inventoryHandler: handleDeployAdmissions})",
      {
        crypto: webcrypto,
        Response,
        Request,
        URL,
        sanitizeResidentBody,
        residentAddress,
        DurableObject: class {
          constructor(
            public ctx: unknown,
            public env: unknown,
          ) {}
        },
        injectedBuildStamp: () => stamp,
        buildId,
        registryStub: () =>
          new Proxy(api, {
            get: (target, key) =>
              typeof target[key] === "function"
                ? (...args: unknown[]) => initialization.then(() => target[key](...args))
                : target[key],
          }),
        residentStub: () => ({
          getResidentDeployInfo: async () => recoveryView,
          reconcileForDeploy: async () => ({ result: "current", verified: true }),
          getResidentRecoveryProbe: async () => {
            onRecoveryProbe();
            return { activeProcesses: 0 };
          },
        }),
        TextEncoder,
        Uint8Array,
        systemClock: () => now,
        liveDrain,
        postUploadVersion,
        deployFenceReady,
        parseDrainRequest,
        residentPoolOf: () => null,
        recoveryEvidenceUrl,
        recoveryViewsAreIdle,
        admissionRecordHash,
        deployObligations,
        liveMaintenanceWindow,
        maintenanceRecordSchema,
        releaseWindowSchema,
        stagingMaintenanceSchema,
        stagingAttemptSchema,
        residentImageTargetSchema,
        selectedStagingAttempt,
        stagingAttemptMatches,
        liftDrain,
        reportImageCurrent,
        staleHolds,
        abandonmentAuditSchema,
        recoveryQuote,
        STREAMED_ROUTES: new Set(),
        tracer: {},
        traceSinks: [],
        startAdoptedRoot: () => ({ end: () => {} }),
        catchAllErr: () => ({ error: "request failed" }),
        DRAIN_KEY: "drain",
        DEPLOY_ADMISSION_KEY_PREFIX: "deploy:admission:",
        RESOURCE_KEY: "resource",
        DEPLOY_RELEASE_RECEIPTS_KEY: "deploy:release-receipts",
        DEPLOY_RECOVERY_KEY_PREFIX: "deploy:recovered:",
        STAGING_MAINTENANCE_KEY: "deploy:staging-maintenance",
        STAGING_WINDOW_KEY: "deploy:staging-window",
        DEPLOY_ABANDONED_KEY_PREFIX: "deploy:abandoned:",
        console: {
          log: (line: string) => {
            if (line.startsWith("[resident-deploy-admission] "))
              events.push(JSON.parse(line.slice("[resident-deploy-admission] ".length)));
          },
        },
      },
    );
    const env = {
      CLOUDFLARE_ACCOUNT_ID: TEST_MAINTENANCE.stagingAccount,
      RESIDENT_SCRIPT_NAME: TEST_MAINTENANCE.residentScript,
      ...(options.policy ? { RESIDENT_MAINTENANCE_POLICY: JSON.stringify(options.policy) } : {}),
    };
    const api = new Registry(
      {
        storage,
        blockConcurrencyWhile: (work: () => Promise<void>) => {
          initialization = work();
          void initialization.catch(() => {});
          return initialization;
        },
      },
      env,
    );
    api.pushDrainPost = async () => {};
    api.getDrainOutbox = async () => null;
    api.list = async () => [{ resource: "repo:acme/api" }];
    api.listRepositories = api.list;
    let recoveryMutations = 0;
    const recoverOriginal = api.recoverQuotedDeployAdmission.bind(api);
    api.recoverQuotedDeployAdmission = (...args: unknown[]) => {
      recoveryMutations++;
      return recoverOriginal(...args);
    };
    return {
      api,
      boot: () => initialization,
      http: (
        method: string,
        path: string,
        body?: Record<string, unknown>,
        version = "00000000-0000-4000-8000-000000000002",
      ) =>
        Worker.fetch(
          new Request(`https://example.com${path}`, {
            method,
            headers: { authorization: "Bearer admin-fixture", "content-type": "application/json" },
            ...(body
              ? {
                  body: JSON.stringify({
                    ...(path === "/reconcile"
                      ? {
                          imageTarget: {
                            application: `${env.RESIDENT_SCRIPT_NAME}-residentdo`,
                            version: 1,
                            image: "registry.example.test/resident:one",
                          },
                        }
                      : {}),
                    ...body,
                  }),
                }
              : {}),
          }),
          {
            ...env,
            CF_VERSION_METADATA: { id: version, timestamp: "1970-01-01T00:00:02.000Z" },
            RESIDENT_ADMIN_TOKEN: "admin-fixture",
            RESIDENT_READ_TOKEN: "read-fixture",
            RESIDENT_DRAIN_TOKEN: "drain-fixture",
          },
        ),
      inventory: (id?: string) =>
        inventoryHandler({}, new URL(`https://example.com/deploy-admissions${id ? `?id=${id}` : ""}`)),
      recoveryMutations: () => recoveryMutations,
      failAuditWrite: () => {
        failAuditWrite = true;
      },
      setRecoveryView: (view: typeof recoveryView) => {
        recoveryView = view;
      },
      recover: async (
        body: Record<string, unknown>,
        probe = () => {},
        http?: { path: string; token?: string; olderRoutes?: boolean },
      ) => {
        onRecoveryProbe = probe;
        rows.set("drain", {
          since: "1970-01-01T00:00:00.000Z",
          until: "1970-01-01T01:00:00.000Z",
          by: "deploy",
          reason: "release",
        });
        const env = {
          CF_VERSION_METADATA: { id: "00000000-0000-4000-8000-000000000002" },
          RESIDENT_ADMIN_TOKEN: "admin-fixture",
          RESIDENT_READ_TOKEN: "read-fixture",
          RESIDENT_OPERATOR_TOKEN: "operator-fixture",
          RESIDENT_DRAIN_TOKEN: "drain-fixture",
        };
        if (http) {
          if (http.olderRoutes) delete routes["/recover-quoted-admission"];
          return Worker.fetch(
            new Request(`https://example.com${http.path}`, {
              method: "POST",
              headers: { authorization: `Bearer ${http.token ?? "admin-fixture"}`, "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
            env,
          );
        }
        return recoveryHandler(env, body);
      },
      loseRecoveryAck: () => {
        loseRecoveryAck = true;
      },
      fence: async (failRead = false) => {
        rows.set("drain", {
          since: "1970-01-01T00:00:00.000Z",
          until: "1970-01-01T01:00:00.000Z",
          by: "deploy",
          reason: "release",
        });
        if (failRead)
          api.getDeployAdmissionReadback = async () => {
            throw new Error("private-read-error");
          };
        return (
          await fenceHandler({
            CF_VERSION_METADATA: { id: "00000000-0000-4000-8000-000000000002", timestamp: "1970-01-01T00:00:00.000Z" },
          })
        ).json();
      },
      beginTracked: (store: unknown = api) => beginTracked(store, origin),
      beginReconcile: (store: unknown = api) =>
        beginTracked(store, origin, { versionId: origin.workerVersion, versionTimestamp: "1970-01-01T00:00:02.000Z" }),
      endTracked: (store: unknown, identity: unknown) => endTracked(store, identity),
      resident: (failure: "read" | "rpc" | "begin-reply" | "end-reply") => {
        const instance = new Resident();
        instance.env = {};
        instance.ctx = {
          storage: {
            get: async () => {
              if (failure === "read") throw new Error("private-read-error");
              return "repo:acme/api";
            },
          },
        };
        instance.registry = () => ({
          beginDeployAdmission: async (origin: unknown, identity?: unknown) => {
            const id = await api.beginDeployAdmission(origin, identity);
            if (failure === "begin-reply") throw new Error("lost-begin-reply");
            return id;
          },
          endDeployAdmission: async (id: string, hash?: string) => {
            await api.endDeployAdmission(id, hash);
            if (failure === "end-reply") throw new Error("lost-end-reply");
          },
          readDeployAdmissionReceipt: (identity: unknown) => api.readDeployAdmissionReceipt(identity),
          recordDeployAdmissionResource: async () => {
            throw new Error("private-rpc-error");
          },
        });
        return instance;
      },
      rows,
      events,
      advance: () => {
        now = 2000;
      },
      failDelete: () => {
        failDelete = true;
      },
      loseDeleteAck: () => {
        loseDeleteAck = true;
      },
      failOrigin: () => {
        failOrigin = true;
      },
    };
  }
  const origin = {
    kind: "watchdog",
    component: "scheduler",
    build: "a".repeat(40),
    workerVersion: "00000000-0000-4000-8000-000000000001",
    traceId: "b".repeat(32),
  };

  const identity = { id: "00000000-0000-4000-8000-000000000011", requestHash: "c".repeat(64) };
  const recoveryRequest = {
    id: "00000000-0000-4000-8000-000000000012",
    evidence: "https://example.com/receipts/original-request-ended",
    expectedStartedAt: 1000,
    expectedRecordSha256: "a81747d391ba39d7ed7e15e4b633483a6104f8c6f9318d5548a2589a3f22ab6a",
  };

  it("starts a stamped Registry and completes selected claim, reconciliation and release without changing source authority", async () => {
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 3_600_000 } };
    const h = fixture({
      stamp: buildStamp({ commit: "a".repeat(40), dirty: false, now: new Date("2026-10-15T00:00:00.000Z") }),
      policy,
    });
    const held = await h.http("GET", "/staging-maintenance");
    expect(held.status).toBe(200);
    expect(await held.json()).toMatchObject({ maintenance: { state: "held", generation: 1, window: null } });
    h.rows.set(`deploy:admission:${recoveryRequest.id}`, { startedAt: 1000, kind: "watchdog" });
    const quote = await h.http("GET", `/deploy-admissions?id=${recoveryRequest.id}`);
    expect(await quote.json()).toEqual({
      admission: { id: recoveryRequest.id, startedAt: 1000, recordSha256: recoveryRequest.expectedRecordSha256 },
    });
    const attempt = { ...policy.attempt, holdId: policy.holdId, generation: 1 };
    expect((await h.http("POST", "/drain", { minutes: 90, attempt })).status).toBe(200);
    expect(
      (
        await h.http("POST", "/staging-abandon-admission", {
          id: recoveryRequest.id,
          expectedStartedAt: 1000,
          expectedRecordSha256: recoveryRequest.expectedRecordSha256,
          expectedFixtureSha256: policy.fixtureSha256,
          expectedDecisionSha256: policy.decisionSha256,
          attempt,
        })
      ).status,
    ).toBe(200);
    expect((await h.http("POST", "/drain", { minutes: 90, attempt })).status).toBe(200);
    const fence = await h.http("POST", "/deploy-fence", { attempt });
    expect(fence.status).toBe(200);
    expect(await fence.json()).toMatchObject({
      fenceReady: true,
      deployDiagnostic: { producer: { build: `${"a".repeat(40)}@2026-10-15T00:00:00.000Z` } },
    });
    const later = fixture({
      stamp: resolveBuildStamp("a".repeat(40), "2026-10-15T00:01:00.000Z"),
      policy,
      rows: h.rows,
    });
    later.advance();
    const uploadedVersion = "00000000-0000-4000-8000-000000000003";
    const reconciled = await later.http("POST", "/reconcile", { attempt }, uploadedVersion);
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({
      reconciled: [{ resource: "repo:acme/api", result: "current", verified: true }],
    });
    expect((await later.http("POST", "/staging-seal-window", { attempt }, uploadedVersion)).status).toBe(200);
    expect(
      (
        await later.http(
          "POST",
          "/staging-release-maintenance",
          {
            expectedStartedAt: 1000,
            expectedRecordSha256: recoveryRequest.expectedRecordSha256,
            attempt,
            releaseDecisionSha256: "7".repeat(64),
          },
          uploadedVersion,
        )
      ).status,
    ).toBe(200);
    expect((await (await later.http("GET", "/staging-maintenance")).json()).maintenance).toMatchObject({
      state: "released",
      generation: 1,
      releaseDecisionSha256: "7".repeat(64),
    });
    const restarted = fixture({
      stamp: resolveBuildStamp("a".repeat(40), "2026-10-15T00:02:00.000Z"),
      policy,
      rows: h.rows,
    });
    expect((await (await restarted.http("GET", "/staging-maintenance")).json()).maintenance.state).toBe("released");
    expect(h.rows.get(`deploy:admission:${recoveryRequest.id}`)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.rows.get(`deploy:abandoned:${recoveryRequest.id}`)).toMatchObject({
      requestEnd: "unobserved",
      nativeOutcome: "unverified",
    });
  });

  it("admits the selected post-upload reconcile from a stamped source and refuses wrong source or generation", async () => {
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 3_600_000 } };
    const attempt = { ...policy.attempt, holdId: policy.holdId, generation: 1 };
    const run = async (commit: string, generation: number) => {
      const h = fixture({ stamp: resolveBuildStamp(commit, "2026-10-15T00:00:00.000Z") });
      h.rows.set("deploy:staging-maintenance", { schema: 1, state: "held", installedAt: 1000, policy });
      h.rows.set("drain", {
        since: "1970-01-01T00:00:00.000Z",
        until: "1970-01-01T01:00:00.000Z",
        by: "deploy",
        reason: "release",
        swapFence: true,
        swapVersion: "00000000-0000-4000-8000-000000000001",
        swapAt: "1970-01-01T00:00:01.000Z",
      });
      const response = await h.http("POST", "/reconcile", { attempt: { ...attempt, generation } });
      const body = await response.json();
      return {
        status: response.status,
        body: response.status === 200 ? { reconciled: body.reconciled } : body,
        rows: await h.api.listDeployAdmissions(),
      };
    };
    expect(await run("a".repeat(40), 1)).toEqual({
      status: 200,
      body: { reconciled: [{ resource: "repo:acme/api", result: "current", verified: true }] },
      rows: [],
    });
    for (const [source, generation] of [
      ["b".repeat(40), 1],
      ["a".repeat(40), 2],
    ] as const)
      expect(await run(source, generation)).toEqual({
        status: 409,
        body: { error: "deploy-fence: reconcile waits for the uploaded Worker" },
        rows: [],
      });
  });

  it("refuses missing, malformed and foreign image targets before reconcile admission", async () => {
    const h = fixture();
    await h.boot();
    const before = [...h.rows];
    for (const imageTarget of [
      undefined,
      { application: "foreign-residentdo", version: 1, image: "registry.example.test/resident:one" },
      { application: "test-resident-residentdo", version: 1, image: null },
    ]) {
      const response = await h.http("POST", "/reconcile", { imageTarget });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "an exact Resident application version and image target are required",
      });
      expect([...h.rows]).toEqual(before);
    }
  });

  it("refuses wrong, unknown and dirty stamped source or a changed held generation at Registry startup", async () => {
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 3_600_000 } };
    for (const commit of ["b".repeat(40), "unknown", "a".repeat(7), `${"a".repeat(40)}-dirty`]) {
      const h = fixture({ stamp: resolveBuildStamp(commit, "2026-10-15T00:00:00.000Z"), policy });
      await expect(h.boot()).rejects.toThrow("staging-maintenance-scope-mismatch");
      expect((await h.http("GET", "/staging-maintenance")).status).toBe(500);
      expect([...h.rows]).toEqual([]);
    }
    const original = { schema: 1, state: "held", installedAt: 1000, policy };
    const rows = new Map<string, unknown>([["deploy:staging-maintenance", original]]);
    const h = fixture({
      stamp: resolveBuildStamp("a".repeat(40), "2026-10-15T00:00:00.000Z"),
      policy: { ...policy, generation: 2 },
      rows,
    });
    await expect(h.boot()).rejects.toThrow("staging-maintenance-generation-mismatch");
    expect((await h.http("GET", "/staging-maintenance")).status).toBe(500);
    expect([...rows]).toEqual([["deploy:staging-maintenance", original]]);
  });

  it("excludes only the exact staging record while retaining its original data and unknown result", async () => {
    const h = fixture();
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 3_600_000 } };
    const original = { startedAt: 1000, kind: "watchdog" };
    const originalRecordSha256 = await admissionRecordHash(original);
    const fence = {
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T01:00:00.000Z",
      versionId: "00000000-0000-4000-8000-000000000002",
    };
    h.rows.set("deploy:staging-maintenance", { schema: 1, state: "held", installedAt: 1000, policy });
    h.rows.set(`deploy:admission:${recoveryRequest.id}`, original);
    h.rows.set(`deploy:abandoned:${recoveryRequest.id}`, {
      schema: 1,
      id: recoveryRequest.id,
      disposition: "operator-abandoned",
      requestEnd: "unobserved",
      nativeOutcome: "unverified",
      independentObligations: "unchanged",
      policy,
      originalRecord: original,
      originalRecordSha256,
      decidedAt: 1000,
      fence,
    });
    h.rows.set("deploy:staging-window", {
      schema: 1,
      state: "fenced",
      recordId: recoveryRequest.id,
      holdId: policy.holdId,
      generation: 1,
      attemptId: policy.attempt.id,
      drain: fence,
    });
    h.rows.set("drain", { ...fence, swapFence: true, swapVersion: fence.versionId });
    expect(await h.api.activeDeployAdmissions()).toBe(0);
    h.rows.set(`deploy:admission:${identity.id}`, { startedAt: 1000 });
    expect(await h.api.activeDeployAdmissions()).toBe(1);
    expect(h.rows.get(`deploy:admission:${recoveryRequest.id}`)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.rows.get(`deploy:abandoned:${recoveryRequest.id}`)).toMatchObject({
      requestEnd: "unobserved",
      nativeOutcome: "unverified",
      independentObligations: "unchanged",
    });
  });

  it("installs a durable hold that refuses new work after ordinary drain removal", async () => {
    const h = fixture();
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 3_600_000 } };
    h.api.env.RESIDENT_MAINTENANCE_POLICY = JSON.stringify(policy);
    await h.api.initializeStagingMaintenance();
    expect(await h.api.beginDeployAdmission(origin)).toBe(null);
    h.rows.delete("drain");
    delete h.api.env.RESIDENT_MAINTENANCE_POLICY;
    expect(await h.api.beginDeployAdmission(origin)).toBe(null);
    expect(h.rows.get("deploy:staging-maintenance")).toMatchObject({
      state: "held",
      policy: { holdId: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("commits one exact staging abandonment audit without deleting the request", async () => {
    const h = fixture();
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 3_600_000 } };
    h.api.env.RESIDENT_MAINTENANCE_POLICY = JSON.stringify(policy);
    await h.api.initializeStagingMaintenance();
    const original = { startedAt: 1000, kind: "watchdog" };
    h.rows.set(`deploy:admission:${recoveryRequest.id}`, original);
    h.rows.set("drain", {
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T01:00:00.000Z",
      swapFence: true,
      swapVersion: "00000000-0000-4000-8000-000000000002",
      swapBuild: "a".repeat(40),
      swapAt: "1970-01-01T00:00:01.000Z",
      reason: "release",
      by: "selected-controller",
    });
    const quote = await h.api.getDeployAdmissionRecoveryQuote(recoveryRequest.id);
    const attempt = { ...policy.attempt, holdId: policy.holdId, generation: 1 };
    expect(
      await h.api.abandonStagingAdmission(
        recoveryRequest.id,
        quote,
        attempt,
        policy.fixtureSha256,
        policy.decisionSha256,
        "00000000-0000-4000-8000-000000000002",
      ),
    ).toBe(true);
    expect(h.rows.get(`deploy:admission:${recoveryRequest.id}`)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.rows.get(`deploy:abandoned:${recoveryRequest.id}`)).toMatchObject({
      disposition: "operator-abandoned",
      requestEnd: "unobserved",
      nativeOutcome: "unverified",
      originalRecord: { startedAt: 1000, kind: "watchdog" },
      originalRecordSha256: "a81747d391ba39d7ed7e15e4b633483a6104f8c6f9318d5548a2589a3f22ab6a",
    });
    expect(await h.api.activeDeployAdmissions()).toBe(0);
  });

  it("uses the authenticated HTTP risk path and releases only through a fresh decision after expiry", async () => {
    const h = fixture();
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 1500 } };
    h.api.env.RESIDENT_MAINTENANCE_POLICY = JSON.stringify(policy);
    await h.api.initializeStagingMaintenance();
    h.rows.set(`deploy:admission:${recoveryRequest.id}`, { startedAt: 1000, kind: "watchdog" });
    const attempt = { ...policy.attempt, holdId: policy.holdId, generation: 1 };
    const body = {
      ...recoveryRequest,
      attempt,
      expectedFixtureSha256: policy.fixtureSha256,
      expectedDecisionSha256: policy.decisionSha256,
    };
    expect(
      (await h.recover(body, () => {}, { path: "/staging-abandon-admission", token: "read-fixture" })).status,
    ).toBe(401);
    const committed = await h.recover(body, () => {}, { path: "/staging-abandon-admission" });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ disposition: "operator-abandoned", requestEnd: "unobserved" });
    h.advance();
    expect(await h.api.activeDeployAdmissions()).toBe(1);
    expect(await h.api.clearDrain(null, null)).toMatchObject({
      cleared: false,
      error: "staging maintenance requires explicit release",
    });
    expect(await h.api.beginDeployAdmission(origin)).toBe(null);
    const released = await h.recover({ ...body, releaseDecisionSha256: "7".repeat(64) }, () => {}, {
      path: "/staging-release-maintenance",
    });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ uploadWindowRenewed: false, requestEnd: "unobserved" });
    expect(h.rows.get(`deploy:admission:${recoveryRequest.id}`)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.rows.get("deploy:staging-maintenance")).toMatchObject({
      state: "released",
      releaseDecisionSha256: "7".repeat(64),
    });
    await h.api.initializeStagingMaintenance();
    expect(h.rows.get("deploy:staging-maintenance")).toMatchObject({ state: "released" });
  });

  it("keeps maintenance through ordinary alarm and last-image callbacks", async () => {
    const h = fixture();
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 3_600_000 } };
    h.api.env.RESIDENT_MAINTENANCE_POLICY = JSON.stringify(policy);
    await h.api.initializeStagingMaintenance();
    h.rows.set("drain", {
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T00:00:01.500Z",
      holds: ["repo:acme/api"],
      liftAsked: true,
      reason: "release",
      by: "controller",
    });
    expect(await h.api.reportContainerImageCurrent("repo:acme/api")).toEqual({ lifted: false });
    h.advance();
    await h.api.alarm();
    expect(await h.api.beginDeployAdmission(origin)).toBe(null);
    expect(h.rows.get("deploy:staging-maintenance")).toMatchObject({ state: "held" });
  });

  it("reports an uncertain seal without exposing raw errors or retrying it", async () => {
    const h = fixture();
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 3_600_000 } };
    h.api.env.RESIDENT_MAINTENANCE_POLICY = JSON.stringify(policy);
    await h.api.initializeStagingMaintenance();
    let calls = 0;
    h.api.sealStagingWindow = async () => {
      calls++;
      throw new Error("private-seal-detail");
    };
    const response = await h.recover(
      { attempt: { ...policy.attempt, holdId: policy.holdId, generation: 1 } },
      () => {},
      { path: "/staging-seal-window" },
    );
    expect(response.status).toBe(409);
    expect({ calls, event: h.events.at(-1) }).toMatchObject({
      calls: 1,
      event: {
        phase: "staging-seal-commit",
        commit: "unverified",
        failure: "storage-or-rpc",
        nativeOutcome: "unverified",
      },
    });
    expect(JSON.stringify(h.events)).not.toContain("private-seal-detail");
  });

  it("keeps an abandonment request held even with an upload URL and caller assertions", async () => {
    const h = fixture();
    h.rows.set(`deploy:admission:${recoveryRequest.id}`, { startedAt: 1000, kind: "watchdog" });
    const response = await h.recover({
      ...recoveryRequest,
      disposition: "operator-abandoned",
      requestEnd: "unobserved",
      containmentVerified: true,
    });
    expect(response.status).toBe(409);
    expect(await h.api.activeDeployAdmissions()).toBe(1);
    expect(h.rows.get(`deploy:admission:${recoveryRequest.id}`)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.rows.has(`deploy:recovered:${recoveryRequest.id}`)).toBe(false);
  });

  it("refuses the operator's stale quote and a row changed during the independent probes", async () => {
    const h = fixture();
    const key = `deploy:admission:${recoveryRequest.id}`;
    h.rows.set(key, { startedAt: 1000, kind: "watchdog" });
    const stale = await h.recover({ ...recoveryRequest, expectedStartedAt: 999 });
    expect(stale.status).toBe(409);
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "watchdog" });
    const changed = await h.recover(recoveryRequest, () => h.rows.set(key, { startedAt: 1000, kind: "reconcile" }));
    expect(changed.status).toBe(409);
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "reconcile" });
    expect(h.rows.has(`deploy:recovered:${recoveryRequest.id}`)).toBe(false);
  });

  it("archives the exact original record without claiming native ending or changing a neighbor", async () => {
    const h = fixture();
    h.rows.set(`deploy:admission:${recoveryRequest.id}`, { startedAt: 1000, kind: "watchdog" });
    h.rows.set("deploy:admission:neighbor", { startedAt: 500, kind: "unknown" });
    const response = await h.recover(recoveryRequest);
    expect(response.status).toBe(200);
    expect(h.rows.get(`deploy:recovered:${recoveryRequest.id}`)).toMatchObject({
      schema: 1,
      disposition: "request-ended",
      requestEnd: "operator-attested",
      nativeOutcome: "unverified",
      independentObligations: "unchanged",
      originalRecord: { startedAt: 1000, kind: "watchdog" },
      originalRecordSha256: recoveryRequest.expectedRecordSha256,
    });
    expect(h.rows.get("deploy:admission:neighbor")).toEqual({ startedAt: 500, kind: "unknown" });
    expect(await h.api.activeDeployAdmissions()).toBe(1);
  });

  it("qualifies a lost recovery commit reply through its exact audit without another deletion", async () => {
    const h = fixture();
    h.rows.set(`deploy:admission:${recoveryRequest.id}`, { startedAt: 1000, kind: "watchdog" });
    h.loseRecoveryAck();
    const response = await h.recover(recoveryRequest);
    expect(response.status).toBe(200);
    expect(await h.api.activeDeployAdmissions()).toBe(0);
    expect(h.recoveryMutations()).toBe(1);
    expect(h.rows.get(`deploy:recovered:${recoveryRequest.id}`)).toMatchObject({
      originalRecord: { startedAt: 1000, kind: "watchdog" },
      originalRecordSha256: recoveryRequest.expectedRecordSha256,
      requestEnd: "operator-attested",
      nativeOutcome: "unverified",
    });
  });

  it("reports an uncertain recovery without printing raw errors or receipt URLs", async () => {
    const h = fixture();
    h.rows.set(`deploy:admission:${recoveryRequest.id}`, { startedAt: 1000, kind: "watchdog" });
    h.api.recoverQuotedDeployAdmission = async () => {
      throw new Error("https://example.com/private?receipt=hidden");
    };
    expect((await h.recover(recoveryRequest)).status).toBe(503);
    expect(h.events).toEqual([
      {
        schema: 1,
        phase: "recovery-commit",
        id: recoveryRequest.id,
        workerVersion: "00000000-0000-4000-8000-000000000002",
        observedAt: 1000,
        commit: "unverified",
        failure: "storage-or-rpc",
        nativeOutcome: "unverified",
      },
    ]);
    expect(h.rows.get(`deploy:admission:${recoveryRequest.id}`)).toEqual({ startedAt: 1000, kind: "watchdog" });
  });

  it("quotes the complete original record read-only while retaining the compact inventory", async () => {
    const h = fixture();
    const key = `deploy:admission:${recoveryRequest.id}`;
    h.rows.set(key, { startedAt: 1000, kind: "watchdog" });
    expect(await (await h.inventory()).json()).toEqual({
      admissions: [{ id: recoveryRequest.id, startedAt: 1000, kind: "watchdog" }],
    });
    expect(await (await h.inventory(recoveryRequest.id)).json()).toEqual({
      admission: { id: recoveryRequest.id, startedAt: 1000, recordSha256: recoveryRequest.expectedRecordSha256 },
    });
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(await h.api.activeDeployAdmissions()).toBe(1);
    h.rows.set(key, { kind: "watchdog", startedAt: 1000 });
    expect(await h.api.getDeployAdmissionRecoveryQuote(recoveryRequest.id)).toEqual({
      startedAt: 1000,
      recordSha256: recoveryRequest.expectedRecordSha256,
    });
    h.rows.set(key, { startedAt: 1000, kind: "watchdog", delayedEffect: { unknown: true } });
    expect((await h.inventory(recoveryRequest.id)).status).toBe(409);
    expect(await h.api.activeDeployAdmissions()).toBe(1);
  });

  it("refuses the legacy mutation protocol even when passed a valid quote", async () => {
    const h = fixture();
    h.rows.set(`deploy:admission:${recoveryRequest.id}`, { startedAt: 1000, kind: "watchdog" });
    h.rows.set("drain", {
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T01:00:00.000Z",
      swapFence: true,
      swapVersion: "00000000-0000-4000-8000-000000000002",
      by: "deploy",
      reason: "release",
    });
    expect(
      await h.api.recoverDeployAdmission(
        recoveryRequest.id,
        "1970-01-01T00:00:00.000Z",
        "1970-01-01T01:00:00.000Z",
        "00000000-0000-4000-8000-000000000002",
        "d".repeat(64),
        { startedAt: 1000, recordSha256: recoveryRequest.expectedRecordSha256 },
      ),
    ).toBe(false);
    expect(h.rows.get(`deploy:admission:${recoveryRequest.id}`)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.rows.has(`deploy:recovered:${recoveryRequest.id}`)).toBe(false);
  });

  it("recovers through the separate admin HTTP address and refuses the legacy address", async () => {
    const h = fixture();
    const key = `deploy:admission:${recoveryRequest.id}`;
    h.rows.set(key, { startedAt: 1000, kind: "watchdog" });
    expect((await h.recover(recoveryRequest, () => {}, { path: "/recover-admission" })).status).toBe(409);
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.recoveryMutations()).toBe(0);
    expect(
      (
        await h.recover({ id: recoveryRequest.id, evidence: recoveryRequest.evidence }, () => {}, {
          path: "/recover-quoted-admission",
        })
      ).status,
    ).toBe(400);
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect((await h.recover(recoveryRequest, () => {}, { path: "/recover-quoted-admission" })).status).toBe(200);
    expect(await h.api.activeDeployAdmissions()).toBe(0);
    expect(h.rows.get(`deploy:recovered:${recoveryRequest.id}`)).toMatchObject({
      originalRecord: { startedAt: 1000, kind: "watchdog" },
      nativeOutcome: "unverified",
    });
  });

  it("keeps changed data when an older HTTP route table receives the quoted request", async () => {
    const h = fixture();
    const key = `deploy:admission:${recoveryRequest.id}`;
    h.rows.set(key, { startedAt: 1000, kind: "watchdog" });
    const quote = await (await h.inventory(recoveryRequest.id)).json();
    expect(quote.admission.recordSha256).toBe(recoveryRequest.expectedRecordSha256);
    h.rows.set(key, { startedAt: 1000, kind: "reconcile" });
    const response = await h.recover(recoveryRequest, () => {}, {
      path: "/recover-quoted-admission",
      olderRoutes: true,
    });
    expect(response.status).toBe(404);
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "reconcile" });
    expect(h.recoveryMutations()).toBe(0);
    expect(h.rows.has(`deploy:recovered:${recoveryRequest.id}`)).toBe(false);
  });

  it("requires the admin bearer before accepting either recovery address", async () => {
    const h = fixture();
    const key = `deploy:admission:${recoveryRequest.id}`;
    h.rows.set(key, { startedAt: 1000, kind: "watchdog" });
    for (const token of ["read-fixture", "operator-fixture", "drain-fixture", "not-a-token"]) {
      for (const path of ["/recover-admission", "/recover-quoted-admission"]) {
        expect((await h.recover(recoveryRequest, () => {}, { path, token })).status).toBe(401);
      }
    }
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.recoveryMutations()).toBe(0);
  });

  it("does not fall back to an older unchecked Registry after the quote was read", async () => {
    const h = fixture();
    const key = `deploy:admission:${recoveryRequest.id}`;
    h.rows.set(key, { startedAt: 1000, kind: "watchdog" });
    const response = await h.recover(recoveryRequest, () => {
      h.api.recoverQuotedDeployAdmission = async () => {
        throw new Error("quoted-method-unavailable");
      };
      h.api.recoverDeployAdmission = async () => {
        h.rows.delete(key);
        return true;
      };
    });
    expect(response.status).toBe(503);
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.rows.has(`deploy:recovered:${recoveryRequest.id}`)).toBe(false);
  });

  it("holds an unquoted request and unknown native ownership without creating an audit", async () => {
    const h = fixture();
    const key = `deploy:admission:${recoveryRequest.id}`;
    h.rows.set(key, { startedAt: 1000, kind: "watchdog" });
    expect((await h.recover({ id: recoveryRequest.id, evidence: recoveryRequest.evidence })).status).toBe(400);
    h.setRecoveryView({ state: "warm", executingRuns: 0, unknownRuns: 1 });
    expect((await h.recover(recoveryRequest)).status).toBe(409);
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.recoveryMutations()).toBe(0);
    expect(h.rows.has(`deploy:recovered:${recoveryRequest.id}`)).toBe(false);
  });

  it("preserves the original row when audit storage or the delete fails", async () => {
    for (const failure of ["audit", "delete"] as const) {
      const h = fixture();
      h.rows.set(`deploy:admission:${recoveryRequest.id}`, { startedAt: 1000, kind: "watchdog" });
      if (failure === "audit") h.failAuditWrite();
      else h.failDelete();
      expect((await h.recover(recoveryRequest)).status).toBe(503);
      expect(h.rows.get(`deploy:admission:${recoveryRequest.id}`)).toEqual({ startedAt: 1000, kind: "watchdog" });
      expect(h.rows.has(`deploy:recovered:${recoveryRequest.id}`)).toBe(false);
      expect(h.recoveryMutations()).toBe(1);
    }
  });

  it("does not overwrite a prior audit or admit another caller under its recovered identity", async () => {
    const h = fixture();
    const key = `deploy:admission:${recoveryRequest.id}`;
    const auditKey = `deploy:recovered:${recoveryRequest.id}`;
    h.rows.set(key, { startedAt: 1000, kind: "watchdog" });
    h.rows.set(auditKey, { recoveredAt: 500, evidenceHash: "legacy" });
    expect((await h.recover(recoveryRequest)).status).toBe(409);
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "watchdog" });
    expect(h.rows.get(auditKey)).toEqual({ recoveredAt: 500, evidenceHash: "legacy" });
    await expect(h.api.beginDeployAdmission(origin, { ...identity, id: recoveryRequest.id })).rejects.toThrow(
      "deploy-admission-identity-used-or-unverified",
    );
  });

  it("leaves a replaced fence intact and treats unreadable or altered commit evidence as unknown", async () => {
    const h = fixture();
    const key = `deploy:admission:${recoveryRequest.id}`;
    h.rows.set(key, { startedAt: 1000, kind: "watchdog" });
    const replacement = {
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T01:00:00.000Z",
      by: "deploy",
      reason: "new-release",
      swapFence: true,
      swapVersion: "foreign",
    };
    expect((await h.recover(recoveryRequest, () => h.rows.set("drain", replacement))).status).toBe(409);
    expect(h.rows.get("drain")).toEqual(replacement);
    expect(h.rows.get(key)).toEqual({ startedAt: 1000, kind: "watchdog" });
    for (const failure of ["read", "altered"] as const) {
      const r = fixture();
      r.rows.set(key, { startedAt: 1000, kind: "watchdog" });
      const readOriginal = r.api.readDeployAdmissionRecoveryReceipt.bind(r.api);
      r.api.readDeployAdmissionRecoveryReceipt = async (...args: unknown[]) => {
        if (failure === "read") throw new Error("audit-read-unavailable");
        const audit = r.rows.get(`deploy:recovered:${recoveryRequest.id}`) as Record<string, unknown>;
        r.rows.set(`deploy:recovered:${recoveryRequest.id}`, {
          ...audit,
          originalRecord: { startedAt: 1000, kind: "reconcile" },
        });
        return readOriginal(...args);
      };
      r.loseRecoveryAck();
      expect((await r.recover(recoveryRequest)).status).toBe(503);
      expect(r.recoveryMutations()).toBe(1);
      expect(await r.api.activeDeployAdmissions()).toBe(0);
      expect(r.rows.get(`deploy:recovered:${recoveryRequest.id}`)).toMatchObject({
        requestEnd: "operator-attested",
        nativeOutcome: "unverified",
      });
    }
  });

  it("reads a committed begin after a lost reply without repeating admission or work", async () => {
    const h = fixture();
    let calls = 0,
      work = 0;
    const store = {
      beginDeployAdmission: async (origin: unknown, key: unknown) => {
        calls++;
        await h.api.beginDeployAdmission(origin, key);
        throw new Error("lost-begin-reply");
      },
      readDeployAdmissionReceipt: (key: unknown) => h.api.readDeployAdmissionReceipt(key),
    };
    const admitted = await h.beginTracked(store);
    if (admitted) work++;
    expect({ calls, work }).toEqual({ calls: 1, work: 1 });
    expect(h.rows.get(`deploy:admission:${admitted.id}`)).toMatchObject({
      requestHash: admitted.requestHash,
      startedAt: 1000,
    });
    expect(await h.api.readDeployAdmissionReceipt(admitted)).toEqual({
      state: "admitted",
      id: admitted.id,
      requestHash: admitted.requestHash,
      startedAt: 1000,
    });
  });

  it("recovers committed storage acknowledgements and reconcile replies through exact reads", async () => {
    const h = fixture();
    h.loseDeleteAck();
    const admitted = await h.beginTracked();
    expect(await h.api.readDeployAdmissionReceipt(admitted)).toEqual({
      state: "admitted",
      ...admitted,
      startedAt: 1000,
    });
    h.loseDeleteAck();
    await h.endTracked(h.api, admitted);
    expect(await h.api.readDeployAdmissionReceipt(admitted)).toEqual({
      state: "released",
      ...admitted,
      startedAt: 1000,
      releasedAt: 1000,
      nativeOutcome: "unverified",
    });
    let calls = 0;
    const store = {
      beginDeployReconcileAdmission: async (version: string, stamp: string, key: unknown) => {
        calls++;
        await h.api.beginDeployReconcileAdmission(version, stamp, key);
        throw new Error("lost-reconcile-reply");
      },
      readDeployAdmissionReceipt: (key: unknown) => h.api.readDeployAdmissionReceipt(key),
    };
    const reconcile = await h.beginReconcile(store);
    expect(calls).toBe(1);
    expect(h.rows.get(`deploy:admission:${reconcile.id}`)).toMatchObject({
      requestHash: reconcile.requestHash,
      kind: "reconcile",
      workerVersion: origin.workerVersion,
    });
  });

  it.each(["begin-reply", "end-reply"] as const)(
    "keeps original Resident work once after a lost %s",
    async (failure) => {
      const h = fixture();
      let work = 0;
      expect(
        await h.resident(failure).withDeployAdmission(async () => {
          work++;
          return "original-work-completed";
        }),
      ).toBe("original-work-completed");
      expect(work).toBe(1);
      const id = h.events.find((row) => row.phase === "admission-requested")?.id;
      expect(h.events.filter((row) => row.phase === "admitted")).toHaveLength(1);
      expect(h.events.filter((row) => row.phase === "permit-release")).toEqual([
        {
          schema: 1,
          phase: "permit-release",
          id,
          observedAt: 1000,
          commit: "acknowledged",
          nativeOutcome: "unverified",
        },
      ]);
      expect(await h.api.activeDeployAdmissions()).toBe(0);
    },
  );

  it("holds caller death debt, including foreign, legacy and expired evidence", async () => {
    const h = fixture();
    expect(await h.api.beginDeployAdmission(origin, identity)).toBe(identity.id);
    h.advance();
    h.rows.set("drain", {
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T00:00:01.001Z",
      by: "deploy",
      reason: "release",
      swapFence: true,
    });
    expect(await h.api.readDeployAdmissionReceipt({ ...identity, requestHash: "d".repeat(64) })).toEqual({
      state: "unknown",
    });
    expect(await h.api.readDeployAdmissionReceipt(identity)).toEqual({
      state: "admitted",
      ...identity,
      startedAt: 1000,
    });
    expect(await h.api.activeDeployAdmissions()).toBe(1);
    await expect(h.api.endDeployAdmission(identity.id, "d".repeat(64))).rejects.toThrow();
    await expect(h.api.endDeployAdmission(identity.id)).rejects.toThrow();
    expect(await h.api.activeDeployAdmissions()).toBe(1);
    h.rows.set(`deploy:admission:${identity.id}`, { startedAt: 1 });
    expect(await h.api.readDeployAdmissionReceipt(identity)).toEqual({ state: "unknown" });
  });

  it("qualifies only an atomic matching release receipt after a lost end acknowledgement", async () => {
    const h = fixture();
    await h.api.beginDeployAdmission(origin, identity);
    let calls = 0;
    const store = {
      endDeployAdmission: async (id: string, hash: string) => {
        calls++;
        await h.api.endDeployAdmission(id, hash);
        throw new Error("lost-end-reply");
      },
      readDeployAdmissionReceipt: (key: unknown) => h.api.readDeployAdmissionReceipt(key),
    };
    await h.endTracked(store, identity);
    expect(calls).toBe(1);
    expect(await h.api.readDeployAdmissionReceipt(identity)).toEqual({
      state: "released",
      ...identity,
      startedAt: 1000,
      releasedAt: 1000,
      nativeOutcome: "unverified",
    });
    expect(await h.api.activeDeployAdmissions()).toBe(0);
    expect(await h.api.readDeployAdmissionReceipt({ ...identity, requestHash: "d".repeat(64) })).toEqual({
      state: "unknown",
    });
  });

  it("refuses uncommitted begin and failed end without repeating either mutation", async () => {
    const h = fixture();
    let begins = 0,
      ends = 0;
    const beginStore = {
      beginDeployAdmission: async () => {
        begins++;
        throw new Error("uncommitted");
      },
      readDeployAdmissionReceipt: (key: unknown) => h.api.readDeployAdmissionReceipt(key),
    };
    await expect(h.beginTracked(beginStore)).rejects.toThrow("deploy-admission-unverified");
    expect(begins).toBe(1);
    await h.api.beginDeployAdmission(origin, identity);
    h.failDelete();
    const endStore = {
      endDeployAdmission: (id: string, hash: string) => {
        ends++;
        return h.api.endDeployAdmission(id, hash);
      },
      readDeployAdmissionReceipt: (key: unknown) => h.api.readDeployAdmissionReceipt(key),
    };
    await expect(h.endTracked(endStore, identity)).rejects.toThrow("deploy-release-unverified");
    expect(ends).toBe(1);
    expect(await h.api.readDeployAdmissionReceipt(identity)).toEqual({
      state: "admitted",
      ...identity,
      startedAt: 1000,
    });
  });

  it("preserves unknown receipts after eviction, corruption and foreign cleanup", async () => {
    const h = fixture();
    await h.api.beginDeployAdmission(origin, identity);
    await h.api.endDeployAdmission(identity.id, identity.requestHash);
    for (let i = 0; i < 128; i++) {
      const key = { id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`, requestHash: "e".repeat(64) };
      await h.api.beginDeployAdmission(origin, key);
      await h.api.endDeployAdmission(key.id, key.requestHash);
    }
    expect(h.rows.get("deploy:release-receipts")).toHaveLength(128);
    expect(await h.api.readDeployAdmissionReceipt(identity)).toEqual({ state: "unknown" });
    const alive = { ...identity, id: "00000000-0000-4000-8000-000000000999" };
    await h.api.beginDeployAdmission(origin, alive);
    h.rows.set("deploy:release-receipts", "private-corrupt-data");
    await expect(h.api.endDeployAdmission(alive.id, alive.requestHash)).rejects.toThrow(
      "deploy-release-receipts-unverified",
    );
    expect(await h.api.readDeployAdmissionReceipt(alive)).toEqual({ state: "admitted", ...alive, startedAt: 1000 });
    expect(await h.api.activeDeployAdmissions()).toBe(1);
  });

  it("cannot credit absent storage as release or launch work from foreign or unavailable readback", async () => {
    const h = fixture();
    let begins = 0,
      ends = 0;
    const foreign = {
      beginDeployAdmission: async () => {
        begins++;
        throw new Error("lost");
      },
      readDeployAdmissionReceipt: async () => ({ state: "admitted", ...identity, startedAt: 1000 }),
    };
    await expect(h.beginTracked(foreign)).rejects.toThrow("deploy-admission-unverified");
    expect(begins).toBe(1);
    const empty = {
      endDeployAdmission: async () => {
        ends++;
        throw new Error("lost");
      },
      readDeployAdmissionReceipt: (key: unknown) => h.api.readDeployAdmissionReceipt(key),
    };
    await expect(h.endTracked(empty, identity)).rejects.toThrow("deploy-release-unverified");
    expect(ends).toBe(1);
    const unreadable = {
      beginDeployAdmission: async () => {
        throw new Error("lost");
      },
      readDeployAdmissionReceipt: async () => {
        throw new Error("private-read-error");
      },
    };
    await expect(h.beginTracked(unreadable)).rejects.toThrow("deploy-admission-unverified");
  });

  it("reports withdrawn fence and failed readback through the production fenced handler", async () => {
    const h = fixture();
    await h.api.beginDeployAdmission(origin, identity);
    const refused = await h.fence();
    expect(refused).toMatchObject({
      activeAdmissions: 1,
      fenceReady: false,
      draining: { swapFence: false },
      deployDiagnostic: {
        schema: 1,
        producer: { build: "a".repeat(40), workerVersion: "00000000-0000-4000-8000-000000000002" },
        fenceDisposition: "withdrawn",
        admissionReadback: "reported",
      },
      admissionReadback: { rows: [{ id: identity.id }], observedActiveCount: 1 },
    });
    const failed = await h.fence(true);
    expect(failed).toMatchObject({
      activeAdmissions: 1,
      fenceReady: false,
      admissionReadback: null,
      deployDiagnostic: { fenceDisposition: "withdrawn", admissionReadback: "unavailable" },
    });
    expect(JSON.stringify(failed)).not.toContain("private-read-error");
    expect(await h.api.activeDeployAdmissions()).toBe(1);
    const fresh = fixture();
    expect(await fresh.fence()).toMatchObject({
      fenceReady: true,
      activeAdmissions: 0,
      draining: { swapFence: true },
      deployDiagnostic: { fenceDisposition: "retained", admissionReadback: "reported" },
    });
  });

  it.each(["read", "rpc"] as const)(
    "reports unavailable origin after %s failure while preserving the work result",
    async (failure) => {
      const h = fixture();
      const result = await h.resident(failure).withDeployAdmission(async () => "work-completed");
      const id = h.events[0].id;
      expect(result).toBe("work-completed");
      expect(h.events).toContainEqual({
        schema: 1,
        phase: "origin-unverified",
        id,
        observedAt: 1000,
        failure: "storage-or-rpc",
      });
      expect(h.events.at(-1)).toEqual({
        schema: 1,
        phase: "permit-release",
        id,
        observedAt: 1000,
        commit: "acknowledged",
        nativeOutcome: "unverified",
      });
    },
  );

  it("persists original internal work and joins a committed permit release by id", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    const stored = h.rows.get(`deploy:admission:${id}`);
    expect(stored).toEqual({
      schema: 1,
      startedAt: 1000,
      ...origin,
      resource: null,
      sourceId: null,
      requesterScope: null,
    });
    h.advance();
    await h.api.endDeployAdmission(id);
    expect(h.events).toEqual([
      { schema: 1, phase: "admitted", id, observedAt: 1000, ...(stored as object) },
      { schema: 1, phase: "permit-release", id, observedAt: 2000, commit: "acknowledged", nativeOutcome: "unverified" },
    ]);
    expect(await h.api.listDeployAdmissions()).toEqual([]);
  });

  it("keeps failed release debt and emits only a closed storage category", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.failDelete();
    await expect(h.api.endDeployAdmission(id)).rejects.toThrow("private-delete-error");
    expect(h.events[1]).toEqual({
      schema: 1,
      phase: "permit-release",
      id,
      observedAt: 1000,
      commit: "unverified",
      failure: "storage",
      nativeOutcome: "unverified",
    });
    expect(await h.api.listDeployAdmissions()).toEqual([{ id, startedAt: 1000, kind: "watchdog" }]);
  });

  it("keeps a lost release acknowledgement unverified even when storage removed the permit", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.loseDeleteAck();
    await expect(h.api.endDeployAdmission(id)).rejects.toThrow("private-delete-ack-error");
    expect(h.events.at(-1)).toEqual({
      schema: 1,
      phase: "permit-release",
      id,
      observedAt: 1000,
      commit: "unverified",
      failure: "storage",
      nativeOutcome: "unverified",
    });
    expect(await h.api.getDeployAdmissionReadback()).toEqual({
      schema: 1,
      observedAt: 1000,
      observedActiveCount: 0,
      omittedCount: 0,
      rows: [],
    });
  });

  it("returns bounded stored rows without discarding legacy, foreign or old permits", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.rows.set("deploy:admission:00000000-0000-4000-8000-000000000002", { startedAt: 1, secret: "private-token" });
    h.advance();
    const readback = await h.api.getDeployAdmissionReadback();
    expect(readback).toMatchObject({
      schema: 1,
      observedAt: 2000,
      observedActiveCount: 2,
      omittedCount: 0,
      rows: [
        { id, kind: "watchdog", startedAt: 1000 },
        { id: "00000000-0000-4000-8000-000000000002", startedAt: 1, kind: "unknown" },
      ],
    });
    expect(JSON.stringify(readback)).not.toContain("private-token");
    expect(await h.api.listDeployAdmissions()).toHaveLength(2);
    for (let i = 0; i < 30; i++) h.rows.set(`deploy:admission:extra-${i}`, { startedAt: 2 });
    expect(await h.api.getDeployAdmissionReadback()).toMatchObject({ observedActiveCount: 32, omittedCount: 7 });
  });

  it("admits only post-upload reconcile and retains unrelated permits", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.rows.set("drain", {
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-01T01:00:00.000Z",
      by: "deploy",
      reason: "release",
      swapFence: true,
      swapVersion: origin.workerVersion,
      swapAt: "1970-01-01T00:00:00.500Z",
    });
    expect(await h.api.beginDeployReconcileAdmission(origin.workerVersion, "1970-01-01T00:00:02.000Z")).toBeNull();
    const successor = "00000000-0000-4000-8000-000000000002";
    const reconcileId = await h.api.beginDeployReconcileAdmission(successor, "1970-01-01T00:00:02.000Z");
    expect(await h.api.listDeployAdmissions()).toEqual([
      { id, startedAt: 1000, kind: "watchdog" },
      { id: reconcileId, startedAt: 1000, kind: "reconcile" },
    ]);
    expect(h.rows.get(`deploy:admission:${reconcileId}`)).toMatchObject({
      schema: 1,
      component: "http",
      kind: "reconcile",
      workerVersion: successor,
    });
  });

  it("does not resurrect a released permit or erase debt after failed annotation", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    h.failOrigin();
    await h.api.recordDeployAdmissionResource(id, "repo:acme/api");
    expect(h.rows.get(`deploy:admission:${id}`)).toMatchObject({ startedAt: 1000, resource: null, kind: "watchdog" });
    expect(h.events.at(-1)).toEqual({
      schema: 1,
      phase: "origin-unverified",
      id,
      observedAt: 1000,
      failure: "storage",
    });
    await h.api.endDeployAdmission(id);
    await h.api.recordDeployAdmissionResource(id, "repo:acme/api");
    expect(await h.api.listDeployAdmissions()).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ id, commit: "acknowledged" });
  });

  it("records a safe resource without overwriting the permit identity or admitting work behind a fence", async () => {
    const h = fixture();
    const id = await h.api.beginDeployAdmission(origin);
    await h.api.recordDeployAdmissionResource(id, "repo:acme/api");
    expect(h.rows.get(`deploy:admission:${id}`)).toMatchObject({
      startedAt: 1000,
      kind: "watchdog",
      resource: "repo:acme/api",
    });
    await h.api.recordDeployAdmissionResource(id, "/workspace/private");
    expect(h.rows.get(`deploy:admission:${id}`)).toMatchObject({ resource: "repo:acme/api" });
    h.rows.set("drain", {
      since: "1970-01-01T00:00:00.000Z",
      until: "2099-01-01T00:00:00.000Z",
      by: "deploy",
      reason: "release",
      swapFence: true,
    });
    expect(await h.api.beginDeployAdmission(origin)).toBeNull();
    expect(await h.api.listDeployAdmissions()).toEqual([{ id, startedAt: 1000, kind: "watchdog" }]);
  });
});

describe("targeted deploy admission recovery", () => {
  const idle = { state: "warm", executingRuns: 0, unknownRuns: 0, activeProcesses: 0 };

  it("requires settled residents with no executing or unknown runs and no container processes", () => {
    expect(recoveryViewsAreIdle([idle, { ...idle, state: "degraded" }])).toBe(true);
    expect(recoveryViewsAreIdle([{ ...idle, state: "refreshing" }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, state: "onboarding" }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, executingRuns: 1 }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, unknownRuns: 1 }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, activeProcesses: 1 }])).toBe(false);
    expect(recoveryViewsAreIdle([{ ...idle, activeProcesses: null }])).toBe(false);
    expect(recoveryViewsAreIdle([{ error: "probe failed" }])).toBe(false);
  });

  it("requires a link to an external request-end receipt", () => {
    expect(recoveryEvidenceUrl("https://dash.cloudflare.com/audit/request-123")).toBe(
      "https://dash.cloudflare.com/audit/request-123",
    );
    expect(recoveryEvidenceUrl("operator says request ended")).toBeNull();
    expect(recoveryEvidenceUrl("http://example.com/receipt")).toBeNull();
    expect(recoveryEvidenceUrl("https://user:pass@example.com/receipt")).toBeNull();
  });
});

describe("deploy upload phase proof", () => {
  const fence = {
    since: "2026-10-02T17:00:00.000Z",
    until: "2026-10-02T18:00:00.000Z",
    by: "deploy",
    reason: "release",
    swapFence: true as const,
    swapVersion: "old-version",
    swapAt: "2026-10-02T17:05:00.000Z",
  };

  it("requires a distinct Worker version created after the upload fence", () => {
    expect(postUploadVersion(fence, "old-version", "2026-10-02T17:10:00.000Z")).toBe(false);
    expect(postUploadVersion(fence, "other-old-version", "2026-10-02T16:59:00.000Z")).toBe(false);
    expect(postUploadVersion(fence, "other-old-version", "2026-10-02T17:03:00.000Z")).toBe(false);
    expect(postUploadVersion(fence, "new-version", "2026-10-02T17:10:00.000Z")).toBe(true);
    expect(postUploadVersion(fence, "new-version", null)).toBe(false);
  });
});

// Feature: docs/reference/specs/resident-repos.md item 69 — the fleet drain: a
// record in the registry Durable Object with an end, read by `POST /attach`
// before any work, set and lifted by two admin routes, shown on `/residents`.
// Plain Node: the decision module is loaded; the Worker's wiring is read as text
// (testing/sourceScan.ts), as every scan in this directory does.

const NOW = Date.parse("2026-09-18T05:00:00.000Z");

describe("deploy fence lifetime", () => {
  it("refuses a drain that expires before upload and readiness can finish", () => {
    const parsed = parseDrainRequest({ minutes: DRAIN.maxMinutes }, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fenced = { ...parsed.record, swapFence: true } as const;
    const latestStart = Date.parse(fenced.until) - DRAIN.deployFenceMinRemainingMinutes * 60_000;
    expect(deployFenceReady(fenced, latestStart)).toBe(true);
    expect(deployFenceReady(fenced, latestStart + 1)).toBe(false);
    expect(deployFenceReady({ ...fenced, liftAsked: true }, NOW)).toBe(false);
    expect(deployFenceReady({ ...fenced, holds: ["repo:x/y"] }, NOW)).toBe(false);
    expect(deployFenceReady({ ...parsed.record }, NOW)).toBe(false);
  });
});

describe("parseDrainRequest — the record a drain asks for", () => {
  it("defaults: an empty body drains for the default minutes as `admin` for `a deploy`, since now", () => {
    const r = parseDrainRequest({}, NOW);
    expect(r).toEqual({
      ok: true,
      record: {
        since: "2026-09-18T05:00:00.000Z",
        until: new Date(NOW + DRAIN_DEFAULT_MINUTES * 60_000).toISOString(),
        by: "admin",
        reason: "a deploy",
      },
    });
  });

  it("minutes, reason and by are taken as given, trimmed; `until` is since + minutes", () => {
    const r = parseDrainRequest({ minutes: 65, reason: "  deploy 62e4e9a ", by: "deploy all" }, NOW);
    expect(r).toEqual({
      ok: true,
      record: {
        since: "2026-09-18T05:00:00.000Z",
        until: "2026-09-18T06:05:00.000Z",
        by: "deploy all",
        reason: "deploy 62e4e9a",
      },
    });
  });

  it("refuses by name — never clamps — a non-integer, zero, or a drain past the cap, and an empty or overlong word", () => {
    expect(parseDrainRequest({ minutes: 1.5 }, NOW)).toEqual({
      ok: false,
      error: "minutes must be an integer number of minutes",
    });
    expect(parseDrainRequest({ minutes: "60" }, NOW)).toEqual({
      ok: false,
      error: "minutes must be an integer number of minutes",
    });
    expect(parseDrainRequest({ minutes: 0 }, NOW)).toEqual({
      ok: false,
      error: `minutes must be between 1 and ${DRAIN_MAX_MINUTES}`,
    });
    expect(parseDrainRequest({ minutes: DRAIN_MAX_MINUTES + 1 }, NOW)).toEqual({
      ok: false,
      error: `minutes must be between 1 and ${DRAIN_MAX_MINUTES}`,
    });
    expect(parseDrainRequest({ reason: "   " }, NOW)).toEqual({
      ok: false,
      error: "reason must be a non-empty string",
    });
    expect(parseDrainRequest({ by: "x".repeat(81) }, NOW)).toEqual({
      ok: false,
      error: "by must be at most 80 characters",
    });
    expect(parseDrainRequest({ minutes: DRAIN_MAX_MINUTES }, NOW).ok).toBe(true);
    // Length is judged after the trim: padding never refuses a value that fits.
    expect(parseDrainRequest({ by: `  ${"x".repeat(80)}  ` }, NOW).ok).toBe(true);
  });
});

describe("liveDrain — the drain in force, or none", () => {
  const record = parseDrainRequest({ minutes: 10, reason: "deploy abc1234", by: "deploy all" }, NOW);
  const stored = record.ok ? record.record : undefined;

  it("a stored record whose `until` is ahead is the drain; at and past `until` it is nothing — whoever forgot to lift it", () => {
    expect(liveDrain(stored, NOW)).toEqual(stored);
    expect(liveDrain(stored, NOW + 10 * 60_000 - 1)).toEqual(stored);
    expect(liveDrain(stored, NOW + 10 * 60_000)).toBeNull();
    expect(liveDrain(stored, NOW + 24 * 3_600_000)).toBeNull();
  });

  it("nothing stored, or a shape this build cannot read, is no drain — never a closed fleet", () => {
    expect(liveDrain(undefined, NOW)).toBeNull();
    expect(liveDrain(null, NOW)).toBeNull();
    expect(liveDrain("2026-09-18T06:00:00.000Z", NOW)).toBeNull();
    expect(liveDrain({ until: "2026-09-18T06:00:00.000Z" }, NOW)).toBeNull();
    expect(liveDrain({ ...stored, until: "not a time" }, NOW)).toBeNull();
  });
});

describe("the reopen gate — the fleet reopens on the last container's new-image report, never on the reconcile's return (issue 1931)", () => {
  const parsed = parseDrainRequest({ minutes: 60, reason: "deploy 62e4e9a", by: "deploy all" }, NOW);
  if (!parsed.ok) throw new Error("fixture");
  const record = parsed.record;

  it("holdDrain marks the residents whose containers still report the pre-deploy image, deduplicated; an empty set changes nothing", () => {
    expect(holdDrain(record, [], NOW)).toEqual(record);
    const held = holdDrain(record, ["repo:a/x", "repo:a/y"], NOW);
    expect(held.holds).toEqual(["repo:a/x", "repo:a/y"]);
    expect(holdDrain(held, ["repo:a/y", "repo:a/z"], NOW).holds).toEqual(["repo:a/x", "repo:a/y", "repo:a/z"]);
  });

  it("the first hold stamps the record's cycle bound (issue 2044): now + the measured bound, clamped to `until`, kept by later holds", () => {
    const held = holdDrain(record, ["repo:a/x"], NOW);
    expect(held.holdsUntil).toBe(new Date(NOW + HOLD_CYCLE_BOUND_MINUTES * 60_000).toISOString());
    // A later hold keeps the first stamp — the bound is the reconcile's ask, not the last holdout's.
    expect(holdDrain(held, ["repo:a/y"], NOW + 60_000).holdsUntil).toBe(held.holdsUntil);
    // A drain shorter than the bound clamps to its own end — `until` stays the last resort.
    const short = parseDrainRequest({ minutes: 1 }, NOW);
    if (!short.ok) throw new Error("fixture");
    expect(holdDrain(short.record, ["repo:a/x"], NOW).holdsUntil).toBe(short.record.until);
  });

  it("the lift does NOT reopen while a container still reports the old image: the record stands with liftAsked, and liveDrain keeps refusing attaches", () => {
    const held = holdDrain(record, ["repo:a/x"], NOW);
    const lift = liftDrain(held);
    expect(lift.cleared).toBe(false);
    if (lift.cleared) throw new Error("unreachable");
    expect(lift.record).toEqual({ ...held, liftAsked: true });
    // The gated record is still the drain in force — the fleet stays closed.
    expect(liveDrain(lift.record, NOW + 60_000)).toEqual({ ...held, liftAsked: true });
  });

  it("the lift with no holds clears as before", () => {
    expect(liftDrain(record)).toEqual({ cleared: true });
  });

  it("a report while another container is still old drops only that hold; the LAST container's new-image report lifts the asked drain", () => {
    const gated = liftDrain(holdDrain(record, ["repo:a/x", "repo:a/y"], NOW));
    if (gated.cleared) throw new Error("fixture");
    const first = reportImageCurrent(gated.record, "repo:a/x");
    expect(first.lifted).toBe(false);
    expect(first.record?.holds).toEqual(["repo:a/y"]);
    const last = reportImageCurrent(first.record!, "repo:a/y");
    expect(last).toEqual({ lifted: true, record: null });
  });

  it("the last report before any lift was asked keeps the drain standing without holds — the deploy's own lift still decides", () => {
    const held = holdDrain(record, ["repo:a/x"], NOW);
    const reported = reportImageCurrent(held, "repo:a/x");
    expect(reported.lifted).toBe(false);
    expect(reported.record).toEqual(record);
    expect(liftDrain(reported.record!)).toEqual({ cleared: true });
  });

  it("the two-idle two-restarted fleet reopens on its last report, before the backstop", () => {
    const resources = ["repo:a/idle-one", "repo:a/idle-two", "repo:a/restarted-one", "repo:a/restarted-two"];
    const held = holdDrain(record, resources, NOW);
    const gated = liftDrain(held);
    if (gated.cleared) throw new Error("fixture");

    const restartedOne = reportImageCurrent(gated.record, "repo:a/restarted-one");
    const idleOne = reportImageCurrent(restartedOne.record!, "repo:a/idle-one");
    const idleTwo = reportImageCurrent(idleOne.record!, "repo:a/idle-two");
    expect(idleTwo.record?.holds).toEqual(["repo:a/restarted-two"]);
    expect(liveDrain(idleTwo.record, NOW + 7 * 60_000)).not.toBeNull();

    const restartedTwo = reportImageCurrent(idleTwo.record!, "repo:a/restarted-two");
    expect(restartedTwo).toEqual({ lifted: true, record: null });
    expect(NOW + 7 * 60_000).toBeLessThan(Date.parse(held.holdsUntil!));
  });

  it("liveDrain carries holds and liftAsked through a stored record, and drops malformed holds", () => {
    const gated = { ...record, holds: ["repo:a/x", 7], liftAsked: true };
    expect(liveDrain(gated, NOW)).toEqual({ ...record, holds: ["repo:a/x"], liftAsked: true });
  });
});

describe("the hold's liveness — a cycle that never happens reopens the fleet with the container named, never a silence to the record's own until (issue 2044)", () => {
  const parsed = parseDrainRequest({ minutes: 65, reason: "deploy fd814ee", by: "deploy all" }, NOW);
  if (!parsed.ok) throw new Error("fixture");
  const record = parsed.record;
  const boundMs = HOLD_CYCLE_BOUND_MINUTES * 60_000;

  it("a held record whose cycle bound passed reads as NO drain — the fleet reopens by construction, liftAsked or not", () => {
    const held = holdDrain(record, ["repo:acme/api"], NOW);
    expect(liveDrain(held, NOW + boundMs - 1)).not.toBeNull();
    expect(liveDrain(held, NOW + boundMs)).toBeNull();
    const gated = liftDrain(held);
    if (gated.cleared) throw new Error("fixture");
    expect(liveDrain(gated.record, NOW + boundMs)).toBeNull();
  });

  it("staleHolds names the containers the reopen left stale — and nothing for a record that expired on `until`, has no holds, or whose bound is still ahead", () => {
    const held = holdDrain(record, ["repo:acme/api"], NOW);
    expect(staleHolds(held, NOW + boundMs)).toEqual(["repo:acme/api"]);
    expect(staleHolds(held, NOW + boundMs - 1)).toBeNull();
    expect(staleHolds(record, NOW + boundMs)).toBeNull();
    expect(staleHolds(held, Date.parse(record.until))).toBeNull();
  });

  it("a record from before the bound (holds, no holdsUntil) keeps `until` as its only end — the last resort", () => {
    const legacy = { ...record, holds: ["repo:a/x"], liftAsked: true };
    expect(liveDrain(legacy, NOW + boundMs)).not.toBeNull();
    expect(liveDrain(legacy, Date.parse(record.until))).toBeNull();
    expect(staleHolds(legacy, NOW + boundMs)).toBeNull();
  });

  it("replays the incident's deploy: drain, reconcile holds the one container that never reports, the lift is asked, the cycle bound elapses — the fleet is open and the container is named", () => {
    // 04:48Z: the deploy drains the fleet and the swap lands.
    const drained = record;
    // The reconcile cannot verify the switchboard container on the new image: held.
    const held = holdDrain(drained, ["repo:acme/api"], NOW);
    // The runner's `/undrain` meets the hold: the fleet stays closed…
    const gated = liftDrain(held);
    if (gated.cleared) throw new Error("the lift must hold");
    expect(liveDrain(gated.record, NOW + 60_000)).not.toBeNull();
    // …the container never cycles, so no report ever lands; the bound elapses…
    const at = NOW + boundMs;
    // …and the fleet is OPEN — not closed to the drain's 65-minute `until` —
    // with the stale container named for the warning.
    expect(liveDrain(gated.record, at)).toBeNull();
    expect(staleHolds(gated.record, at)).toEqual(["repo:acme/api"]);
    // A rebuild that DID report would have lifted it earlier: the report is the fact.
    expect(reportImageCurrent(gated.record, "repo:acme/api")).toEqual({ lifted: true, record: null });
  });
});

describe("drainRefusal — what /attach answers while drained", () => {
  it("is a 503 whose error opens with `draining:`, names the reason, who asked, when it ends, and says the run waits; the record rides beside it", () => {
    const record = parseDrainRequest({ minutes: 60, reason: "deploy 62e4e9a", by: "deploy all" }, NOW);
    if (!record.ok) throw new Error("fixture");
    const refusal = drainRefusal(record.record);
    expect(refusal.status).toBe(503);
    expect(refusal.draining).toEqual(record.record);
    expect(refusal.error).toBe(
      "draining: the resident fleet is closed to new runs for deploy 62e4e9a (asked by deploy all at 2026-09-18T05:00:00.000Z, " +
        "ends by 2026-09-18T06:00:00.000Z) — the run waits at its attach and starts when the fleet reopens",
    );
  });
});

describe("fresh provisioning image reports", () => {
  it.each(["repo:acme/api", "resident-secondary"])(
    "retains the warm member's report until the registry acknowledges it: %s",
    async (residentId) => {
      const source = readSource("worker.ts");
      const resident = source.slice(source.indexOf("export class ResidentDO"));
      const methods = ["runProvisioning", "residentIdentity", "reportPendingImageCurrent"]
        .map((name) => methodOf(resident, name)!)
        .join("\n");
      const rows = new Map<string, unknown>([
        ["resident:resource", "repo:acme/api"],
        ["resident:state", "onboarding"],
        ...(residentId === "repo:acme/api" ? [] : [["resident:instanceId", residentId] as [string, unknown]]),
      ]);
      const reports: Array<{ resource: string; state: unknown; pending: unknown }> = [];
      let reportFails = true;
      let acknowledge!: () => void;
      let reportStarted!: () => void;
      const started = new Promise<void>((resolve) => (reportStarted = resolve));
      const acknowledged = new Promise<void>((resolve) => (acknowledge = resolve));
      const registry = {
        getRecord: async () => ({ defaultRef: "main", provisioningTimeoutMs: 1_000, commands: { build: "" } }),
        reportContainerImageCurrent: async (resource: string) => {
          reports.push({ resource, state: rows.get("resident:state"), pending: rows.get("imageReportPending") });
          if (reportFails) throw new Error("registry unavailable");
          reportStarted();
          await acknowledged;
          return { lifted: true };
        },
      };
      const compiled = ts.transpileModule(`class Resident { ${methods} }`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const { Resident } = runInNewContext(compiled + "\n({ Resident })", {
        STATE_KEY: "resident:state",
        RESOURCE_KEY: "resident:resource",
        RESIDENT_ID_KEY: "resident:instanceId",
        FACTS_KEY: "resident:facts",
        SNAPSHOT_KEY: "resident:snapshot",
        IMAGE_REPORT_PENDING_KEY: "imageReportPending",
        MIRROR_DIR: "/workspace/mirror.git",
        CHECKOUT_DIR: "/workspace/checkout",
        STAGING_CHECKOUT_DIR: "/workspace/staging",
        RETIRED_CHECKOUT_DIR: "/workspace/retired",
        DISK_MARKERS: [],
        BUILD_USER: "builder",
        PROVISIONING_CALLBACK: "onProvisioningDeadline",
        StepError: class extends Error {},
        githubAppConfigured: () => false,
        unmountAllRestoresScript: () => "true",
        systemClock: () => NOW,
        registryStub: () => registry,
        errMsg: (error: Error) => error.message,
        console: { log: () => {} },
      });
      const instance = new Resident();
      Object.assign(instance, {
        env: {},
        ctx: {
          storage: {
            get: async (key: string) => rows.get(key),
            put: async (key: string | Record<string, unknown>, value?: unknown) => {
              if (typeof key === "string") rows.set(key, value);
              else for (const [name, item] of Object.entries(key)) rows.set(name, item);
            },
            delete: async (key: string) => rows.delete(key),
          },
        },
        pendingRestores: new Set(),
        currentUidLedger: async () => ({}),
        registry: () => registry,
        runOk: async () => "",
        ensureGitSetup: async () => {},
        withMirrorLock: async (fn: () => Promise<void>) => fn(),
        gitWithCred: async () => {},
        refExists: async () => true,
        readMirrorSha: async () => "a".repeat(40),
        lockfileKey: async () => "lockfile",
        buildUserRun: async () => {},
        snapshot: async () => ({ done: true, record: { mirror: { id: "mirror" }, checkout: { id: "checkout" } } }),
        writeDiskMarkers: async () => {},
        deleteSchedules: () => {},
        setResidentState: async (state: string) => rows.set("resident:state", state),
      });

      await instance.runProvisioning("repo:acme/api");
      expect(rows.get("resident:state")).toBe("warm");
      expect(reports).toEqual([{ resource: residentId, state: "warm", pending: { resource: residentId } }]);
      expect(rows.get("imageReportPending")).toEqual({ resource: residentId });

      reportFails = false;
      const retry = instance.reportPendingImageCurrent("reconcile");
      await started;
      expect(rows.get("imageReportPending")).toEqual({ resource: residentId });
      acknowledge();
      expect(await retry).toBe(true);
      expect(reports).toEqual([
        { resource: residentId, state: "warm", pending: { resource: residentId } },
        { resource: residentId, state: "warm", pending: { resource: residentId } },
      ]);
      expect(rows.has("imageReportPending")).toBe(false);
    },
  );
});

describe("the Worker's wiring (by scan)", () => {
  const source = readSource("worker.ts");

  it("repeated deploy reconcile preserves the image report and only retries a cycle that was not issued", () => {
    const method = source.slice(source.indexOf("async reconcileForDeploy("), source.indexOf("// -- watchdog"));
    expect(method).toContain("nextDeployImageReconcile");
    expect(method).toMatch(/action === "verified"[\s\S]*verified: true/);
    expect(method).toMatch(/action === "await-report"[\s\S]*reportPendingImageCurrent/);
    expect(method).toMatch(
      /replacementContainerStarted\([\s\S]*await this\.ensureHydrated\(\);[\s\S]*reportPendingImageCurrent/,
    );
    expect(method).toMatch(/action === "start"[\s\S]*holdDrainFor[\s\S]*IMAGE_REPORT_PENDING_KEY/);
    expect(method).toMatch(
      /const activeBeforeCycle = await this\.isRuntimeActive\(\)\.catch\(\(\) => null\);\s*const containerBeforeCycle = activeBeforeCycle === true \? await this\.containerIdentity\(\) : undefined;/,
    );
    expect(method).toMatch(/this\.reconcileImage\("deploy", true\)/);
  });

  it("the hold's liveness is wired (issue 2044): holdDrainFor stamps the bound and arms the alarm at it, the alarm's reopen names the stale containers, a fresh provision reports its own container current, /op answers the drain, and the admin view carries the image report", () => {
    // The bound stamped and the alarm armed at it — the earlier end fires first.
    expect(source).toMatch(/holdDrain\(record, resources, now\)/);
    expect(source).toMatch(
      /if \(held\?\.holdsUntil !== undefined\) await this\.ctx\.storage\.setAlarm\(Date\.parse\(held\.holdsUntil\)\);/,
    );
    // The reopen past the bound is a warning naming who never cycled, never a silence.
    expect(source).toMatch(/const stale = staleHolds\(stored, now\);/);
    expect(source).toMatch(
      /async alarm\(\): Promise<void> \{[\s\S]*?const result = await this\.ctx\.storage\.transaction/,
    );
    expect(source).toMatch(/fleet reopened with \$\{result\.stale\.join\(", "\)\} still on the pre-deploy image/);
    // The provisioning report is exercised by the behavior tests above.
    // A typed op on a drained fleet answers with the drain instead of hanging.
    const op = source.slice(source.indexOf("private async runOpTraced("));
    expect(op).toMatch(/op-refused: the resident fleet is drained for \$\{drain\.reason\}/);
    // Readiness tells the truth: the admin view says whether the container's report is owed.
    expect(source).toMatch(/imageReport: map\.get\(IMAGE_REPORT_PENDING_KEY\) !== undefined \? "pending" : "current"/);
  });

  it("`/drain` and `/undrain` are POST routes of the drain scope, dispatched to their handlers; the drain bearer is a fourth scope that passes only its own routes, admin passes everything", () => {
    expect(source).toMatch(/"\/drain": \{ scope: "drain", method: "POST" \}/);
    expect(source).toMatch(/"\/undrain": \{ scope: "drain", method: "POST" \}/);
    expect(source).toMatch(/case "\/drain":\s*\n\s*return await handleDrain\(env, body\);/);
    expect(source).toMatch(/case "\/undrain":\s*\n\s*return await handleUndrain\(env\);/);
    expect(source).toMatch(/type Scope = "admin" \| "operator" \| "read" \| "drain";/);
    expect(source).toMatch(
      /env\.RESIDENT_DRAIN_TOKEN && timingSafeEqual\(token, env\.RESIDENT_DRAIN_TOKEN\)\) return "drain";/,
    );
    const hasScope = source.slice(source.indexOf("function hasScope("), source.indexOf("const READ_DEBUG_OPS"));
    expect(hasScope).toMatch(/if \(have === "admin"\) return true;\s*return have === scope;/);
  });

  it("the registry Durable Object stores the drain under its own key outside the `resident:` prefix and offers get, set, a gated clear, the deploy's holds and the per-container new-image report (issue 1931)", () => {
    expect(source).toMatch(/const DRAIN_KEY = "drain";/);
    expect(source).toMatch(/async getDrain\(\): Promise<unknown>/);
    expect(source).toMatch(/async setDrain\(record: DrainRecord, attempt\?: unknown\): Promise<DrainRecord \| null>/);
    expect(source).toContain("async clearDrain(");
    expect(source).toContain("versionTimestamp: string | null,");
    expect(source).toMatch(/async holdDrainFor\(resources: string\[\]\): Promise<void>/);
    expect(source).toMatch(/async reportContainerImageCurrent\(resource: string\): Promise<\{ lifted: boolean \}>/);
    // The lift with holds outstanding keeps the record standing (liftAsked);
    // the last report deletes it and posts `below` — the fleet reopens on the
    // container's own fact, never on the reconcile call's return.
    const clear = source.slice(source.indexOf("async clearDrain("), source.indexOf("async holdDrainFor("));
    expect(clear).toMatch(/const lift = liftDrain\(record\);/);
    expect(clear).toMatch(/if \(!lift\.cleared\) \{\s*\n\s*await txn\.put\(DRAIN_KEY, lift\.record\);/);
    const report = source.slice(
      source.indexOf("async reportContainerImageCurrent("),
      source.indexOf("/** The one alarm"),
    );
    expect(report).toMatch(/reportImageCurrent\(record, resource\)/);
    expect(report).toMatch(/if \(lifted\) \{\s*await this\.pushDrainPost\("below"\);/);
  });

  it("the gate is the Durable Object's — after hydration, before the image reconcile — and only a live registration owned by this run permits reattach; the Worker-level handler gates nothing; `/residents` carries `draining`", () => {
    const attach = methodOf(source.slice(source.indexOf("export class ResidentDO")), "attachThreadTraced")!;
    const hydrate = attach.indexOf("await this.ensureHydrated();");
    const gate = attach.indexOf("const drain = await this.fleetDrain();");
    const reconcile = attach.indexOf('this.reconcileImage("attach")');
    expect(hydrate).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(hydrate);
    expect(reconcile).toBeGreaterThan(gate);
    // One owned, live registration decision serves the drain, memory, and image gates.
    expect(attach).toMatch(
      /const registration = await this\.ctx\.storage\.get<RunRegistration>\(runRegKey\(threadKey\)\);\s*const registered = registeredRunAllowsReattach\(\s*registration,\s*runId,\s*systemClock\(\),\s*RUN_REGISTRATION_GRACE_MS,\s*ownerGen,\s*ownerFence,\s*\);/,
    );
    expect(attach).toMatch(/if \(drain && \(drain\.swapFence \|\| !registered\)\) \{/);
    expect(attach).toMatch(/drainRefusal\(drain\)/);
    const handler = source.slice(
      source.indexOf("async function handleAttach("),
      source.indexOf("async function handleDetach("),
    );
    expect(handler).not.toContain("liveDrain(");
    // A registry that cannot be read is no drain: the run never fails on a flag it could not read.
    const helper = source.slice(source.indexOf("private async fleetDrain("), source.indexOf("async getInFlightCount("));
    expect(helper).toMatch(/return liveDrain\(await this\.registry\(\)\.getDrain\(\), systemClock\(\)\);/);
    expect(helper).toMatch(/catch \(err\) \{[\s\S]*return null;/);
    const residents = source.slice(
      source.indexOf("async function handleResidents("),
      source.indexOf("async function handleStatus("),
    );
    expect(residents).toMatch(/draining: liveDrain\(await registryStub\(env\)\.getDrain\(\), systemClock\(\)\)/);
  });

  it("the reconcile route is a drain-scope POST dispatched to its handler, which asks every resident's Durable Object to cycle its container onto the current image and VERIFY the fresh start (issue 1931: 'reconciled' is not 'swapped') — an unverified resident holds the drain until its own report", () => {
    expect(source).toMatch(/"\/reconcile": \{ scope: "drain", method: "POST" \}/);
    expect(source).toMatch(
      /case "\/reconcile":\s*\n\s*return await handleReconcile\(env, body\.attempt, body\.imageTarget\);/,
    );
    // The DO method never trusts the pool-user probe on the deploy path (the
    // pre-deploy image passes it when the pool did not change): the active
    // container is cycled (force), and only the replacement's completed
    // hydration to `warm` provides the report.
    expect(source).toMatch(
      /async reconcileForDeploy\(\s*resource: string,\s*input: unknown,?\s*\): Promise<\{ result: ImageReconcileResult; verified: boolean \}>/,
    );
    const forDeploy = source.slice(source.indexOf("async reconcileForDeploy("), source.indexOf("// -- watchdog"));
    expect(forDeploy).toMatch(/this\.reconcileImage\("deploy", true\)/);
    // The later report stands on either an inactive runtime (whose next start
    // is on the deployed image by construction), or an active replacement
    // completing its own hydration to `warm` — never on the stop or the
    // pool-user probe.
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    expect(reconcile).toMatch(/if \(!force && pending === undefined\) \{/);
    expect(reconcile).toContain("reportPendingImageCurrent");
    const hydrate = source.slice(source.indexOf("private async doHydrate()"), source.indexOf("// -- freshness"));
    expect(hydrate.match(/setResidentState\("warm"\)/g)).toHaveLength(2);
    expect(hydrate.match(/reportPendingImageCurrent\("hydrate"\)/g)).toHaveLength(2);
    expect(source).toMatch(/private async reportPendingImageCurrent\(where: string\): Promise<boolean>/);
    expect(source).toMatch(/registryStub\(this\.env\)\.reportContainerImageCurrent\(pending\.resource\)/);
    // The marker is deleted only AFTER a successful report, so a transient
    // report failure keeps the retry-on-next-reconcile behavior.
    const report = source.slice(
      source.indexOf("private async reportPendingImageCurrent("),
      source.indexOf("async reconcileForDeploy("),
    );
    expect(report.indexOf("reportContainerImageCurrent(pending.resource)")).toBeLessThan(
      report.indexOf("storage.delete(IMAGE_REPORT_PENDING_KEY)"),
    );
  });

  it("the image reconcile defers while a run registration is live on the resident — a harness run's process lives in the container between the bot's operator calls, so the op counters alone would restart the container under it — and answers a word, so the deploy's pass can say what each resident decided", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("async reconcileForDeploy("),
    );
    expect(reconcile).toMatch(/Promise<ImageReconcileResult>/);
    expect(reconcile).toMatch(/const registered = await this\.registeredRunsBeyondOps\(\);/);
    expect(reconcile).toMatch(/run registration\(s\) live — deferring restart until the resident is quiet/);
    expect(reconcile).toMatch(/return "deferred";[\s\S]*return "restarted";/);
    // The registration read sits between the op-counter check and the stop, so
    // a busy container is still named by its operations first.
    expect(reconcile.indexOf("this.inFlightCount()")).toBeLessThan(reconcile.indexOf("registeredRunsBeyondOps"));
    expect(reconcile.indexOf("registeredRunsBeyondOps")).toBeLessThan(reconcile.indexOf("this.swapIncarnation()"));
    // The call sites act on their own words: a refresh cycle restarts only on
    // a stop (`restarted`); an attach acts only on `stale` — a refusal, never
    // a stop (issue 2101). A deferral never answers `image-stale` to an attach
    // and never restarts a refresh cycle.
    expect(source).toMatch(/\(await this\.reconcileImage\("refresh"\)\) === "restarted"/);
    expect(source).toMatch(/\(await this\.reconcileImage\("attach"\)\) === "stale" && !registered/);
  });

  it("an idle DO marked pending after its reconcile still reports current on the next cycle", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    const inactive = reconcile.slice(
      reconcile.indexOf("const active = await this.isRuntimeActive()"),
      reconcile.indexOf("const last = THREAD_USERS"),
    );
    // The helper reads the marker at call time. A reconcile before the marker
    // is a no-op; the first cycle after the marker reports it.
    expect(inactive).toMatch(
      /if \(!active\) \{[\s\S]*await this\.reportPendingImageCurrent\(where\);\s*return "inactive";/,
    );
  });

  it("a failed activity probe preserves the pending marker and drain hold, and refuses a new attach", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    const activity = reconcile.slice(
      reconcile.indexOf("const active = await this.isRuntimeActive()"),
      reconcile.indexOf("const last = THREAD_USERS"),
    );
    expect(activity).toMatch(
      /\.catch\(\(err\) => \{[\s\S]*return null;[\s\S]*if \(active === null\) \{[\s\S]*where === "attach"[\s\S]*IMAGE_REPORT_PENDING_KEY[\s\S]*return "stale";[\s\S]*return "deferred";/,
    );
    expect(activity.indexOf("if (active === null) {")).toBeLessThan(activity.indexOf("if (!active)"));
    expect(activity.indexOf('where === "attach"')).toBeLessThan(activity.indexOf('return "stale";'));
    expect(activity.indexOf("IMAGE_REPORT_PENDING_KEY")).toBeLessThan(activity.indexOf('return "stale";'));
    expect(activity.indexOf('return "stale";')).toBeLessThan(activity.indexOf('return "deferred";'));
    expect(activity.indexOf("if (!active)")).toBeLessThan(activity.indexOf("reportPendingImageCurrent(where)"));
  });

  it("a report from a non-running container reaches the registry", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    const inactive = reconcile.slice(
      reconcile.indexOf("const active = await this.isRuntimeActive()"),
      reconcile.indexOf("const last = THREAD_USERS"),
    );
    expect(inactive).toContain("reportPendingImageCurrent(where)");
    const report = source.slice(
      source.indexOf("private async reportPendingImageCurrent("),
      source.indexOf("async reconcileForDeploy("),
    );
    expect(report).toContain("registryStub(this.env).reportContainerImageCurrent(pending.resource)");
  });

  it("an attach never stops an active container, and its replacement reports only after hydration (issue 2101)", () => {
    const reconcile = source.slice(
      source.indexOf("private async reconcileImage("),
      source.indexOf("/** The report a held drain waits for"),
    );
    // The attach branch answers before any stop: `stale` (refused — the run
    // takes the fallback sandbox) or `deferred` (a stale pool with no marker
    // keeps admitting onto a busy container); while the marker is pending
    // every new attach is refused, so the resident can go quiet for the
    // refresh cycle's restart.
    const attachBranch = reconcile.slice(reconcile.indexOf('if (where === "attach")'), reconcile.indexOf("const busy"));
    expect(attachBranch).toMatch(/return "stale";/);
    expect(attachBranch).not.toMatch(/this\.stop\(/);
    expect(attachBranch).not.toMatch(/swapIncarnation/);
    expect(attachBranch).toMatch(/if \(pending === undefined && \(this\.inFlightCount\(\) > 0/);
    // The one pool-user probe left runs only with NO pending marker (the
    // current-image shortcut), while `doHydrate` reports only after an active
    // replacement reaches `warm`, so the active path cannot race the restore.
    expect(reconcile.match(/this\.run\(capability\)/g)).toHaveLength(1);
    const hydrate = source.slice(source.indexOf("private async doHydrate()"), source.indexOf("// -- freshness"));
    expect(hydrate).toContain('reportPendingImageCurrent("hydrate")');
    // The attach route refuses a `stale` verdict only for a thread with no run
    // registration — a registered run's re-attach passes as it passes the
    // drain and the memory gate.
    expect(source).toMatch(/=== "stale" && !registered/);
  });
});
