import { describe, expect, it } from "vitest";
import { renderMarkdownInto } from "./markdownLite.js";

// Feature: features/live-view.md item 12 — the safe-subset markdown renderer the
// run page uses for the Request/Answer blocks and assistant rows. It runs in the
// browser under the page's strict CSP, so it is exercised here against a minimal
// fake DOM (createElement / createTextNode / appendChild / textContent /
// setAttribute — exactly the surface the function is allowed to touch). The
// load-bearing contract: markup in the input is DATA (angle brackets are text),
// only http(s) links become anchors, and unknown syntax degrades to plain text.

interface FakeNode {
  tag: string; // "#text" for text nodes
  attrs: Record<string, string>;
  children: FakeNode[];
  data: string;
}

function makeDoc() {
  class Node implements FakeNode {
    attrs: Record<string, string> = {};
    children: FakeNode[] = [];
    data = "";
    constructor(
      public tag: string,
      public ownerDocument: unknown,
    ) {}
    appendChild(child: FakeNode) {
      this.children.push(child);
      return child;
    }
    setAttribute(k: string, v: string) {
      this.attrs[k] = String(v);
    }
    get textContent() {
      return this.data;
    }
    set textContent(v: string) {
      this.children.length = 0;
      this.data = String(v);
    }
  }
  const doc = {
    createElement: (tag: string) => new Node(tag.toLowerCase(), doc),
    createTextNode: (data: string) => {
      const t = new Node("#text", doc);
      t.data = String(data);
      return t;
    },
  };
  const node = (tag: string) => new Node(tag, doc);
  return { doc, node };
}

