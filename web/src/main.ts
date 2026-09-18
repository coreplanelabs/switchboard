import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import { routes } from "./routes";
import { browser, routeNavigationInApp } from "./lib/browser";
import { fetchSeed, readSeed } from "./lib/seed";
import { installSeedRouting, SeedRoutingKey } from "./lib/seedRouting";
// The two faces, bundled: Instrument Sans for the chrome and every proportional
// surface, JetBrains Mono for the monospace ones — each the weight-axis build,
// one woff2 per script, emitted as hashed assets the shell serves same-origin.
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./assets/main.css";

const app = createApp(App);
const router = createRouter({
  history: createWebHistory(),
  routes,
  // A new page opens at its top, a hash at its element (an id the page has —
  // one it lacks scrolls nowhere), the back button where the reader left.
  scrollBehavior(to, _from, saved) {
    if (saved) return saved;
    if (to.hash) {
      const el = document.getElementById(decodeURIComponent(to.hash.slice(1)));
      return el ? { el } : false;
    }
    return { top: 0 };
  },
});
// Navigation in place: the island seeds the first page, every later address is
// asked for its seed before its page mounts, and an address that is not a page
// of this app is a full navigation (lib/seedRouting.ts). `browser.navigate`
// goes through the router for the app's own paths from here on.
const routing = installSeedRouting(router, { island: readSeed(), load: fetchSeed, leave: browser.leave });
routeNavigationInApp((href) => void router.push(href));

app.provide(SeedRoutingKey, routing);
app.use(router);
app.use(ui);
app.mount("#app");
