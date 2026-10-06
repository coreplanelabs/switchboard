import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckpointRecord } from "./sandboxCheckpoint.js";
import type { LifecycleRecord } from "./sandboxOperationWindow.js";

// The selected real Worker methods execute against isolated workerd/SQLite.
// Container, SDK and seed effects are controlled; this is not VM retirement.
const OWNER_KEY = "switchboard.preservation.owner";
const SEED_KEY = "switchboard.preservation.seedState";
const legacy: CheckpointRecord = {
  owner: {
    run: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requester: "mcp:operator",
    thread: "mcp:thread",
    repository: "example/project",
    ref: "main",
    head: "b".repeat(40),
    seed: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    container: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  },
  doorOrigin: "https://example.test",
  backupId: "checkpoint-original",
};
function versioned(admission: "open" | "closed" = "open"): LifecycleRecord {
  return {
    version: 2,
    lifecycle: {
      allocation: {
        runId: legacy.owner.run,
        ownerGen: "original-generation",
        allocationKey: "original-allocation",
        actorId: "a".repeat(64),
      },
      binding: "pending",
      admission,
      operationWindow: {
        issuedThrough: 1,
        settledThrough: 0,
        slots: [{ ordinal: 1, operation: "warm-up", state: "unknown", cause: "reset-lost" }, ...Array(15).fill(null)],
      },
    },
  };
}

