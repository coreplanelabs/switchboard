import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { renderManifest, type RenderedRequest, type Surface } from "./screenshotManifest.js";
import {
  captureRequired,
  renderedAssets,
  renderedInputs,
  renderedMechanics,
  loadRenderedAssets,
} from "./screenshotRenderedInputs.js";

const surface: Surface = {
  name: "sample",
  path: "/sample",
  page: "web/src/pages/Sample.vue",
  what: "fixture",
  fixture: { server: "scripts/web-preview.ts", inputs: [] },
};
const pictures = ["sample-light.png", "sample-dark.png"];
const requests: RenderedRequest[] = [
  { path: "/sample", accept: "text/html" },
  { path: "/assets/main.js", accept: "*/*" },
  { path: "/assets/font.woff2", accept: "*/*" },
  { path: "/assets/main.css", accept: "*/*" },
  { path: "/assets/mark.svg", accept: "*/*" },
  { path: "/assets/data.json", accept: "*/*" },
  { path: "/assets/image.png", accept: "*/*" },
  { path: "/events", accept: "text/event-stream" },
];
const bundle = (
  hash = "abcdefgh",
  code = 'import("./Other-abcdefgh.js");',
  font = [1, 2, 3],
  css = "body{color:black}",
) => {
  const files = [
    { path: `assets/main-${hash}.js`, bytes: Buffer.from(code.replaceAll("abcdefgh", hash)), type: "text/javascript" },
    { path: `assets/Other-${hash}.js`, bytes: Buffer.from("unrelated page"), type: "text/javascript" },
    { path: `assets/font-${hash}.woff2`, bytes: Uint8Array.from(font), type: "font/woff2" },
    { path: `assets/main-${hash}.css`, bytes: Buffer.from(css), type: "text/css" },
    { path: `assets/mark-${hash}.svg`, bytes: Buffer.from("<svg/>"), type: "image/svg+xml" },
    { path: `assets/data-${hash}.json`, bytes: Buffer.from('{"value":1}'), type: "application/json" },
    { path: `assets/image-${hash}.png`, bytes: Uint8Array.from([7, 8, 9]), type: "image/png" },
  ];
  return { assets: renderedAssets(files), files };
};
const fixtureFetch =
  (hash = "abcdefgh", seed = "alice", stream = "running", status = 200, csp = "default-src 'self'"): typeof fetch =>
  async (input) => {
    const url = new URL(String(input));
    return new Response(
      url.pathname === "/events" ? stream : `<script src="/assets/main-${hash}.js"></script>${seed}`,
      {
        status,
        headers: { "content-type": "text/html", "content-security-policy": csp, "x-switchboard-preview-snapshot": "1" },
      },
    );
  };
type AssetResponse = (file: ReturnType<typeof bundle>["files"][number]) => Response | Promise<Response>;
const servedAsset = (
  file: ReturnType<typeof bundle>["files"][number],
  init: Omit<ResponseInit, "headers"> & { headers?: Record<string, string> } = {},
) =>
  new Response(new Uint8Array(file.bytes), {
    ...init,
    headers: { "content-type": file.type, "x-switchboard-preview-snapshot": "1", ...init.headers },
  });
const snapshot = (state = bundle(), fetchResponse = fixtureFetch(), mechanics = {}, assetResponse?: AssetResponse) =>
  renderedInputs("http://127.0.0.1:8791", requests, state.assets, mechanics, async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (!path.startsWith("/assets/")) return fetchResponse(input, init);
    const file = state.files.find((file) => `/${file.path}` === path);
    if (!file) throw new Error(`Fixture asset unavailable: ${path}`);
    return assetResponse ? assetResponse(file) : servedAsset(file);
  });

