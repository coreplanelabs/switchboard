import { createApp, defineComponent, h, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import UApp from "@nuxt/ui/components/App.vue";
import LinkConsent from "./LinkConsent.vue";
import { fixtureConsentAction, linkConsentFixtures } from "./fixtures";
import type { LinkConsentView } from "@core/channels/linkBrowser.js";
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../../assets/main.css";

// Separate Vite HTML entry, deliberately absent from production build inputs,
// routing and seed registration. No fetch, storage, credentials or real provider.
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
const name = params.get("state") ?? "consent";
const initial = Object.hasOwn(linkConsentFixtures, name)
  ? linkConsentFixtures[name as keyof typeof linkConsentFixtures]
  : linkConsentFixtures.consent;
const app = createApp(
  defineComponent({
    setup() {
      const view = ref<LinkConsentView>(structuredClone(initial));
      return () =>
        h(UApp, null, {
          default: () =>
            h(LinkConsent, {
              view: view.value,
              onSubmit: ({ action }: { action: string }) => {
                view.value = fixtureConsentAction(action);
              },
            }),
        });
    },
  }),
);
app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: { template: "<div />" } }] }));
app.use(ui);
app.mount("#app");
