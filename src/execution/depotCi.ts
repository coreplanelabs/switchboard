import { z } from "zod";
import { MINUTE_MS } from "../core/budgets.js";
import {
  DEPOT_CI_PATH,
  DEPOT_ERRORS,
  depotId,
  depotJson,
  depotOperationSchema,
  type DepotCi,
  type DepotOperation,
} from "../core/depotCi.js";
import { processSecrets, type Secret, type Secrets } from "../secrets.js";
import { depotCiAuthorizations, type DepotCiAuthorizations } from "./depotCiAuthorization.js";

// The edge normalizes omitted protobuf fields. A bridge acknowledgement must
// carry all of them: HTTP success alone cannot establish a mutation's outcome.
const retryResponseSchema = z
  .object({ workflowId: depotId, jobIds: z.array(depotId), jobCount: z.number().int().nonnegative() })
  .strict()
  .refine((answer) => answer.jobCount === answer.jobIds.length);

/** Bind only the run's resolved repository; permission is read again per call.
 * Missing configuration disables this capability, never falls back to a CLI. */
export function buildDepotCi(
  opts: {
    runId: string;
    repo?: string;
    canUseRepo: (repo: string) => boolean;
    baseUrl?: string;
  },
  secrets: Secrets = processSecrets,
): DepotCi | undefined {
  const token = secrets.get("DEPOT_CI_BRIDGE_TOKEN");
  if (!opts.repo || !opts.baseUrl || !token) return undefined;
  try {
    return new WorkerDepotCi({ ...opts, repo: opts.repo, baseUrl: opts.baseUrl, token });
  } catch {
    return undefined;
  }
}

/** Only the internal operation bearer lives in the bot. The organization
 * credential is neither an option nor an environment read in this client. */
export class WorkerDepotCi implements DepotCi {
  private readonly url: string;
  constructor(
    private readonly opts: {
      runId: string;
      repo: string;
      authorizations?: DepotCiAuthorizations;
      canUseRepo: (repo: string) => boolean;
      baseUrl: string;
      token: Secret;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(opts.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Depot CI bridge requires an HTTPS origin");
    this.url = `${url.origin}${DEPOT_CI_PATH}`;
  }

  async call(operation: DepotOperation, stop?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.opts.canUseRepo(this.opts.repo)) throw new DepotCiError("Depot CI repository access refused.");
    const parsed = depotOperationSchema.safeParse(operation);
    if (!parsed.success) throw new DepotCiError(DEPOT_ERRORS.invalid);
    const signal = AbortSignal.any([AbortSignal.timeout(MINUTE_MS), ...(stop ? [stop] : [])]);
    const permit = (this.opts.authorizations ?? depotCiAuthorizations).issue(
      { runId: this.opts.runId, repo: this.opts.repo, operation: parsed.data },
      () => this.opts.canUseRepo(this.opts.repo),
      signal,
    );
    let response: Response;
    let data: unknown;
    try {
      response = await (this.opts.fetch ?? fetch)(this.url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { authorization: `Bearer ${this.opts.token.reveal()}`, "content-type": "application/json" },
        body: JSON.stringify({ ticket: permit.ticket }),
      });
      data = await depotJson(response);
    } catch {
      throw new DepotCiError(
        operation.operation === "retry_failed" ? DEPOT_ERRORS.unknown : "Depot CI bridge unavailable.",
      );
    } finally {
      permit.release();
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new DepotCiError(
        operation.operation === "retry_failed" ? DEPOT_ERRORS.unknown : "Depot CI bridge response invalid.",
      );
    if (!response.ok) {
      const error = (data as { error?: unknown }).error;
      // An edge/proxy error is untrusted. Only the contract's finite vocabulary
      // (or a status-only refusal) crosses back into the model's transcript.
      const known =
        typeof error === "string" &&
        (Object.values(DEPOT_ERRORS).includes(error as (typeof DEPOT_ERRORS)[keyof typeof DEPOT_ERRORS]) ||
          /^Depot CI upstream refused \(HTTP \d{3}\)\.$/.test(error));
      throw new DepotCiError(
        known
          ? error
          : operation.operation === "retry_failed"
            ? DEPOT_ERRORS.unknown
            : `Depot CI bridge refused (HTTP ${response.status}).`,
      );
    }
    if (parsed.data.operation === "retry_failed") {
      const answer = retryResponseSchema.safeParse(data);
      if (!answer.success || answer.data.workflowId !== parsed.data.workflowId)
        throw new DepotCiError(DEPOT_ERRORS.unknown);
      return answer.data;
    }
    return data as Record<string, unknown>;
  }
}

export class DepotCiError extends Error {}

/** An offline second implementation: fixtures model results, never credentials. */
export class InMemoryDepotCi implements DepotCi {
  readonly calls: DepotOperation[] = [];
  constructor(private readonly results: Record<string, Record<string, unknown>> = {}) {}
  async call(operation: DepotOperation): Promise<Record<string, unknown>> {
    this.calls.push(structuredClone(operation));
    const result = this.results[operation.workflowId];
    if (!result) throw new DepotCiError(DEPOT_ERRORS.notFound);
    return structuredClone(result);
  }
}
