import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GAP_MARKER, NOTEPAD_MAX_BYTES } from "../../src/core/runLedger/sessionLog.ts";
import type { SessionLogDO } from "./worker.ts";

// Feature: docs/reference/specs/session-log.md — one SessionLogDO per thread and
// agent: the owner fence, rows at their log indices under the (idx, part)
// upsert with the full-text index kept in step, attachments by reference, the
// range read, the tail read within a byte budget cut at a turn boundary, the
// byte policy that replaces the oldest tool results first, and the drop the
// sweep issues. Runs in workerd against the real SQLite object (FTS5
// included); a unique key per test.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };
let n = 0;
const sessionKey = () => `slack:C1:${Date.now()}.${n++}:coding`;

async function post(path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...AUTH, "content-length": String(new TextEncoder().encode(raw).byteLength) },
    body: raw,
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const text = (idx: number, part: number, t: string, role: "user" | "assistant" = "user") => ({
  idx,
  part,
  json: JSON.stringify({ role, part: { type: "text", text: t } }),
});
const result = (idx: number, part: number, callId: string, t: string) => ({
  idx,
  part,
  json: JSON.stringify({ role: "user", part: { type: "tool_result", toolUseId: callId, content: t } }),
});
const stubOf = (key: string) => env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(key));
const indices = (rows: unknown) => (rows as Array<{ idx: number; part: number }>).map((r) => [r.idx, r.part]);

