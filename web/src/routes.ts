import type { RouteRecordRaw } from "vue-router";

/*
 * Navigation between top-level pages is full page loads (plain anchors): the
 * server renders a fresh shell + seed per request, exactly like the previous
 * string-rendered frontend. The router's only job is to mount the page
 * component matching the URL the shell was served for.
 */
export const routes: RouteRecordRaw[] = [
  { path: "/runs", component: () => import("./pages/RunsIndexPage.vue") },
  { path: "/runs/scheduled", component: () => import("./pages/ScheduledPage.vue") },
  // The seed decides between the run page and the non-revealing 404 (the
  // server serves both from this path — see RunRoutePage).
  { path: "/runs/:id", component: () => import("./pages/RunRoutePage.vue") },
  { path: "/residents", component: () => import("./pages/ResidentsIndexPage.vue") },
  {
    path: "/residents/:owner/:name",
    component: () => import("./pages/ResidentDetailPage.vue"),
  },
  { path: "/costs/:group?", component: () => import("./pages/CostsPage.vue") },
  { path: "/delivery/:owner?/:name?", component: () => import("./pages/DeliveryPage.vue") },
  { path: "/:pathMatch(.*)*", component: () => import("./pages/NotFoundPage.vue") },
];
