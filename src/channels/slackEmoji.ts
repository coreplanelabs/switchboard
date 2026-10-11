import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HOSTED_MCP_PROBE_TIMEOUT_MS } from "../core/budgets.js";

export type EmojiCatalog = Record<string, { path: string }>;
const ASSET = /^[0-9a-f]{64}\.(png|gif|webp)$/;
const NAME = /^[A-Za-z0-9_+-]{1,100}$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export interface EmojiStore {
  catalog(): Promise<EmojiCatalog>;
  saveCatalog(catalog: EmojiCatalog): Promise<void>;
  get(asset: string): Promise<Uint8Array | undefined>;
  put(asset: string, bytes: Uint8Array): Promise<void>;
}
export class InMemoryEmojiStore implements EmojiStore {
  private current: EmojiCatalog = {};
  private assets = new Map<string, Uint8Array>();
  async catalog() {
    return structuredClone(this.current);
  }
  async saveCatalog(catalog: EmojiCatalog) {
    this.current = structuredClone(catalog);
  }
  async get(asset: string) {
    return this.assets.get(asset);
  }
  async put(asset: string, bytes: Uint8Array) {
    this.assets.set(asset, bytes);
  }
}
/** Installation-owned cache, outside the repository and model workspace. */
export class FileEmojiStore implements EmojiStore {
  constructor(private readonly directory: string) {}
  async catalog(): Promise<EmojiCatalog> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.directory, "catalog.json"), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(
          ([name, value]) =>
            NAME.test(name) &&
            value &&
            typeof value === "object" &&
            "path" in value &&
            typeof value.path === "string" &&
            value.path.startsWith("/assets/emoji/") &&
            ASSET.test(value.path.slice("/assets/emoji/".length)),
        ),
      );
    } catch {
      return {};
    }
  }
  async saveCatalog(catalog: EmojiCatalog) {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `catalog-${randomUUID()}.tmp`);
    await writeFile(path, JSON.stringify(catalog));
    await rename(path, join(this.directory, "catalog.json"));
  }
  async get(asset: string) {
    if (!ASSET.test(asset)) return;
    try {
      return new Uint8Array(await readFile(join(this.directory, asset)));
    } catch {
      return;
    }
  }
  async put(asset: string, bytes: Uint8Array) {
    if (!ASSET.test(asset) || bytes.length > MAX_IMAGE_BYTES) throw new Error("Invalid emoji asset");
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, asset), bytes, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
}
function imageExtension(bytes: Uint8Array): "png" | "gif" | "webp" | undefined {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"))) return "gif";
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
}
function sourceUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["emoji.slack-edge.com", "emoji.slack.com", "my.slack.com"].includes(url.hostname)
      ? url
      : undefined;
  } catch {
    return;
  }
}
export function createSlackEmojiCache(options: { store: EmojiStore; fetch?: typeof fetch }) {
  let current: EmojiCatalog = {};
  async function download(raw: string) {
    let url = sourceUrl(raw);
    for (let hop = 0; url && hop < 4; hop++) {
      const response = await (options.fetch ?? fetch)(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(HOSTED_MCP_PROBE_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("location");
        url = next ? sourceUrl(new URL(next, url).href) : undefined;
        continue;
      }
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES || !response.body)
        return;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > MAX_IMAGE_BYTES) {
          await reader.cancel();
          return;
        }
        chunks.push(part.value);
      }
      const bytes = Buffer.concat(chunks),
        extension = imageExtension(bytes);
      if (!extension) return;
      const asset = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
      await options.store.put(asset, bytes);
      return { path: `/assets/emoji/${asset}` };
    }
  }
  async function refresh(client: { emoji: { list(): Promise<{ ok?: boolean; emoji?: Record<string, string> }> } }) {
    current = await options.store.catalog();
    try {
      const result = await client.emoji.list();
      if (result.ok !== true || !result.emoji) return { status: "unavailable" as const, downloaded: 0 };
      const urls = result.emoji,
        catalog: EmojiCatalog = Object.create(null),
        seen = new Map<string, Promise<{ path: string } | undefined>>();
      const resolve = (name: string): string | undefined => {
        const path = new Set<string>();
        while (NAME.test(name) && !path.has(name) && path.size < 100) {
          path.add(name);
          const value = Object.hasOwn(urls, name) ? urls[name] : undefined;
          if (!value) return;
          if (!value.startsWith("alias:")) return value;
          name = value.slice(6);
        }
      };
      const names = Object.keys(urls).filter((name) => NAME.test(name));
      let offset = 0,
        missing = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (offset < names.length) {
            const name = names[offset++]!,
              raw = resolve(name);
            if (!raw) {
              missing++;
              continue;
            }
            if (!seen.has(raw))
              seen.set(
                raw,
                download(raw).catch(() => undefined),
              );
            const asset = await seen.get(raw);
            if (asset) catalog[name] = asset;
            else missing++;
          }
        }),
      );
      await options.store.saveCatalog(catalog);
      current = catalog;
      return {
        status: missing ? ("partial" as const) : ("complete" as const),
        downloaded: Object.keys(catalog).length,
      };
    } catch {
      return { status: "unavailable" as const, downloaded: 0 };
    }
  }
  /** The host authenticates the organization before this handler is called. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const asset = new URL(req.url ?? "/", "http://localhost").pathname.slice("/assets/emoji/".length);
    const bytes =
      req.method === "GET" &&
      ASSET.test(asset) &&
      Object.values(current).some((row) => row.path === `/assets/emoji/${asset}`)
        ? await options.store.get(asset)
        : undefined;
    if (!bytes || `${createHash("sha256").update(bytes).digest("hex")}.${imageExtension(bytes)}` !== asset) {
      res.writeHead(404, { "cache-control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": `image/${asset.endsWith(".png") ? "png" : asset.endsWith(".gif") ? "gif" : "webp"}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
    });
    res.end(bytes);
  }
  return { refresh, catalog: () => ({ ...current }), handle };
}