/** HTML-like serialization of the fake tree with text ESCAPED — so a `<` that
 *  reached the DOM as an element shows as `<img`, one that stayed text as `&lt;img`. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function ser(n: FakeNode): string {
  if (n.tag === "#text") return esc(n.data);
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`)
    .join("");
  const inner = n.children.length > 0 ? n.children.map(ser).join("") : esc(n.data);
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}

function render(text: string): { html: string; root: FakeNode } {
  const { doc, node } = makeDoc();
  const root = node("div");
  renderMarkdownInto(root as unknown as HTMLElement, text);
  return { html: ser(root).replace(/^<div>|<\/div>$/g, ""), root };
}

function tags(n: FakeNode): string[] {
  return [n.tag, ...n.children.flatMap(tags)];
}

describe("renderMarkdownInto — blocks", () => {
  it("renders paragraphs, splitting on blank lines and keeping soft line breaks as text", () => {
    expect(render("one\ntwo\n\nthree").html).toBe("<p>one\ntwo</p><p>three</p>");
  });

  it("renders #/##/### headings", () => {
    expect(render("# A\n## B\n### C").html).toBe("<h1>A</h1><h2>B</h2><h3>C</h3>");
  });

  it("renders ####/#####/###### headings as h4/h5/h6 — never paragraph text (#209)", () => {
    expect(render("#### D\n##### E\n###### F").html).toBe("<h4>D</h4><h5>E</h5><h6>F</h6>");
    // seven+ markers are not a heading — unknown syntax degrades to text
    expect(render("####### G").html).toBe("<p>####### G</p>");
  });

  it("renders a GFM table: header row, |---| separator, body rows (#209)", () => {
    expect(render("| File | Lines |\n|---|---|\n| a.ts | 10 |\n| b.ts | 20 |").html).toBe(
      "<table><thead><tr><th>File</th><th>Lines</th></tr></thead>" +
        "<tbody><tr><td>a.ts</td><td>10</td></tr><tr><td>b.ts</td><td>20</td></tr></tbody></table>",
    );
  });

  it("table cells run through the inline renderer; alignment colons in the separator are accepted", () => {
    const { html } = render("| A | B |\n|:---|---:|\n| **x** `c` | [d](https://e.com) |");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td><strong>x</strong> <code>c</code></td>");
    expect(html).toContain('<a href="https://e.com"');
  });

  it("a pipe row with no |---| separator under it is not a table (stays text)", () => {
    expect(render("| just | pipes |").html).toBe("<p>| just | pipes |</p>");
    expect(render("a | b\nplain").html).toBe("<p>a | b\nplain</p>");
    // a bare --- rule (no pipe) never counts as a table separator
    expect(render("head\n---").html).toBe("<p>head\n---</p>");
  });

  it("a table directly after a paragraph line starts a table (the paragraph does not swallow it)", () => {
    expect(render("intro\n| H |\n|---|\n| v |").html).toBe(
      "<p>intro</p><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>",
    );
  });

  it("a header-only table (no body rows) renders a thead without a tbody", () => {
    expect(render("| H1 | H2 |\n|---|---|").html).toBe("<table><thead><tr><th>H1</th><th>H2</th></tr></thead></table>");
  });

  it("renders fenced code blocks verbatim (no inline parsing inside)", () => {
    expect(render("```js\nconst a = **not bold**;\n```").html).toBe("<pre><code>const a = **not bold**;</code></pre>");
  });

  it("an unterminated fence runs to the end of the text", () => {
    expect(render("```\nleft open").html).toBe("<pre><code>left open</code></pre>");
  });

  it("renders bullet lists (-/*) and ordered lists (1.)", () => {
    expect(render("- a\n- b").html).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(render("* a\n* b").html).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(render("1. a\n2. b").html).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("nests an indented list one level inside the previous item", () => {
    expect(render("- a\n  - a1\n  - a2\n- b").html).toBe(
      "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>",
    );
  });

  it("renders > quotes, with block syntax parsed inside them", () => {
    expect(render("> quoted\n> **line**").html).toBe("<blockquote><p>quoted\n<strong>line</strong></p></blockquote>");
  });

  it("empty / whitespace-only input renders nothing", () => {
    expect(render("").html).toBe("");
    expect(render("  \n\n ").html).toBe("");
  });
});

describe("renderMarkdownInto — inlines", () => {
  it("renders **bold**, _italic_, *italic* and `code`", () => {
    expect(render("**b** _i_ *j* `c`").html).toBe("<p><strong>b</strong> <em>i</em> <em>j</em> <code>c</code></p>");
  });

  it("nests inlines inside bold and inside list items", () => {
    expect(render("**bold `code`**").html).toBe("<p><strong>bold <code>code</code></strong></p>");
    expect(render("- **x** y").html).toBe("<ul><li><strong>x</strong> y</li></ul>");
  });

  it("code spans are literal (markdown inside is not parsed)", () => {
    expect(render("`**not bold**`").html).toBe("<p><code>**not bold**</code></p>");
  });

  it("renders http/https links with rel=noopener noreferrer", () => {
    expect(render("see [docs](https://example.com/x?a=1)").html).toBe(
      '<p>see <a href="https://example.com/x?a=1" rel="noopener noreferrer" target="_blank">docs</a></p>',
    );
    expect(render("[h](http://example.com)").html).toContain('href="http://example.com"');
  });

  it("unbalanced markers and unknown syntax degrade to plain text", () => {
    expect(render("a ** b").html).toBe("<p>a ** b</p>");
    expect(render("snake_case_name and 2*3*4").html).toBe("<p>snake_case_name and 2*3*4</p>");
    expect(render("`open").html).toBe("<p>`open</p>");
    expect(render("~~strike~~ ==mark==").html).toBe("<p>~~strike~~ ==mark==</p>");
    expect(render("[not a link]").html).toBe("<p>[not a link]</p>");
  });
});

describe("renderMarkdownInto — safety contract", () => {
  it("angle brackets are text: an <img onerror> never becomes an element", () => {
    const { html, root } = render('hi <img src=x onerror="alert(1)"> there');
    expect(tags(root)).not.toContain("img");
    expect(html).toBe('<p>hi &lt;img src=x onerror="alert(1)"&gt; there</p>');
  });

  it("a javascript: link is rendered as plain text, not an anchor", () => {
    const { html, root } = render("[click](javascript:alert(1))");
    expect(tags(root)).not.toContain("a");
    expect(html).toBe("<p>[click](javascript:alert(1))</p>");
  });

  it("other non-http schemes (data:, vbscript:, protocol-relative) are plain text too", () => {
    for (const href of ["data:text/html,x", "vbscript:x", "//evil.example", "ftp://x", "HTTPS-ish://x"]) {
      expect(tags(render(`[t](${href})`).root)).not.toContain("a");
    }
  });

  // Review round 1 (#179): a heading marker with no content matched the block
  // start regex but no block, so the paragraph fall-through made no progress and
  // the browser tab hung for every viewer. The parser must ALWAYS consume a line.
  it("a heading marker with no content (`# `) terminates and degrades to text — never hangs", () => {
    const { node } = makeDoc();
    const root = node("div");
    renderMarkdownInto(root as unknown as HTMLElement, "before\n# \nafter");
    const out = ser(root);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("# "); // the bare marker is shown as text, not swallowed
    const root2 = node("div");
    renderMarkdownInto(root2 as unknown as HTMLElement, "text\n## \ntext");
    expect(ser(root2)).toContain("text");
    for (const bare of ["#", "##  ", "### \t"]) {
      const r = node("div");
      renderMarkdownInto(r as unknown as HTMLElement, bare);
      expect(ser(r)).toContain(bare.trim().replace(/\s+$/, "").slice(0, 1)); // returned, rendered as text
    }
  });

  it("deeply nested quotes are bounded: 50,000 `>` neither throws nor loses the text", () => {
    const { node } = makeDoc();
    const root = node("div");
    expect(() => renderMarkdownInto(root as unknown as HTMLElement, ">".repeat(50_000) + " x")).not.toThrow();
    const out = ser(root);
    expect(out).toContain("x");
    expect((out.match(/<blockquote>/g) ?? []).length).toBeLessThanOrEqual(8);
  });

  it("a link's href is set via setAttribute exactly as written, never interpreted", () => {
    const { html } = render('[t](https://e.com/"onmouseover="x)');
    // The quote is data inside the attribute (serialized escaped here); the
    // href is one attribute, no attribute breakout is possible via setAttribute.
    expect(html).toContain('href="https://e.com/&quot;onmouseover=&quot;x"');
  });

  it("</script> inside a code block stays text", () => {
    const { html, root } = render("```\n</script><script>alert(1)</script>\n```");
    expect(tags(root)).not.toContain("script");
    expect(html).toBe("<pre><code>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>");
  });

  it("markup in table cells stays text: <img>/<script>/javascript: never become nodes (#209)", () => {
    const t = render(
      '| <img src=x onerror="alert(1)"> | </td><script>x</script> |\n|---|---|\n| <svg onload=alert(1)> | [x](javascript:alert(1)) |',
    );
    expect(tags(t.root)).not.toContain("img");
    expect(tags(t.root)).not.toContain("script");
    expect(tags(t.root)).not.toContain("svg");
    expect(tags(t.root)).not.toContain("a");
    expect(t.html).toContain("&lt;img src=x onerror=");
    expect(t.html).toContain("&lt;/td&gt;&lt;script&gt;");
  });

  it("markup in h4–h6 heading text stays text (#209)", () => {
    const h = render("#### <script>alert(1)</script>\n##### <img src=x onerror=alert(1)>");
    expect(tags(h.root)).not.toContain("script");
    expect(tags(h.root)).not.toContain("img");
    expect(h.html).toBe("<h4>&lt;script&gt;alert(1)&lt;/script&gt;</h4><h5>&lt;img src=x onerror=alert(1)&gt;</h5>");
  });

  it("a bare `#### ` marker (no content) terminates and degrades to text — the progress guarantee covers h4–h6", () => {
    expect(render("before\n#### \nafter").html).toBe("<p>before</p><p>#### </p><p>after</p>");
  });

  it("clears the root before rendering (re-render replaces, never appends)", () => {
    const { doc, node } = makeDoc();
    const root = node("div");
    renderMarkdownInto(root as unknown as HTMLElement, "first");
    renderMarkdownInto(root as unknown as HTMLElement, "second");
    expect(ser(root)).toBe("<div><p>second</p></div>");
    void doc;
  });
});

describe("renderMarkdownInto — inlinable into the run page", () => {
  it("is a self-contained function: String(fn) is a plain `function` with no imports/requires", () => {
    const src = String(renderMarkdownInto);
    expect(src.startsWith("function renderMarkdownInto(")).toBe(true);
    expect(src).not.toMatch(/\bimport\b|\brequire\(/);
    expect(src).not.toContain("innerHTML");
    expect(src).not.toContain("</script"); // it is interpolated raw into a <script>
    // Executable as browser JS (ES2022): re-evaluating the source yields the same behavior.
    const again = new Function(`return ${src};`)() as typeof renderMarkdownInto;
    const { doc, node } = makeDoc();
    const root = node("div");
    again(root as unknown as HTMLElement, "**ok**");
    expect(ser(root)).toBe("<div><p><strong>ok</strong></p></div>");
    void doc;
  });
});
