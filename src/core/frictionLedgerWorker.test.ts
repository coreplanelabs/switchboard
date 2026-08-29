import { describe, expect, it } from "vitest";
import { analyzeRunFriction } from "./runFriction.js";
import { FileFrictionLedger, InMemoryFrictionLedger } from "./frictionLedger.js";
import { buildFrictionLedger, WorkerFrictionLedger } from "./frictionLedgerWorker.js";
import type { FrictionRunRecord } from "./frictionProposals.js";

// Feature: features/self-improvement.md — the DURABLE FrictionLedger: an HTTPS
// client to the FrictionDO on the state Worker (deploy/cloudflare-memory/), so
// the ledger survives bot restarts and redeploys (AGENTS.md invariant 6). Route
// contract (bearer MEMORY_TOKEN):
//   POST /friction/record {ledgerKey, record} → {ok:true}
//   POST /friction/recent {ledgerKey, limit?, sinceMs?} → {records}

const rec = (runId: string, finishedAt: number): FrictionRunRecord => ({
  runId,
  agent: "review",
  finishedAt,
  diagnosis: analyzeRunFriction([]),
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(handler: (call: Call) => { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = handler(call);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const OPTS = { baseUrl: "https://state.example/", token: "tok", ledgerKey: "friction:coreplanelabs/switchboard" };

describe("WorkerFrictionLedger", () => {
  it("record POSTs the record under the ledger key with the bearer", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
    await new WorkerFrictionLedger({ ...OPTS, fetch }).record(rec("a", 1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://state.example/friction/record"); // trailing slash trimmed
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].body).toEqual({ ledgerKey: OPTS.ledgerKey, record: rec("a", 1) });
  });

  it("record throws with the status + Worker error on non-2xx (the dispatcher logs it)", async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: { error: "record.runId must be a string" } }));
    await expect(new WorkerFrictionLedger({ ...OPTS, fetch }).record(rec("a", 1))).rejects.toThrow(/HTTP 400.*runId/);
  });

  it("recent POSTs the filters and returns only well-shaped records, oldest first", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 200,
      body: { records: [rec("b", 2), { runId: "junk" }, rec("a", 1)] },
    }));
    const out = await new WorkerFrictionLedger({ ...OPTS, fetch }).recent({ limit: 5, sinceMs: 1 });
    expect(calls[0].url).toBe("https://state.example/friction/recent");
    expect(calls[0].body).toEqual({ ledgerKey: OPTS.ledgerKey, limit: 5, sinceMs: 1 });
    expect(out.map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("recent throws on non-2xx, a non-JSON body, or a transport failure (the command reports it)", async () => {
    const l = (fetch: typeof globalThis.fetch) => new WorkerFrictionLedger({ ...OPTS, fetch });
    await expect(l(fakeFetch(() => ({ status: 503 })).fetch).recent()).rejects.toThrow(/HTTP 503/);
    await expect(l(fakeFetch(() => ({ status: 200, body: { nope: 1 } })).fetch).recent()).rejects.toThrow(/records/);
    await expect(l(fakeFetch(() => new Error("ECONNRESET")).fetch).recent()).rejects.toThrow(/ECONNRESET/);
  });
});

describe("buildFrictionLedger", () => {
  const warnings: string[] = [];
  const warn = (m: string) => void warnings.push(m);

  it("with a worker configured and its bearer present → the durable Worker ledger", () => {
    warnings.length = 0;
    const l = buildFrictionLedger(
      { repo: "o/r", worker: { baseUrl: "https://state.example" } },
      { MEMORY_TOKEN: "tok" },
      { dataDir: "/tmp/x", warn },
    );
    expect(l).toBeInstanceOf(WorkerFrictionLedger);
    expect(warnings).toEqual([]);
  });

  it("honors tokenEnv", () => {
    const l = buildFrictionLedger(
      { repo: "o/r", worker: { baseUrl: "https://state.example", tokenEnv: "LEDGER_TOKEN" } },
      { LEDGER_TOKEN: "tok" },
      { dataDir: "/tmp/x", warn },
    );
    expect(l).toBeInstanceOf(WorkerFrictionLedger);
  });

  it("with no worker → the file ledger under dataDir, with a durability warning", () => {
    warnings.length = 0;
    const l = buildFrictionLedger({ repo: "o/r" }, {}, { dataDir: "/tmp/x", warn });
    expect(l).toBeInstanceOf(FileFrictionLedger);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/host disk/);
    expect(warnings[0]).toContain("/tmp/x/friction.jsonl");
  });

  it("with a worker but no bearer → the file ledger and a warning naming the env var", () => {
    warnings.length = 0;
    const l = buildFrictionLedger({ repo: "o/r", worker: { baseUrl: "https://state.example" } }, {}, { dataDir: "/tmp/x", warn });
    expect(l).toBeInstanceOf(FileFrictionLedger);
    expect(warnings[0]).toContain("MEMORY_TOKEN");
  });

  it("no selfImprovement config at all still yields a (file) ledger — runs are always recorded", () => {
    warnings.length = 0;
    expect(buildFrictionLedger(undefined, {}, { dataDir: "/tmp/x", warn })).toBeInstanceOf(FileFrictionLedger);
    expect(new InMemoryFrictionLedger()).toBeDefined(); // the third impl stays for tests/dev
  });
});
