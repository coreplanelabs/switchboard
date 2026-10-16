import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  symlinkSync,
  fstatSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWebAssets, WEB_DIST_DIR, webDistDir } from "./webAssets.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});
afterEach(() => vi.mocked(readFileSync).mockReset());

/** A minimal Vite dist: manifest + entry js/css + a lazy chunk. */
function fixtureDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-web-assets-"));
  mkdirSync(join(dir, ".vite"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  const manifest = {
    "green/main.ts": { file: "assets/main-AbC123.js", isEntry: true, css: ["assets/main-DeF456.css"] },
    "green/pages/RunRoute.vue": { file: "assets/RunPage-XyZ789.js", isDynamicEntry: true, imports: ["green/main.ts"] },
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

type FakeRes = Recorded & import("node:http").ServerResponse;

function fakeRes(): FakeRes {
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
  return r as unknown as FakeRes;
}

const req = (url: string, method = "GET") => ({ url, method }) as import("node:http").IncomingMessage;

describe("loadWebAssets", () => {
  it("refuses external asset symlinks while safe directory entries remain unserved", () => {
    const dir = fixtureDist();
    mkdirSync(join(dir, "assets", "nested"));
    const safe = loadWebAssets(dir);
    const regular = fakeRes();
    safe.serve(req("/assets/main-AbC123.js"), regular);
    expect(regular.body).toBe("console.log('entry')");
    const directory = fakeRes();
    safe.serve(req("/assets/nested"), directory);
    expect(directory.status).toBe(404);
    const external = join(mkdtempSync(join(tmpdir(), "sb-web-external-")), "secret.js");
    writeFileSync(external, "private external bytes");
    symlinkSync(external, join(dir, "assets", "linked.js"));
    expect(() => loadWebAssets(dir)).toThrow();
  });
  it("caches the inspected original file when its pathname is replaced before reading and closes the descriptor", async () => {
    const dir = fixtureDist();
    const path = join(dir, "assets", "main-AbC123.js");
    const inode = statSync(path).ino;
    const external = join(mkdtempSync(join(tmpdir(), "sb-web-replacement-")), "secret.js");
    writeFileSync(external, "private replacement bytes");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let swapped = false;
    let descriptor: number | undefined;
    vi.mocked(readFileSync).mockImplementation(((input: string | number, options?: unknown) => {
      if (!swapped && (input === path || (typeof input === "number" && fstatSync(input).ino === inode))) {
        swapped = true;
        if (typeof input === "number") descriptor = input;
        renameSync(path, `${path}.original`);
        symlinkSync(external, path);
      }
      return actual.readFileSync(input, options as Parameters<typeof readFileSync>[1]);
    }) as typeof readFileSync);
    const assets = loadWebAssets(dir);
    const response = fakeRes();
    assets.serve(req("/assets/main-AbC123.js"), response);
    expect(response.status).toBe(200);
    expect(response.body).toBe("console.log('entry')");
    expect(swapped).toBe(true);
    expect(() => fstatSync(descriptor!)).toThrow(/bad file descriptor|EBADF/i);
  });
  it("selects the requested frontend and includes its shared static styles", () => {
    const dir = fixtureDist();
    writeFileSync(
      join(dir, ".vite", "manifest.json"),
      JSON.stringify({
        "green/main.ts": { file: "assets/green.js", isEntry: true, css: ["assets/green.css"], imports: ["_shared.js"] },
        "src/main.ts": {
          file: "assets/main-AbC123.js",
          isEntry: true,
          css: ["assets/main-DeF456.css"],
          imports: ["_shared.js"],
        },
        "_shared.js": { file: "assets/shared.js", css: ["assets/shared.css"] },
      }),
    );
    expect(loadWebAssets(dir, "src/main.ts").entry).toEqual({
      js: "/assets/main-AbC123.js",
      css: ["/assets/shared.css", "/assets/main-DeF456.css"],
    });
    expect(loadWebAssets(dir).entry).toEqual({
      js: "/assets/green.js",
      css: ["/assets/shared.css", "/assets/green.css"],
    });
  });
  it("refuses a missing frontend entry instead of switching the viewer to another build", () => {
    expect(() => loadWebAssets(fixtureDist(), "missing/main.ts")).toThrow("entry");
  });
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

describe("webDistDir", () => {
  it("is web/dist under the package root — the checkout, /app in the image, dist/assets in the npm package — never the working directory; SWITCHBOARD_WEB_DIST overrides it", () => {
    expect(WEB_DIST_DIR).toBe("web/dist");
    expect(webDistDir({}, "/repo")).toBe("/repo/web/dist");
    expect(webDistDir({}, "/app")).toBe("/app/web/dist");
    expect(webDistDir({}, "/x/node_modules/@scope/pkg/dist/assets")).toBe(
      "/x/node_modules/@scope/pkg/dist/assets/web/dist",
    );
    expect(webDistDir({ SWITCHBOARD_WEB_DIST: "/elsewhere/dist" }, "/repo")).toBe("/elsewhere/dist");
  });
});
