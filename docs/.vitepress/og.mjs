// The social card of every page — the picture a link unfurls to in Slack, on
// X, in a chat — as pure data: which file a page's card is, what it says, the
// head tags that point at it, and the element tree the renderer draws
// (og-render.mjs turns that tree into a PNG at build time; nothing here reads a
// file). Plain JS with a .d.mts twin, so the bot's test can import it without
// the docs theme entering its program.
//
// One card per page, the home page's for the not-found route too. Every card is
// the same composition: the canvas is the site's dark ground, a hairline frame
// inset from the edge, the mark and the product's name in the mono face along
// the top with the page's section as an uppercase eyebrow opposite, the page's
// title in the text face set large with the letters tightened, one muted line
// under it, and along the bottom the docs host and the page's route. No hue but
// the mark's own; no image, texture or gradient behind the type.

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** A title longer than this is cut with an ellipsis; a card is read at a glance, not scrolled. */
export const OG_TITLE_MAX = 90;
/** The muted line's cap, for a description written for a page rather than for a card. */
export const OG_DESCRIPTION_MAX = 160;

/** The site's dark palette, as the card's own constants: the renderer has no stylesheet to read. */
const INK = "#ffffff";
const MUTED = "#a3a3a3";
const FAINT = "#737373";
const CANVAS = "#000000";
const HAIRLINE = "rgba(255,255,255,0.14)";
const TEXT_FACE = "Instrument Sans";
const MONO_FACE = "JetBrains Mono";

/**
 * The card file stem for a page, from the compiler's rewritten path:
 * `index.md` → `index`, `tutorials/get-started.md` → `tutorials/get-started`,
 * `tutorials/index.md` → `tutorials/index`. The not-found page has no subject
 * of its own and shares the home card.
 */
export function ogFile(relativePath) {
  const stem = relativePath.replace(/\.md$/, "");
  return stem === "404" ? "index" : stem;
}

/**
 * The eyebrow: the page's section, read off the route's first segment
 * (`tutorials`, `how-to`, `reference`, `explanation`); a spec under the
 * reference tree reads `spec`; the home card carries none.
 */
export function ogEyebrow(file) {
  if (file === "index") return undefined;
  if (/^reference\/specs\/(?!index$)/.test(file)) return "spec";
  return file.split("/")[0];
}

/** The URL a card's page lives at under the docs origin, in the site's clean-URL form. */
export function ogPageUrl(file, docsUrl) {
  const base = docsUrl.replace(/\/+$/, "");
  if (file === "index") return `${base}/`;
  return file.endsWith("/index") ? `${base}/${file.slice(0, -"index".length)}` : `${base}/${file}`;
}

/** The absolute URL of a card's picture. */
export function ogImageUrl(file, docsUrl) {
  return `${docsUrl.replace(/\/+$/, "")}/og/${file}.png`;
}

/**
 * Text as the card sets it: code spans unwrapped (a heading may quote a path),
 * whitespace collapsed, and cut at `max` with an ellipsis when longer.
 */
export function ogText(text, max) {
  const flat = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * What one page's card says. `page` is what the compiler knows at head time —
 * the rewritten path, the page's title (its H1) and its resolved description;
 * `site` is the product's name and its one-sentence description from
 * project.json. The home card (and the not-found page's) is the product's:
 * its name and its sentence, no eyebrow.
 */
export function ogSubject(page, site) {
  const file = ogFile(page.relativePath);
  const home = file === "index";
  return {
    file,
    eyebrow: ogEyebrow(file),
    title: home ? site.displayName : page.title,
    description: home ? site.description : page.description,
  };
}

/**
 * The head tags for a page's card: Open Graph and the large-image Twitter card,
 * every URL absolute under the docs origin from project.json — an unfurler
 * reads the tags from the page and fetches the picture from wherever they say.
 */
export function ogHead(subject, docsUrl) {
  const image = ogImageUrl(subject.file, docsUrl);
  return [
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: subject.title }],
    ["meta", { property: "og:description", content: subject.description }],
    ["meta", { property: "og:url", content: ogPageUrl(subject.file, docsUrl) }],
    ["meta", { property: "og:image", content: image }],
    ["meta", { property: "og:image:width", content: String(OG_WIDTH) }],
    ["meta", { property: "og:image:height", content: String(OG_HEIGHT) }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: subject.title }],
    ["meta", { name: "twitter:description", content: subject.description }],
    ["meta", { name: "twitter:image", content: image }],
  ];
}

/** The title's size: three steps down as it lengthens, so a long spec title still fits three lines. */
export function ogTitleSize(title) {
  if (title.length > 72) return 48;
  if (title.length > 52) return 56;
  return 66;
}

/** One element of the renderer's tree: a tag, its style, its children. Every box with children is a flex box, which is what the renderer requires. */
const el = (type, props = {}, children) => ({ type, props: { ...props, children } });
const row = (style, children) => el("div", { style: { display: "flex", ...style } }, children);
const text = (style, content) => el("div", { style }, content);

/**
 * The card's element tree — the layout the renderer draws, as data. `mark` is
 * the product's mark as an image source (a data URI the renderer prepared),
 * `wordmark` the product's name, `host` the docs host, `route` the page's path.
 */
export function ogCard({ subject, mark, wordmark, host, route }) {
  const title = ogText(subject.title, OG_TITLE_MAX);
  const description = ogText(subject.description, OG_DESCRIPTION_MAX);
  return row(
    {
      width: `${OG_WIDTH}px`,
      height: `${OG_HEIGHT}px`,
      flexDirection: "column",
      backgroundColor: CANVAS,
      padding: "64px 72px",
      fontFamily: TEXT_FACE,
      position: "relative",
    },
    [
      // The hairline frame, inset from the edge at the site's frame radius.
      el("div", {
        style: {
          position: "absolute",
          top: "24px",
          left: "24px",
          right: "24px",
          bottom: "24px",
          border: `1px solid ${HAIRLINE}`,
          borderRadius: "16px",
        },
      }),
      // Top: the mark and the name, the section opposite.
      row({ justifyContent: "space-between", alignItems: "center" }, [
        row({ alignItems: "center", gap: "18px" }, [
          el("img", { src: mark, width: 44, height: 44 }),
          text({ fontFamily: MONO_FACE, fontSize: "30px", fontWeight: 500, color: INK }, wordmark),
        ]),
        text(
          {
            fontFamily: MONO_FACE,
            fontSize: "20px",
            fontWeight: 500,
            color: FAINT,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
          },
          subject.eyebrow ?? "",
        ),
      ]),
      // Middle, pushed to the bottom of its box: the title and the one muted line.
      row({ flexDirection: "column", justifyContent: "flex-end", flexGrow: 1, paddingBottom: "8px" }, [
        text(
          {
            fontSize: `${ogTitleSize(title)}px`,
            fontWeight: 500,
            color: INK,
            letterSpacing: "-0.025em",
            lineHeight: 1.08,
            maxWidth: "980px",
          },
          title,
        ),
        text(
          { marginTop: "26px", fontSize: "27px", fontWeight: 500, color: MUTED, lineHeight: 1.45, maxWidth: "900px" },
          description,
        ),
      ]),
      // Bottom: the host and the route, both in the mono face.
      row({ justifyContent: "space-between", marginTop: "40px" }, [
        text({ fontFamily: MONO_FACE, fontSize: "20px", fontWeight: 500, color: FAINT }, host),
        text({ fontFamily: MONO_FACE, fontSize: "20px", fontWeight: 500, color: FAINT }, route),
      ]),
    ],
  );
}
