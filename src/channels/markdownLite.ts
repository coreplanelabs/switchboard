// Safe-subset markdown for the run page (features/live-view.md item 12).
//
// The run page renders model-authored text (the request, the model's prose
// between tool calls, the final answer) under a strict CSP with no external
// assets. Rendering it as markdown must not become an injection vector, so
// this is ONE self-contained function that builds DOM exclusively through
// createElement / createTextNode / appendChild / textContent / setAttribute:
//   - angle brackets are text (no HTML passthrough, ever);
//   - only `http://` / `https://` link targets become anchors, with
//     rel="noopener noreferrer"; every other scheme stays literal text;
//   - unknown syntax degrades to plain text instead of erroring.
//
// Supported blocks: paragraphs, #–###### headings, fenced code, quotes,
// lists (one nested level), and a GFM table subset (#209: header row +
// `|---|` separator + body rows, built as table/thead/tbody/tr/th/td).
//
// It ships into the page by interpolating `String(renderMarkdownInto)` into the
// inline <script> (see liveView.ts) — so it must have NO imports, NO closures
// over module scope, and only ES2022 syntax. The unit tests drive it against a
// minimal fake DOM and re-evaluate its source with `new Function` to prove it
// survives that round trip.

/** The DOM surface the renderer is allowed to touch (a structural subset of
 *  the real Element/Document, also satisfied by the test fake). */
export interface MdNode {
  appendChild(child: MdNode): unknown;
  textContent: string | null;
}
export interface MdElement extends MdNode {
  setAttribute(name: string, value: string): void;
  ownerDocument: MdDocument | null;
}
export interface MdDocument {
  createElement(tag: string): MdElement;
  createTextNode(data: string): MdNode;
}

