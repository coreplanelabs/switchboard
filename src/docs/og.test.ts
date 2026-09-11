import { describe, expect, it } from "vitest";
import {
  OG_DESCRIPTION_MAX,
  OG_HEIGHT,
  OG_TITLE_MAX,
  OG_WIDTH,
  ogCard,
  ogEyebrow,
  ogFile,
  ogHead,
  ogImageUrl,
  ogPageUrl,
  ogSubject,
  ogText,
  ogTitleSize,
  type OgElement,
  type OgSubject,
} from "../../docs/.vitepress/og.mjs";

// The social cards' pure half (docs/reference/specs/docs-site.md item 22): which
// file a page's card is, what it says, the head tags that point at it, and the
// element tree the renderer draws. The renderer itself (satori + resvg) is
// exercised by the build and `check:site`, not here.

const DOCS = "https://docs.switchboard.example.com";
const site = { displayName: "Acme Switchboard", description: "Mention it in Slack and an agent answers." };

describe("ogFile", () => {
  it("is the compiler's rewritten path without its extension, so a directory's README is that directory's index card", () => {
    expect(ogFile("index.md")).toBe("index");
    expect(ogFile("tutorials/get-started.md")).toBe("tutorials/get-started");
    expect(ogFile("tutorials/index.md")).toBe("tutorials/index");
    expect(ogFile("reference/specs/docs-site.md")).toBe("reference/specs/docs-site");
  });

  it("gives the not-found page the home card — it has no subject of its own", () => {
    expect(ogFile("404.md")).toBe("index");
  });
});

describe("ogEyebrow", () => {
  it("is the route's first segment — the page's section — and nothing on the home card", () => {
    expect(ogEyebrow("index")).toBeUndefined();
    expect(ogEyebrow("tutorials/get-started")).toBe("tutorials");
    expect(ogEyebrow("how-to/index")).toBe("how-to");
    expect(ogEyebrow("explanation/architecture")).toBe("explanation");
    expect(ogEyebrow("reference/cli")).toBe("reference");
  });

  it("reads `spec` under the reference tree's specs directory, but not on the specs index itself", () => {
    expect(ogEyebrow("reference/specs/docs-site")).toBe("spec");
    expect(ogEyebrow("reference/specs/index")).toBe("reference");
  });
});

describe("ogPageUrl and ogImageUrl", () => {
  it("build absolute URLs under the docs origin in the site's clean-URL form, whatever the origin's trailing slash", () => {
    expect(ogPageUrl("index", DOCS)).toBe(`${DOCS}/`);
    expect(ogPageUrl("index", `${DOCS}/`)).toBe(`${DOCS}/`);
    expect(ogPageUrl("tutorials/get-started", DOCS)).toBe(`${DOCS}/tutorials/get-started`);
    expect(ogPageUrl("tutorials/index", DOCS)).toBe(`${DOCS}/tutorials/`);
    expect(ogImageUrl("index", DOCS)).toBe(`${DOCS}/og/index.png`);
    expect(ogImageUrl("reference/specs/docs-site", `${DOCS}/`)).toBe(`${DOCS}/og/reference/specs/docs-site.png`);
  });
});

describe("ogText", () => {
  it("unwraps code spans and collapses whitespace, and leaves a fitting text otherwise alone", () => {
    expect(ogText("Docs site: the `docs/` tree,  compiled\nand hosted", 90)).toBe(
      "Docs site: the docs/ tree, compiled and hosted",
    );
  });

  it("cuts a longer text at the cap with an ellipsis, never leaving a trailing space before it", () => {
    const long = "Reference: every command, every flag, every route and every configuration key in one table";
    const cut = ogText(long, 40);
    expect(cut).toBe("Reference: every command, every flag, e…");
    expect(cut.length).toBeLessThanOrEqual(40);
    // The cut falls after a space here: the space goes, the ellipsis sits against the word.
    expect(ogText("every command every flag", 15)).toBe("every command…");
    expect(ogText("x".repeat(90), 90)).toBe("x".repeat(90));
    expect(ogText("x".repeat(91), 90)).toBe(`${"x".repeat(89)}…`);
  });
});

describe("ogTitleSize", () => {
  it("steps the title down as it lengthens — 66px, then 56px past 52 characters, then 48px past 72", () => {
    expect(ogTitleSize("Get started")).toBe(66);
    expect(ogTitleSize("x".repeat(52))).toBe(66);
    expect(ogTitleSize("x".repeat(53))).toBe(56);
    expect(ogTitleSize("x".repeat(72))).toBe(56);
    expect(ogTitleSize("x".repeat(73))).toBe(48);
  });
});

describe("ogSubject", () => {
  it("gives a page its own title and resolved description under its section's eyebrow", () => {
    expect(
      ogSubject(
        { relativePath: "tutorials/get-started.md", title: "Get started", description: "The site's line." },
        site,
      ),
    ).toEqual({
      file: "tutorials/get-started",
      eyebrow: "tutorials",
      title: "Get started",
      description: "The site's line.",
    });
  });

  it("gives the home page — and the not-found page — the product's name and its one-sentence description, no eyebrow", () => {
    const home = { file: "index", eyebrow: undefined, title: site.displayName, description: site.description };
    expect(
      ogSubject({ relativePath: "index.md", title: "Acme Switchboard", description: "The site's line." }, site),
    ).toEqual(home);
    expect(ogSubject({ relativePath: "404.md", title: "404", description: "The site's line." }, site)).toEqual(home);
  });
});

