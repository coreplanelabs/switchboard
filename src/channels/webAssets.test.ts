import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWebAssets } from "./webAssets.js";

/** A minimal Vite dist: manifest + entry js/css + a lazy chunk. */
function fixtureDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-web-assets-"));
  mkdirSync(join(dir, ".vite"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  const manifest = {
    "src/main.ts": { file: "assets/main-AbC123.js", isEntry: true, css: ["assets/main-DeF456.css"] },
    "src/pages/RunPage.vue": { file: "assets/RunPage-XyZ789.js", isDynamicEntry: true, imports: ["src/main.ts"] },
  };
  writeFileSync(join(dir, ".vite", "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "assets", "main-AbC123.js"), "console.log('entry')");
  writeFileSync(join(dir, "assets", "main-DeF456.css"), "body{}");
  writeFileSync(join(dir, "assets", "RunPage-XyZ789.js"), "console.log('page')");
  return dir;
}

interface Recorded {
  status?: number;
  headers?: Record<string, string>;
  body: string;
  ended: boolean;
}

function fakeRes(): Recorded & { writeHead(s: number, h: Record<string, string>): void; end(b?: unknown): void } {
  const r = {
    body: "",
    ended: false,
    writeHead(s: number, h: Record<string, string>) {
      r.status = s;
      r.headers = h;
    },
    end(b?: unknown) {
      if (b !== undefined) r.body += String(b);
      r.ended = true;
    },
  } as Recorded & { writeHead(s: number, h: Record<string, string>): void; end(b?: unknown): void };
  return r;
}

const req = (url: string, method = "GET") => ({ url, method }) as import("node:http").IncomingMessage;

describe("loadWebAssets", () => {
  it("exposes the entry's hashed js and css paths from the manifest", () => {
    const assets = loadWebAssets(fixtureDist());
    expect(assets.entry.js).toBe("/assets/main-AbC123.js");
    expect(assets.entry.css).toEqual(["/assets/main-DeF456.css"]);
  });

  it("throws a clear error when the dist has no manifest (web app not built)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-web-empty-"));
    expect(() => loadWebAssets(dir)).toThrow(/npm run build|manifest/i);
  });

  it("serves a hashed asset with its content type and immutable caching", () => {
    const assets = loadWebAssets(fixtureDist());
    const res = fakeRes();
    expect(assets.serve(req("/assets/main-AbC123.js"), res)).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers?.["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers?.["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.body).toBe("console.log('entry')");
    const css = fakeRes();
    assets.serve(req("/assets/main-DeF456.css"), css);
    expect(css.headers?.["content-type"]).toBe("text/css; charset=utf-8");
  });

  it("owns only /assets/*: other paths fall through", () => {
    const assets = loadWebAssets(fixtureDist());
    expect(assets.serve(req("/runs"), fakeRes())).toBe(false);
    expect(assets.serve(req("/"), fakeRes())).toBe(false);
  });

  it("404s an unknown asset and never reads outside the dist (traversal-shaped paths)", () => {
    const assets = loadWebAssets(fixtureDist());
    for (const p of ["/assets/nope.js", "/assets/../secrets", "/assets/%2e%2e/secrets", "/assets/a/../../x"]) {
      const res = fakeRes();
      expect(assets.serve(req(p), res)).toBe(true);
      expect(res.status).toBe(404);
      expect(res.body).toBe("not found");
    }
  });

  it("is GET/HEAD-only; a HEAD sends headers and no body", () => {
    const assets = loadWebAssets(fixtureDist());
    const post = fakeRes();
    assets.serve(req("/assets/main-AbC123.js", "POST"), post);
    expect(post.status).toBe(405);
    const head = fakeRes();
    assets.serve(req("/assets/main-AbC123.js", "HEAD"), head);
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("ignores query strings on asset URLs", () => {
    const assets = loadWebAssets(fixtureDist());
    const res = fakeRes();
    assets.serve(req("/assets/main-AbC123.js?v=1"), res);
    expect(res.status).toBe(200);
  });
});
