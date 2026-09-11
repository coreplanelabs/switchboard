import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import { routes } from "./routes";
// The two faces, bundled: Instrument Sans for the chrome and every proportional
// surface, JetBrains Mono for the monospace ones — each the weight-axis build,
// one woff2 per script, emitted as hashed assets the shell serves same-origin.
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./assets/main.css";

const app = createApp(App);
const router = createRouter({ history: createWebHistory(), routes });

app.use(router);
app.use(ui);
app.mount("#app");
