// The dashboard screenshots (docs/reference/specs/docs-site.md item 20).
//
//   npm run screenshots:gen     build the dashboard, serve the fixture preview,
//                               render every surface in both themes to
//                               docs/public/screenshots/<surface>-<theme>.png,
//                               and record the inputs' hashes in manifest.json
//   npm run screenshots:check   what CI runs — no browser: exit 1 naming each
//                               input that changed since the pictures were
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectedFiles,
  hashInputs,
  listInputs,
  MANIFEST_PATH,
  manifestProblems,
  renderManifest,
  SCREENSHOTS_DIR,
  SURFACES,
  THEMES,
  VIEWPORT,
  type Manifest,
} from "../src/docs/screenshotManifest.js";

/** The instant every picture is rendered at, on the server and in the browser:
 *  a weekday afternoon after the fixture's own timestamps, so "4 hours ago"
 *  reads the same on every machine. Changing it changes every picture. */
const NOW = 1_788_877_800_000;
const PORT = 8791;
/** A picture past this is a page weight problem, not a screenshot. */
const SIZE_BUDGET_BYTES = 400 * 1024;

const root = process.cwd();
const dir = join(root, SCREENSHOTS_DIR);
const check = process.argv.includes("--check");
const tag = check ? "screenshots:check" : "screenshots:gen";

function currentInputs(): Record<string, string> {
  return hashInputs(listInputs(root).map((path) => ({ path, text: readFileSync(join(root, path)) })));
}

function presentPictures(): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
}

function runCheck(): number {
  if (!existsSync(join(root, MANIFEST_PATH))) {
    console.error(`${tag} ${MANIFEST_PATH} is missing — run \`npm run screenshots:gen\``);
    return 1;
  }
  const recorded = JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8")) as Manifest;
  const problems = manifestProblems(currentInputs(), recorded, presentPictures());
  if (problems.length > 0) {
    for (const p of problems) console.error(`${tag} ${p}`);
    console.error(`${tag} the dashboard changed since its pictures were rendered — run \`npm run screenshots:gen\``);
    return 1;
  }
  console.log(
    `${tag} ok — ${expectedFiles().length} picture(s) current against ${Object.keys(recorded.inputs).length} input(s)`,
  );
  return 0;
}

/** The preview server on a fixed clock; resolves once it answers. */
async function startPreview(): Promise<() => void> {
  const server = spawn(join(root, "node_modules", ".bin", "tsx"), ["scripts/web-preview.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), SWITCHBOARD_PREVIEW_NOW: String(NOW) },
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
      for (const surface of SURFACES) {
        const page = await context.newPage();
        await page.clock.setFixedTime(NOW);
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
  const manifest = renderManifest(currentInputs(), NOW);
  writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${tag} wrote ${MANIFEST_PATH} — ${Object.keys(manifest.inputs).length} input(s) hashed`);
  return 0;
}

process.exitCode = check ? runCheck() : await runGen();
