import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config.js";
import type { CoreDeps } from "../core/dispatcher.js";
import { InMemoryFrictionLedger } from "../core/frictionLedger.js";
import type { FrictionRunRecord } from "../core/frictionProposals.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent } from "../core/runEvents.js";
import { InMemoryIssueTracker } from "../execution/githubIssues.js";
import { createFrictionTriggerHandler, handleFrictionTrigger, parseFrictionTriggerToken } from "./frictionTrigger.js";

// Feature: features/self-improvement.md — the SCHEDULED trigger of the
// self-improvement step: `POST /friction/propose` on the bot's HTTP server,
// behind a dedicated bearer (FRICTION_TRIGGER_TOKEN) the Worker shim's weekly
// cron presents. Fail-closed without the token; same step the chat command
// runs; the response is the report so the caller can log it.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function config(extra = ""): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "friction-trigger-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "config.yaml"),
    `
providers:
  fake: { type: anthropic, apiKeyEnv: X }
defaults:
  agent: general
  models: { general: fake/m }
${extra}
`,
  );
  return new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
}

const WITH_REPO = `
selfImprovement:
  repo: coreplanelabs/switchboard
`;

let t = 0;
const at = (ms: number) => (t += ms);
const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary, at: at(10) });
const result = (ok: boolean, summary: string, ms: number): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary, at: at(ms) });
function lockfileRun(runId: string, finishedAt: number): FrictionRunRecord {
  t = 0;
  return {
    runId,
    agent: "coding",
    finishedAt,
    diagnosis: analyzeRunFriction([call("$ pnpm install --frozen-lockfile"), result(false, "ERR_PNPM_OUTDATED_LOCKFILE", 45_000)]),
  };
}
async function seeded() {
  const ledger = new InMemoryFrictionLedger();
  await ledger.record(lockfileRun("r1", 1));
  await ledger.record(lockfileRun("r2", 2));
  return ledger;
}

async function depsWith(extra = WITH_REPO): Promise<CoreDeps & { issueTracker: InMemoryIssueTracker }> {
  return {
    config: config(extra),
    providers: {} as CoreDeps["providers"],
    frictionLedger: await seeded(),
    issueTracker: new InMemoryIssueTracker(),
  };
}

const bearer = (token: string): IncomingHttpHeaders => ({ authorization: `Bearer ${token}` });

