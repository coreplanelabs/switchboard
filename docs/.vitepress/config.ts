// The docs site: a compilation of the SAME markdown that renders on GitHub.
//
// The site is built IN PLACE from this tree — no copy, no second source — so a
// relative `.md` link keeps working on both surfaces: GitHub follows it to the
// file, VitePress rewrites it to the built clean URL. A relative link that
// leaves the tree (a source file, AGENTS.md) is rewritten at build time to that
// file's page in the repository — see the `link_open` rule below.
//
// Build: `npm run build` in docs/ → docs/.vitepress/dist, deployed by CI from
// deploy/cloudflare-docs/ (an assets-only Worker). Dead links FAIL the build.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { MermaidMarkdown } from "vitepress-plugin-mermaid";
import { writeOgCards } from "./og-render.mjs";
import { ogHead, ogSubject, type OgSubject } from "./og.mjs";

// The project's identity — the name a reader sees, its repository and steward —
// is stated once in project.json (npm run check:project-facts); the site reads
// it, never copies it: `displayName` is the site title, the tab, and the hero's
// product name (theme/LandingPage.vue reads it back as `site.title`), and
// `check:site` proves the built home page carries it. The licence the footer
// names is the one package.json declares, for the same reason. The one-sentence
// `description` is the home card's muted line, and `docs` — the site's own
// origin — is what every card's absolute URL is built on.
const project = JSON.parse(readFileSync(new URL("../../project.json", import.meta.url), "utf8")) as {
  displayName: string;
  description: string;
  repository: string;
  docs: string;
  steward: { name: string };
};
const { license } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  license: string;
};
const GITHUB_REPO = project.repository;

