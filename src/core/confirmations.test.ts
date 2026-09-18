import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "./types.js";
import {
  confirmationFooter,
  confirmationMessageOf,
  FileConfirmationStore,
  InMemoryConfirmationStore,
  isConfirmation,
  parseConfirmation,
  parsePendingConfirmation,
  renderOffer,
  WorkerConfirmationStore,
  type Confirmation,
  type ConfirmationStore,
  type PendingConfirmation,
  type RunConfirmation,
} from "./confirmations.js";

// Feature: docs/reference/specs/routing-and-config.md item 25 — where the
// confirmation a routed write is offered as lives: one contract, three stores
// (the config object's client, a file, memory), the same answers from each.

const message: IncomingMessage = {
  channelId: "slack:CX",
  userId: "slack:UREQ",
  threadKey: "slack:CX:1.0",
  text: "use opus for coding in this channel",
  userName: "requester",
};

const pending = (id: string, over: Partial<Omit<RunConfirmation, "expiresAt">> = {}): PendingConfirmation => ({
  kind: "run",
  id,
  message,
  command: "config.set",
  input: { args: ["channel"], options: { models: { coding: "anthropic/claude-opus-5" } } },
  receipt: "config set channel --models.coding anthropic/claude-opus-5",
  risk: "changes the scope's settings for everyone in it until reset",
  footer: "confirmation required by the built-in default",
  model: "anthropic/general-model",
  ...over,
});

const TTL = 600_000;

