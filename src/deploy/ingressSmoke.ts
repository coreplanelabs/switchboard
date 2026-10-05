/** Trusted destination binding shared by deployment smoke transports. */
function smokeOrigin(origin: string): URL {
  if (!origin) throw new Error("SMOKE_INGRESS_ORIGIN is not set");
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new Error("the smoke ingress origin must use HTTPS");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("the smoke ingress origin must be a bare HTTPS origin");
  }
  return url;
}

/** The separately configured request destination must be the bot this plan deploys. */
export function assertSmokeOriginMatchesPlan(origin: string, plannedHealthUrl: string): void {
  const healthUrl = new URL("/healthz", smokeOrigin(origin)).href;
  if (healthUrl !== plannedHealthUrl) throw new Error("smoke ingress origin differs from the deployment profile");
}