describe("session log object — the owner fence and the rows", () => {
  it("an empty log's tail is 0; a write before any owner is unknown-run; the owner's writes land, another generation is fenced; a range read answers rows in (idx, part) order with their attachments", async () => {
    const key = sessionKey();
    expect(await post("/runs/session/tail", { key })).toEqual({ status: 200, data: { next: 0 } });
    expect(await post("/runs/session/write", { key, gen: "g1", rows: [text(0, 0, "a")], attachments: [] })).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown-run" },
    });
    expect(await post("/runs/session/owner", { key, runId: "r1", gen: "g1" })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const written = await post("/runs/session/write", {
      key,
      gen: "g1",
      rows: [
        text(1, 0, "b", "assistant"),
        text(0, 0, "a"),
        {
          idx: 0,
          part: 1,
          json: JSON.stringify({
            role: "user",
            part: { type: "image", mediaType: "image/png", data: "", dataRef: "t0p1" },
          }),
        },
      ],
      attachments: [{ ref: "t0p1", mediaType: "image/png", data: "QUJD" }],
    });
    expect(written.status).toBe(200);
    expect(written.data.ok).toBe(true);
    expect(typeof written.data.bytes).toBe("number");
    expect(await post("/runs/session/write", { key, gen: "g2", rows: [text(2, 0, "c")], attachments: [] })).toEqual({
      status: 409,
      data: { ok: false, reason: "fenced" },
    });
    expect(await post("/runs/session/tail", { key })).toEqual({ status: 200, data: { next: 2 } });
    const read = await post("/runs/session/read", { key, from: 0 });
    expect(read.status).toBe(200);
    expect(indices(read.data.rows)).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
    expect(read.data.attachments).toEqual([{ ref: "t0p1", mediaType: "image/png", data: "QUJD" }]);
  });

  it("a range read is [from, to] inclusive and carries only the attachments its rows reference; a read past the tail is empty", async () => {
    const key = sessionKey();
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1" });
    await post("/runs/session/write", {
      key,
      gen: "g1",
      rows: [
        text(0, 0, "a"),
        {
          idx: 1,
          part: 0,
          json: JSON.stringify({
            role: "user",
            part: { type: "image", mediaType: "image/png", data: "", dataRef: "t1p0" },
          }),
        },
        text(2, 0, "c"),
        text(3, 0, "d"),
      ],
      attachments: [{ ref: "t1p0", mediaType: "image/png", data: "QUJD" }],
    });
    const middle = await post("/runs/session/read", { key, from: 1, to: 2 });
    expect(indices(middle.data.rows)).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(middle.data.attachments).toEqual([{ ref: "t1p0", mediaType: "image/png", data: "QUJD" }]);
    const late = await post("/runs/session/read", { key, from: 2 });
    expect(indices(late.data.rows)).toEqual([
      [2, 0],
      [3, 0],
    ]);
    expect(late.data.attachments).toEqual([]);
    expect((await post("/runs/session/read", { key, from: 9 })).data).toEqual({ rows: [], attachments: [] });
  });

  it("the owner moves with a later claim: g2 then writes at the tail, g1 is fenced; the owner clears itself and no one else; a cleared log refuses every write until the next claim", async () => {
    const key = sessionKey();
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1" });
    await post("/runs/session/write", { key, gen: "g1", rows: [text(0, 0, "a")], attachments: [] });
    await post("/runs/session/owner", { key, runId: "r2", gen: "g2" });
    expect(
      (await post("/runs/session/write", { key, gen: "g1", rows: [text(1, 0, "b")], attachments: [] })).status,
    ).toBe(409);
    expect(
      (await post("/runs/session/write", { key, gen: "g2", rows: [text(1, 0, "b")], attachments: [] })).status,
    ).toBe(200);
    expect(await post("/runs/session/clear-owner", { key, runId: "r1", gen: "g1" })).toEqual({
      status: 409,
      data: { ok: false, reason: "fenced" },
    });
    expect(await post("/runs/session/clear-owner", { key, runId: "r2", gen: "g2" })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(
      (await post("/runs/session/write", { key, gen: "g2", rows: [text(2, 0, "z")], attachments: [] })).data,
    ).toEqual({ ok: false, reason: "unknown-run" });
    // Nothing was cleared but the owner: the rows stay for the next run's seed.
    expect(await post("/runs/session/tail", { key })).toEqual({ status: 200, data: { next: 2 } });
    expect(await post("/runs/session/clear-owner", { key, runId: "r2", gen: "g2" })).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown-run" },
    });
  });

  it("a replaced row (a new generation overwriting a zombie's late row) is stored once and the index follows it: the old text is gone, the new one found", async () => {
    const key = sessionKey();
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1" });
    await post("/runs/session/write", {
      key,
      gen: "g1",
      rows: [
        text(0, 0, "go"),
        text(1, 0, "checking", "assistant"),
        result(2, 0, "c1", "FAIL src/x.test.ts > helper_names_it"),
      ],
      attachments: [],
    });
    const search = (q: string) =>
      runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.search(q, 5)).then((hits) =>
        hits.map((h) => [h.idx, h.part]),
      );
    expect(await search("helper_names_it")).toEqual([[2, 0]]);
    expect(await search("checking")).toEqual([[1, 0]]);
    await post("/runs/session/owner", { key, runId: "r1", gen: "g2" });
    await post("/runs/session/write", {
      key,
      gen: "g2",
      rows: [result(2, 0, "c1", "PASS src/x.test.ts > other_case")],
      attachments: [],
    });
    expect(indices((await post("/runs/session/read", { key, from: 2 })).data.rows)).toEqual([[2, 0]]);
    expect(await search("helper_names_it")).toEqual([]);
    expect(await search("other_case")).toEqual([[2, 0]]);
    const stored = await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.rowCount());
    expect(stored).toBe(3);
  });

  it("the notepad table exists and is empty until something writes it", async () => {
    const key = sessionKey();
    expect(await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.notepad())).toBeNull();
  });

  it("a malformed key, a missing generation, malformed rows or a negative index are 400", async () => {
    expect((await post("/runs/session/tail", { key: "has space" })).status).toBe(400);
    expect((await post("/runs/session/tail", {})).status).toBe(400);
    expect((await post("/runs/session/owner", { key: sessionKey(), runId: "r1" })).status).toBe(400);
    expect(
      (await post("/runs/session/write", { key: sessionKey(), gen: "g1", rows: [{ idx: "0" }], attachments: [] }))
        .status,
    ).toBe(400);
    expect((await post("/runs/session/read", { key: sessionKey(), from: -1 })).status).toBe(400);
    expect((await post("/runs/session/read-tail", { key: sessionKey(), maxBytes: 0 })).status).toBe(400);
  });
});

