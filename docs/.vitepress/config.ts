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
import { withMermaid } from "vitepress-plugin-mermaid";

// The project's identity — its repository and steward — is stated once in
// project.json (npm run check:project-facts); the site reads it, never copies it.
const project = JSON.parse(readFileSync(new URL("../../project.json", import.meta.url), "utf8")) as {
  repository: string;
  steward: { name: string };
};
const GITHUB_REPO = project.repository;

// The reference specs are one sidebar entry per file, read from the directory
// at build time so the list cannot drift from the tree; the label is each
// spec's own H1.
const SPECS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "reference", "specs");
const specItems = readdirSync(SPECS_DIR)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .sort()
  .map((f) => {
    const slug = f.slice(0, -3);
    const h1 = /^# (.+)$/m.exec(readFileSync(join(SPECS_DIR, f), "utf8"))?.[1] ?? slug;
    return { text: h1, link: `/reference/specs/${slug}` };
  });

export default withMermaid(
  defineConfig({
    title: "Switchboard",
    description:
      "Agents in Slack, on the CLI, over HTTP and MCP — docs for whoever uses, watches, or runs Switchboard.",
    // Dated implementation plans are working documents for the repo, not pages.
    srcExclude: ["plans/**"],
    // GitHub renders a directory's README.md when you browse to the directory;
    // the site does the same by serving each README.md as that directory's
    // index. That is what keeps a bare `[Tutorials](tutorials/)` link — the
    // form GitHub needs — resolvable here too.
    rewrites: { "README.md": "index.md", ":dir/README.md": ":dir/index.md" },
    // Default output (docs/.vitepress/dist) — the content tree stays clean and
    // .gitignore's `dist/` already covers it. deploy/cloudflare-docs/ uploads it.
    cleanUrls: true,
    lastUpdated: true,
    // A dead internal link is a build failure, not a 404 someone finds later.
    ignoreDeadLinks: false,
    markdown: {
      // Inline code is literal text. Fenced blocks already get `v-pre`; without
      // it on `<code>` too, a `{{placeholder}}` in a code span is compiled as a
      // Vue interpolation and breaks the build.
      config(md) {
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
              token.attrSet("href", `${GITHUB_REPO}/blob/main/${repoPath}${hash ? `#${hash}` : ""}`);
            }
          }
          return linkOpen(tokens, idx, options, env, self);
        };
      },
    },
    head: [["link", { rel: "icon", href: "/favicon.svg" }]],
    // Mermaid renders client-side (bundled — nothing is fetched at runtime).
    // The font is pinned to the system stack ON PURPOSE: mermaid sizes each
    // label's box at render time, and with a webfont (VitePress's Inter) the
    // swap lands after the measurement, re-wrapping a `<br/>`-heavy label into
    // one more line than the box was cut for — the last line then clips off.
    // A locally-available stack is never re-measured. `.mermaid foreignObject`
    // also gets `overflow: visible` in product.css as the backstop.
    mermaid: {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      flowchart: { useMaxWidth: true },
    },
    themeConfig: {
      nav: [
        { text: "Tutorials", link: "/tutorials/first-request-in-slack" },
        { text: "How-to", link: "/how-to/configure-your-defaults" },
        { text: "Reference", link: "/reference/slack-commands" },
        { text: "Explanation", link: "/explanation/how-a-request-flows" },
      ],
      // Diataxis, one group per kind — the same four the docs/README.md hub
      // lists, in the same order.
      sidebar: [
        {
          text: "Tutorials",
          collapsed: false,
          items: [
            { text: "Your first request in Slack", link: "/tutorials/first-request-in-slack" },
            { text: "Run it locally", link: "/tutorials/run-it-locally" },
          ],
        },
        {
          text: "How-to guides",
          collapsed: false,
          items: [
            { text: "Configure your defaults", link: "/how-to/configure-your-defaults" },
            { text: "Connect an MCP server", link: "/how-to/connect-an-mcp-server" },
            { text: "Onboard a repo", link: "/how-to/onboard-a-repo" },
            { text: "Watch a run and check spend", link: "/how-to/watch-a-run-and-check-spend" },
            { text: "Restrict who can do what", link: "/how-to/restrict-who-can-do-what" },
            { text: "Add a provider or an agent", link: "/how-to/add-a-provider-or-agent" },
            { text: "Deploy and rotate a secret", link: "/how-to/deploy-and-rotate-a-secret" },
            { text: "Operate production", link: "/how-to/operate-production" },
            { text: "Configure the repository", link: "/how-to/configure-the-repository" },
            { text: "Run a load test", link: "/how-to/run-a-load-test" },
            { text: "Turn features on and off", link: "/how-to/turn-features-on-and-off" },
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
            { text: "Specs", link: "/reference/specs/", collapsed: true, items: specItems },
          ],
        },
        {
          text: "Explanation",
          collapsed: false,
          items: [
            { text: "How a request flows", link: "/explanation/how-a-request-flows" },
            { text: "Why config is layered", link: "/explanation/config-layers" },
            { text: "Execution and trust", link: "/explanation/execution-and-trust" },
            { text: "Worker topology", link: "/explanation/worker-topology" },
            { text: "One definition, every surface", link: "/explanation/one-command-many-surfaces" },
            { text: "Runs: live, then remembered", link: "/explanation/runs-live-and-history" },
            { text: "How Switchboard improves itself", link: "/explanation/how-switchboard-improves-itself" },
            { text: "Design decisions", link: "/explanation/design-decisions" },
            { text: "How we work", link: "/explanation/how-we-work" },
            { text: "Capacity and sizing", link: "/explanation/capacity-and-sizing" },
            { text: "Known limits", link: "/explanation/known-limits" },
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
        message: `Built from <a href="${GITHUB_REPO}/tree/main/docs">docs/</a> on every push to main. The behavioral contract is the <a href="/reference/specs/">reference specs</a>.`,
        copyright: project.steward.name,
      },
    },
  }),
);
