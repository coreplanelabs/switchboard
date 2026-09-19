import type { RouteRecordRaw } from "vue-router";

/*
 * Navigation between pages is in place: a link is a RouterLink, the router
 * asks the next address for its seed before the route resolves
 * (lib/seedRouting.ts), and App.vue mounts the page component for the address
 * from that seed — the same mount the shell's island gives on a full load.
 * The server still decides every page's content: a route here only says which
 * component paints the seed the server answered for its URL.
 */
export const routes: RouteRecordRaw[] = [
  // The home page: the chat (docs/reference/specs/web-chat.md, record 0043) — under
  // one prefix so the Access application covers it in one rule; `/` redirects here.
  { path: "/threads", component: () => import("./pages/HomePage.vue") },
  { path: "/threads/:id", component: () => import("./pages/HomePage.vue") },
  { path: "/runs", component: () => import("./pages/RunsIndexPage.vue") },
  { path: "/runs/scheduled", component: () => import("./pages/ScheduledPage.vue") },
  // A ship unit's page (or the run 404 — the seed decides, see UnitRoutePage).
  { path: "/runs/unit/:key", component: () => import("./pages/UnitRoutePage.vue") },
  // The seed decides between the run page and the non-revealing 404 (the
  // server serves both from this path — see RunRoutePage).
  { path: "/runs/:id", component: () => import("./pages/RunRoutePage.vue") },
  { path: "/residents", component: () => import("./pages/ResidentsIndexPage.vue") },
  {
    path: "/residents/:owner/:name",
    component: () => import("./pages/ResidentDetailPage.vue"),
  },
  { path: "/costs/:group?", component: () => import("./pages/CostsPage.vue") },
  // The plane's table (docs/reference/specs/orchestration-plane.md, record 0064).
  { path: "/plane", component: () => import("./pages/PlanePage.vue") },
  { path: "/delivery/:owner?/:name?", component: () => import("./pages/DeliveryPage.vue") },
  // The settings page and its tabs; `/settings/channels/<id>` carries the channel id (the seed decides the tab).
  { path: "/settings/:tab?/:channel?", component: () => import("./pages/SettingsPage.vue") },
  { path: "/:pathMatch(.*)*", component: () => import("./pages/NotFoundPage.vue") },
];