describe("handleFrictionTrigger", () => {
  it("with no token configured it is fail-closed: 503, nothing runs", async () => {
    const deps = await depsWith();
    const r = await handleFrictionTrigger({ method: "POST", headers: bearer("x"), body: "" }, deps, { token: undefined });
    expect(r.status).toBe(503);
    expect(deps.issueTracker.calls).toEqual([]);
  });

  it("rejects a missing or wrong bearer with 401 (constant-time compare), and non-POST with 405", async () => {
    const deps = await depsWith();
    expect((await handleFrictionTrigger({ method: "POST", headers: {}, body: "" }, deps, { token: "secret" })).status).toBe(401);
    expect((await handleFrictionTrigger({ method: "POST", headers: bearer("nope"), body: "" }, deps, { token: "secret" })).status).toBe(401);
    expect((await handleFrictionTrigger({ method: "POST", headers: bearer("secreT"), body: "" }, deps, { token: "secret" })).status).toBe(401);
    expect((await handleFrictionTrigger({ method: "GET", headers: bearer("secret"), body: "" }, deps, { token: "secret" })).status).toBe(405);
    expect(deps.issueTracker.calls).toEqual([]);
  });

  it("runs the self-improvement step and files through the injected tracker; the response carries the report", async () => {
    const deps = await depsWith();
    const r = await handleFrictionTrigger({ method: "POST", headers: bearer("secret"), body: "" }, deps, { token: "secret" });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; runsAnalyzed: number; filed: string[]; duplicates: string[]; failed: string[]; text: string };
    expect(body.ok).toBe(true);
    expect(body.runsAnalyzed).toBe(2);
    expect(body.filed).toEqual(["https://github.com/coreplanelabs/switchboard/issues/1"]);
    expect(body.text).toContain("2 runs analyzed");
    expect(deps.issueTracker.issues("coreplanelabs/switchboard")).toHaveLength(1);
    // Second trigger: deduped, nothing new.
    const again = await handleFrictionTrigger({ method: "POST", headers: bearer("secret"), body: "" }, deps, { token: "secret" });
    expect((again.body as { filed: string[]; duplicates: string[] }).filed).toEqual([]);
    expect((again.body as { duplicates: string[] }).duplicates).toHaveLength(1);
  });

  it("honors a JSON body {dryRun:true} — computes, files nothing", async () => {
    const deps = await depsWith();
    const r = await handleFrictionTrigger(
      { method: "POST", headers: bearer("secret"), body: JSON.stringify({ dryRun: true }) },
      deps,
      { token: "secret" },
    );
    expect(r.status).toBe(200);
    expect((r.body as { dryRun: boolean }).dryRun).toBe(true);
    expect(deps.issueTracker.issues("coreplanelabs/switchboard")).toEqual([]);
  });

  it("a malformed body is 400; nothing runs", async () => {
    const deps = await depsWith();
    const r = await handleFrictionTrigger({ method: "POST", headers: bearer("secret"), body: "{not json" }, deps, { token: "secret" });
    expect(r.status).toBe(400);
    expect(deps.issueTracker.calls).toEqual([]);
  });

  it("without selfImprovement.repo or a ledger it is 503 with a reason", async () => {
    const noRepo = await depsWith("");
    const r1 = await handleFrictionTrigger({ method: "POST", headers: bearer("secret"), body: "" }, noRepo, { token: "secret" });
    expect(r1.status).toBe(503);
    expect(String((r1.body as { error: string }).error)).toContain("selfImprovement.repo");
    const noLedger = { ...(await depsWith()), frictionLedger: undefined };
    const r2 = await handleFrictionTrigger({ method: "POST", headers: bearer("secret"), body: "" }, noLedger, { token: "secret" });
    expect(r2.status).toBe(503);
    expect(String((r2.body as { error: string }).error)).toMatch(/ledger/);
  });

  it("a ledger failure is a 500 with the error, never a crash", async () => {
    const deps = await depsWith();
    deps.frictionLedger = {
      record: async () => {},
      recent: async () => {
        throw new Error("worker down");
      },
    };
    const r = await handleFrictionTrigger({ method: "POST", headers: bearer("secret"), body: "" }, deps, { token: "secret" });
    expect(r.status).toBe(500);
    expect(String((r.body as { error: string }).error)).toContain("worker down");
  });
});

describe("createFrictionTriggerHandler (node:http wrapper)", () => {
  function fakeReqRes(method: string, headers: IncomingHttpHeaders, body: string) {
    async function* iter() {
      yield Buffer.from(body, "utf8");
    }
    const req = Object.assign(iter(), { method, headers, destroy: vi.fn() });
    let statusCode = 0;
    let payload = "";
    const res = {
      writeHead: (code: number) => {
        statusCode = code;
      },
      end: (chunk?: string) => {
        payload = chunk ?? "";
      },
    };
    return {
      req: req as unknown as Parameters<ReturnType<typeof createFrictionTriggerHandler>>[0],
      res: res as unknown as Parameters<ReturnType<typeof createFrictionTriggerHandler>>[1],
      status: () => statusCode,
      json: () => JSON.parse(payload) as Record<string, unknown>,
    };
  }

  it("reads the body, runs the step, writes JSON; unauthorized never reads the body", async () => {
    const deps = await depsWith();
    const handler = createFrictionTriggerHandler(deps, { token: "secret" });
    const ok = fakeReqRes("POST", bearer("secret"), JSON.stringify({ dryRun: true }));
    handler(ok.req, ok.res);
    await vi.waitFor(() => expect(ok.status()).toBe(200));
    expect(ok.json().dryRun).toBe(true);
    const bad = fakeReqRes("POST", bearer("wrong"), "{}");
    handler(bad.req, bad.res);
    await vi.waitFor(() => expect(bad.status()).toBe(401));
  });
});

describe("parseFrictionTriggerToken", () => {
  it("reads FRICTION_TRIGGER_TOKEN, trimmed; blank/absent → undefined (route disabled)", () => {
    expect(parseFrictionTriggerToken({ FRICTION_TRIGGER_TOKEN: " abc " })).toBe("abc");
    expect(parseFrictionTriggerToken({ FRICTION_TRIGGER_TOKEN: "  " })).toBeUndefined();
    expect(parseFrictionTriggerToken({})).toBeUndefined();
  });
});
