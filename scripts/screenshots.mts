// The dashboard screenshots (docs/reference/specs/screenshot-capture.md).
//
//   npm run screenshots:gen     refresh stale surfaces; capture changed rendered inputs
//                               (--force re-renders all; --no-build reuses the bundle)
//   npm run screenshots:check   drift and missing/stray output checks, no browser
//
// The resolver in screenshotManifest.ts owns profiles, output names and hashes.
// This file owns the filesystem and browser. The fixture and browser clocks,
// density, locale, timezone and motion are pinned; no real workspace is read.
// `gen` needs the browser pinned by playwright-core.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  captureBatches,
  currentSurfaceInputs,
  expectedFiles,
  FIXED_NOW,
  listInputs,
  MANIFEST_DIR,
  manifestPath,
  manifestProblems,
  renderManifest,
  samePngPixels,
  SCREENSHOTS_DIR,
  strayFiles,
  SURFACES,
  type Manifest,
  type RenderedInputs,
  type RenderedRequest,
  type Surface,
} from "../src/docs/screenshotManifest.js";
import {
  ensureOutputDirectory,
  listOutputFiles,
  publishOutputFile,
  readOutputFile,
  removeUnexpectedOutputFiles,
} from "../src/docs/screenshotOutput.js";
import {
  captureRequired,
  loadRenderedAssets,
  renderedInputs,
  renderedMechanics,
} from "../src/docs/screenshotRenderedInputs.js";

/** A picture past this is a page weight problem, not a screenshot. */
const SIZE_BUDGET_BYTES = 400 * 1024;

const root = process.cwd();
const check = process.argv.includes("--check");
const tag = check ? "screenshots:check" : "screenshots:gen";
// Parallel captures must not attach to another preview's fixed port.
const PORT = check
  ? 0
  : await new Promise<number>((resolve, reject) => {
      const reservation = createServer();
      reservation.on("error", reject);
      reservation.listen(0, "127.0.0.1", () => {
        const address = reservation.address();
        if (!address || typeof address === "string") {
          reservation.close();
          reject(new Error("Could not allocate a screenshot preview port"));
          return;
        }
        reservation.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });

function inputSources(): { path: string; text: string; bytes: Buffer }[] {
  return listInputs(root).map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, text: bytes.toString("utf8"), bytes };
  });
}

function recordedManifest(surface: string): Manifest | undefined {
  const bytes = readOutputFile(root, MANIFEST_DIR, `${surface}.json`);
  return bytes ? (JSON.parse(bytes.toString("utf8")) as Manifest) : undefined;
}

function presentPictures(): string[] {
  return listOutputFiles(root, SCREENSHOTS_DIR).filter((f) => f.endsWith(".png"));
}

function presentManifests(): string[] {
  return listOutputFiles(root, MANIFEST_DIR).filter((f) => f.endsWith(".json"));
}

function runCheck(): number {
  const sources = inputSources();
  const present = presentPictures();
  const problems = [
    ...SURFACES.flatMap((s) =>
      manifestProblems(s, currentSurfaceInputs(s, sources), recordedManifest(s.name), present),
    ),
    ...strayFiles(present, presentManifests()),
  ];
  if (problems.length > 0) {
    for (const p of problems) console.error(`${tag} ${p}`);
    console.error(`${tag} the dashboard changed since its pictures were rendered — run \`npm run screenshots:gen\``);
    return 1;
  }
  console.log(`${tag} ok — ${expectedFiles().length} picture(s) current across ${SURFACES.length} surface(s)`);
  return 0;
}

