import { mkdtempSync } from "node:fs";
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
  renderOffer,
  WorkerConfirmationStore,
  type Confirmation,
  type ConfirmationStore,
  type PendingConfirmation,
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

const pending = (id: string, over: Partial<PendingConfirmation> = {}): PendingConfirmation => ({
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

    it("a row past its expiry is `expired` on touch and gone afterwards", async () => {
      const { store, tick } = make();
      const row = await store.put(pending("c2"), TTL);
      tick(TTL - 1);
      expect((await store.consume("c2", ["slack:UOTHER"])).ok).toBe(false); // still pending: foreign, not expired
      tick(1);
      expect(await store.consume("c2", ["slack:UREQ"])).toEqual({ ok: false, refused: "expired" });
      expect(await store.consume("c2", ["slack:UREQ"])).toEqual({ ok: false, refused: "used" });
      expect(row.expiresAt).toBeGreaterThan(0);
    });

    it("an actor whose ids miss the requester is `foreign` and the row stays; the requester's id anywhere in the list consumes", async () => {
      const { store } = make();
      await store.put(pending("c3"), TTL);
      expect(await store.consume("c3", ["slack:UOTHER"])).toEqual({ ok: false, refused: "foreign" });
      expect(await store.consume("c3", ["access:sub-1"])).toEqual({ ok: false, refused: "foreign" });
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
    const id = b.id as string;
    const actorIds = b.actorIds as string[];
    const stored = rows.get(id);
    if (!stored) return answer({ refused: "used" });
    if (path === "/config/confirmations/consume" && stored.expiresAt <= clock()) {
      rows.delete(id);
      return answer({ refused: "expired" });
    }
    if (!actorIds.includes(stored.requester)) return answer({ refused: "foreign" });
    rows.delete(id);
    return answer(path === "/config/confirmations/cancel" ? { ok: true } : { row: { id, ...stored } });
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
});
