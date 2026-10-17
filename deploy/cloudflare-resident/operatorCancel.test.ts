import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sanitizeResidentBody } from "../../src/execution/residentText.js";
import {
  abandonOperatorAdmission,
  handleOperatorAbandonment,
  handleOperatorAbandonmentRead,
  operatorAbandonmentSchema,
  operatorSha256,
  operatorRequestHash,
  quoteOperatorAdmission,
  readOperatorAbandonment,
} from "./operatorCancel.js";
import { webcrypto } from "node:crypto";

function worker(dependencies: Record<string, unknown> = {}) {
  const source = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true);
  const helpers = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["bearerToken", "timingSafeEqual", "tokenScope", "hasScope", "json"].includes(node.name?.text ?? ""),
  );
  const routes = ast.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === "ROUTES"),
  )!;
  const exported = ast.statements.find(ts.isExportAssignment)!;
  let value = exported.expression;
  while (ts.isSatisfiesExpression(value) || ts.isAsExpression(value)) value = value.expression;
  const fetch = (value as ts.ObjectLiteralExpression).properties.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === "fetch",
  )!;
  const compiled = ts.transpileModule(
    `${helpers.map((node) => node.getText(ast)).join("\n")}\n${routes.getText(ast)}\nglobalThis.worker = {${fetch.getText(ast)}};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context = {
    URL,
    Response,
    TextEncoder,
    sanitizeResidentBody,
    STREAMED_ROUTES: new Set(),
    startAdoptedRoot: () => undefined,
    tracer: {},
    traceSinks: [],
    catchAllErr: () => ({ error: "request failed" }),
    ...dependencies,
    worker: undefined as unknown,
  };
  runInNewContext(compiled, context);
  return context.worker as { fetch(request: Request, env: Record<string, unknown>, ctx: object): Promise<Response> };
}

const id = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const version = "33333333-3333-4333-8333-333333333333";
const key = `deploy:admission:${id}`;
const tombstone = `deploy:abandoned:${id}`;

function fixture() {
  const original = {
    schema: 1,
    startedAt: 100,
    kind: "resident-call",
    component: "resident",
    build: "a".repeat(40),
    workerVersion: version,
    resource: "repo:example/app",
    sourceId: null,
    traceId: null,
    requesterScope: null,
    requestHash: "c".repeat(64),
  };
  const drain = {
    since: new Date(0).toISOString(),
    until: new Date(10000).toISOString(),
    by: "deploy controller",
    reason: "deploy candidate",
  };
  const neighbor = { schema: 1, startedAt: 50, kind: "watchdog" };
  const rows = new Map<string, unknown>([
    [key, original],
    ["drain", drain],
    ["deploy:admission:neighbor", neighbor],
    ["native-operation:original", { outcome: "unknown" }],
    ["workspace:original", { retained: true }],
  ]);
  let now = 1000,
    failAudit = false,
    loseAck = false,
    failReadback = false,
    attempts = 0,
    expireBeforeWrite = false,
    malformedAck = false,
    failDelete = false,
    retryBody = false,
    throwLog = false,
    logCalls = 0;
  const events: string[] = [];
  const storage = {
    async transaction(fn: (store: unknown) => Promise<unknown>) {
      let copy = new Map(rows);
      let wroteAudit = false;
      const transaction = {
        async get(at: string) {
          return copy.get(at);
        },
        async put(at: string, value: unknown) {
          if (at === tombstone) {
            if (failAudit) throw new Error("private storage failure");
            wroteAudit = true;
          }
          copy.set(at, value);
        },
        async delete(at: string) {
          if (failDelete) throw new Error("delete failure");
          return copy.delete(at);
        },
      };
      let result = await fn(transaction);
      if (retryBody) {
        retryBody = false;
        copy = new Map(rows);
        wroteAudit = false;
        result = await fn(transaction);
      }
      rows.clear();
      for (const [at, value] of copy) rows.set(at, value);
      if (wroteAudit && loseAck) throw new Error("private reply loss");
      return result;
    },
  };
  const source = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true);
  const registry = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "ResidentRegistryDO",
  ) as ts.ClassDeclaration;
  const methods = registry.members
    .filter((node) =>
      [
        "getOperatorAbandonmentQuote",
        "operatorAbandonDeployAdmission",
        "readOperatorAbandonment",
        "endDeployAdmission",
        "recordDeployAdmissionResource",
        "beginDeployAdmission",
      ].includes(node.name?.getText(ast) ?? ""),
    )
    .map((node) => node.getText(ast));
  const helpers = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      [
        "workerVersionId",
        "deployAdmissionOrigin",
        "validDeployAdmissionIdentity",
        "validDeployReleaseReceipts",
        "emitDeployAdmission",
      ].includes(node.name?.text ?? ""),
  );
  const env = {
    RESIDENT_ADMIN_TOKEN: "admin-secret",
    RESIDENT_DRAIN_TOKEN: "drain-secret",
    RESIDENT_OPERATOR_TOKEN: "operator-secret",
    RESIDENT_READ_TOKEN: "read-secret",
    CF_VERSION_METADATA: { id: version },
  };
  let clockReads = 0;
  const context = {
    ...Object.fromEntries(
      [
        "DEPLOY_ADMISSION_KEY_PREFIX",
        "DEPLOY_ABANDONED_KEY_PREFIX",
        "DEPLOY_RECOVERY_KEY_PREFIX",
        "DEPLOY_RELEASE_RECEIPTS_KEY",
      ].map((name, index) => [
        name,
        ["deploy:admission:", "deploy:abandoned:", "deploy:recovered:", "deploy:release-receipts"][index],
      ]),
    ),
    DRAIN_KEY: "drain",
    liveDrain: () => null,
    systemClock: () => (expireBeforeWrite && clockReads++ > 0 ? 10000 : now),
    BUILD_ID: "b".repeat(40),
    crypto: webcrypto,
    TextEncoder,
    quoteOperatorAdmission,
    abandonOperatorAdmission,
    readOperatorAbandonment,
    console: {
      log(line: string) {
        logCalls++;
        if (throwLog) throw new Error("private log sink failure");
        events.push(line);
      },
    },
    storage,
    env,
    api: undefined as unknown,
    maintenance: null as { state: string } | null,
  };
  const compiled = ts.transpileModule(
    `${helpers.map((node) => node.getText(ast)).join("\n")}
    class Registry { constructor(){this.ctx={storage};this.env=env;} async getStagingMaintenance(){return maintenance;}
    ${methods.join("\n")} } globalThis.api = new Registry();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(compiled, context);
  const api = context.api as {
    operatorAbandonDeployAdmission: (...args: unknown[]) => Promise<unknown>;
    readOperatorAbandonment: (...args: string[]) => Promise<unknown>;
    endDeployAdmission: (id: string, hash: string) => Promise<void>;
    recordDeployAdmissionResource: (id: string, resource: string) => Promise<void>;
    beginDeployAdmission: (origin: unknown, identity: unknown) => Promise<unknown>;
  };
  const originalWrite = api.operatorAbandonDeployAdmission.bind(api),
    originalRead = api.readOperatorAbandonment.bind(api);
  api.operatorAbandonDeployAdmission = async (...args) => {
    attempts++;
    const result = await originalWrite(...args);
    return malformedAck ? { state: "released" } : result;
  };
  api.readOperatorAbandonment = (...args) =>
    failReadback ? Promise.reject(new Error("private read failure")) : originalRead(...args);
  const entry = worker({
    registryStub: () => api,
    handleOperatorAbandonment,
    handleOperatorAbandonmentRead,
    operatorSha256,
  });
  const call = (method: string, path: string, body?: unknown, token = "admin-secret") =>
    entry.fetch(
      new Request(`https://resident.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      {},
    );
  const request = async () => {
    const response = await call("GET", `/deploy-admission-abandonment?id=${id}`);
    expect(response.status).toBe(200);
    return {
      ...((await response.json()) as { quote: object }).quote,
      operationId,
      decision: {
        by: "operator",
        reference: "https://example.test/decisions/one",
        issuedAt: 900,
        expiresAt: 9000,
        acceptUnobservedRequestRisk: true,
      },
    };
  };
  return {
    rows,
    api,
    env,
    context,
    original,
    drain,
    neighbor,
    call,
    request,
    events,
    logCalls: () => logCalls,
    attempts: () => attempts,
    now: (value: number) => {
      now = value;
    },
    failAudit: () => {
      failAudit = true;
    },
    loseAck: () => {
      loseAck = true;
    },
    failReadback: () => {
      failReadback = true;
    },
    malformedAck: () => {
      malformedAck = true;
    },
    failDelete: () => {
      failDelete = true;
    },
    expireBeforeWrite: () => {
      expireBeforeWrite = true;
      clockReads = 0;
    },
    retryBody: () => {
      retryBody = true;
    },
    throwLog: () => {
      throwLog = true;
    },
  };
}

describe("operator deploy admission abandonment", () => {
  it("emits one closed committed event without copying the operator decision", async () => {
    const h = fixture();
    h.rows.set(key, { ...h.original, sourceId: "private-origin-marker" });
    const request = await h.request();
    request.decision.by = "private-operator-marker";
    request.decision.reference = "https://example.test/private-decision-marker";
    const response = await h.call("POST", "/abandon-deploy-admission", request);
    expect(response.status).toBe(200);
    expect(h.events).toEqual([
      `[resident-deploy-admission] ${JSON.stringify({
        schema: 1,
        phase: "operator-abandonment-commit",
        id,
        operationId,
        decidedAt: 1000,
        requestEnd: "unobserved",
        nativeOutcome: "unverified",
        commit: "acknowledged",
      })}`,
    ]);
    expect(h.rows.get(tombstone)).toMatchObject({
      requestEnd: "unobserved",
      originalRecord: { sourceId: "private-origin-marker" },
    });
  });

  it("keeps an acknowledged abandonment successful when the log sink throws", async () => {
    const h = fixture(),
      request = await h.request();
    h.throwLog();
    const response = await h.call("POST", "/abandon-deploy-admission", request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requestEnd: "unobserved", uploadAuthorized: false });
    expect(h.logCalls()).toBe(1);
    expect(h.rows.get(tombstone)).toMatchObject({ request: { operationId }, requestEnd: "unobserved" });
  });

  it("emits once after an acknowledged transaction despite callback reevaluation", async () => {
    const h = fixture(),
      request = await h.request();
    h.retryBody();
    expect((await h.call("POST", "/abandon-deploy-admission", request)).status).toBe(200);
    expect(h.events.map((line) => JSON.parse(line.slice("[resident-deploy-admission] ".length)))).toEqual([
      {
        schema: 1,
        phase: "operator-abandonment-commit",
        id,
        operationId,
        decidedAt: 1000,
        requestEnd: "unobserved",
        nativeOutcome: "unverified",
        commit: "acknowledged",
      },
    ]);
    expect(h.rows.get(tombstone)).toMatchObject({ request: { operationId } });
  });

  it("emits no success event for refusal, failed commits or lost commit replies", async () => {
    for (const [mode, status] of [
      ["refuse", 409],
      ["audit", 503],
      ["delete", 503],
      ["lost", 200],
      ["unknown", 503],
    ] as const) {
      const h = fixture(),
        request = await h.request();
      if (mode === "refuse") h.now(9000);
      if (mode === "audit") h.failAudit();
      if (mode === "delete") h.failDelete();
      if (mode === "lost" || mode === "unknown") h.loseAck();
      if (mode === "unknown") h.failReadback();
      expect((await h.call("POST", "/abandon-deploy-admission", request)).status).toBe(status);
      expect(h.events).toEqual([]);
    }
  });

  it("lets an admin record an explicit unknown-request risk decision", async () => {
    const h = fixture(),
      request = await h.request();
    const response = await h.call("POST", "/abandon-deploy-admission", request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      disposition: "operator-abandoned",
      requestEnd: "unobserved",
      nativeOutcome: "unverified",
      runtimeContainment: "not-established",
      uploadAuthorized: false,
    });
    expect(h.rows.get(tombstone)).toMatchObject({
      originalRecord: h.original,
      decidedAt: 1000,
      authority: { scope: "admin", credentialSha256: await operatorSha256("admin-secret") },
    });
    expect([...h.rows.keys()]).toEqual([
      "drain",
      "deploy:admission:neighbor",
      "native-operation:original",
      "workspace:original",
      tombstone,
    ]);
    expect(h.rows.get("drain")).toEqual(h.drain);
    expect(h.rows.get("deploy:admission:neighbor")).toEqual(h.neighbor);
    expect(JSON.stringify(h.rows.get(tombstone))).not.toContain("admin-secret");
  });

  it("keeps quote and exact receipt reads free of mutations", async () => {
    const h = fixture(),
      before = structuredClone([...h.rows]);
    const request = await h.request();
    expect([...h.rows]).toEqual(before);
    const response = await h.call("POST", "/abandon-deploy-admission", request);
    expect(response.status).toBe(200);
    const abandoned = structuredClone([...h.rows]);
    h.now(20000);
    const read = await h.call(
      "GET",
      `/deploy-admission-abandonment?id=${id}&operationId=${operationId}&expectedRecordSha256=${operatorAbandonmentSchema.parse(request).expectedRecordSha256}`,
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ receipt: { request: { operationId }, requestEnd: "unobserved" } });
    expect([...h.rows]).toEqual(abandoned);
  });

  it.each(["drain-secret", "operator-secret", "read-secret", "invalid"])(
    "refuses %s at the existing admin boundary",
    async (token) => {
      const h = fixture(),
        request = await h.request(),
        before = structuredClone([...h.rows]);
      expect((await h.call("POST", "/abandon-deploy-admission", request, token)).status).toBe(401);
      expect((await h.call("GET", `/deploy-admission-abandonment?id=${id}`, undefined, token)).status).toBe(401);
      expect([...h.rows]).toEqual(before);
    },
  );

  it.each(["record", "producer", "source", "drain owner", "fence", "expired", "future", "risk", "reference"])(
    "refuses changed %s without removing the request",
    async (change) => {
      const h = fixture(),
        input = await h.request();
      const request = operatorAbandonmentSchema.parse(input);
      if (change === "record") h.rows.set(key, { ...h.original, sourceId: "different" });
      if (change === "producer") h.context.BUILD_ID = "d".repeat(40);
      if (change === "source") request.source.build = "d".repeat(40);
      if (change === "drain owner") h.rows.set("drain", { ...h.drain, by: "other controller" });
      if (change === "fence") h.rows.set("drain", { ...h.drain, swapAcquisitionId: null });
      if (change === "expired") h.now(9000);
      if (change === "future") request.decision.issuedAt = 2000;
      if (change === "reference") request.decision.reference = "invalid";
      const sent =
        change === "risk"
          ? { ...request, decision: { ...request.decision, acceptUnobservedRequestRisk: false } }
          : request;
      const before = structuredClone([...h.rows]);
      expect((await h.call("POST", "/abandon-deploy-admission", sent)).status).toBe(
        ["risk", "reference"].includes(change) ? 400 : 409,
      );
      expect([...h.rows]).toEqual(before);
    },
  );

  it("refuses a deadline crossed during the transaction", async () => {
    const h = fixture(),
      request = await h.request(),
      before = structuredClone([...h.rows]);
    h.expireBeforeWrite();
    expect((await h.call("POST", "/abandon-deploy-admission", request)).status).toBe(409);
    expect([...h.rows]).toEqual(before);
  });

  it("preserves selected staging maintenance instead of using an operator override", async () => {
    const h = fixture(),
      request = await h.request(),
      before = structuredClone([...h.rows]);
    h.context.maintenance = { state: "held" };
    expect((await h.call("POST", "/abandon-deploy-admission", request)).status).toBe(409);
    expect((await h.call("GET", `/deploy-admission-abandonment?id=${id}`)).status).toBe(409);
    expect([...h.rows]).toEqual(before);
  });

  it("rolls back the exact permit when the audit cannot commit", async () => {
    const h = fixture(),
      request = await h.request(),
      before = structuredClone([...h.rows]);
    h.failAudit();
    expect((await h.call("POST", "/abandon-deploy-admission", request)).status).toBe(503);
    expect([...h.rows]).toEqual(before);
    expect(h.attempts()).toBe(1);
  });

  it("rolls back the audit when the exact deletion fails", async () => {
    const h = fixture(),
      request = await h.request(),
      before = structuredClone([...h.rows]);
    h.failDelete();
    expect((await h.call("POST", "/abandon-deploy-admission", request)).status).toBe(503);
    expect([...h.rows]).toEqual(before);
  });

  it("qualifies a lost commit reply only through its exact audit without replay", async () => {
    const h = fixture(),
      request = await h.request();
    h.loseAck();
    expect((await h.call("POST", "/abandon-deploy-admission", request)).status).toBe(200);
    expect(h.attempts()).toBe(1);
    const parsed = operatorAbandonmentSchema.parse(request),
      hash = await operatorRequestHash(parsed);
    const changed = await h.call(
      "GET",
      `/deploy-admission-abandonment?id=${id}&operationId=${operationId}&expectedRecordSha256=${parsed.expectedRecordSha256}&requestSha256=${"0".repeat(64)}`,
    );
    expect(changed.status).toBe(409);
    expect(await h.api.readOperatorAbandonment(id, operationId, hash)).toMatchObject({ requestEnd: "unobserved" });
  });

  it("keeps a lost acknowledgement unknown when exact readback is unavailable", async () => {
    const h = fixture(),
      request = await h.request();
    h.loseAck();
    h.failReadback();
    const response = await h.call("POST", "/abandon-deploy-admission", request);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "operator decision outcome is unverified", operationId });
    expect(h.attempts()).toBe(1);
    expect(h.rows.get(tombstone)).toMatchObject({ requestEnd: "unobserved" });
  });

  it("does not accept a malformed mutation reply without the exact original audit", async () => {
    const h = fixture(),
      request = await h.request();
    h.malformedAck();
    h.failReadback();
    const response = await h.call("POST", "/abandon-deploy-admission", request);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ commit: "unverified", requestEnd: "unobserved" });
    expect(h.attempts()).toBe(1);
    expect(h.rows.get(tombstone)).toMatchObject({ request: { operationId } });
  });

  it("does not treat absence or a changed retained audit as an exact receipt", async () => {
    const h = fixture(),
      request = await h.request();
    const response = await h.call("POST", "/abandon-deploy-admission", request);
    expect(response.status).toBe(200);
    const url = `/deploy-admission-abandonment?id=${id}&operationId=${operationId}&expectedRecordSha256=${operatorAbandonmentSchema.parse(request).expectedRecordSha256}`;
    h.rows.set(tombstone, { ...(h.rows.get(tombstone) as object), requestEnd: "operator-attested" });
    expect((await h.call("GET", url)).status).toBe(409);
    h.rows.delete(tombstone);
    expect((await h.call("GET", url)).status).toBe(409);
    expect(h.attempts()).toBe(1);
  });

  it("retains the immutable tombstone through delayed cleanup and identity reuse", async () => {
    const h = fixture(),
      request = await h.request();
    expect((await h.call("POST", "/abandon-deploy-admission", request)).status).toBe(200);
    const before = structuredClone([...h.rows]);
    await expect(h.api.endDeployAdmission(id, h.original.requestHash)).rejects.toThrow(
      "deploy-release-abandoned-request-held",
    );
    await h.api.recordDeployAdmissionResource(id, "repo:other/app");
    await expect(h.api.beginDeployAdmission({}, { id, requestHash: h.original.requestHash })).rejects.toThrow(
      "deploy-admission-identity-used-or-unverified",
    );
    expect((await h.call("POST", "/abandon-deploy-admission", request)).status).toBe(409);
    expect([...h.rows]).toEqual(before);
  });
});
