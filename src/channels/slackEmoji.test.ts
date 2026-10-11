import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createSlackEmojiCache, FileEmojiStore, InMemoryEmojiStore } from "./slackEmoji.js";
const gif = new Uint8Array(Buffer.from("GIF89a"));
const client = {
  emoji: {
    list: async () => ({
      ok: true,
      emoji: {
        ship: "https://emoji.slack-edge.com/T_FIXTURE/ship.gif",
        shipit: "alias:ship",
        again: "alias:shipit",
      },
    }),
  },
};
function response() {
  let status = 0,
    headers: Record<string, string> = {},
    bytes: unknown;
  return {
    res: {
      writeHead(code: number, value: Record<string, string>) {
        status = code;
        headers = value;
      },
      end(value: unknown) {
        bytes = value instanceof Uint8Array ? new Uint8Array(value) : value;
      },
    } as unknown as ServerResponse,
    value: () => ({ status, headers, bytes }),
  };
}
describe("Slack emoji assets", () => {
  it("downloads custom images once across aliases and serves only hashed verified image bytes", async () => {
    const requested: string[] = [];
    const store = new InMemoryEmojiStore();
    const cache = createSlackEmojiCache({
      store,
      fetch: async (url) => {
        requested.push(String(url));
        return new Response(gif, { headers: { "content-type": "image/gif" } });
      },
    });
    expect(await cache.refresh(client)).toEqual({ status: "complete", downloaded: 3 });
    expect(requested).toEqual(["https://emoji.slack-edge.com/T_FIXTURE/ship.gif"]);
    const catalog = cache.catalog();
    expect(catalog.ship.path).toMatch(/^\/assets\/emoji\/[0-9a-f]{64}\.gif$/);
    expect(catalog.shipit).toEqual(catalog.ship);
    expect(catalog.again).toEqual(catalog.ship);
    const output = response();
    await cache.handle({ url: catalog.ship.path, method: "GET" } as IncomingMessage, output.res);
    expect(output.value()).toEqual({
      status: 200,
      bytes: gif,
      headers: {
        "content-type": "image/gif",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=3600",
      },
    });
    const missing = response();
    await cache.handle({ url: "/assets/emoji/../../outside", method: "GET" } as IncomingMessage, missing.res);
    expect(missing.value().status).toBe(404);
  });
  it("refuses unknown hosts, unsafe redirects, alias cycles and non-image bodies", async () => {
    const requested: string[] = [];
    const cache = createSlackEmojiCache({
      store: new InMemoryEmojiStore(),
      fetch: async (url) => {
        requested.push(String(url));
        return String(url).endsWith("redirect")
          ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })
          : new Response("<svg onload='anything' />");
      },
    });
    expect(
      await cache.refresh({
        emoji: {
          list: async () => ({
            ok: true,
            emoji: {
              external: "https://other.test/image.png",
              local: "http://127.0.0.1/image.png",
              cycle: "alias:cycle",
              redirect: "https://emoji.slack-edge.com/redirect",
              svg: "https://emoji.slack-edge.com/unsafe.svg",
            },
          }),
        },
      }),
    ).toEqual({ status: "partial", downloaded: 0 });
    expect(requested.sort()).toEqual([
      "https://emoji.slack-edge.com/redirect",
      "https://emoji.slack-edge.com/unsafe.svg",
    ]);
    expect(cache.catalog()).toEqual({});
  });
  it("keeps installed image bytes and catalog after restart when Slack is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "switchboard-emoji-"));
    try {
      const first = createSlackEmojiCache({
        store: new FileEmojiStore(directory),
        fetch: async () => new Response(gif),
      });
      await first.refresh(client);
      const restarted = createSlackEmojiCache({ store: new FileEmojiStore(directory) });
      expect(
        await restarted.refresh({
          emoji: {
            list: async () => {
              throw new Error("upstream unavailable");
            },
          },
        }),
      ).toEqual({ status: "unavailable", downloaded: 0 });
      expect(restarted.catalog()).toEqual(first.catalog());
      const output = response();
      await restarted.handle({ url: restarted.catalog().ship.path, method: "GET" } as IncomingMessage, output.res);
      expect(output.value().status).toBe(200);
      expect(output.value().bytes).toEqual(gif);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
