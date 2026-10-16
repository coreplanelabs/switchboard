import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  captureMechanicsSource,
  hashInputs,
  renderManifest,
  resolveCaptures,
  type Manifest,
  type RenderedInputs,
  type RenderedRequest,
  type Surface,
} from "./screenshotManifest.js";

/** Hashed filenames can move when an unrelated lazy page changes. Compare the
 * bytes each page actually loaded, with references expressed as stable names. */
export function renderedAssets(files: readonly { path: string; name?: string }[]) {
  const assets = new Map<string, { path: string }>();
  const names = new Map<string, string>();
  for (const file of files) {
    const stable = file.name ?? file.path.replace(/-[\w-]{8}(?=\.[^./]+$)/, "");
    if (assets.has(stable)) throw new Error(`Ambiguous screenshot asset: ${stable}`);
    assets.set(stable, file);
    names.set(file.path.split("/").at(-1)!, stable.split("/").at(-1)!);
  }
  const pattern = new RegExp([...names.keys()].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  const normalize = (text: string) => (names.size ? text.replace(pattern, (name) => names.get(name)!) : text);
  return {
    normalize,
    request(request: RenderedRequest): RenderedRequest {
      return { ...request, path: normalize(request.path) };
    },
    resolve(path: string): string {
      const url = new URL(path, "http://localhost");
      const file = assets.get(url.pathname.slice(1));
      if (!file) throw new Error(`Missing screenshot asset: ${path}`);
      return `/${file.path}${url.search}`;
    },
  };
}

export function loadRenderedAssets(root: string) {
  const dir = join(root, "web/dist/assets");
  const manifest = JSON.parse(readFileSync(join(root, "web/dist/.vite/manifest.json"), "utf8")) as Record<
    string,
    { file: string; src?: string }
  >;
  const chunks = Object.entries(manifest)
    .sort()
    .map(([key, chunk]) => ({
      key,
      file: chunk.file,
      identity: chunk.src ?? key.replace(/-[\w-]{8}(?=\.[^./]+$)/, ""),
    }));
  const filesByIdentity = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    const files = filesByIdentity.get(chunk.identity) ?? new Set<string>();
    files.add(chunk.file);
    filesByIdentity.set(chunk.identity, files);
  }
  // Dual entry builds can emit different modules under one basename. Keep the
  // full manifest key for those collisions instead of aliasing their bytes.
  const identities = new Map(
    chunks.map((chunk) => [chunk.file, filesByIdentity.get(chunk.identity)!.size > 1 ? chunk.key : chunk.identity]),
  );
  return renderedAssets(
    readdirSync(dir).map((name) => {
      const path = `assets/${name}`;
      const identity = identities.get(path);
      return {
        path,
        ...(identity
          ? {
              name: `assets/${hashInputs([{ path: "id", text: identity }]).id.slice(0, 16)}${name.slice(name.lastIndexOf("."))}`,
            }
          : {}),
      };
    }),
  );
}

/** Capture mechanics and Chromium's package identity remain inputs even when
 * the emitted app is unchanged. Build-tool versions are reflected in output. */
export function renderedMechanics(sources: readonly { path: string; text: string }[]): Record<string, string> {
  const mechanics = sources.filter((s) =>
    /^(?:scripts\/screenshots\.mts|scripts\/screenshot-output-worker\.mts|src\/docs\/screenshot[^/]*\.ts)$/.test(
      s.path,
    ),
  );
  const lock = JSON.parse(sources.find((s) => s.path === "package-lock.json")!.text) as {
    packages: Record<string, { version?: string; integrity?: string }>;
  };
  const browser = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/playwright-core$/.test(path));
  if (!browser.length) throw new Error("Missing screenshot Chromium package");
  return hashInputs([
    ...mechanics.map((s) => ({
      path: s.path,
      text: ts.transpileModule(s.path === "src/docs/screenshotManifest.ts" ? captureMechanicsSource(s.text) : s.text, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true },
      }).outputText,
    })),
    ...browser.map(([path, { version, integrity }]) => ({ path, text: JSON.stringify({ version, integrity }) })),
  ]);
}

/** Replay only GET resources observed during capture. Changed code or initial
 * data forces capture, which discovers any newly conditional requests. */
export async function renderedInputs(
  origin: string,
  requests: readonly RenderedRequest[],
  assets: ReturnType<typeof renderedAssets>,
  mechanics: Record<string, string>,
  fetchResponse: typeof fetch = fetch,
): Promise<RenderedInputs> {
  const unique = new Map(
    requests.map((r) => {
      const request = assets.request(r);
      return [JSON.stringify(request), request] as const;
    }),
  );
  const selected = [...unique.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const inputs = await Promise.all(
    selected.map(async (request) => {
      const url = new URL(request.path.startsWith("/assets/") ? assets.resolve(request.path) : request.path, origin);
      if (!request.path.startsWith("/") || url.origin !== origin)
        throw new Error("Screenshot requests must stay local");
      const path = `response:${request.accept}:${request.path}`;
      const response = await fetchResponse(url, {
        headers: { accept: request.accept, "x-switchboard-preview-snapshot": "1" },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.headers.get("x-switchboard-preview-snapshot") !== "1") {
        await response.body?.cancel();
        throw new Error("Preview does not support rendered-input snapshots");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const type = response.headers.get("content-type") ?? "";
      const body = /(?:text\/|json|javascript|svg)/.test(type)
        ? Buffer.from(assets.normalize(bytes.toString("utf8")))
        : bytes;
      // Header changes can affect script execution, image decoding or CSP.
      const headers = [...response.headers]
        .filter(([name]) => !["date", "connection", "keep-alive", "content-length"].includes(name))
        .sort();
      return { path, text: Buffer.concat([Buffer.from(JSON.stringify([response.status, headers])), body]) };
    }),
  );
  return { requests: selected, inputs: { ...mechanics, ...hashInputs(inputs) } };
}

/** No cache or incomplete artifacts always require a real capture. */
export function captureRequired(
  surface: Surface,
  recorded: Manifest | undefined,
  present: readonly string[],
  next: RenderedInputs | undefined,
): boolean {
  return (
    !next ||
    !recorded?.rendered ||
    recorded.configHash !== renderManifest({}, surface).configHash ||
    resolveCaptures([surface]).some((c) => !present.includes(c.file)) ||
    JSON.stringify(Object.entries(recorded.rendered.inputs).sort()) !==
      JSON.stringify(Object.entries(next.inputs).sort())
  );
}
