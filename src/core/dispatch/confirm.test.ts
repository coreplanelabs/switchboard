import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { processSecrets } from "../../secrets.js";
import { ConfigStore } from "../../config.js";
import { CONFIRMATION_TTL_MS } from "../budgets.js";
import { buildCoreCommands } from "../commandCatalogue.js";
import type { AuditEntry } from "../commandRegistry.js";
import {
  InMemoryConfirmationStore,
  type ConfirmationStore,
  type PendingConfirmation,
  type RedispatchConfirmation,
} from "../confirmations.js";
import type { DispatchOutcome } from "./outcome.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { isSpanRecord, type RunEvent } from "../runEvents.js";
import { NullRunHistoryWriter } from "../runHistoryWriter.js";
import { RunRegistry } from "../runRegistry.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { FastPathDeps } from "./fastPath.js";
import {
  actorIdsOf,
  cancelPending,
  consumeAndRun,
  OFFER_CANCELLED_LINE,
  OFFER_EXPIRED_LINE,
  OFFER_FOREIGN_LINE,
  OFFER_UNREADABLE_LINE,
  OFFER_USED_LINE,
  refusalLine,
} from "./confirm.js";

// Feature: docs/reference/specs/routing-and-config.md item 25 (record 0044) — the
// click: the stored row is consumed once for the requester and its input runs
// through the typed line's own path, `source: confirm` on the audit line and
// `outcome: confirmed` on the record; every refusal is a named line.

const YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    coding: anthropic/coding-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
`;

let now = 10_000;
const tick = (ms: number) => void (now += ms);

function deps(): FastPathDeps & { runRegistry: RunRegistry; audits: AuditEntry[]; store: InMemoryConfirmationStore } {
  const dir = mkdtempSync(join(tmpdir(), "swb-confirm-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, YAML);
  const config = new ConfigStore(path, join(dir, "overrides.json"));
  let n = 0;
  const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => "tok" });
  const audits: AuditEntry[] = [];
  const commands = buildCoreCommands(config, null, {
    registry,
    secrets: processSecrets,
    dataDir: dir,
    warn: () => {},
    audit: (e) => void audits.push(e),
  });
  const store = new InMemoryConfirmationStore({ clock: () => now });
  return {
    config,
    runRegistry: registry,
    runHistoryWriter: new NullRunHistoryWriter(),
    clock: () => now,
    commands,
    confirmations: store,
    audits,
    store,
  };
}

const message = (user = "slack:UADMIN"): IncomingMessage => ({
  channelId: "slack:CX",
  userId: user,
  threadKey: "slack:CX:1.0",
  text: "use opus for coding in this channel",
});

/** A `run` row's `dispatch()` stand-in for tests where no redispatch may
 *  happen: a `run` row must never reach it. */
const noRedispatch = async (): Promise<DispatchOutcome> => {
  throw new Error("a run row must not redispatch");
};

const pending = (id: string, user = "slack:UADMIN"): PendingConfirmation => ({
  kind: "run",
  id,
  message: message(user),
  command: "config.set",
  input: { args: ["channel"], options: { models: { coding: "anthropic/claude-opus-5" } } },
  receipt: "config set channel --models.coding anthropic/claude-opus-5",
  risk: "changes the scope's settings for everyone in it until reset",
  footer: "confirmation required by the built-in default",
  model: "anthropic/general-model",
});

function request(d: FastPathDeps & { runRegistry: RunRegistry }) {
  const replies: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: vi.fn(async () => []),
  };
  const trace = startRequestRoot({ clock: () => now }, { channel: channelOf("slack:CX"), receivedAt: now });
  const ending = createRunEnding({ registry: d.runRegistry });
  return { io, ending, trace, replies };
}

const contentTypes = (events: readonly RunEvent[]) => events.filter((e) => !isSpanRecord(e)).map((e) => e.type);
const codingModelIn = (d: FastPathDeps) =>
  d.config.resolve({ channelId: "slack:CX", userId: "slack:UADMIN", request: { agent: "coding" } }).modelRef;

describe("the named lines and the clicker's ids", () => {
  it("refusalLine names each refusal; the cancel and the unreadable store have lines of their own", () => {
    expect(refusalLine("expired")).toBe(OFFER_EXPIRED_LINE);
    expect(refusalLine("foreign")).toBe(OFFER_FOREIGN_LINE);
    expect(refusalLine("used")).toBe(OFFER_USED_LINE);
    expect(OFFER_EXPIRED_LINE).toBe("this offer expired; type the line to run it");
    expect(OFFER_FOREIGN_LINE).toBe("only the requester can confirm this");
    expect(OFFER_USED_LINE).toBe("this offer was already used");
    expect(OFFER_UNREADABLE_LINE).toBe("the confirmation could not be read; type the line to run it");
    expect(OFFER_CANCELLED_LINE).toBe("Cancelled; nothing ran");
  });

  it("actorIdsOf is the actor's id and its `self`, once each: a plain actor's own id, a bound credential's id and person", () => {
    expect(actorIdsOf({ id: "slack:UA" })).toEqual(["slack:UA"]);
    expect(actorIdsOf({ id: "access:sub", self: ["access:sub", "slack:UA"] })).toEqual(["access:sub", "slack:UA"]);
    expect(actorIdsOf({ id: "http:tok", self: ["slack:UA"] })).toEqual(["http:tok", "slack:UA"]);
  });
});

describe("consumeAndRun — the stored input runs once, as the requester, through the typed path (record 0044)", () => {
  it("runs the row's command with its input as the requester: source confirm on the audit line, one record with outcome confirmed, the reply's first line the receipt, the setting changed", async () => {
    const d = deps();
    await d.store.put(pending("c1"), CONFIRMATION_TTL_MS);
    const { io, ending, trace } = request(d);
    const res = await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch);
    await ending.sealAfterReply(async () => {});
    expect(res.kind).toBe("ran");
    if (res.kind !== "ran") throw new Error("unreachable");
    const [first, ...rest] = res.text.split("\n");
    expect(first).toBe("routed: config set channel --models.coding anthropic/claude-opus-5");
    expect(rest.join("\n")).toBe('Updated channel scope. Now: {"models":{"coding":"anthropic/claude-opus-5"}}');
    expect(codingModelIn(d)).toBe("anthropic/claude-opus-5");
    expect(d.audits).toEqual([
      expect.objectContaining({ commandId: "config.set", callerId: "slack:UADMIN", outcome: "ok", source: "confirm" }),
    ]);
    const snap = d.runRegistry.snapshotById("run-1");
    expect(d.runRegistry.getById("run-1")).toMatchObject({
      status: "completed",
      agent: "command",
      threadKey: "slack:CX:1.0",
    });
    expect(contentTypes(snap?.events ?? [])).toEqual(["input", "run_meta", "route", "answer"]);
    expect(snap?.events.find((e) => e.type === "route")).toMatchObject({
      preset: "command",
      reason: "confirmed after offer",
      model: "anthropic/general-model",
      command: "config.set",
      input: { args: ["channel"], options: { models: { coding: "anthropic/claude-opus-5" } } },
      receipt: "config set channel --models.coding anthropic/claude-opus-5",
      outcome: "confirmed",
    });
    // The record's answer is the command's own text, as a routed read's is; the receipt leads the reply alone.
    if (res.kind !== "ran") throw new Error("unreachable");
    expect(snap?.events.find((e) => e.type === "answer")).toMatchObject({ text: res.result.text });
    expect(d.runRegistry.snapshotById("run-2")).toBeNull();
  });

  it("a second click on the same id reads `already used` and nothing runs", async () => {
    const d = deps();
    await d.store.put(pending("c1"), CONFIRMATION_TTL_MS);
    const { io, ending, trace } = request(d);
    await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch);
    const again = await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch);
    expect(again).toEqual({ kind: "refused", refusal: "confirmation_used", text: OFFER_USED_LINE });
    expect(d.audits).toHaveLength(1);
  });

  it("a click after the expiry reads `expired`, judged on the store's clock; nothing runs and the row is gone", async () => {
    const d = deps();
    await d.store.put(pending("c1"), CONFIRMATION_TTL_MS);
    tick(CONFIRMATION_TTL_MS);
    const { io, ending, trace } = request(d);
    // The store's expired refusal still names the row it deleted, so the
    // result carries it for the refused record (record 0054).
    expect(await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch)).toEqual({
      kind: "refused",
      refusal: "confirmation_expired",
      text: OFFER_EXPIRED_LINE,
      row: expect.objectContaining({ id: "c1", command: "config.set" }),
    });
    expect(
      await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch),
    ).toMatchObject({
      refusal: "confirmation_used",
    });
    expect(d.audits).toEqual([]);
    expect(codingModelIn(d)).toBe("anthropic/coding-model");
  });

  it("a clicker whose id and `self` miss the requester reads `only the requester can confirm this`; the row stays for the requester", async () => {
    const d = deps();
    await d.store.put(pending("c1"), CONFIRMATION_TTL_MS);
    const { io, ending, trace } = request(d);
    expect(
      await consumeAndRun(
        d,
        { id: "c1", actorIds: ["slack:UOTHER", "access:someone-else"] },
        io,
        ending,
        trace,
        noRedispatch,
      ),
    ).toEqual({
      kind: "refused",
      refusal: "confirmation_foreign",
      text: OFFER_FOREIGN_LINE,
      // The kept row rides the refusal so the click can be recorded (record 0054).
      row: expect.objectContaining({ id: "c1", command: "config.set" }),
    });
    expect(d.audits).toEqual([]);
    expect(
      (await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch)).kind,
    ).toBe("ran");
  });

  it("a clicker whose `self` holds the requester runs it from another surface's id, and the command still runs as the requester", async () => {
    const d = deps();
    await d.store.put(pending("c1"), CONFIRMATION_TTL_MS);
    const { io, ending, trace } = request(d);
    const res = await consumeAndRun(
      d,
      { id: "c1", actorIds: ["access:sub-1", "slack:UADMIN"] },
      io,
      ending,
      trace,
      noRedispatch,
    );
    expect(res.kind).toBe("ran");
    expect(d.audits[0]).toMatchObject({ callerId: "slack:UADMIN", source: "confirm", outcome: "ok" });
  });

  it("the command is authorized as the requester again at the click: a requester without the grant gets the typed path's refusal under the receipt, recorded as a failed confirmed run", async () => {
    const d = deps();
    await d.store.put(pending("c1", "slack:UX"), CONFIRMATION_TTL_MS);
    const { io, ending, trace } = request(d);
    const res = await consumeAndRun(d, { id: "c1", actorIds: ["slack:UX"] }, io, ending, trace, noRedispatch);
    await ending.sealAfterReply(async () => {});
    expect(res.kind).toBe("ran");
    if (res.kind !== "ran") throw new Error("unreachable");
    expect(res.result.ok).toBe(false);
    expect(res.text.split("\n")[0]).toBe("routed: config set channel --models.coding anthropic/claude-opus-5");
    expect(res.text).toMatch(/🚫 `config set`: .*restricted/);
    expect(d.audits).toEqual([
      expect.objectContaining({
        commandId: "config.set",
        callerId: "slack:UX",
        outcome: "unauthorized",
        source: "confirm",
      }),
    ]);
    expect(d.runRegistry.getById("run-1")).toMatchObject({ status: "failed", agent: "command" });
    expect(d.runRegistry.snapshotById("run-1")?.events.find((e) => e.type === "route")).toMatchObject({
      outcome: "confirmed",
    });
    expect(codingModelIn(d)).toBe("anthropic/coding-model");
  });

  it("a store that cannot be read, or no store at all, answers the unreadable line and runs nothing", async () => {
    const d = deps();
    const { io, ending, trace } = request(d);
    const throwing: ConfirmationStore = {
      put: (row, ttl) => d.store.put(row, ttl),
      cancel: (id, ids) => d.store.cancel(id, ids),
      cancelByThread: (key, ids) => d.store.cancelByThread(key, ids),
      pendingByThread: (key) => d.store.pendingByThread(key),
      describe: () => "throwing",
      consume: async () => {
        throw new Error("store down");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await consumeAndRun(
          { ...d, confirmations: throwing },
          { id: "c1", actorIds: ["slack:UADMIN"] },
          io,
          ending,
          trace,
          noRedispatch,
        ),
      ).toEqual({ kind: "refused", refusal: "confirmation_unreadable", text: OFFER_UNREADABLE_LINE });
      expect(warn.mock.calls.some((c) => String(c[0]).includes("store down"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    const { confirmations: _none, ...without } = d;
    expect(
      await consumeAndRun(without, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch),
    ).toEqual({
      kind: "refused",
      refusal: "confirmation_unreadable",
      text: OFFER_UNREADABLE_LINE,
    });
    expect(d.audits).toEqual([]);
  });
});

describe("consumeAndRun — a question's Yes hands the stored proposal to dispatch as the requester (record 0054)", () => {
  const redispatchRow = (id: string, user = "slack:UADMIN"): PendingConfirmation => ({
    kind: "redispatch",
    id,
    message: { ...message(user), text: "agent:ship repo:acme/api fix the flaky test" },
    line: "agent:ship repo:acme/api fix the flaky test",
    evidence: "acme/api is one edit away from acme/apj, which is onboarded",
    code: "repo_not_onboarded",
  });

  it("Yes on a redispatch row calls the callback once with the row — the proposal, the code — and answers `redispatched` with the dispatch's outcome; the row is consumed", async () => {
    const d = deps();
    await d.store.put(redispatchRow("c1"), CONFIRMATION_TTL_MS);
    const { io, ending, trace } = request(d);
    const seen: RedispatchConfirmation[] = [];
    const redispatch = async (row: RedispatchConfirmation): Promise<DispatchOutcome> => {
      seen.push(row);
      return { status: "completed" };
    };
    const res = await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, redispatch);
    expect(res).toMatchObject({ kind: "redispatched", outcome: { status: "completed" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "redispatch",
      message: expect.objectContaining({ userId: "slack:UADMIN", text: "agent:ship repo:acme/api fix the flaky test" }),
      code: "repo_not_onboarded",
    });
    // Consumed: a second Yes reads `used` and redispatches nothing.
    expect(await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, redispatch)).toEqual({
      kind: "refused",
      refusal: "confirmation_used",
      text: OFFER_USED_LINE,
    });
    expect(seen).toHaveLength(1);
    // No typed-path command ran: the outcome is the redispatched request's own.
    expect(d.audits).toEqual([]);
  });

  it("a foreign Yes is refused with the requester line and the row stays for the requester", async () => {
    const d = deps();
    await d.store.put(redispatchRow("c1"), CONFIRMATION_TTL_MS);
    const { io, ending, trace } = request(d);
    expect(await consumeAndRun(d, { id: "c1", actorIds: ["slack:UOTHER"] }, io, ending, trace, noRedispatch)).toEqual({
      kind: "refused",
      refusal: "confirmation_foreign",
      text: OFFER_FOREIGN_LINE,
      row: expect.objectContaining({ id: "c1", kind: "redispatch" }),
    });
    const ran = await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, async () => ({
      status: "completed" as const,
    }));
    expect(ran.kind).toBe("redispatched");
  });

  it("No on a redispatch row cancels it: `Cancelled; nothing ran`, and the row is gone", async () => {
    const d = deps();
    await d.store.put(redispatchRow("c1"), CONFIRMATION_TTL_MS);
    expect(await cancelPending(d, { id: "c1", actorIds: ["slack:UADMIN"] })).toEqual({
      kind: "cancelled",
      text: OFFER_CANCELLED_LINE,
    });
    const { io, ending, trace } = request(d);
    expect(await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch)).toEqual({
      kind: "refused",
      refusal: "confirmation_used",
      text: OFFER_USED_LINE,
    });
  });
});

describe("cancelPending — the other button", () => {
  it("cancels for the requester and answers `Cancelled; nothing ran`; a later confirm reads `used`", async () => {
    const d = deps();
    await d.store.put(pending("c1"), CONFIRMATION_TTL_MS);
    expect(await cancelPending(d, { id: "c1", actorIds: ["slack:UADMIN"] })).toEqual({
      kind: "cancelled",
      text: OFFER_CANCELLED_LINE,
    });
    const { io, ending, trace } = request(d);
    expect(
      await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch),
    ).toMatchObject({
      refusal: "confirmation_used",
    });
    expect(d.audits).toEqual([]);
  });

  it("refuses a stranger with the requester line, a confirmed id with `used`, and an unreadable store with its line", async () => {
    const d = deps();
    await d.store.put(pending("c1"), CONFIRMATION_TTL_MS);
    expect(await cancelPending(d, { id: "c1", actorIds: ["slack:UOTHER"] })).toEqual({
      kind: "refused",
      refusal: "confirmation_foreign",
      text: OFFER_FOREIGN_LINE,
    });
    const { io, ending, trace } = request(d);
    expect(
      (await consumeAndRun(d, { id: "c1", actorIds: ["slack:UADMIN"] }, io, ending, trace, noRedispatch)).kind,
    ).toBe("ran");
    expect(await cancelPending(d, { id: "c1", actorIds: ["slack:UADMIN"] })).toEqual({
      kind: "refused",
      refusal: "confirmation_used",
      text: OFFER_USED_LINE,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const throwing: ConfirmationStore = {
        put: (row, ttl) => d.store.put(row, ttl),
        consume: (id, ids) => d.store.consume(id, ids),
        cancelByThread: (key, ids) => d.store.cancelByThread(key, ids),
        pendingByThread: (key) => d.store.pendingByThread(key),
        describe: () => "throwing",
        cancel: async () => {
          throw new Error("store down");
        },
      };
      expect(await cancelPending({ ...d, confirmations: throwing }, { id: "c1", actorIds: ["slack:UADMIN"] })).toEqual({
        kind: "refused",
        refusal: "confirmation_unreadable",
        text: OFFER_UNREADABLE_LINE,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
