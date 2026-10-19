import { maintenancePageResponse, maintenancePageRoute } from "../../src/channels/maintenancePage.ts";
import { DASHBOARD_FALLBACK_TIMEOUT_MS } from "../../src/core/budgets.ts";

/** Only page reads have an HTML fallback. API, asset and streaming reads keep their own contracts. */
export async function withDashboardFallback(request: Request, forward: () => Promise<Response>): Promise<Response> {
  const path = maintenancePageRoute(request);
  if (!path) return forward();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Error("dashboard_timeout");
  try {
    const response = await Promise.race([
      forward().then(async (response) => {
        // Keep stream cleanup inside the same browser deadline.
        if (response.status >= 500) await response.body?.cancel();
        return response;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeout), DASHBOARD_FALLBACK_TIMEOUT_MS);
      }),
    ]);
    if (response.status < 500) return response;
    console.warn("[dashboard.fallback]", { kind: "http", status: response.status, path });
  } catch (error) {
    console.warn("[dashboard.fallback]", { kind: error === timeout ? "timeout" : "unavailable", path });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return maintenancePageResponse(
    request,
    "Switchboard web pages are temporarily unavailable.",
    "Switchboard is not responding. The service may be restarting. Reload this page to check again.",
  );
}