/** Replace `root`'s children with the rendered markdown of `text`. */
export function renderMarkdownInto(root: MdElement, text: string): void {
  const doc = root.ownerDocument as MdDocument;
  root.textContent = "";
  const lines = String(text == null ? "" : text)
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const LIST_RE = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
  const BLOCK_START_RE = /^(```|#{1,6}\s|>)/;
  // Quote nesting is recursion; bound it (model text is the input, and a wall of
  // `>` must never overflow the stack). Declared inside the function because the
  // whole function is inlined into the page: no module-scope closures allowed.
  const MAX_QUOTE_DEPTH = 8;

  function el(parent: MdNode, tag: string): MdElement {
    const e = doc.createElement(tag);
    parent.appendChild(e);
    return e;
  }
  function txt(parent: MdNode, s: string): void {
    if (s) parent.appendChild(doc.createTextNode(s));
  }

  // GFM table subset (#209): a header row, a `|---|` separator (alignment
  // colons accepted, ignored), then body rows. A table exists only when the
  // separator sits directly under a pipe-bearing header with the SAME cell
  // count — anything else stays text. Cells go through the inline renderer;
  // the DOM is table/thead/tbody/tr/th/td via createElement, cells textContent.
  function splitCells(line: string): string[] {
    let t = line.trim();
    if (t[0] === "|") t = t.slice(1);
    if (t[t.length - 1] === "|") t = t.slice(0, -1);
    return t.split("|").map((c) => c.trim());
  }
  function isTableSep(line: string): boolean {
    const t = line.trim();
    if (t.indexOf("|") < 0 || !/^[\s:|-]+$/.test(t)) return false;
    return splitCells(t).every((c) => /^:?-+:?$/.test(c));
  }
  function isTableStart(src: string[], i: number): boolean {
    const line = src[i];
    if (line.indexOf("|") < 0 || isTableSep(line)) return false;
    if (i + 1 >= src.length || !isTableSep(src[i + 1])) return false;
    return splitCells(line).length === splitCells(src[i + 1]).length;
  }

  // Inline pass: code spans, **bold**, _italic_/*italic*, [text](http(s)://…).
  // Anything that does not close, or is not one of those, is emitted as text.
  function inline(parent: MdNode, s: string): void {
    let i = 0;
    let buf = "";
    const flush = () => {
      txt(parent, buf);
      buf = "";
    };
    while (i < s.length) {
      const c = s[i];
      if (c === "`") {
        const end = s.indexOf("`", i + 1);
        if (end > i + 1) {
          flush();
          el(parent, "code").textContent = s.slice(i + 1, end);
          i = end + 1;
          continue;
        }
      } else if (c === "*" && s[i + 1] === "*") {
        const end = s.indexOf("**", i + 2);
        if (end > i + 2) {
          flush();
          inline(el(parent, "strong"), s.slice(i + 2, end));
          i = end + 2;
          continue;
        }
      } else if (c === "*" || c === "_") {
        // An opener sits at a word boundary and hugs its content (`_i_`, `*j*`);
        // `snake_case` and `2*3*4` never open. The closer mirrors that.
        const prev = i > 0 ? s[i - 1] : "";
        if (/\S/.test(s[i + 1] || "") && !/\w/.test(prev)) {
          let end = -1;
          for (let j = i + 2; j < s.length; j++) {
            if (s[j] === c && /\S/.test(s[j - 1]) && !/\w/.test(s[j + 1] || "")) {
              end = j;
              break;
            }
          }
          if (end > 0) {
            flush();
            inline(el(parent, "em"), s.slice(i + 1, end));
            i = end + 1;
            continue;
          }
        }
      } else if (c === "[") {
        const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
        if (m && /^https?:\/\//i.test(m[2])) {
          flush();
          const a = el(parent, "a");
          a.setAttribute("href", m[2]);
          a.setAttribute("rel", "noopener noreferrer");
          a.setAttribute("target", "_blank");
          inline(a, m[1]);
          i += m[0].length;
          continue;
        }
      }
      buf += c;
      i++;
    }
    flush();
  }

  // Block pass: fences, headings, quotes (recursive), lists (one nested level),
  // paragraphs (soft line breaks kept as text; the page uses pre-wrap).
  function blocks(parent: MdNode, src: string[], depth = 0): void {
    let i = 0;
    while (i < src.length) {
      const line = src[i];
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }
      if (/^```/.test(line)) {
        const body: string[] = [];
        i++;
        while (i < src.length && !/^```\s*$/.test(src[i])) body.push(src[i++]);
        i++; // the closing fence (or past the end for an unterminated one)
        el(el(parent, "pre"), "code").textContent = body.join("\n");
        continue;
      }
      // Content must start with a non-space: `##  ` (marker + spaces) is not an
      // empty heading, it is text (via the fall-through below).
      const h = /^(#{1,6})\s+(\S.*?)\s*$/.exec(line);
      if (h) {
        inline(el(parent, "h" + h[1].length), h[2]);
        i++;
        continue;
      }
      // Quotes nest by recursion, one level per `>` prefix — bounded so a run of
      // thousands of `>` (model text is the input) cannot overflow the stack;
      // past the cap the line degrades to text via the paragraph fall-through.
      if (line[0] === ">" && depth < MAX_QUOTE_DEPTH) {
        const q: string[] = [];
        while (i < src.length && src[i][0] === ">") q.push(src[i++].replace(/^>\s?/, ""));
        blocks(el(parent, "blockquote"), q, depth + 1);
        continue;
      }
      if (isTableStart(src, i)) {
        const headers = splitCells(line);
        const table = el(parent, "table");
        const headRow = el(el(table, "thead"), "tr");
        for (const c of headers) inline(el(headRow, "th"), c);
        i += 2; // the header row and its separator
        let tbody: MdElement | null = null;
        while (i < src.length && src[i].indexOf("|") >= 0 && !isTableStart(src, i)) {
          if (!tbody) tbody = el(table, "tbody");
          const cells = splitCells(src[i]);
          const tr = el(tbody, "tr");
          // Rows are squared to the header width (GFM): short rows pad, long rows truncate.
          for (let k = 0; k < headers.length; k++) inline(el(tr, "td"), k < cells.length ? cells[k] : "");
          i++;
        }
        continue;
      }
      if (LIST_RE.test(line)) {
        const items: Array<{ indent: number; ordered: boolean; text: string }> = [];
        let m: RegExpExecArray | null;
        while (i < src.length && (m = LIST_RE.exec(src[i])) !== null) {
          items.push({ indent: m[1].length, ordered: /^\d/.test(m[2]), text: m[3] });
          i++;
        }
        const base = items[0].indent;
        const list = el(parent, items[0].ordered ? "ol" : "ul");
        let lastLi: MdElement | null = null;
        let sub: MdElement | null = null;
        for (const it of items) {
          if (it.indent > base && lastLi) {
            if (!sub) sub = el(lastLi, it.ordered ? "ol" : "ul");
            inline(el(sub, "li"), it.text);
          } else {
            lastLi = el(list, "li");
            sub = null;
            inline(lastLi, it.text);
          }
        }
        continue;
      }
      const p: string[] = [];
      while (
        i < src.length &&
        !/^\s*$/.test(src[i]) &&
        !BLOCK_START_RE.test(src[i]) &&
        !LIST_RE.test(src[i]) &&
        !isTableStart(src, i)
      )
        p.push(src[i++]);
      // Progress guarantee: a line that LOOKS like a block start but matched no
      // block above (a bare `# ` heading marker, a `>` past the quote-depth cap)
      // would otherwise leave `p` empty and `i` unmoved — an infinite loop that
      // froze every viewer's tab (review of #179). Consume it as plain text.
      if (p.length === 0) p.push(src[i++]);
      inline(el(parent, "p"), p.join("\n"));
    }
  }

  blocks(root, lines);
}
