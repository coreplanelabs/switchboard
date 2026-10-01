/** A real, read-only request through the deployed ingress and dispatcher.
 * Health checks cannot prove that the Door still admits ordinary requests. */
import { minutesToMs } from "../core/budgets.js";
export interface IngressSmokeInput {
  origin: string;
  token: string;
  thread: string;
  fetch?: typeof globalThis.fetch;
}

export interface IngressSmokeReceipt {
  runId: string;
  reply: string;
}

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

export async function smokeIngress(input: IngressSmokeInput): Promise<IngressSmokeReceipt> {
  if (!input.token) throw new Error("SMOKE_INGRESS_TOKEN is not set");
  if (!input.thread || input.thread.length > 128 || input.thread.includes(":") || input.thread.includes("#")) {
    throw new Error("the smoke thread must be one valid ingress component");
  }
  const url = smokeOrigin(input.origin);
  url.pathname = "/ingress";
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "What is 2 + 2? Answer in one sentence.", thread: input.thread }),
    signal: AbortSignal.timeout(minutesToMs(3)),
  });
  const body: unknown = await response.json();
  if (!response.ok || typeof body !== "object" || body === null) {
    throw new Error(`the deployed ingress returned HTTP ${response.status}`);
  }
  const result = body as { reply?: unknown; run?: { id?: unknown; status?: unknown } };
  if (typeof result.run?.id !== "string" || result.run.status !== "completed") {
    throw new Error(`the deployed Door did not complete an agent run (HTTP ${response.status})`);
  }
  if (
    typeof result.reply !== "string" ||
    (!result.reply.includes("4") && !result.reply.toLowerCase().includes("four"))
  ) {
    throw new Error("the deployed agent did not answer the smoke question");
  }
  return { runId: result.run.id, reply: result.reply };
}
