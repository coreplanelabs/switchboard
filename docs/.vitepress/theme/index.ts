// The default VitePress theme, with three things of our own: the landing page
// on the root route (SiteLayout.vue), the mermaid renderer (MermaidDiagram.vue) so every
// diagram is drawn in the site's palette in both modes, and the faces the
// palette is set in — bundled from this workspace's own dependencies so the
// site builds and serves offline. `theme-without-fonts` is the default theme
// minus the Inter it would otherwise ship; everything else stays the default
// theme's, which is the reason the site is fast and legible.
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
// Bricolage Grotesque's `opsz` build carries the optical-size and weight axes
// (no width), which is what the display sizes read at.
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./product.css";
import Layout from "./SiteLayout.vue";
import Mermaid from "./MermaidDiagram.vue";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    // The `<Mermaid>` the fence rule emits (config.ts) resolves to our renderer;
    // the tag name is the plugin's, so it is one word.
    // eslint-disable-next-line vue/multi-word-component-names
    app.component("Mermaid", Mermaid);
  },
} satisfies Theme;