/** The contract every store answers: the clock is the store's own, advanced by the test. */
function contract(name: string, make: () => { store: ConfirmationStore; tick: (ms: number) => void }) {
  describe(name, () => {
    it("put stamps the expiry from the ttl on the store's clock and answers the row; consume returns it once for the requester, then `used`", async () => {
      const { store } = make();
      const row = await store.put(pending("c1"), TTL);
      expect(row).toEqual({ ...pending("c1"), expiresAt: row.expiresAt });
      expect(row.expiresAt).toBeGreaterThan(0);
      const consumed = await store.consume("c1", ["slack:UREQ"]);
      expect(consumed).toEqual({ ok: true, row });
      expect(await store.consume("c1", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
      expect(typeof store.describe()).toBe("string");
    });

    it("a row past its expiry is `expired` on touch — the refusal names the row it deleted — and gone afterwards", async () => {
      const { store, tick } = make();
      const row = await store.put(pending("c2"), TTL);
      tick(TTL - 1);
      expect((await store.consume("c2", ["slack:UOTHER"])).ok).toBe(false); // still pending: foreign, not expired
      tick(1);
      expect(await store.consume("c2", ["slack:UREQ"])).toEqual({ ok: false, refused: "expired", row });
      expect(await store.consume("c2", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
      expect(row.expiresAt).toBeGreaterThan(0);
    });

    it("an actor whose ids miss the requester is `foreign` — the refusal names the row — and the row stays; the requester's id anywhere in the list consumes", async () => {
      const { store } = make();
      const row = await store.put(pending("c3"), TTL);
      expect(await store.consume("c3", ["slack:UOTHER"])).toEqual({ ok: false, refused: "foreign", row });
      expect(await store.consume("c3", ["access:sub-1"])).toEqual({ ok: false, refused: "foreign", row });
      expect((await store.consume("c3", ["access:sub-1", "slack:UREQ"])).ok).toBe(true);
    });

    it("a thread holds one pending confirmation: a new put replaces the thread's older row and leaves another thread's alone", async () => {
      const { store } = make();
      await store.put(pending("other", { message: { ...message, threadKey: "slack:CY:2.0" } }), TTL);
      await store.put(pending("first"), TTL);
      await store.put(pending("second"), TTL);
      expect(await store.consume("first", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
      expect((await store.consume("second", ["slack:UREQ"])).ok).toBe(true);
      expect((await store.consume("other", ["slack:UREQ"])).ok).toBe(true);
    });

    it("cancel deletes under the requester check; a cancel and a consume on one id cannot both succeed, in either order", async () => {
      const { store } = make();
      await store.put(pending("c5"), TTL);
      expect(await store.cancel("c5", ["slack:UOTHER"])).toEqual({ ok: false, refused: "foreign" });
      expect(await store.cancel("c5", ["slack:UREQ"])).toEqual({ ok: true });
      expect(await store.consume("c5", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
      expect(await store.cancel("c5", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
      await store.put(pending("c6"), TTL);
      expect((await store.consume("c6", ["slack:UREQ"])).ok).toBe(true);
      expect(await store.cancel("c6", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
    });

    it("cancelByThread deletes the thread's pending row under the requester check; a thread with none is `used` and another thread's row stays", async () => {
      const { store } = make();
      expect(await store.cancelByThread("slack:CX:1.0", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
      await store.put(pending("other", { message: { ...message, threadKey: "slack:CY:2.0" } }), TTL);
      await store.put(pending("c7"), TTL);
      expect(await store.cancelByThread("slack:CX:1.0", ["slack:UOTHER"])).toEqual({ ok: false, refused: "foreign" });
      expect(await store.cancelByThread("slack:CX:1.0", ["slack:UREQ"])).toEqual({ ok: true });
      expect(await store.consume("c7", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
      expect((await store.consume("other", ["slack:UREQ"])).ok).toBe(true);
    });

    it("a question's redispatch row round-trips whole: put, consume for the requester, the same fields back", async () => {
      const { store } = make();
      const row = await store.put(
        {
          kind: "redispatch",
          id: "q1",
          message: { ...message, text: "agent:ship repo:acme/api fix the flaky test" },
          line: "agent:ship repo:acme/api fix the flaky test",
          evidence: "acme/api is one edit away from acme/apj, which is onboarded",
          code: "repo_not_onboarded",
        },
        TTL,
      );
      expect(row.kind).toBe("redispatch");
      const consumed = await store.consume("q1", ["slack:UREQ"]);
      expect(consumed).toEqual({ ok: true, row });
      expect(await store.consume("q1", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
    });
  });
}

function withClock() {
  let now = 1_000_000;
  return { clock: () => now, tick: (ms: number) => void (now += ms) };
}

contract("InMemoryConfirmationStore", () => {
  const { clock, tick } = withClock();
  return { store: new InMemoryConfirmationStore({ clock }), tick };
});

contract("FileConfirmationStore", () => {
  const { clock, tick } = withClock();
  const path = join(mkdtempSync(join(tmpdir(), "swb-confirmations-")), "confirmations.json");
  return { store: new FileConfirmationStore(path, { clock }), tick };
});

/** The config object's client over a scripted fetch that plays the object: the
 *  same contract, with the Worker's answers shaped as the routes answer them. */
contract("WorkerConfirmationStore over a scripted object", () => {
  const { clock, tick } = withClock();
  const rows = new Map<string, { threadKey: string; requester: string; expiresAt: number; body: unknown }>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const answer = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/config/confirmations/put") {
      for (const [id, r] of rows) if (r.threadKey === b.threadKey) rows.delete(id);
      const expiresAt = clock() + (b.ttlMs as number);
      rows.set(b.id as string, {
        threadKey: b.threadKey as string,
        requester: b.requester as string,
        expiresAt,
        body: b.body,
      });
      return answer({ ok: true, expiresAt });
    }
    const actorIds = b.actorIds as string[];
    // The cancel-by-thread route: the thread's row under the same requester check.
    const id =
      path === "/config/confirmations/cancel-by-thread"
        ? [...rows.entries()].find(([, r]) => r.threadKey === b.threadKey)?.[0]
        : (b.id as string);
    const stored = id === undefined ? undefined : rows.get(id);
    if (id === undefined || !stored) return answer({ refused: "used" });
    if (path === "/config/confirmations/consume" && stored.expiresAt <= clock()) {
      rows.delete(id);
      return answer({ refused: "expired", row: { id, ...stored } });
    }
    if (!actorIds.includes(stored.requester))
      return answer(
        path === "/config/confirmations/consume"
          ? { refused: "foreign", row: { id, ...stored } }
          : { refused: "foreign" },
      );
    rows.delete(id);
    return answer(path === "/config/confirmations/consume" ? { row: { id, ...stored } } : { ok: true });
  };
  return {
    store: new WorkerConfirmationStore({ baseUrl: "https://memory.test/", token: "tok", fetch: fetchImpl }),
    tick,
  };
});

describe("WorkerConfirmationStore (the ConfigDO confirmations client)", () => {
  function fake(routes: Record<string, (body: Record<string, unknown>) => unknown>, status = 200) {
    const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
      const handler = routes[url.pathname];
      if (!handler) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(handler(body)), { status, headers: { "content-type": "application/json" } });
    };
    return {
      calls,
      store: new WorkerConfirmationStore({ baseUrl: "https://memory.test/", token: "tok", fetch: fetchImpl }),
    };
  }

  it("speaks the route contract with the bearer: the thread and the requester are lifted off the message, the ttl travels and the object's expiry comes back", async () => {
    const { calls, store } = fake({
      "/config/confirmations/put": () => ({ ok: true, expiresAt: 4_200_000 }),
      "/config/confirmations/consume": (b) => ({
        row: {
          id: b.id,
          threadKey: "slack:CX:1.0",
          requester: "slack:UREQ",
          expiresAt: 4_200_000,
          body: pending("c1"),
        },
      }),
      "/config/confirmations/cancel": () => ({ ok: true }),
    });
    const row = await store.put(pending("c1"), TTL);
    expect(row).toEqual({ ...pending("c1"), expiresAt: 4_200_000 });
    expect(await store.consume("c1", ["slack:UREQ", "access:sub"])).toEqual({ ok: true, row });
    expect(await store.cancel("c1", ["slack:UREQ"])).toEqual({ ok: true });
    expect(calls.map((c) => c.path)).toEqual([
      "/config/confirmations/put",
      "/config/confirmations/consume",
      "/config/confirmations/cancel",
    ]);
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(calls[0]!.body).toEqual({
      id: "c1",
      threadKey: "slack:CX:1.0",
      requester: "slack:UREQ",
      body: pending("c1"),
      ttlMs: TTL,
    });
    expect(calls[1]!.body).toEqual({ id: "c1", actorIds: ["slack:UREQ", "access:sub"] });
    expect(store.describe()).toContain("memory.test");
  });

  it("a refusal the object names is answered as one; an answer outside the contract, a non-2xx and a transport failure throw naming the store", async () => {
    const refusing = fake({
      "/config/confirmations/consume": () => ({ refused: "foreign" }),
      "/config/confirmations/cancel": () => ({ refused: "used" }),
    });
    expect(await refusing.store.consume("c1", ["slack:UOTHER"])).toEqual({ ok: false, refused: "foreign" });
    expect(await refusing.store.cancel("c1", ["slack:UOTHER"])).toEqual({ ok: false, refused: "used" });
    // A refusal beside which the object still names the row (expired, foreign)
    // answers the row too, so the click's refusal can be recorded; a malformed
    // row beside a refusal is dropped, never a thrown consume.
    const refusingWithRow = fake({
      "/config/confirmations/consume": (b) => ({
        refused: "expired",
        row: {
          id: b.id,
          threadKey: "slack:CX:1.0",
          requester: "slack:UREQ",
          expiresAt: 4_200_000,
          body: pending("c1"),
        },
      }),
    });
    expect(await refusingWithRow.store.consume("c1", ["slack:UREQ"])).toEqual({
      ok: false,
      refused: "expired",
      row: { ...pending("c1"), expiresAt: 4_200_000 },
    });
    const refusingMalformedRow = fake({
      "/config/confirmations/consume": () => ({ refused: "foreign", row: { body: { command: 7 } } }),
    });
    expect(await refusingMalformedRow.store.consume("c1", ["slack:UOTHER"])).toEqual({
      ok: false,
      refused: "foreign",
    });
    const malformed = fake({
      "/config/confirmations/consume": () => ({ row: { id: "c1", body: { command: 7 } } }),
      "/config/confirmations/put": () => ({ ok: true }),
    });
    await expect(malformed.store.consume("c1", ["slack:UREQ"])).rejects.toThrow(/confirmation store/);
    await expect(malformed.store.put(pending("c1"), TTL)).rejects.toThrow(/confirmation store/);
    const down = fake({ "/config/confirmations/put": () => ({ error: "unavailable" }) }, 503);
    await expect(down.store.put(pending("c1"), TTL)).rejects.toThrow(/confirmation store answered HTTP 503/);
    const unreachable = new WorkerConfirmationStore({
      baseUrl: "https://memory.test",
      token: "tok",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(unreachable.consume("c1", ["slack:UREQ"])).rejects.toThrow(/confirmation store unreachable/);
  });
});

describe("the offer's words and the stored message", () => {
  it("confirmationFooter names the scope that asked, the built-in default included", () => {
    expect(confirmationFooter("channel")).toBe("confirmation required by this channel's boundary");
    expect(confirmationFooter("user")).toBe("confirmation required by your boundary");
    expect(confirmationFooter("defaults")).toBe("confirmation required by the defaults' boundary");
    expect(confirmationFooter("built-in")).toBe("confirmation required by the built-in default");
  });

  it("renderOffer is the offer as a channel without components would read it: the line, the risk when there is one, the footer", () => {
    expect(
      renderOffer({
        id: "c1",
        line: "config set channel --x y",
        risk: "changes it",
        footer: "confirmation required by the built-in default",
        expiresAt: 1,
      }),
    ).toBe("config set channel --x y\nchanges it\nconfirmation required by the built-in default");
    expect(renderOffer({ id: "c1", line: "mcp remove linear", risk: "", footer: "f", expiresAt: 1 })).toBe(
      "mcp remove linear\nf",
    );
  });

  it("renderOffer on a question's offer reads as the question the renderer would have typed: the sentence, the marker, the line as code, the evidence", () => {
    expect(
      renderOffer({
        id: "q1",
        line: "agent:ship repo:acme/api fix it",
        risk: "",
        footer: "",
        expiresAt: 1,
        question: {
          text: "acme/api is not onboarded here.",
          evidence: "acme/api is one edit away from acme/apj, which is onboarded",
        },
      }),
    ).toBe(
      "acme/api is not onboarded here.\nDid you mean:\n`agent:ship repo:acme/api fix it`\n\nacme/api is one edit away from acme/apj, which is onboarded",
    );
  });

  it("confirmationMessageOf keeps the identity, thread and relay fields the typed path reads and drops the sentence's attachments", () => {
    const full: IncomingMessage = {
      ...message,
      relayedBy: "an app",
      postedBy: "slack:bot:B1",
      authenticatedAs: "http:token",
      sourceUrl: "https://chat.example/p/1",
      messageId: "1.0",
      images: [{ mediaType: "image/png", data: "AAAA" }],
      documents: [{ mediaType: "text/plain", data: "hello" }],
      staged: [{ name: "big.mov", size: 1, type: "video/quicktime", url: "https://files.example/1", messageId: "1.0" }],
    };
    expect(confirmationMessageOf(full)).toEqual({
      ...message,
      relayedBy: "an app",
      postedBy: "slack:bot:B1",
      authenticatedAs: "http:token",
      sourceUrl: "https://chat.example/p/1",
      messageId: "1.0",
    });
  });

  it("isConfirmation holds a stored row to its shape and refuses one a store could not have written", () => {
    const row: Confirmation = { ...pending("c1"), expiresAt: 5 };
    expect(isConfirmation(row)).toBe(true);
    expect(isConfirmation({ ...row, input: "config set" })).toBe(false);
    expect(isConfirmation({ ...row, message: { userId: "slack:U" } })).toBe(false);
    expect(isConfirmation({ ...row, expiresAt: "soon" })).toBe(false);
    expect(isConfirmation(null)).toBe(false);
  });

  it("a row stored before the union existed — no `kind` — still parses, as the routed write it was, with the kind stamped", () => {
    // The pre-change fixture: yesterday's stored shape, byte for byte.
    const { kind: _kind, ...old } = pending("c1");
    expect(parsePendingConfirmation(old)).toEqual(pending("c1"));
    expect(parseConfirmation({ ...old, expiresAt: 5 })).toEqual({ ...pending("c1"), expiresAt: 5 });
    // A kind no store writes is refused, never misread as either shape.
    expect(parsePendingConfirmation({ ...old, kind: "other" })).toBeUndefined();
    // A redispatch row needs its own fields, not the routed write's.
    expect(parsePendingConfirmation({ ...old, kind: "redispatch" })).toBeUndefined();
    expect(
      parsePendingConfirmation({ kind: "redispatch", id: "q1", message, line: "l", evidence: "e", code: "c" }),
    ).toEqual({ kind: "redispatch", id: "q1", message, line: "l", evidence: "e", code: "c" });
  });
});

describe("a store written before the union existed", () => {
  it("FileConfirmationStore reads a file whose rows carry no `kind` and answers them as routed writes", async () => {
    const { clock } = withClock();
    const path = join(mkdtempSync(join(tmpdir(), "swb-confirmations-old-")), "confirmations.json");
    const { kind: _kind, ...old } = pending("c1");
    writeFileSync(path, JSON.stringify({ confirmations: [{ ...old, expiresAt: clock() + TTL }] }));
    const store = new FileConfirmationStore(path, { clock });
    const consumed = await store.consume("c1", ["slack:UREQ"]);
    expect(consumed).toEqual({ ok: true, row: { ...pending("c1"), expiresAt: clock() + TTL } });
  });
});
