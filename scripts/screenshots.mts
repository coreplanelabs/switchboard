// The dashboard screenshots (docs/reference/specs/docs-site.md item 20).
//
//   npm run screenshots:gen     build the dashboard, serve the fixture preview,
//                               render each surface whose inputs changed (both
//                               themes) to docs/public/screenshots/<surface>-<theme>.png,
//                               and record that surface's inputs' hashes in
//                               manifest/<surface>.json — untouched surfaces'
//                               pictures and manifests never move (--force
//                               re-renders everything)
//   npm run screenshots:check   what CI runs — no browser: exit 1 naming each
//                               surface whose inputs changed since it was
//                               rendered, and each picture missing
//
// Deterministic by construction: the preview and the browser are held at one
// fixed clock, the viewport, density, locale and timezone are pinned, motion
// is off, and the fixture carries only made-up names. The decisions live in
// src/docs/screenshotManifest.ts and are unit-tested there; this file reads and
// writes the tree, drives the browser, and nothing else.
//
// `gen` needs the browser `playwright-core` pins: `npx playwright-core install chromium`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectedFiles,
  FIXED_NOW,
  hashInputs,
  listInputs,
  MANIFEST_DIR,
  manifestPath,
  manifestProblems,
  renderManifest,
  SCREENSHOTS_DIR,
  strayFiles,
  SURFACES,
  surfaceInputs,
  THEMES,
  VIEWPORT,
  type Manifest,
} from "../src/docs/screenshotManifest.js";

const PORT = 8791;
/** A picture past this is a page weight problem, not a screenshot. */
const SIZE_BUDGET_BYTES = 400 * 1024;

const root = process.cwd();
const dir = join(root, SCREENSHOTS_DIR);
const check = process.argv.includes("--check");
const tag = check ? "screenshots:check" : "screenshots:gen";

/** Every input's source text, read once; surfaceInputs slices it per page. */
function inputSources(): { path: string; text: string }[] {
  return listInputs(root).map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

/** One surface's inputs in this tree, hashed. */
function currentSurfaceInputs(page: string, sources: { path: string; text: string }[]): Record<string, string> {
  const paths = new Set(surfaceInputs(page, sources));
  return hashInputs(sources.filter((f) => paths.has(f.path)));
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
      manifestProblems(s.name, currentSurfaceInputs(s.page, sources), recordedManifest(s.name), present),
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

/** The preview server on a fixed clock; resolves once it answers. */
async function startPreview(): Promise<() => void> {
  const server = spawn(join(root, "node_modules", ".bin", "tsx"), ["scripts/web-preview.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), SWITCHBOARD_PREVIEW_NOW: String(FIXED_NOW) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const stop = () => server.kill();
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/runs`);
      if (res.ok) return stop;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  throw new Error(`the preview did not answer on port ${PORT} within 30 s`);
}

async function runGen(): Promise<number> {
  // A surface whose recorded inputs equal this tree's and whose pictures are
  // present was rendered from exactly this code — re-rendering it could only
  // introduce environment noise, so it is skipped (the issue this fixes:
  // unrelated PNGs moving on every gen). `--force` re-renders everything.
  const sources = inputSources();
  // A removed or renamed surface leaves its old picture and manifest behind;
  // check reports them as stray, so gen sweeps them here.
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
    (s) =>
      force ||
      manifestProblems(s.name, currentSurfaceInputs(s.page, sources), recordedManifest(s.name), present).length > 0,
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
  const stopPreview = await startPreview();
  const browser = await chromium.launch().catch((e: unknown) => {
    stopPreview();
    throw new Error(`${tag} could not launch chromium — run \`npx playwright-core install chromium\`\n${String(e)}`);
  });
  mkdirSync(dir, { recursive: true });
  try {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
        deviceScaleFactor: VIEWPORT.deviceScaleFactor,
        colorScheme: theme,
        reducedMotion: "reduce",
        timezoneId: "UTC",
        locale: "en-US",
      });
      // The header's theme switch (web/src/components/ThemeToggle.vue) reads
      // this key on mount and stamps the class the token set keys on.
      await context.addInitScript((t: string) => localStorage.setItem("vueuse-color-scheme", t), theme);
      for (const surface of stale) {
        const page = await context.newPage();
        await page.clock.setFixedTime(FIXED_NOW);
        await page.goto(`http://127.0.0.1:${PORT}${surface.path}`, { waitUntil: "load" });
        await page.waitForSelector("#app header");
        await page.evaluate(() => document.fonts.ready);
        // Icons are bundled but painted a frame after mount; a fixed settle
        // is what makes two renders of one tree agree.
        await page.waitForTimeout(500);
        const file = join(dir, `${surface.name}-${theme}.png`);
        await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
        await page.close();
        const kib = Math.round(statSync(file).size / 1024);
        const over = statSync(file).size > SIZE_BUDGET_BYTES ? " — over the 400 KiB budget" : "";
        console.log(`${tag} ${surface.name}-${theme}.png ${kib} KiB (${surface.what})${over}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    stopPreview();
  }
  mkdirSync(join(root, MANIFEST_DIR), { recursive: true });
  for (const surface of stale) {
    const manifest = renderManifest(currentSurfaceInputs(surface.page, sources));
    writeFileSync(join(root, manifestPath(surface.name)), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${tag} wrote ${manifestPath(surface.name)} — ${Object.keys(manifest.inputs).length} input(s) hashed`);
  }
  return 0;
}

process.exitCode = check ? runCheck() : await runGen();
