import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import { routes } from "./routes";
import "./assets/main.css";

const app = createApp(App);
const router = createRouter({ history: createWebHistory(), routes });

app.use(router);
app.use(ui);
app.mount("#app");
