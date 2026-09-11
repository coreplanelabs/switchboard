// Types for the social cards' pure half (docs/.vitepress/og.mjs).

export const OG_WIDTH: 1200;
export const OG_HEIGHT: 630;
export const OG_TITLE_MAX: 90;
export const OG_DESCRIPTION_MAX: 160;

/** What one page's card says. */
export interface OgSubject {
  /** The card's file stem under `og/` in the build output (`index`, `tutorials/get-started`). */
  file: string;
  /** The page's section, uppercased on the card; the home card has none. */
  eyebrow: string | undefined;
  title: string;
  description: string;
}

/** What the compiler knows about a page when it writes its head. */
export interface OgPage {
  relativePath: string;
  title: string;
  description: string;
}

/** The product, from project.json. */
export interface OgSite {
  displayName: string;
  description: string;
}

/** A head tag as VitePress takes it: tag, attributes. */
export type OgHeadTag = [string, Record<string, string>];

/** One element of the renderer's tree. */
export interface OgElement {
  type: string;
  props: Record<string, unknown> & { children?: OgElement | OgElement[] | string };
}

export function ogFile(relativePath: string): string;
export function ogEyebrow(file: string): string | undefined;
export function ogPageUrl(file: string, docsUrl: string): string;
export function ogImageUrl(file: string, docsUrl: string): string;
export function ogText(text: string, max: number): string;
export function ogSubject(page: OgPage, site: OgSite): OgSubject;
export function ogHead(subject: OgSubject, docsUrl: string): OgHeadTag[];
export function ogTitleSize(title: string): 48 | 56 | 66;
export function ogCard(input: {
  subject: OgSubject;
  mark: string;
  wordmark: string;
  host: string;
  route: string;
}): OgElement;
