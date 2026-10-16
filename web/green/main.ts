import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import { browser, routeNavigationInApp } from "../src/lib/browser";
import { fetchSeed, readSeed } from "../src/lib/seed";
import { installSeedRouting, SeedRoutingKey } from "../src/lib/seedRouting";
import App from "./App.vue";
import { routes } from "./routes";
import "@fontsource-variable/dm-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./theme.css";
const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, _from, saved) {
    if (saved) return saved;
    if (to.hash) {
      const element = document.getElementById(decodeURIComponent(to.hash.slice(1)));
      return element ? { el: element } : false;
    }
    return { top: 0 };
  },
});
const routing = installSeedRouting(router, { island: readSeed(), load: fetchSeed, leave: browser.leave });
routeNavigationInApp((href) => void router.push(href));
createApp(App).provide(SeedRoutingKey, routing).use(router).use(ui).mount("#app");
