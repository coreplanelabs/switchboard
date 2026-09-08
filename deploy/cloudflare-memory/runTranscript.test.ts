import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Feature: docs/reference/specs/run-history.md item 32 — one RunTranscriptDO per live run:
// the owner fence, part rows and attachments written and read back verbatim,
// clear. Runs in workerd against the real SQLite object; a unique run id per test.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };
let n = 0;
const runId = () => `tr-${Date.now()}-${n++}`;

async function post(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...AUTH, "content-length": String(new TextEncoder().encode(raw).byteLength) },
    body: raw,
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const row = (idx: number, part: number, text: string) => ({
  idx,
  part,
  json: JSON.stringify({ role: "user", part: { type: "text", text } }),
});

describe("run transcript object", () => {
  it("a write before any owner is set is unknown-run; after owner g1, g1 writes and g2 is fenced; read returns rows in (idx, part) order and attachments", async () => {
    const id = runId();
    expect(
      await post("/runs/transcript/write", { runId: id, gen: "g1", rows: [row(0, 0, "a")], attachments: [] }),
    ).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown-run" },
    });
    expect(await post("/runs/transcript/owner", { runId: id, gen: "g1" })).toEqual({ status: 200, data: { ok: true } });
    expect(
      await post("/runs/transcript/write", {
        runId: id,
        gen: "g1",
        rows: [row(1, 0, "b"), row(0, 0, "a"), row(0, 1, "a2")],
        attachments: [{ ref: "t0p1", mediaType: "image/png", data: "QUJD" }],
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect(
      await post("/runs/transcript/write", { runId: id, gen: "g2", rows: [row(2, 0, "c")], attachments: [] }),
    ).toEqual({
      status: 409,
      data: { ok: false, reason: "fenced" },
    });
    const read = await post("/runs/transcript/read", { runId: id });
    expect(read.status).toBe(200);
    expect((read.data.rows as Array<{ idx: number; part: number }>).map((r) => [r.idx, r.part])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
    expect(read.data.attachments).toEqual([{ ref: "t0p1", mediaType: "image/png", data: "QUJD" }]);
  });

  it("owner is replaced by a later reclaim: g2 then writes, g1 is fenced; clear empties rows, attachments and the owner", async () => {
    const id = runId();
    await post("/runs/transcript/owner", { runId: id, gen: "g1" });
    await post("/runs/transcript/write", { runId: id, gen: "g1", rows: [row(0, 0, "a")], attachments: [] });
    await post("/runs/transcript/owner", { runId: id, gen: "g2" });
    expect(
      (await post("/runs/transcript/write", { runId: id, gen: "g1", rows: [row(1, 0, "b")], attachments: [] })).status,
    ).toBe(409);
    expect(
      (await post("/runs/transcript/write", { runId: id, gen: "g2", rows: [row(1, 0, "b")], attachments: [] })).status,
    ).toBe(200);
    expect(await post("/runs/transcript/clear", { runId: id })).toEqual({ status: 200, data: { ok: true } });
    expect(await post("/runs/transcript/read", { runId: id })).toEqual({
      status: 200,
      data: { rows: [], attachments: [] },
    });
    expect(
      (await post("/runs/transcript/write", { runId: id, gen: "g2", rows: [row(0, 0, "z")], attachments: [] })).data,
    ).toEqual({ ok: false, reason: "unknown-run" });
  });

  it("a 1.4 MB part row is accepted under the 2 MiB body fence; malformed rows or attachments are 400; a bad run id is 400", async () => {
    const id = runId();
    await post("/runs/transcript/owner", { runId: id, gen: "g1" });
    const big = row(0, 0, "x".repeat(1_400_000));
    expect((await post("/runs/transcript/write", { runId: id, gen: "g1", rows: [big], attachments: [] })).status).toBe(
      200,
    );
    expect(
      (await post("/runs/transcript/write", { runId: id, gen: "g1", rows: [{ idx: "0" }], attachments: [] })).status,
    ).toBe(400);
    expect(
      (await post("/runs/transcript/write", { runId: id, gen: "g1", rows: [], attachments: [{ ref: "r" }] })).status,
    ).toBe(400);
    expect((await post("/runs/transcript/read", { runId: "bad id!" })).status).toBe(400);
  });
});