describe("session log object — the tail read a follow-up seeds from", () => {
  it("answers the newest whole turns within the byte budget, oldest first, naming the first index; a budget the newest turn alone exceeds answers nothing at the tail", async () => {
    const key = sessionKey();
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1" });
    const rows = [
      text(0, 0, "x".repeat(1000)),
      text(1, 0, "y".repeat(50), "assistant"),
      result(2, 0, "c1", "z".repeat(300)),
      result(2, 1, "c2", "z".repeat(300)),
      text(3, 0, "w".repeat(100), "assistant"),
    ];
    await post("/runs/session/write", { key, gen: "g1", rows, attachments: [] });
    const bytesOf = (r: { json: string }) => new TextEncoder().encode(r.json).byteLength;
    const turn3 = bytesOf(rows[4]);
    const turn2 = bytesOf(rows[2]) + bytesOf(rows[3]);
    const turn1 = bytesOf(rows[1]);
    const all = await post("/runs/session/read-tail", { key, maxBytes: 1_000_000 });
    expect(all.data.from).toBe(0);
    expect(indices(all.data.rows)).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
      [3, 0],
    ]);
    const three = await post("/runs/session/read-tail", { key, maxBytes: turn3 + turn2 + turn1 });
    expect(three.data.from).toBe(1);
    expect(indices(three.data.rows)).toEqual([
      [1, 0],
      [2, 0],
      [2, 1],
      [3, 0],
    ]);
    // One byte short of turn 2's second part: the whole turn is out, never half of it.
    const cut = await post("/runs/session/read-tail", { key, maxBytes: turn3 + turn2 - 1 });
    expect(cut.data.from).toBe(3);
    expect(indices(cut.data.rows)).toEqual([[3, 0]]);
    const none = await post("/runs/session/read-tail", { key, maxBytes: turn3 - 1 });
    expect(none.data).toEqual({ rows: [], attachments: [], from: 4 });
  });
});