describe("ogHead", () => {
  const subject: OgSubject = {
    file: "reference/cli",
    eyebrow: "reference",
    title: "Reference: CLI",
    description: "The site's line.",
  };

  it("emits Open Graph and the large-image Twitter card, every URL absolute under the docs origin", () => {
    const tags = Object.fromEntries(
      ogHead(subject, DOCS).map(([tag, attrs]) => [attrs.property ?? attrs.name, { tag, ...attrs }]),
    );
    expect(tags["og:type"]).toMatchObject({ tag: "meta", content: "website" });
    expect(tags["og:title"]).toMatchObject({ content: "Reference: CLI" });
    expect(tags["og:description"]).toMatchObject({ content: "The site's line." });
    expect(tags["og:url"]).toMatchObject({ content: `${DOCS}/reference/cli` });
    expect(tags["og:image"]).toMatchObject({ content: `${DOCS}/og/reference/cli.png` });
    expect(tags["og:image:width"]).toMatchObject({ content: String(OG_WIDTH) });
    expect(tags["og:image:height"]).toMatchObject({ content: String(OG_HEIGHT) });
    expect(tags["twitter:card"]).toMatchObject({ content: "summary_large_image" });
    expect(tags["twitter:title"]).toMatchObject({ content: "Reference: CLI" });
    expect(tags["twitter:description"]).toMatchObject({ content: "The site's line." });
    expect(tags["twitter:image"]).toMatchObject({ content: `${DOCS}/og/reference/cli.png` });
    expect(Object.keys(tags)).toHaveLength(11);
  });

  it("names the picture's true dimensions", () => {
    expect([OG_WIDTH, OG_HEIGHT]).toEqual([1200, 630]);
  });
});

describe("ogCard", () => {
  const draw = (subject: OgSubject) =>
    ogCard({
      subject,
      mark: "data:image/png;base64,AA==",
      wordmark: "Acme Switchboard",
      host: "docs.switchboard.example.com",
      route: "/x",
    });

  /** Every string a tree sets, in draw order. */
  const texts = (node: OgElement): string[] => {
    const c = node.props.children;
    if (typeof c === "string") return [c];
    if (Array.isArray(c)) return c.flatMap(texts);
    return c ? texts(c) : [];
  };
  const nodes = (node: OgElement): OgElement[] => {
    const c = node.props.children;
    const kids = Array.isArray(c) ? c : c && typeof c !== "string" ? [c] : [];
    return [node, ...kids.flatMap(nodes)];
  };

  it("sets the wordmark, the eyebrow, the title, the line, the host and the route, in reading order, on a 1200×630 box", () => {
    const card = draw({
      file: "reference/cli",
      eyebrow: "reference",
      title: "Reference: CLI",
      description: "One line.",
    });
    expect(texts(card)).toEqual([
      "Acme Switchboard",
      "reference",
      "Reference: CLI",
      "One line.",
      "docs.switchboard.example.com",
      "/x",
    ]);
    expect(card.props.style).toMatchObject({ width: "1200px", height: "630px", backgroundColor: "#000000" });
    expect(nodes(card).find((n) => n.type === "img")?.props).toMatchObject({ src: "data:image/png;base64,AA==" });
  });

  it("cuts a long title and a long line at their caps, and sets the title at the size its length earns", () => {
    const title = "T".repeat(OG_TITLE_MAX + 20);
    const description = "d".repeat(OG_DESCRIPTION_MAX + 20);
    const card = draw({ file: "x", eyebrow: "x", title, description });
    const [, , drawnTitle, drawnLine] = texts(card);
    expect(drawnTitle).toBe(`${"T".repeat(OG_TITLE_MAX - 1)}…`);
    expect(drawnLine).toBe(`${"d".repeat(OG_DESCRIPTION_MAX - 1)}…`);
    const titleNode = nodes(card).find((n) => n.props.children === drawnTitle)!;
    expect(titleNode.props.style).toMatchObject({ fontSize: "48px", letterSpacing: "-0.025em" });
  });

  it("draws an empty eyebrow on the home card rather than dropping the box the section would sit in", () => {
    const card = draw({ file: "index", eyebrow: undefined, title: "Acme Switchboard", description: "One line." });
    expect(texts(card)).toEqual([
      "Acme Switchboard",
      "",
      "Acme Switchboard",
      "One line.",
      "docs.switchboard.example.com",
      "/x",
    ]);
  });

  it("gives every box with more than one child an explicit flex display — the layout engine refuses one without", () => {
    const card = draw({ file: "x", eyebrow: "x", title: "x", description: "x" });
    const boxes = nodes(card).filter((n) => Array.isArray(n.props.children) && n.props.children.length > 1);
    expect(boxes.length).toBeGreaterThan(3);
    for (const box of boxes) expect((box.props.style as { display?: string }).display).toBe("flex");
  });
});