let runtime: Miniflare;
let directory: string;
let script: string;
let compatibilityDate: string;
async function makeRuntime() {
  return new Miniflare(
    convertV4MiniflareOptions({
      name: "local-preservation-reader",
      modules: [{ type: "ESModule", path: "fixture.mjs", contents: script }],
      compatibilityDate,
      cf: false,
      durableObjects: { FIXTURE: { className: "LifecycleFixture", useSQLite: true } },
      resourcePersistencePath: directory,
      isolatedResourcePersistencePath: directory,
      telemetry: { enabled: false },
    }),
  );
}
async function request(path: string, body: object = {}) {
  const response = await runtime.dispatchFetch(`http://fixture${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    ok: boolean;
    record?: unknown;
    snapshot?: unknown;
    effects?: string[];
    result?: Record<string, unknown>;
    error?: string;
    sqlite?: boolean;
  };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "preservation-reader-sqlite-"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const template = await readFile(join(root, "deploy/cloudflare-sandbox/wrangler.template.jsonc"), "utf8");
  const configuredDate = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(template)?.[1];
  if (!configuredDate) throw new Error("Worker compatibility date unavailable");
  compatibilityDate = configuredDate;
  const path = join(root, "deploy/cloudflare-sandbox/worker.ts");
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  const klass = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "SwitchboardSandbox",
  );
  if (!klass) throw new Error("Worker class unavailable");
  const names = [
    "preserveBeforeDestroy",
    "preservationRecord",
    "seed",
    "claimMatches",
    "readLegacyPreservation",
    "saveLegacyPreservation",
  ];
  const methods = klass.members
    .filter(
      (node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && names.includes(node.name.getText(source)),
    )
    .map((method) => method.getText(source));
  let save: ts.PropertyAssignment | undefined;
  const findSave = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "save") save = node;
    ts.forEachChild(node, findSave);
  };
  const guard = klass.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "preserveBeforeDestroy",
  );
  if (!guard) throw new Error("guard unavailable");
  findSave(guard);
  if (!save) throw new Error("checkpoint callback unavailable");
  const callback = `async checkpointCallback(record, backupId) { const save = ${save.initializer.getText(source)}; return save(backupId, record.owner); }`;
  const sourceText = `
    import { DurableObject } from 'cloudflare:workers';
    import { checkpointIfSafe, sameOwner, normalizedSeedDoorOrigin, boundSeedOriginMatches, seedClaimHeadMatches } from './src/execution/sandboxCheckpoint.ts';
    import { decodeLifecycle, updateCheckpoint } from './src/execution/sandboxOperationWindow.ts';
    import { seedMarkerText } from './src/execution/seedPlan.ts';
    import { sandboxStartingAnswer } from './src/execution/sandboxErrors.ts';
    const PRESERVATION_KEY = ${JSON.stringify(OWNER_KEY)}, PRESERVATION_SEED_STATE_KEY = ${JSON.stringify(SEED_KEY)};
    const SEED_MARKER = '/fixture-seed', PRESERVATION_CONTAINER_MARKER = '/fixture-container';
    class Methods { ${methods.join("\n")} ${callback} }
    export class LifecycleFixture extends DurableObject {
      async fetch(request) {
        const body = await request.json(), path = new URL(request.url).pathname;
        const storage = this.ctx.storage;
        if(path === '/setup') { await storage.deleteAll(); if(Object.hasOwn(body,'record')) await storage.put(PRESERVATION_KEY,body.record); await storage.put(PRESERVATION_SEED_STATE_KEY, body.seedState || 'unseeded'); return Response.json({ok:true}); }
        if(path === '/read') return Response.json({ok:true, record:await storage.get(PRESERVATION_KEY), sqlite:[...storage.sql.exec('SELECT 1 AS value')][0].value === 1});
        const effects = [], f = new Methods();
        f.ctx = {storage,container:{running:true},id:{name:'mcp:thread',toString:()=>this.ctx.id.toString()}};
        f.env = {};
        f.exists = async()=>{effects.push('exists');if(body.replaceOnProbe)await storage.put(PRESERVATION_KEY,body.replaceOnProbe);return {success:true,exists:false}};
        f.readFile = async()=>{effects.push('readFile');return {content:''}};
        f.createBackup = async()=>{effects.push('backup');return {id:'fixture'}};
        f.idle={served:async op=>op()}; f.checkoutFence={shared:async op=>op()}; f.gate={through:async op=>{effects.push('warm-up');return op()}};
        f.seedNow=async seed=>{effects.push('seed');return {seeded:true,cached:false,sha:seed.sha}};
        f.writeFile=async()=>{effects.push('writeFile');if(body.replaceOnMarker)await storage.put(PRESERVATION_KEY,body.replaceOnMarker)};
        try {
          if(path === '/guard') return Response.json({ok:true,result:await f.preserveBeforeDestroy('idle'),effects});
          if(path === '/metadata') return Response.json({ok:true,snapshot:await f.preservationRecord(),effects});
          if(path === '/checkpoint') {await f.checkpointCallback(body.expected,body.backupId);if(body.loseReply)return new Response('fixture acknowledgment lost',{status:503});return Response.json({ok:true,record:await storage.get(PRESERVATION_KEY),effects})}
          if(path === '/seed') {const result=await f.seed(body.seed,body.env,body.claim);return Response.json({ok:true,result,record:await storage.get(PRESERVATION_KEY),effects})}
          return Response.json({ok:false,error:'unknown fixture route'});
        }catch(error){return Response.json({ok:false,error:error.message,record:await storage.get(PRESERVATION_KEY),effects})}
      }
    }
    export default {fetch(request,env){return env.FIXTURE.get(env.FIXTURE.idFromName('mcp:thread')).fetch(request)}};
  `;
  const bundle = await build({
    stdin: { contents: sourceText, resolveDir: root, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
    target: "es2022",
  });
  script = bundle.outputFiles[0]!.text;
  runtime = await makeRuntime();
});
afterAll(async () => {
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("sandbox legacy storage writers", () => {
  it("retains lifecycle data that lands while the original legacy probe is pending", async () => {
    await request("/setup");
    const record = versioned("closed");
    expect(await request("/guard", { replaceOnProbe: record })).toMatchObject({
      ok: true,
      result: false,
      effects: ["exists"],
    });
    expect(await request("/read")).toMatchObject({ record });
  });
  it("serializes competing same-key callbacks without overwriting the winning checkpoint", async () => {
    await request("/setup", { record: legacy, seedState: "seeded" });
    const results = await Promise.all(
      ["checkpoint-a", "checkpoint-b"].map((backupId) => request("/checkpoint", { expected: legacy, backupId })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const stored = await request("/read");
    expect(["checkpoint-a", "checkpoint-b"]).toContain((stored.record as CheckpointRecord).backupId);
    expect((stored.record as CheckpointRecord).owner).toEqual(legacy.owner);
    expect(results.every((result) => result.effects?.length === 0)).toBe(true);
  });
  it("reads the committed checkpoint after a lost HTTP acknowledgment without replaying its callback", async () => {
    await request("/setup", { record: legacy, seedState: "seeded" });
    const response = await runtime.dispatchFetch("http://fixture/checkpoint", {
      method: "POST",
      body: JSON.stringify({ expected: legacy, backupId: "checkpoint-landed", loseReply: true }),
    });
    expect(response.status).toBe(503);
    expect(await request("/read")).toMatchObject({ record: { ...legacy, backupId: "checkpoint-landed" } });
  });
  it("holds a pending versioned SQLite record before the old unseeded cleanup branch", async () => {
    const record = versioned();
    await request("/setup", { record });
    expect(await request("/guard")).toMatchObject({ ok: true, result: false, effects: [] });
    expect(await request("/read")).toMatchObject({ record, sqlite: true });
  });
  it("a legacy checkpoint callback cannot overwrite newly landed closing debt", async () => {
    const record = versioned("closed");
    await request("/setup", { record });
    expect(await request("/checkpoint", { expected: legacy, backupId: "checkpoint-next" })).toMatchObject({
      ok: false,
      record,
      effects: [],
    });
    expect(await request("/read")).toMatchObject({ record });
  });
  it("updates a normal legacy checkpoint through the same SQLite key without losing owner or origin", async () => {
    await request("/setup", { record: legacy, seedState: "seeded" });
    expect(await request("/checkpoint", { expected: legacy, backupId: "checkpoint-next" })).toMatchObject({
      ok: true,
      record: { ...legacy, backupId: "checkpoint-next" },
      effects: [],
    });
  });
  it("holds stale owner origin and checkpoint pointers rather than overwriting newer legacy data", async () => {
    for (const record of [
      { ...legacy, owner: { ...legacy.owner, container: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } },
      { ...legacy, doorOrigin: "https://changed.test" },
      { ...legacy, backupId: "checkpoint-newer" },
    ]) {
      await request("/setup", { record, seedState: "seeded" });
      expect(await request("/checkpoint", { expected: legacy, backupId: "checkpoint-next" })).toMatchObject({
        ok: false,
        record,
        effects: [],
      });
    }
  });
  it("a late versioned record survives the original legacy seed birth callback", async () => {
    await request("/setup");
    const record = versioned("closed");
    const { container: _container, ...claim } = legacy.owner;
    const seed = {
      slug: legacy.owner.repository,
      ref: legacy.owner.ref,
      sha: legacy.owner.head,
      checkoutBackupId: legacy.owner.seed,
    };
    expect(
      await request("/seed", { seed, claim, env: { GIT_DOOR_ORIGIN: legacy.doorOrigin }, replaceOnMarker: record }),
    ).toMatchObject({ ok: true, result: { seeded: false, reason: "seed-incompatible" }, record });
    expect(await request("/read")).toMatchObject({ record });
  });
  it("keeps the original fresh legacy seed birth compatible", async () => {
    await request("/setup");
    const { container: _container, ...claim } = legacy.owner;
    const seed = {
      slug: legacy.owner.repository,
      ref: legacy.owner.ref,
      sha: legacy.owner.head,
      checkoutBackupId: legacy.owner.seed,
    };
    const answer = await request("/seed", { seed, claim, env: { GIT_DOOR_ORIGIN: legacy.doorOrigin } });
    expect(answer).toMatchObject({
      ok: true,
      result: { seeded: true },
      record: { owner: claim, doorOrigin: legacy.doorOrigin },
    });
    expect((answer.record as CheckpointRecord).owner.container).toBe(answer.result?.preservationContainer);
  });
  it("keeps unsupported lifecycle refusal and debt after disposing and restarting workerd", async () => {
    const record = versioned("closed");
    await request("/setup", { record });
    await runtime.dispose();
    runtime = await makeRuntime();
    expect(await request("/read")).toMatchObject({ record, sqlite: true });
    expect(await request("/metadata")).toMatchObject({
      ok: false,
      error: "preservation lifecycle unavailable",
      record,
      effects: [],
    });
    expect(await request("/guard")).toMatchObject({ ok: true, result: false, effects: [] });
  });
});
