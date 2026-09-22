// Feature: docs/reference/specs/live-view.md item 31 — the app asks a page's
// address for its seed; anything that is not a seed is the browser's to show.
import { describe, expect, it, vi } from "vitest";
import type { WebSeed } from "@core/channels/webSeed.js";
import { fetchSeed, readSeed, SEED_ACCEPT } from "./seed";
import { ALL_ON } from "../testing/mount";

const SEED: WebSeed = { page: "runNotFound", title: "No run found", retentionDays: 30, capabilities: ALL_ON };

const answer = (body: string, type: string | null, status = 200) =>
  new Response(body, { status, headers: type ? { "content-type": type } : {} });

describe("fetchSeed", () => {
  it("asks the address with Accept: application/json and same-origin credentials, and returns the seed a JSON answer carries — at any status", async () => {
    const fetchImpl = vi.fn(async () => answer(JSON.stringify(SEED), "application/json; charset=utf-8", 404));
    const seed = await fetchSeed("/runs/nope?t=x", fetchImpl as unknown as typeof fetch);
    expect(seed).toEqual(SEED);
    expect(fetchImpl).toHaveBeenCalledWith("/runs/nope?t=x", {
      headers: { accept: SEED_ACCEPT },
      credentials: "same-origin",
    });
  });

  it("an answer that is not a seed is null: a document, a JSON twin without a page, a text error, a failing fetch", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => answer("<!doctype html><html></html>", "text/html; charset=utf-8"),
      async () => answer(JSON.stringify({ repo: "acme/api", totals: {} }), "application/json"),
      async () => answer("no run found", "text/plain", 404),
      async () => answer("{}", null),
      async () => answer("not json", "application/json"),
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    for (const f of cases) {
      expect(await fetchSeed("/x", f as unknown as typeof fetch)).toBeNull();
    }
  });

  it("an answer that is not JSON is cancelled unread, so a stream does not hold the connection", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel });
    const fetchImpl = vi.fn(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    expect(await fetchSeed("/runs/abc/events", fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("readSeed", () => {
  it("reads the island the shell served; no island or a broken one is null", () => {
    const doc = document.implementation.createHTMLDocument("t");
    expect(readSeed(doc)).toBeNull();
    const el = doc.createElement("script");
    el.id = "sb-seed";
    el.type = "application/json";
    el.textContent = JSON.stringify(SEED);
    doc.body.appendChild(el);
    expect(readSeed(doc)).toEqual(SEED);
    el.textContent = "{not json";
    expect(readSeed(doc)).toBeNull();
  });
});
