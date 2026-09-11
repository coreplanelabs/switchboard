// Types for the social cards' renderer (docs/.vitepress/og-render.mjs).
import type { OgElement, OgSubject } from "./og.mjs";

export interface OgFont {
  name: string;
  weight: number;
  data: Buffer;
}

export function markDataUri(svgPath: string, height: number): string;
export function renderOgCard(card: OgElement, fonts: OgFont[]): Promise<Uint8Array>;
export function writeOgCards(
  subjects: Iterable<OgSubject>,
  outDir: string,
  site: { displayName: string; docsUrl: string; markSvgPath: string },
): Promise<string[]>;