describe("rendered screenshot inputs", () => {
  it("keeps same-name chunks from different frontend entries distinct", async () => {
    const root = mkdtempSync(join(tmpdir(), "rendered-entries-"));
    try {
      mkdirSync(join(root, "web/dist/assets"), { recursive: true });
      mkdirSync(join(root, "web/dist/.vite"), { recursive: true });
      writeFileSync(join(root, "web/dist/assets/delivery-abcdefgh.js"), "legacy delivery");
      writeFileSync(join(root, "web/dist/assets/delivery-ijklmnop.js"), "replacement delivery");
      writeFileSync(
        join(root, "web/dist/.vite/manifest.json"),
        JSON.stringify({
          "_delivery-abcdefgh.js": { file: "assets/delivery-abcdefgh.js" },
          "_delivery-ijklmnop.js": { file: "assets/delivery-ijklmnop.js" },
        }),
      );
      const assets = loadRenderedAssets(root);
      const first = assets.request({ path: "/assets/delivery-abcdefgh.js", accept: "*/*" });
      const second = assets.request({ path: "/assets/delivery-ijklmnop.js", accept: "*/*" });
      expect(readFileSync(join(root, "web/dist", assets.resolve(first.path)), "utf8")).toBe("legacy delivery");
      expect(readFileSync(join(root, "web/dist", assets.resolve(second.path)), "utf8")).toBe("replacement delivery");
      const loaded = await renderedInputs("http://127.0.0.1:8791", [first, second], assets, {}, async (input) => {
        const path = new URL(String(input)).pathname;
        return new Response(readFileSync(join(root, "web/dist", path), "utf8"), {
          headers: { "content-type": "text/javascript", "x-switchboard-preview-snapshot": "1" },
        });
      });
      expect(loaded.requests).toHaveLength(2);
      expect(Object.keys(loaded.inputs).filter((key) => key.startsWith("response:"))).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips capture after source-only changes and unrelated asset filename changes", async () => {
    const prior = await snapshot();
    const recorded = renderManifest({ "src/backend.ts": "old source" }, surface, prior);
    const next = await snapshot(bundle("ijklmnop"), fixtureFetch("ijklmnop"));
    expect(next.requests).toContainEqual({ path: "/assets/main.js", accept: "*/*" });
    expect(captureRequired(surface, recorded, pictures, next)).toBe(false);
    expect(
      captureRequired(
        surface,
        recorded,
        pictures,
        await snapshot(bundle("ijklmnop", "changed component"), fixtureFetch("ijklmnop")),
      ),
    ).toBe(true);
  });

  it("captures changes to loaded component code, styles, fixture data, streams, fonts and response behavior", async () => {
    const recorded = renderManifest({}, surface, await snapshot());
    for (const next of [
      await snapshot(bundle("abcdefgh", "changed component")),
      await snapshot(bundle(), fixtureFetch("abcdefgh", "sam")),
      await snapshot(bundle(), fixtureFetch("abcdefgh", "alice", "failed")),
      await snapshot(bundle("abcdefgh", undefined, [4, 5, 6])),
      await snapshot(bundle("abcdefgh", undefined, undefined, "body{color:red}")),
      await snapshot(bundle(), fixtureFetch("abcdefgh", "alice", "running", 404)),
      await snapshot(bundle(), fixtureFetch("abcdefgh", "alice", "running", 200, "default-src 'none'")),
      await snapshot(bundle(), fixtureFetch(), { capture: "new clock" }),
    ])
      expect(captureRequired(surface, recorded, pictures, next)).toBe(true);
    expect(captureRequired(surface, recorded, pictures, await snapshot())).toBe(false);
  });

  it("compares served asset bodies, status and headers instead of trusting emitted bytes", async () => {
    const recorded = renderManifest({}, surface, await snapshot());
    const state = bundle();
    const alter =
      (path: string, response: AssetResponse): AssetResponse =>
      (file) =>
        file.path === path ? response(file) : servedAsset(file);
    for (const target of state.files.filter((file) => !file.path.includes("/Other-"))) {
      const changedBody = alter(
        target.path,
        (file) =>
          new Response(
            ["font/woff2", "image/png"].includes(file.type) ? new Uint8Array([4, 5, 6]) : "changed served text",
            { headers: { "content-type": file.type, "x-switchboard-preview-snapshot": "1" } },
          ),
      );
      expect(
        captureRequired(surface, recorded, pictures, await snapshot(state, fixtureFetch(), {}, changedBody)),
        target.path,
      ).toBe(true);
    }
    const css = state.files.find((file) => file.type === "text/css")!;
    for (const status of [404, 302, 500]) {
      const response = alter(css.path, (file) => servedAsset(file, { status, headers: { location: "/other" } }));
      expect(captureRequired(surface, recorded, pictures, await snapshot(state, fixtureFetch(), {}, response))).toBe(
        true,
      );
    }
    const changedHeaders: Record<string, string>[] = [
      { "content-type": "application/octet-stream" },
      { "x-content-type-options": "nosniff" },
      { "content-security-policy": "default-src 'none'" },
    ];
    for (const headers of changedHeaders) {
      const response = alter(css.path, (file) => servedAsset(file, { headers }));
      expect(captureRequired(surface, recorded, pictures, await snapshot(state, fixtureFetch(), {}, response))).toBe(
        true,
      );
    }
    expect(captureRequired(surface, recorded, pictures, await snapshot())).toBe(false);
    await expect(
      snapshot(
        state,
        fixtureFetch(),
        {},
        alter(css.path, () => new Response("unacknowledged asset")),
      ),
    ).rejects.toThrow("does not support rendered-input snapshots");
    const failedBody = alter(
      css.path,
      (file) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException("asset read timed out", "TimeoutError"));
            },
          }),
          { headers: { "content-type": file.type, "x-switchboard-preview-snapshot": "1" } },
        ),
    );
    await expect(snapshot(state, fixtureFetch(), {}, failedBody)).rejects.toThrow("asset read timed out");
  });

  it("invalidates live snapshots when replay selection or clock code changes, but ignores comments", async () => {
    const text = readFileSync(new URL("../../scripts/web-preview.ts", import.meta.url), "utf8");
    const start = text.indexOf("const LAST_CALL_INDEX =");
    const source = text.slice(start, text.indexOf("\nconst RESIDENTS =", start));
    const replay = (code: string, snapshot: boolean, clock = () => 1234) => {
      let interval = () => {};
      let body = "";
      const context = {
        NOW: 1234,
        HIST_EVENTS: [
          { type: "input", text: "first", seq: 1, at: 100 },
          { type: "tool_call", seq: 2, at: 101 },
          { type: "answer", seq: 3, at: 102 },
        ],
        systemClock: clock,
        setInterval: (callback: () => void) => {
          interval = callback;
          return 1;
        },
        clearInterval: () => {},
        res: {
          writeHead: () => {},
          write: (value: string) => {
            body += value;
          },
          end: (value: string) => {
            body += value;
          },
          on: () => {},
        },
      };
      vm.runInNewContext(
        ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext, removeComments: true } })
          .outputText + `\nserveLiveStream(res, ${snapshot});`,
        context,
      );
      if (!snapshot) interval();
      return body;
    };
    const changed = source.replace("let i = 0;", "let i = 1;");
    expect(replay(source, false)).toBe(
      'retry: 3000\n\nid: 1\ndata: {"type":"input","text":"first","seq":1,"at":1234}\n\n',
    );
    expect(replay(changed, false)).toBe('retry: 3000\n\nid: 2\ndata: {"type":"tool_call","seq":2,"at":1234}\n\n');
    const next = (body: string) =>
      renderedInputs(
        "http://127.0.0.1:8791",
        [{ path: "/events", accept: "text/event-stream" }],
        renderedAssets([]),
        {},
        async () =>
          new Response(body, {
            headers: { "content-type": "application/json", "x-switchboard-preview-snapshot": "1" },
          }),
      );
    const recorded = renderManifest({}, surface, await next(replay(source, true)));
    expect(captureRequired(surface, recorded, pictures, await next(replay(changed, true)))).toBe(true);
    expect(captureRequired(surface, recorded, pictures, await next(replay(source, true, () => 2234)))).toBe(true);
    expect(
      captureRequired(
        surface,
        recorded,
        pictures,
        await next(replay(source.replace("let i = 0;", "/* Comment only. */ let i = 0;"), true)),
      ),
    ).toBe(false);
  });

  it("requires capture for missing cache, unavailable inputs, missing images and changed settings", async () => {
    const next = await snapshot();
    const recorded = renderManifest({}, surface, next);
    expect(captureRequired(surface, recorded, pictures, next)).toBe(false);
    expect(captureRequired(surface, undefined, pictures, next)).toBe(true);
    expect(captureRequired(surface, renderManifest({}, surface), pictures, next)).toBe(true);
    expect(captureRequired(surface, recorded, pictures, undefined)).toBe(true);
    expect(captureRequired(surface, recorded, ["sample-light.png"], next)).toBe(true);
    expect(captureRequired({ ...surface, path: "/other" }, recorded, pictures, next)).toBe(true);
  });

  it("fails closed on absent assets, ambiguous names, remote requests and failed fixture reads", async () => {
    await expect(snapshot({ assets: renderedAssets([]), files: [] })).rejects.toThrow("Missing screenshot asset");
    expect(() => renderedAssets([{ path: "assets/main-abcdefgh.js" }, { path: "assets/main-ijklmnop.js" }])).toThrow(
      "Ambiguous screenshot asset",
    );
    await expect(
      renderedInputs("http://127.0.0.1:8791", [{ path: "//example.com/", accept: "*/*" }], bundle().assets, {}),
    ).rejects.toThrow("must stay local");
    await expect(
      snapshot(bundle(), async () => {
        throw new Error("fixture unavailable");
      }),
    ).rejects.toThrow("fixture unavailable");
    await expect(snapshot(bundle(), async () => new Response("unknown preview"))).rejects.toThrow(
      "does not support rendered-input snapshots",
    );
  });

  it("ignores comments and erased types while keeping executable capture code and Chromium pinned", () => {
    const sources = (text: string, version = "1.63.0") => [
      { path: "scripts/screenshots.mts", text },
      {
        path: "package-lock.json",
        text: JSON.stringify({ packages: { "node_modules/playwright-core": { version, integrity: "browser" } } }),
      },
    ];
    const before = renderedMechanics(sources("export const clock = 1;"));
    const same = renderedMechanics(sources("// changed comment\nexport const clock: number = 1;"));
    expect(same).toEqual(before);
    expect(renderedMechanics(sources("export const clock = 2;"))).not.toEqual(before);
    expect(renderedMechanics(sources("export const clock = 1;", "1.64.0"))).not.toEqual(before);
    expect(Object.keys(before).sort()).toEqual(["node_modules/playwright-core", "scripts/screenshots.mts"]);
  });
});