/** Each server implements the same local PORT/fixed-clock fixture interface. */
async function startPreview(surface: Surface): Promise<() => Promise<void>> {
  const server = spawn(join(root, "node_modules", ".bin", "tsx"), [surface.fixture.server], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      SWITCHBOARD_PREVIEW_NOW: String(FIXED_NOW),
      SWITCHBOARD_PREVIEW_CAPABILITIES: "full",
      SWITCHBOARD_WEB_DIST: join(root, "web", "dist"),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const stopped = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  const stop = async () => {
    server.kill();
    await stopped;
  };
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error(`Preview exited: ${surface.fixture.server}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${surface.path}`);
      if (res.ok) return stop;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await stop();
  throw new Error(`the preview did not answer on port ${PORT} within 30 s`);
}

async function runGen(): Promise<number> {
  // Resolving the whole registry and every input precedes any filesystem write.
  const sources = inputSources();
  const current = new Map(SURFACES.map((s) => [s.name, currentSurfaceInputs(s, sources)]));
  const expectedPngs = new Set(expectedFiles());
  const expectedManifests = new Set(SURFACES.map((s) => `${s.name}.json`));
  for (const png of removeUnexpectedOutputFiles(root, SCREENSHOTS_DIR, ".png", expectedPngs))
    console.log(`${tag} removed stray ${png}`);
  for (const m of removeUnexpectedOutputFiles(root, MANIFEST_DIR, ".json", expectedManifests))
    console.log(`${tag} removed stray manifest/${m}`);
  const present = presentPictures();
  const force = process.argv.includes("--force");
  const stale = SURFACES.filter(
    (s) => force || manifestProblems(s, current.get(s.name)!, recordedManifest(s.name), present).length > 0,
  );
  if (stale.length === 0) {
    console.log(`${tag} nothing to render — every surface is current (use --force to re-render)`);
    return 0;
  }
  console.log(`${tag} checking ${stale.length}/${SURFACES.length} surface(s): ${stale.map((s) => s.name).join(", ")}`);
  if (!process.argv.includes("--no-build")) {
    const build = spawnSync("npm", ["run", "--silent", "build", "-w", "web"], { cwd: root, stdio: "inherit" });
    if (build.status !== 0) return build.status ?? 1;
  }
  const assets = loadRenderedAssets(root);
  const mechanics = renderedMechanics(sources);
  const rendered = new Map<string, RenderedInputs>();
  let browser: import("playwright-core").Browser | undefined;
  // Unknown or unbounded fixture responses cannot establish equivalence.
  const snapshot = async (requests: readonly RenderedRequest[]) => {
    try {
      return await renderedInputs(`http://127.0.0.1:${PORT}`, requests, assets, mechanics);
    } catch (error) {
      console.log(`${tag} rendered inputs unavailable — capturing: ${String(error)}`);
      return undefined;
    }
  };
  ensureOutputDirectory(root, SCREENSHOTS_DIR);
  try {
    for (const server of new Set(stale.map((s) => s.fixture.server))) {
      const candidates = stale.filter((s) => s.fixture.server === server);
      const stopPreview = await startPreview(candidates[0]);
      try {
        const surfaces: Surface[] = [];
        for (const surface of candidates) {
          const recorded = recordedManifest(surface.name);
          const next = recorded?.rendered ? await snapshot(recorded.rendered.requests) : undefined;
          if (!force && !captureRequired(surface, recorded, present, next)) {
            rendered.set(surface.name, next!);
            console.log(`${tag} ${surface.name} rendered inputs unchanged — skipped browser capture`);
          } else surfaces.push(surface);
        }
        if (!surfaces.length) continue;
        console.log(`${tag} capturing ${surfaces.length} surface(s): ${surfaces.map((s) => s.name).join(", ")}`);
        if (!browser) {
          const { chromium } = await import("playwright-core");
          browser = await chromium.launch().catch((e: unknown) => {
            throw new Error(
              `${tag} could not launch chromium — run \`npx playwright-core install chromium\`\n${String(e)}`,
            );
          });
        }
        const requests = new Map(surfaces.map((s) => [s.name, new Map<string, RenderedRequest>()]));
        const unsafe = new Set<string>();
        for (const batch of captureBatches(surfaces)) {
          const context = await browser.newContext(batch.context);
          try {
            await context.addInitScript(
              (t: string) => localStorage.setItem("vueuse-color-scheme", t),
              batch.context.colorScheme,
            );
            for (const { surface, capture } of batch.tasks) {
              const origin = `http://127.0.0.1:${PORT}`;
              const page = await context.newPage();
              page.on("request", (request) => {
                const url = new URL(request.url());
                if (url.origin !== origin || request.method() !== "GET") {
                  unsafe.add(surface.name);
                  return;
                }
                const input = { path: `${url.pathname}${url.search}`, accept: request.headers().accept ?? "*/*" };
                requests.get(surface.name)!.set(JSON.stringify(input), input);
              });
              await page.clock.setFixedTime(FIXED_NOW);
              const response = await page.goto(`${origin}${surface.path}`, { waitUntil: "load" });
              if (!response?.ok()) throw new Error(`Preview failed: ${surface.name}`);
              await page.waitForSelector("#app header");
              // The fixture label belongs in local previews, not in website product images.
              await page.locator(".green-notice.green-info").evaluateAll((banners) => {
                for (const banner of banners) banner.remove();
              });
              await page.evaluate(() => document.fonts.ready);
              // Icons paint a frame after mount; retain the fixed settle.
              await page.waitForTimeout(500);
              const next = await page.screenshot(capture.screenshot);
              const previous = readOutputFile(root, SCREENSHOTS_DIR, capture.file);
              // Compression can change PNG bytes without changing a pixel. Decode
              // in the browser we already own rather than adding a PNG dependency.
              let unchanged = false;
              let output = next;
              if (
                previous &&
                (previous.equals(next) ||
                  (await page.evaluate(samePngPixels, [previous.toString("base64"), next.toString("base64")] as [
                    string,
                    string,
                  ])))
              ) {
                unchanged = true;
                output = previous;
              }
              // Publish even when pixels match: a concurrent path swap is then replaced safely.
              publishOutputFile(root, SCREENSHOTS_DIR, capture.file, output);
              const size = output.length;
              const kib = Math.round(size / 1024);
              const over = size > SIZE_BUDGET_BYTES ? " — over the 400 KiB budget" : "";
              console.log(
                `${tag} ${capture.file} ${kib} KiB — ${unchanged ? "pixels unchanged; bytes retained" : "new or changed pixels"} (${surface.what})${over}`,
              );
              await page.close();
            }
          } finally {
            await context.close();
          }
        }
        for (const surface of surfaces) {
          if (unsafe.has(surface.name)) continue;
          const next = await snapshot([...requests.get(surface.name)!.values()]);
          if (next) rendered.set(surface.name, next);
        }
      } finally {
        await stopPreview();
      }
    }
  } finally {
    await browser?.close();
  }
  ensureOutputDirectory(root, MANIFEST_DIR);
  for (const surface of stale) {
    const manifest = renderManifest(current.get(surface.name)!, surface, rendered.get(surface.name));
    publishOutputFile(
      root,
      MANIFEST_DIR,
      `${surface.name}.json`,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    );
    console.log(`${tag} wrote ${manifestPath(surface.name)} — ${Object.keys(manifest.inputs).length} input(s) hashed`);
  }
  return 0;
}

process.exitCode = check ? runCheck() : await runGen();
