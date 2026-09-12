// The bot's request for a coordinator instance (docs/reference/specs/http-ingress.md
// item 9): `POST <PUBLIC_BASE_URL>/admin/coordinator/instances` on its own shim,
// presented with the `coordinator` bearer of the token map the bot already
// holds to authenticate ingress callers — the shim relays that bearer back to
// the bot's `authorize` question, so the same grant admits the create and the
// steps. The answer is read by `readCreateInstanceAnswer`; a process without
// the base URL or the bearer, and a shim that cannot be reached, are
// `unanswered` by reason — the ship branch replies with the reason, never throws.

import type { Secret } from "../../secrets.js";
import { parseIngressTokenMap, tokenForSubject } from "../ingressTokens.js";
import { COORDINATOR_IDENTITY } from "./contract.js";
import { COORDINATOR_INSTANCES_PATH, readCreateInstanceAnswer, type CreateInstanceAnswer } from "./instancesRoute.js";

export interface ShimInstancesOptions {
  /** The bot's own public base URL (`PUBLIC_BASE_URL`) — the shim's address. */
  baseUrl: string | undefined;
  /** `SWITCHBOARD_INGRESS_TOKENS`, whose `coordinator` entry is the bearer. */
  tokens: Secret | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function createInstanceViaShim(opts: ShimInstancesOptions, id: string): Promise<CreateInstanceAnswer> {
  const base = opts.baseUrl?.trim().replace(/\/+$/, "");
  if (!base) return { kind: "unanswered", reason: "PUBLIC_BASE_URL is not set — the bot cannot address its own shim" };
  const bearer = tokenForSubject(parseIngressTokenMap(opts.tokens?.reveal()).tokens, COORDINATOR_IDENTITY);
  if (bearer === undefined)
    return {
      kind: "unanswered",
      reason: `SWITCHBOARD_INGRESS_TOKENS has no single \`${COORDINATOR_IDENTITY}\` entry — the bot cannot present the coordinator bearer`,
    };
  const fetchImpl = opts.fetch ?? fetch;
  try {
    const res = await fetchImpl(`${base}${COORDINATOR_INSTANCES_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ id, params: {} }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return readCreateInstanceAnswer(res.status, await res.text().catch(() => ""));
  } catch (err) {
    return {
      kind: "unanswered",
      reason: `the shim could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