describe("session log object — the byte policy and the drop", () => {
  it("over its budget the log replaces the oldest tool results first with a marker naming the drop, keeps every user and assistant text, and the index follows; a log that still exceeds after every result is replaced keeps the rest", async () => {
    const key = sessionKey();
    // A small budget through the object itself; the route clamps to the policy's floor.
    // Two 1,200-byte results and three short texts total about 2,700 bytes: a
    // 2,000-byte budget is over by one result.
    await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.setOwner("r1", "g1", 2000));
    await post("/runs/session/write", {
      key,
      gen: "g1",
      rows: [
        text(0, 0, "please run the tests"),
        text(1, 0, "running", "assistant"),
        result(2, 0, "c1", "A".repeat(1200)),
        text(3, 0, "again", "assistant"),
        result(4, 0, "c2", "B".repeat(1200)),
      ],
      attachments: [],
    });
    const after = await post("/runs/session/read", { key, from: 0 });
    const parts = (after.data.rows as Array<{ idx: number; json: string }>).map((r) => ({
      idx: r.idx,
      part: (JSON.parse(r.json) as { part: Record<string, unknown> }).part,
    }));
    expect(parts[0].part).toEqual({ type: "text", text: "please run the tests" });
    expect(parts[1].part).toEqual({ type: "text", text: "running" });
    expect(parts[2].part).toMatchObject({ type: "tool_result", toolUseId: "c1" });
    expect(String(parts[2].part.content)).toMatch(/dropped/);
    expect(parts[3].part).toEqual({ type: "text", text: "again" });
    // The newest result fit once the oldest was replaced.
    expect(parts[4].part).toEqual({ type: "tool_result", toolUseId: "c2", content: "B".repeat(1200) });
    const hits = await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.search("dropped", 5));
    expect(hits.map((h) => h.idx)).toEqual([2]);
    const bytes = await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.bytes());
    expect(bytes).toBeLessThanOrEqual(2000);

    // Text alone over the budget: nothing more is dropped.
    const key2 = sessionKey();
    await runInDurableObject(stubOf(key2), (inst: SessionLogDO) => inst.setOwner("r1", "g1", 200));
    await post("/runs/session/write", {
      key: key2,
      gen: "g1",
      rows: [text(0, 0, "u".repeat(300)), text(1, 0, "a".repeat(300), "assistant")],
      attachments: [],
    });
    const kept = await post("/runs/session/read", { key: key2, from: 0 });
    expect((kept.data.rows as Array<{ json: string }>).map((r) => JSON.parse(r.json).part.text.length)).toEqual([
      300, 300,
    ]);
  });

  it("a trimmed result's attachments go with it when nothing else references them, so a log whose bytes are mostly such an attachment converges under the budget; an attachment another row still references stays", async () => {
    const imageResult = (idx: number, callId: string, ref: string, caption: string) => ({
      idx,
      part: 0,
      json: JSON.stringify({
        role: "user",
        part: {
          type: "tool_result",
          toolUseId: callId,
          content: [
            { type: "text", text: caption },
            { type: "image", mediaType: "image/png", data: "", dataRef: ref },
          ],
        },
      }),
    });
    const partsOf = async (key: string) =>
      ((await post("/runs/session/read", { key, from: 0 })).data.rows as Array<{ json: string }>).map(
        (r) => (JSON.parse(r.json) as { part: Record<string, unknown> }).part,
      );
    const refsOf = (key: string) => runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.attachmentRefs());
    const bytesOf = (key: string) => runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.bytes());

    // A 4,000-byte screenshot referenced only by a 150-byte result: the result's
    // reclaimable bytes are the attachment's too, so the plan takes it and the
    // log converges well under a 2,500-byte budget.
    const sole = sessionKey();
    await runInDurableObject(stubOf(sole), (inst: SessionLogDO) => inst.setOwner("r1", "g1", 2500));
    await post("/runs/session/write", {
      key: sole,
      gen: "g1",
      rows: [
        text(0, 0, "look at the page"),
        text(1, 0, "capturing", "assistant"),
        imageResult(2, "c1", "t2p0", "a screenshot"),
      ],
      attachments: [{ ref: "t2p0", mediaType: "image/png", data: "A".repeat(4000) }],
    });
    const trimmed = await partsOf(sole);
    expect(String(trimmed[2].content)).toMatch(/dropped/);
    expect(await refsOf(sole)).toEqual([]);
    expect(await bytesOf(sole)).toBeLessThanOrEqual(2500);

    // The user's own image at row 1 and a result at row 2 that shows it again:
    // the result is trimmed, the attachment stays for row 1, and the log rests
    // over budget on what is never dropped.
    const shared = sessionKey();
    await runInDurableObject(stubOf(shared), (inst: SessionLogDO) => inst.setOwner("r1", "g1", 1200));
    await post("/runs/session/write", {
      key: shared,
      gen: "g1",
      rows: [
        text(0, 0, "what is in this picture"),
        {
          idx: 1,
          part: 0,
          json: JSON.stringify({
            role: "user",
            part: { type: "image", mediaType: "image/png", data: "", dataRef: "t1p0" },
          }),
        },
        imageResult(2, "c2", "t1p0", "x".repeat(600)),
      ],
      attachments: [{ ref: "t1p0", mediaType: "image/png", data: "B".repeat(1200) }],
    });
    const kept = await partsOf(shared);
    expect(String(kept[2].content)).toMatch(/dropped/);
    expect(kept[1]).toMatchObject({ type: "image", dataRef: "t1p0" });
    expect(await refsOf(shared)).toEqual(["t1p0"]);
    expect((await post("/runs/session/read", { key: shared, from: 1, to: 1 })).data.attachments).toEqual([
      { ref: "t1p0", mediaType: "image/png", data: "B".repeat(1200) },
    ]);
    expect(await bytesOf(shared)).toBeGreaterThan(1200);
  });

  it("the owner route clamps the byte budget into the policy's bounds", async () => {
    const key = sessionKey();
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1", maxBytes: 1 });
    expect(await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.maxBytes())).toBe(16 * 1024 * 1024);
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1" });
    expect(await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.maxBytes())).toBe(200 * 1024 * 1024);
  });

  it("drop clears the owner and every row, attachment and index entry; the next claim starts an empty log at 0", async () => {
    const key = sessionKey();
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1" });
    await post("/runs/session/write", {
      key,
      gen: "g1",
      rows: [
        text(0, 0, "keep searching"),
        {
          idx: 1,
          part: 0,
          json: JSON.stringify({
            role: "user",
            part: { type: "image", mediaType: "image/png", data: "", dataRef: "t1p0" },
          }),
        },
      ],
      attachments: [{ ref: "t1p0", mediaType: "image/png", data: "QUJD" }],
    });
    await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.drop());
    expect(
      (await post("/runs/session/write", { key, gen: "g1", rows: [text(2, 0, "z")], attachments: [] })).data,
    ).toEqual({
      ok: false,
      reason: "unknown-run",
    });
    expect(await post("/runs/session/tail", { key })).toEqual({ status: 200, data: { next: 0 } });
    expect((await post("/runs/session/read", { key, from: 0 })).data).toEqual({ rows: [], attachments: [] });
    expect(await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.search("searching", 5))).toEqual([]);
    expect(await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.bytes())).toBe(0);
    expect((await post("/runs/session/notepad", { key })).data).toEqual({ notepad: null });
  });
});

