import type { Capabilities } from "@core/core/capabilities.js";

export const PRIMARY_NAV = [
  { label: "Home", href: "/home", icon: "i-lucide-house", capability: "runLedger" },
  { label: "Delivery", href: "/delivery", icon: "i-lucide-git-pull-request", capability: "github" },
  { label: "Costs", href: "/costs", icon: "i-lucide-wallet", capability: "costs" },
  { label: "Metrics", href: "/metrics", icon: "i-lucide-chart-no-axes-combined", capability: "metrics" },
] as const;

export function primaryNavigation(capabilities?: Capabilities) {
  return PRIMARY_NAV.filter((item) => item.label === "Home" || !capabilities || capabilities[item.capability]);
}

export function pageTitle(path: string): string {
  if (path.startsWith("/runs/unit/")) return "Unit";
  if (path.startsWith("/runs/")) return "Run details";
  if (path.startsWith("/threads/")) return "Thread";
  if (path.startsWith("/settings/runtime")) return "Runtime";
  if (path.startsWith("/settings")) return "Settings";
  return PRIMARY_NAV.find((item) => path.startsWith(item.href))?.label ?? (path === "/runs" ? "Run details" : "Home");
}
