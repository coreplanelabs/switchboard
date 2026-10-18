import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it("imports every name beyond a search page, including apostrophes, native aliases and legacy Slack images", async () => {
    let downloads = 0;
    const cache = createSlackEmojiCache({
      store: new InMemoryEmojiStore(),
      fetch: async () => {
        downloads++;
        return new Response(gif);
      },
    });
    const source = {
      emoji: {
        list: async () => ({
          ok: true,
          emoji: {
            ...Object.fromEntries(
              Array.from({ length: 205 }, (_, i) => [`custom_${i}`, "https://emoji.slack-edge.com/T_FIXTURE/same.gif"]),
            ),
            "bird's-gift": "https://a.slack-edge.com/same.gif",
            white_square: "alias:white_large_square",
            white_again: "alias:white_square",
          },
        }),
      },
    };
    expect(await cache.refresh(source)).toEqual({
      status: "complete",
      total: 208,
      available: 208,
      downloaded: 1,
      failed: 0,
    });
    expect(cache.catalog()["bird's-gift"].path).toBe(cache.catalog().custom_0.path);
    expect(cache.catalog().white_again).toEqual({ text: "⬜" });
    expect(cache.catalog().white_square).toEqual({ text: "⬜" });
    expect(await cache.refresh(source)).toEqual({
      status: "complete",
      total: 208,
      available: 208,
      downloaded: 0,
      failed: 0,
    });
    expect(downloads).toBe(2);
    expect(JSON.stringify(cache.catalog())).not.toContain("https://");
  });

  it("retains verified cached images on a partial failure and repairs damaged bytes on the next manual sync", async () => {
    const directory = await mkdtemp(join(tmpdir(), "switchboard-emoji-refresh-"));
    try {
      const store = new FileEmojiStore(directory);
      const first = createSlackEmojiCache({ store, fetch: async () => new Response(gif) });
      await first.refresh(client);
      const path = first.catalog().ship.path!;
      const damaged = join(directory, path.split("/").at(-1)!);
      await writeFile(damaged, "broken bytes");
      const repaired = createSlackEmojiCache({ store, fetch: async () => new Response(gif) });
      expect(await repaired.refresh(client)).toMatchObject({ status: "complete", available: 3, downloaded: 1 });
      const output = response();
      await repaired.handle({ url: path, method: "GET" } as IncomingMessage, output.res);
      expect(output.value().bytes).toEqual(gif);
      const failed = createSlackEmojiCache({
        store,
        fetch: async () => {
          throw new Error("offline");
        },
      });
      const replacement = {
        emoji: {
          list: async () => ({ ok: true, emoji: { ship: "https://emoji.slack-edge.com/T_FIXTURE/replacement.gif" } }),
        },
      };
      expect(await failed.refresh(replacement)).toEqual({
        status: "partial",
        total: 1,
        available: 1,
        downloaded: 0,
        failed: 1,
      });
      expect(failed.catalog()).toEqual({ ship: { path } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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
    expect(await cache.refresh(client)).toEqual({
      status: "complete",
      total: 3,
      available: 3,
      downloaded: 1,
      failed: 0,
    });
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
    ).toEqual({ status: "partial", total: 5, available: 0, downloaded: 0, failed: 5 });
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
      ).toEqual({
        status: "unavailable",
        total: null,
        available: 3,
        downloaded: 0,
        failed: 0,
        reason: "source_unavailable",
      });
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