/** The footer message is HTML; a value read from a file is text until escaped. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The faces the theme bundles (theme/index.ts), preloaded so the first paint
// is set in them: the text face carries the headline and the copy above the
// fold, the mono the eyebrow and the install line, so those two — their latin
// files; the other scripts follow with the stylesheet.
const PRELOADED_FONTS = [
  /instrument-sans-latin-wght-normal\.[\w-]+\.woff2$/,
  /jetbrains-mono-latin-wght-normal\.[\w-]+\.woff2$/,
];

// The reference specs are one sidebar entry per file, read from the directory
// at build time so the list cannot drift from the tree; the label is each
// spec's own H1.
const SPECS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "reference", "specs");
// Every page names its social card in its head (transformHead) and the cards
// are drawn once the pages are rendered (buildEnd), into the build output —
// so the set drawn is exactly the set the pages point at. Keyed by file: the
// not-found page shares the home card and must not draw it twice.
const ogSubjects = new Map<string, OgSubject>();
const MARK_SVG = fileURLToPath(new URL("../public/logo-dark.svg", import.meta.url));

const specItems = readdirSync(SPECS_DIR)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .sort()
  .map((f) => {
    const slug = f.slice(0, -3);
    const h1 = /^# (.+)$/m.exec(readFileSync(join(SPECS_DIR, f), "utf8"))?.[1] ?? slug;
    return { text: h1, link: `/reference/specs/${slug}` };
  });

export default defineConfig({
  title: project.displayName,
  description: `Agents in Slack, on the CLI, over HTTP and MCP — docs for whoever uses, watches, or runs ${project.displayName}.`,
  // Dated implementation plans are working documents for the repo, not pages.
  srcExclude: ["plans/**"],
  // GitHub renders a directory's README.md when you browse to the directory;
  // the site does the same by serving each README.md as that directory's
  // index. That is what keeps a bare `[Tutorials](tutorials/)` link — the
  // form GitHub needs — resolvable here too. A `:param` matches one path
  // segment, so the specs directory (reference/specs/, two levels deep) needs
  // its own rule — without it the built page is `reference/specs/README.html`
  // and the sidebar's `/reference/specs/` is a 404 in production while the dev
  // server, which resolves directories itself, still answers. `check:site`
  // requires the built index.
  rewrites: {
    "README.md": "index.md",
    ":dir/README.md": ":dir/index.md",
    ":dir/:sub/README.md": ":dir/:sub/index.md",
  },
  // Default output (docs/.vitepress/dist) — the content tree stays clean and
  // .gitignore's `dist/` already covers it. deploy/cloudflare-docs/ uploads it.
  cleanUrls: true,
  lastUpdated: true,
  // A dead internal link is a build failure, not a 404 someone finds later.
  ignoreDeadLinks: false,
  markdown: {
    // The highlighter's two palettes, one per appearance: the system's pair. The
    // block's ground is the theme's own token (`--vp-code-block-bg`), not a theme's.
    theme: { light: "github-light", dark: "vesper" },
    // Inline code is literal text. Fenced blocks already get `v-pre`; without
    // it on `<code>` too, a `{{placeholder}}` in a code span is compiled as a
    // Vue interpolation and breaks the build.
    config(md) {
      // A ```mermaid fence becomes `<Mermaid id graph>`; the theme's own
      // renderer (theme/MermaidDiagram.vue) draws it in the site's palette. Only the
      // plugin's markdown rule is used — its Vite half would put the whole
      // mermaid library in every page's entry chunk, landing page included.
      MermaidMarkdown(md);
      const codeInline = md.renderer.rules.code_inline!;
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) =>
        codeInline(tokens, idx, options, env, self).replace(/^<code/, "<code v-pre");
      // A relative link that leaves this tree (a source file, AGENTS.md, a
      // plan) has no page here: on the site it points at the repository. The
      // source stays relative so GitHub follows it to the file.
      const linkOpen =
        md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const href = token.attrGet("href");
        if (href && /^\.\.?\//.test(href)) {
          const [file, hash] = href.split("#");
          const target = posix.normalize(posix.join(posix.dirname(env.relativePath ?? ""), file));
          if (target.startsWith("../") || target.startsWith("plans/")) {
            const repoPath = posix.normalize(posix.join("docs", target));
            const view = repoPath.endsWith("/") ? "tree" : "blob";
            token.attrSet("href", `${GITHUB_REPO}/${view}/main/${repoPath}${hash ? `#${hash}` : ""}`);
          }
        }
        return linkOpen(tokens, idx, options, env, self);
      };
    },
  },
  // The SVG for browsers that take one; the .ico for everything that asks for /favicon.ico by
  // convention without reading the page (link unfurlers, feed readers, old clients) — three PNG
  // frames (16, 32, 48) of the same mark, rendered from the SVG.
  head: [
    ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    ["link", { rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" }],
  ],
  // The font preloads, then the page's social card: Open Graph and Twitter
  // tags pointing at `<docs>/og/<route>.png`, absolute under project.json's
  // `docs` — an unfurler fetches the picture from wherever the tags say. The
  // card's title is the page's own (its H1), its line the page's description
  // — the site's sentence unless the page's frontmatter has one; the home
  // card carries the product's name and its one-sentence description.
  transformHead({ assets, pageData, description }) {
    const subject = ogSubject(
      { relativePath: pageData.relativePath, title: pageData.title, description },
      { displayName: project.displayName, description: project.description },
    );
    ogSubjects.set(subject.file, subject);
    return [
      ...assets
        .filter((asset) => PRELOADED_FONTS.some((font) => font.test(asset)))
        .map((href): [string, Record<string, string>] => [
          "link",
          { rel: "preload", href, as: "font", type: "font/woff2", crossorigin: "" },
        ]),
      ...ogHead(subject, project.docs),
    ];
  },
  // The cards themselves, one PNG per page under `og/` in the build output —
  // generated, never committed; deploy/cloudflare-docs/ uploads dist whole.
  async buildEnd(siteConfig) {
    const written = await writeOgCards(ogSubjects.values(), join(siteConfig.outDir, "og"), {
      displayName: project.displayName,
      docsUrl: project.docs,
      markSvgPath: MARK_SVG,
    });
    siteConfig.logger.info(`social cards: ${written.length} drawn into ${join(siteConfig.outDir, "og")}`);
  },
  // The root README.md is the docs hub GitHub shows for the directory; on the
  // site the same route is the landing page. Marking it `layout: home` here
  // — not in frontmatter GitHub would render as a table — makes the default
  // theme render it as a home page, with the landing (theme/LandingPage.vue) in the
  // slot before the README's own content. The tab reads the site's name, not
  // the hub's heading.
  transformPageData(pageData) {
    if (pageData.filePath !== "README.md") return;
    pageData.frontmatter.layout = "home";
    return { title: project.displayName };
  },
  themeConfig: {
    // The mark beside the site name: three planes, one message routed to two
    // lanes — the same drawing as docs/public/favicon.svg and the dashboard's
    // BrandMark. One file per scheme, since an <img> cannot inherit currentColor.
    logo: { light: "/logo-light.svg", dark: "/logo-dark.svg", alt: "" },
    // "Get started" is the first-time reader's path: Home → Get started → a
    // running `ask`, three clicks. The other four entries are the Diataxis
    // kinds, each landing on that kind's index page.
    nav: [
      { text: "Get started", link: "/tutorials/get-started" },
      { text: "Tutorials", link: "/tutorials/" },
      { text: "How-to", link: "/how-to/" },
      { text: "Reference", link: "/reference/" },
      { text: "Explanation", link: "/explanation/" },
    ],
    // Diataxis, one group per kind — the same four the docs/README.md hub
    // lists, in the same order and with the same pages. Keep the two in step.
    sidebar: [
      {
        text: "Tutorials",
        collapsed: false,
        items: [
          { text: "Get started", link: "/tutorials/get-started" },
          { text: "Your first request in Slack", link: "/tutorials/first-request-in-slack" },
          { text: "Run it locally", link: "/tutorials/run-it-locally" },
        ],
      },
      {
        text: "How-to guides",
        collapsed: false,
        items: [
          { text: "Set up accounts", link: "/how-to/set-up-accounts" },
          { text: "Turn features on and off", link: "/how-to/turn-features-on-and-off" },
          { text: "Restrict who can do what", link: "/how-to/restrict-who-can-do-what" },
          { text: "Configure your defaults", link: "/how-to/configure-your-defaults" },
          { text: "Connect an MCP server", link: "/how-to/connect-an-mcp-server" },
          { text: "Onboard a repo", link: "/how-to/onboard-a-repo" },
          { text: "Watch a run", link: "/how-to/watch-a-run" },
          { text: "Check spend", link: "/how-to/check-spend" },
          { text: "Add a model provider", link: "/how-to/add-a-provider" },
          { text: "Add an agent", link: "/how-to/add-an-agent" },
          { text: "Deploy", link: "/how-to/deploy" },
          { text: "Ship a release", link: "/how-to/ship-a-release" },
          { text: "Rotate a secret", link: "/how-to/rotate-a-secret" },
          { text: "Operate production", link: "/how-to/operate-production" },
          { text: "Configure the repository", link: "/how-to/configure-the-repository" },
          { text: "Run a load test", link: "/how-to/run-a-load-test" },
        ],
      },
      {
        text: "Reference",
        collapsed: false,
        items: [
          { text: "Slack commands", link: "/reference/slack-commands" },
          { text: "CLI", link: "/reference/cli" },
          { text: "Configuration", link: "/reference/configuration" },
          { text: "Authorization", link: "/reference/authorization" },
          { text: "Dashboard routes", link: "/reference/dashboard-routes" },
          { text: "Code map", link: "/reference/code-map" },
          { text: "Migration notes", link: "/reference/migrations" },
          { text: "Specs", link: "/reference/specs/", collapsed: true, items: specItems },
        ],
      },
      {
        text: "Explanation",
        collapsed: false,
        items: [
          { text: "Architecture", link: "/explanation/architecture" },
          { text: "How a request flows", link: "/explanation/how-a-request-flows" },
          { text: "The agents and their toolsets", link: "/explanation/agents-and-toolsets" },
          { text: "Worker topology", link: "/explanation/worker-topology" },
          { text: "One definition, every surface", link: "/explanation/one-command-many-surfaces" },
          { text: "Runs: live, then remembered", link: "/explanation/runs-live-and-history" },
          { text: "Why config is layered", link: "/explanation/config-layers" },
          { text: "Security model", link: "/explanation/security-model" },
          { text: "Execution and trust", link: "/explanation/execution-and-trust" },
          { text: "Capacity and sizing", link: "/explanation/capacity-and-sizing" },
          { text: "Known limits", link: "/explanation/known-limits" },
          { text: `How ${project.displayName} improves itself`, link: "/explanation/how-switchboard-improves-itself" },
          { text: "How we work", link: "/explanation/how-we-work" },
          { text: "Design decisions", link: "/explanation/design-decisions" },
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: GITHUB_REPO }],
    editLink: {
      pattern: `${GITHUB_REPO}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    outline: { level: [2, 3] },
    footer: {
      message: `Released under the <a href="${GITHUB_REPO}/blob/main/LICENSE">${escapeHtml(license)} license</a>. Questions and ideas: <a href="${GITHUB_REPO}/discussions">Discussions</a>. Built from <a href="${GITHUB_REPO}/tree/main/docs">docs/</a> on every push to main; the behavioral contract is the <a href="/reference/specs/">reference specs</a>.`,
      copyright: project.steward.name,
    },
  },
});
