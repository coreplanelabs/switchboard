// The dashboard screenshots (docs/reference/specs/screenshot-capture.md).
//
//   npm run screenshots:gen     render stale surfaces and record their inputs
//                               (--force re-renders all; --no-build reuses the bundle)
//   npm run screenshots:check   drift and missing/stray output checks, no browser
//
// The resolver in screenshotManifest.ts owns profiles, output names and hashes.
// This file owns the filesystem and browser. The fixture and browser clocks,
// density, locale, timezone and motion are pinned; no real workspace is read.
// `gen` needs the browser pinned by playwright-core.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  type Surface,
} from "../src/docs/screenshotManifest.js";

const PORT = 8791;
/** A picture past this is a page weight problem, not a screenshot. */
const SIZE_BUDGET_BYTES = 400 * 1024;

const root = process.cwd();
const dir = join(root, SCREENSHOTS_DIR);
const check = process.argv.includes("--check");
const tag = check ? "screenshots:check" : "screenshots:gen";

function inputSources(): { path: string; text: string; bytes: Buffer }[] {
  return listInputs(root).map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, text: bytes.toString("utf8"), bytes };
  });
}

function recordedManifest(surface: string): Manifest | undefined {
  const path = join(root, manifestPath(surface));
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : undefined;
}

function presentPictures(): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
}

function presentManifests(): string[] {
  const mdir = join(root, MANIFEST_DIR);
  return existsSync(mdir) ? readdirSync(mdir).filter((f) => f.endsWith(".json")) : [];
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
  for (const png of presentPictures().filter((f) => !expectedPngs.has(f))) {
    unlinkSync(join(dir, png));
    console.log(`${tag} removed stray ${png}`);
  }
  for (const m of presentManifests().filter((f) => !expectedManifests.has(f))) {
    unlinkSync(join(root, MANIFEST_DIR, m));
    console.log(`${tag} removed stray manifest/${m}`);
  }
  const present = presentPictures();
  const force = process.argv.includes("--force");
  const stale = SURFACES.filter(
    (s) => force || manifestProblems(s, current.get(s.name)!, recordedManifest(s.name), present).length > 0,
  );
  if (stale.length === 0) {
    console.log(`${tag} nothing to render — every surface is current (use --force to re-render)`);
    return 0;
  }
  console.log(`${tag} rendering ${stale.length}/${SURFACES.length} surface(s): ${stale.map((s) => s.name).join(", ")}`);
  if (!process.argv.includes("--no-build")) {
    const build = spawnSync("npm", ["run", "--silent", "build", "-w", "web"], { cwd: root, stdio: "inherit" });
    if (build.status !== 0) return build.status ?? 1;
  }
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch().catch((e: unknown) => {
    throw new Error(`${tag} could not launch chromium — run \`npx playwright-core install chromium\`\n${String(e)}`);
  });
  mkdirSync(dir, { recursive: true });
  try {
    for (const server of new Set(stale.map((s) => s.fixture.server))) {
      const surfaces = stale.filter((s) => s.fixture.server === server);
      const stopPreview = await startPreview(surfaces[0]);
      try {
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
              await page.clock.setFixedTime(FIXED_NOW);
              const response = await page.goto(`${origin}${surface.path}`, { waitUntil: "load" });
              if (!response?.ok()) throw new Error(`Preview failed: ${surface.name}`);
              await page.waitForSelector("#app header");
              await page.evaluate(() => document.fonts.ready);
              // Icons paint a frame after mount; retain the fixed settle.
              await page.waitForTimeout(500);
              const file = join(dir, capture.file);
              const next = await page.screenshot(capture.screenshot);
              const previous = existsSync(file) ? readFileSync(file) : undefined;
              // Compression can change PNG bytes without changing a pixel. Decode
              // in the browser we already own rather than adding a PNG dependency.
              const unchanged =
                previous &&
                (previous.equals(next) ||
                  (await page.evaluate(samePngPixels, [previous.toString("base64"), next.toString("base64")] as [
                    string,
                    string,
                  ])));
              if (!unchanged) writeFileSync(file, next);
              const kib = Math.round(statSync(file).size / 1024);
              const over = statSync(file).size > SIZE_BUDGET_BYTES ? " — over the 400 KiB budget" : "";
              console.log(
                `${tag} ${capture.file} ${kib} KiB — ${unchanged ? "pixels unchanged; bytes retained" : "new or changed pixels"} (${surface.what})${over}`,
              );
              await page.close();
            }
          } finally {
            await context.close();
          }
        }
      } finally {
        await stopPreview();
      }
    }
  } finally {
    await browser.close();
  }
  mkdirSync(join(root, MANIFEST_DIR), { recursive: true });
  for (const surface of stale) {
    const manifest = renderManifest(current.get(surface.name)!, surface);
    writeFileSync(join(root, manifestPath(surface.name)), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${tag} wrote ${manifestPath(surface.name)} — ${Object.keys(manifest.inputs).length} input(s) hashed`);
  }
  return 0;
}

process.exitCode = check ? runCheck() : await runGen();
