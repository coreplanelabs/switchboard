import { closedReadEvidence, type NativeReadEvidence, type PagingObserver } from "./pagingDiagnostic.js";

const PUBLIC_PAGE_SIZE = 100;
const states = new Set([
  "provisioning",
  "running",
  "failed",
  "stopping",
  "stopped",
  "unhealthy",
  "inactive",
  "unknown",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface PublicInventoryObservation {
  complete: boolean;
  pages: number;
  rows: number;
  states: Record<string, number>;
  missingNames: number;
  emptyImages: number;
  reason: string;
  failure?: NativeReadEvidence;
}

// Only this projection reaches the sanitizer. Provider extras, configuration,
// error messages and credential-bearing fields stay out of observations.
function publicPage(body: unknown, application: string) {
  if (
    !record(body) ||
    body.success !== true ||
    !Array.isArray(body.errors) ||
    body.errors.length ||
    !Array.isArray(body.result) ||
    !record(body.result_info)
  )
    return undefined;
  const next = body.result_info.next_page_token;
  if (next !== undefined && next !== null && typeof next !== "string") return undefined;
  const instances: { id: string; state: string; image: string; name?: string }[] = [];
  for (const row of body.result) {
    if (
      !record(row) ||
      typeof row.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.id) ||
      row.application_id !== application ||
      typeof row.image !== "string" ||
      !record(row.status) ||
      typeof row.status.state !== "string" ||
      !states.has(row.status.state) ||
      typeof row.status.updated_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(row.status.updated_at) ||
      !Number.isFinite(Date.parse(row.status.updated_at)) ||
      (row.name !== undefined && (typeof row.name !== "string" || Buffer.byteLength(row.name) > 1024))
    )
      return undefined;
    instances.push({
      id: row.id,
      state: row.status.state,
      image: row.image,
      ...(typeof row.name === "string" ? { name: row.name } : {}),
    });
  }
  return { instances, result_info: { next_page_token: next } };
}

/** Explicit unfiltered traversal. This never produces a legacy version row or
 * readiness receipt; an empty page with continuation is still incomplete. */
export async function observePublicInventory(
  account: string,
  application: string,
  headers: Readonly<Record<string, string>> | undefined,
  signal: AbortSignal,
  observe?: PagingObserver,
  fetcher: typeof fetch = fetch,
): Promise<PublicInventoryObservation> {
  const result: PublicInventoryObservation = {
    complete: false,
    pages: 0,
    rows: 0,
    states: {},
    missingNames: 0,
    emptyImages: 0,
    reason: "public metadata unavailable",
  };
  let cursor: string | null = null;
  let wire: Parameters<PagingObserver>[0]["publicMetadata"];
  const seen = new Map<string, NonNullable<Parameters<PagingObserver>[0]["cycle"]>["firstSeen"]>();
  const emit = (event: Parameters<PagingObserver>[0]) => {
    try {
      observe?.({ ...event, perPage: PUBLIC_PAGE_SIZE, producer: "cloudflare-public-v2" });
    } catch {
      /* Diagnostic I/O never grants completeness. */
    }
  };
  const fail = (
    reason:
      | "scope-unavailable"
      | "credentials-unavailable"
      | "interrupted"
      | "native-request-error"
      | "denied"
      | "native-http-error"
      | "native-api-error"
      | "malformed-page"
      | "unknown-state"
      | "repeated-cursor",
    cycle?: Parameters<PagingObserver>[0]["cycle"],
  ) => {
    emit({
      phase: "failure",
      app: application,
      pageIndex: result.pages,
      requestedCursor: wire?.wireCursor ?? null,
      cumulativeCount: result.rows,
      reason,
      ...(wire ? { publicMetadata: wire } : {}),
      ...(cycle ? { cycle } : {}),
    });
    result.reason = `public metadata ${reason}; completeness unverified`;
    return result;
  };
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(application))
    return fail("scope-unavailable");
  if (!headers) return fail("credentials-unavailable");
  do {
    if (signal.aborted) return fail("interrupted");
    result.pages++;
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications/${application}/instances-v2`,
    );
    url.searchParams.set("per_page", String(PUBLIC_PAGE_SIZE));
    if (cursor !== null) url.searchParams.set("page_token", cursor);
    wire = { account, wireCursor: url.searchParams.get("page_token") };
    emit({
      phase: "before",
      app: application,
      pageIndex: result.pages,
      requestedCursor: cursor,
      cumulativeCount: result.rows,
      publicMetadata: wire,
    });
    let response: Response;
    try {
      response = await fetcher(url, { method: "GET", headers, signal, redirect: "error" });
    } catch {
      return fail(signal.aborted ? "interrupted" : "native-request-error");
    }
    wire = { ...wire, httpStatus: response.status };
    if (signal.aborted) return fail("interrupted");
    if (response.status !== 200) {
      result.failure = closedReadEvidence({
        stage: "instances",
        reason: response.status === 401 || response.status === 403 ? "denied" : "native-http-error",
        httpStatus: response.status,
        errorClass: "unknown",
      });
      emit({
        phase: "after",
        app: application,
        pageIndex: result.pages,
        requestedCursor: cursor,
        cumulativeCount: result.rows,
        publicMetadata: { ...wire, httpStatus: response.status },
      });
      return fail(response.status === 401 || response.status === 403 ? "denied" : "native-http-error");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fail(signal.aborted ? "interrupted" : "malformed-page");
    }
    if (signal.aborted) return fail("interrupted");
    if (record(body) && Array.isArray(body.errors) && (body.success === false || body.errors.length > 0)) {
      result.failure = closedReadEvidence({
        stage: "instances",
        reason: "native-api-error",
        httpStatus: response.status,
        responseFormat: "json",
        providerCodes: body.errors.map((error) => (record(error) ? error.code : undefined)),
      });
      emit({
        phase: "after",
        app: application,
        pageIndex: result.pages,
        requestedCursor: cursor,
        cumulativeCount: result.rows,
        publicMetadata: { ...wire, httpStatus: response.status },
      });
      return fail("native-api-error");
    }
    const page = publicPage(body, application);
    emit({
      phase: "after",
      app: application,
      pageIndex: result.pages,
      requestedCursor: cursor,
      cumulativeCount: result.rows + (page?.instances.length ?? 0),
      ...(page ? { page } : {}),
      publicMetadata: { ...wire, httpStatus: response.status },
    });
    if (!page) return fail("malformed-page");
    result.rows += page.instances.length;
    for (const row of page.instances) {
      result.states[row.state] = (result.states[row.state] ?? 0) + 1;
      if (!row.name) result.missingNames++;
      if (!row.image) result.emptyImages++;
    }
    if (page.instances.some((row) => row.state === "unknown")) return fail("unknown-state");
    const next =
      typeof page.result_info.next_page_token === "string" && page.result_info.next_page_token !== ""
        ? page.result_info.next_page_token
        : null;
    const firstSeen = next ? seen.get(next) : undefined;
    if (next && firstSeen) return fail("repeated-cursor", { cursor: next, firstSeen });
    if (next) seen.set(next, { pageIndex: result.pages, requestedCursor: cursor, cumulativeCount: result.rows });
    cursor = next;
  } while (cursor !== null);
  if (signal.aborted) return fail("interrupted");
  result.complete = true;
  result.reason = "public metadata traversal complete; application-version evidence unavailable";
  return result;
}