// docs/reference/specs/session-log.md item 10: what `recall` and `notes` read
// and write — the search in relevance order with each hit's turn and role, the
// gap rows a search straddles, and the notepad under the owner's fence.
describe("session log object — the search recall reads and the notepad notes writes", () => {
  it("the search route answers hits in relevance order — a row matching two of the query's words ahead of an older row matching one — each with its turn, part, role, kind and text", async () => {
    const key = sessionKey();
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1" });
    await post("/runs/session/write", {
      key,
      gen: "g1",
      rows: [
        text(0, 0, "please fix the flaky lockfile test"),
        text(1, 0, "the lockfile itself is fine", "assistant"),
        result(2, 0, "c1", "1 failed: lockfile.test.ts"),
        text(3, 0, "unrelated remark"),
      ],
      attachments: [],
    });
    const { status, data } = await post("/runs/session/search", { key, query: "flaky lockfile", limit: 5 });
    expect(status).toBe(200);
    const hits = data.hits as Array<{ idx: number; part: number; role?: string; kind: string; text: string }>;
    // The two-word match leads whatever its age; the two one-word matches follow in bm25's order, not the log's.
    expect(hits[0]).toEqual({
      idx: 0,
      part: 0,
      role: "user",
      kind: "text",
      text: "please fix the flaky lockfile test",
    });
    expect(
      hits
        .slice(1)
        .map((h) => h.idx)
        .sort(),
    ).toEqual([1, 2]);
    const byIdx = new Map(hits.map((h) => [h.idx, h]));
    expect(byIdx.get(1)).toMatchObject({ role: "assistant", kind: "text" });
    expect(byIdx.get(2)).toMatchObject({ role: "user", kind: "tool_result" });
    expect(data.gaps).toEqual([]);
    expect((await post("/runs/session/search", { key, query: "flaky lockfile", limit: 1 })).data.hits).toHaveLength(1);
  });

  it("a search that straddles a gap marker names the gap's turn; hits on one side of it name none", async () => {
    const key = sessionKey();
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1" });
    await post("/runs/session/write", {
      key,
      gen: "g1",
      rows: [text(0, 0, "alpha one"), text(1, 0, GAP_MARKER), text(2, 0, "alpha two"), text(3, 0, "beta")],
      attachments: [],
    });
    const straddling = (await post("/runs/session/search", { key, query: "alpha", limit: 5 })).data;
    expect((straddling.hits as Array<{ idx: number }>).map((h) => h.idx).sort()).toEqual([0, 2]);
    expect(straddling.gaps).toEqual([1]);
    const oneSide = (await post("/runs/session/search", { key, query: "beta", limit: 5 })).data;
    expect((oneSide.hits as Array<{ idx: number }>).map((h) => h.idx)).toEqual([3]);
    expect(oneSide.gaps).toEqual([]);
  });

  it("the notepad is written whole under the owner's fence and read back with its time: unknown-run before an owner, fenced for another generation, 400 over the size naming it", async () => {
    const key = sessionKey();
    expect(await post("/runs/session/notepad/write", { key, gen: "g1", text: "first note" })).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown-run" },
    });
    await post("/runs/session/owner", { key, runId: "r1", gen: "g1" });
    expect((await post("/runs/session/notepad/write", { key, gen: "g1", text: "first note" })).data).toEqual({
      ok: true,
    });
    const read = (await post("/runs/session/notepad", { key })).data as {
      notepad: { text: string; updatedAt: number };
    };
    expect(read.notepad.text).toBe("first note");
    expect(typeof read.notepad.updatedAt).toBe("number");
    expect(await post("/runs/session/notepad/write", { key, gen: "g2", text: "zombie" })).toEqual({
      status: 409,
      data: { ok: false, reason: "fenced" },
    });
    expect((await post("/runs/session/notepad/write", { key, gen: "g1", text: "second note" })).data).toEqual({
      ok: true,
    });
    expect(((await post("/runs/session/notepad", { key })).data as { notepad: { text: string } }).notepad.text).toBe(
      "second note",
    );
    const over = await post("/runs/session/notepad/write", { key, gen: "g1", text: "x".repeat(NOTEPAD_MAX_BYTES + 1) });
    expect(over.status).toBe(400);
    expect(String(over.data.error)).toContain(String(NOTEPAD_MAX_BYTES));
    expect(await runInDurableObject(stubOf(key), (inst: SessionLogDO) => inst.notepad())).toMatchObject({
      text: "second note",
    });
  });

  it("a search with no words, a non-integer limit and a notepad write without text are 400", async () => {
    const key = sessionKey();
    expect((await post("/runs/session/search", { key, query: "   ", limit: 5 })).status).toBe(400);
    expect((await post("/runs/session/search", { key, query: "alpha", limit: 0 })).status).toBe(400);
    expect((await post("/runs/session/notepad/write", { key, gen: "g1" })).status).toBe(400);
  });
});
