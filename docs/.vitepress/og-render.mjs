// Draws the social cards og.mjs describes: satori lays the element tree out
// as SVG with the faces' own glyphs, resvg rasterizes that SVG to a 1200×630
// PNG. Both are deterministic given the same fonts and the same tree, so two
// builds of one tree write byte-identical pictures; the fonts are pinned to
// exact versions in docs/package.json for the same reason.
//
// The faces are the static cuts of the two the site bundles — Instrument Sans
// 500 and JetBrains Mono 500 — from the `@fontsource/*` packages beside the
// variable ones the stylesheet uses: satori reads TrueType tables and cannot
// open a woff2, which is the only format the variable packages ship. The mark
// is docs/public/logo-dark.svg — the drawing beside the site name — rasterized
// once ahead of time, since the layout engine takes bitmaps, not SVG.
//
// Build-time only: config.ts calls `writeOgCards` from `buildEnd`, after every
// page's head has named its card, and writes into the build output — nothing
// under docs/public/ is generated or committed.
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { OG_HEIGHT, OG_WIDTH, ogCard } from "./og.mjs";

const font = (specifier) => readFileSync(fileURLToPath(import.meta.resolve(specifier)));

/** The faces the card sets, loaded once per build. */
function loadFonts() {
  return [
    {
      name: "Instrument Sans",
      weight: 500,
      data: font("@fontsource/instrument-sans/files/instrument-sans-latin-500-normal.woff"),
    },
    {
      name: "JetBrains Mono",
      weight: 500,
      data: font("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff"),
    },
  ];
}

/** The mark as a PNG data URI, rendered at twice the height it is drawn at so it stays crisp. */
export function markDataUri(svgPath, height) {
  const svg = readFileSync(svgPath, "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "height", value: height * 2 } }).render().asPng();
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

/** One card as PNG bytes. */
export async function renderOgCard(card, fonts) {
  const svg = await satori(card, { width: OG_WIDTH, height: OG_HEIGHT, fonts });
  return new Resvg(svg, { fitTo: { mode: "width", value: OG_WIDTH } }).render().asPng();
}

/**
 * Writes `<outDir>/<file>.png` for every subject, one per page. `site` names
 * the product (the wordmark), the docs URL (its host is the card's footer)
 * and the mark's SVG file. Returns the files written, in subject order.
 */
export async function writeOgCards(subjects, outDir, site) {
  const fonts = loadFonts();
  const mark = markDataUri(site.markSvgPath, 44);
  const host = new URL(site.docsUrl).host;
  const written = [];
  for (const subject of subjects) {
    const route = subject.file === "index" ? "/" : `/${subject.file.replace(/\/index$/, "/")}`;
    const png = await renderOgCard(ogCard({ subject, mark, wordmark: site.displayName, host, route }), fonts);
    const target = join(outDir, `${subject.file}.png`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, png);
    written.push(target);
  }
  return written;
}
