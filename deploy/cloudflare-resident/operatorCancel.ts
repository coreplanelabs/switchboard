import { z } from "zod";
import { admissionRecordHash } from "./admissionRecovery.js";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const build = z.string().regex(/^[a-f0-9]{40}(?:@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/);
const producerSchema = z.object({ build, workerVersion: uuid }).strict();
const sourceSchema = producerSchema.extend({ resource: z.string().regex(/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) });
const drainSchema = z
  .object({
    since: z.string().datetime(),
    until: z.string().datetime(),
    by: z.string().min(1).max(80),
    reason: z.string().min(1).max(200),
  })
  .strict();

export const operatorAbandonmentSchema = z
  .object({
    operationId: uuid,
    id: uuid,
    expectedStartedAt: instant,
    expectedRecordSha256: digest,
    source: sourceSchema,
    producer: producerSchema,
    drain: drainSchema,
    decision: z
      .object({
        by: z.string().regex(/^[A-Za-z0-9_.:@/-]{1,128}$/),
        reference: z
          .string()
          .max(1000)
          .refine((value) => {
            try {
              const url = new URL(value);
              return url.protocol === "https:" && !url.username && !url.password;
            } catch {
              return false;
            }
          }),
        issuedAt: instant,
        expiresAt: instant,
        acceptUnobservedRequestRisk: z.literal(true),
      })
      .strict(),
  })
  .strict();

type Abandonment = z.infer<typeof operatorAbandonmentSchema>;
type Producer = { build: string; workerVersion: string | null };
type Store = Pick<DurableObjectStorage, "get" | "put" | "delete">;
const permitKey = (id: string) => `deploy:admission:${id}`;
const auditKey = (id: string) => `deploy:abandoned:${id}`;
const disposition = {
  disposition: "operator-abandoned",
  requestEnd: "unobserved",
  nativeOutcome: "unverified",
  runtimeContainment: "not-established",
  independentObligations: "unchanged",
  uploadAuthorized: false,
} as const;

interface Audit {
  schema: 1;
  request: Abandonment;
  requestSha256: string;
  originalRecord: Record<string, unknown>;
  originalRecordSha256: string;
  authority: { scope: "admin"; credentialSha256: string };
  decidedAt: number;
  disposition: typeof disposition.disposition;
  requestEnd: typeof disposition.requestEnd;
  nativeOutcome: typeof disposition.nativeOutcome;
  runtimeContainment: typeof disposition.runtimeContainment;
  independentObligations: typeof disposition.independentObligations;
  uploadAuthorized: false;
}

export async function operatorSha256(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function operatorRequestHash(request: Abandonment): Promise<string> {
  return operatorSha256(JSON.stringify(request));
}

function liveDecision(request: Abandonment, now: number): boolean {
  return (
    Math.max(Date.parse(request.drain.since), request.expectedStartedAt) <= request.decision.issuedAt &&
    request.decision.issuedAt <= now &&
    now < request.decision.expiresAt &&
    request.decision.expiresAt <= Date.parse(request.drain.until)
  );
}

/** Quotes metadata only. A matching digest establishes no request ending. */
export async function quoteOperatorAdmission(store: Store, id: string, producer: Producer, now: number) {
  if (!uuid.safeParse(id).success || !producerSchema.safeParse(producer).success) return null;
  if ((await store.get(auditKey(id))) !== undefined) return null;
  const original = await store.get<Record<string, unknown>>(permitKey(id));
  const hash = await admissionRecordHash(original);
  const source = sourceSchema.safeParse(
    original && {
      build: original.build,
      workerVersion: original.workerVersion,
      resource: original.resource,
    },
  );
  const drain = drainSchema.safeParse(await store.get("drain"));
  if (
    !hash ||
    !source.success ||
    !drain.success ||
    !original ||
    !(Date.parse(drain.data.since) <= now && now < Date.parse(drain.data.until))
  )
    return null;
  return {
    id,
    expectedStartedAt: Number(original.startedAt),
    expectedRecordSha256: hash,
    source: source.data,
    producer,
    drain: drain.data,
  };
}

/** The caller supplies one storage transaction. No runtime operation occurs. */
export async function abandonOperatorAdmission(
  store: Store,
  input: unknown,
  producer: Producer,
  authoritySha256: string,
  clock: () => number,
): Promise<Audit | null> {
  const parsed = operatorAbandonmentSchema.safeParse(input);
  if (!parsed.success || !digest.safeParse(authoritySha256).success) return null;
  const request = parsed.data;
  const now = clock();
  if (!liveDecision(request, now) || (await store.get(`deploy:recovered:${request.id}`)) !== undefined) return null;
  const quote = await quoteOperatorAdmission(store, request.id, producer, now);
  if (
    !quote ||
    JSON.stringify(quote) !==
      JSON.stringify({
        id: request.id,
        expectedStartedAt: request.expectedStartedAt,
        expectedRecordSha256: request.expectedRecordSha256,
        source: request.source,
        producer: request.producer,
        drain: request.drain,
      })
  )
    return null;
  const originalRecord = await store.get<Record<string, unknown>>(permitKey(request.id));
  if (!originalRecord || (await admissionRecordHash(originalRecord)) !== request.expectedRecordSha256) return null;
  const requestSha256 = await operatorRequestHash(request);
  const decidedAt = clock();
  if (!liveDecision(request, decidedAt)) return null;
  const audit: Audit = {
    schema: 1,
    request,
    requestSha256,
    originalRecord,
    originalRecordSha256: request.expectedRecordSha256,
    authority: { scope: "admin", credentialSha256: authoritySha256 },
    decidedAt,
    ...disposition,
  };
  await store.put(auditKey(request.id), audit);
  if (!(await store.delete(permitKey(request.id)))) throw new Error("operator-abandonment-commit-unverified");
  return audit;
}

async function verifyAudit(value: unknown, id: string, operationId: string, requestSha256: string) {
  if (!uuid.safeParse(id).success || !uuid.safeParse(operationId).success || !digest.safeParse(requestSha256).success)
    return null;
  const audit = value as Audit | undefined;
  const parsed = operatorAbandonmentSchema.safeParse(audit?.request);
  const source = sourceSchema.safeParse(
    audit?.originalRecord && {
      build: audit.originalRecord.build,
      workerVersion: audit.originalRecord.workerVersion,
      resource: audit.originalRecord.resource,
    },
  );
  if (
    !audit ||
    audit.schema !== 1 ||
    !parsed.success ||
    !source.success ||
    JSON.stringify(source.data) !== JSON.stringify(parsed.data.source) ||
    parsed.data.id !== id ||
    parsed.data.operationId !== operationId ||
    audit.requestSha256 !== requestSha256 ||
    (await operatorRequestHash(parsed.data)) !== requestSha256 ||
    audit.originalRecordSha256 !== parsed.data.expectedRecordSha256 ||
    (await admissionRecordHash(audit.originalRecord)) !== parsed.data.expectedRecordSha256 ||
    audit.originalRecord.startedAt !== parsed.data.expectedStartedAt ||
    audit.authority?.scope !== "admin" ||
    !digest.safeParse(audit.authority.credentialSha256).success ||
    !instant.safeParse(audit.decidedAt).success ||
    !liveDecision(parsed.data, audit.decidedAt) ||
    Object.entries(disposition).some(([key, value]) => audit[key as keyof Audit] !== value)
  )
    return null;
  return audit;
}

/** An absent permit is insufficient. Read the immutable exact decision. */
export async function readOperatorAbandonment(store: Store, id: string, operationId: string, requestSha256?: string) {
  if ((await store.get(permitKey(id))) !== undefined) return null;
  const audit = await store.get<Audit>(auditKey(id));
  return verifyAudit(audit, id, operationId, requestSha256 ?? audit?.requestSha256 ?? "");
}

interface Registry {
  getOperatorAbandonmentQuote(id: string): ReturnType<typeof quoteOperatorAdmission>;
  operatorAbandonDeployAdmission(input: unknown, authoritySha256: string): Promise<Audit | null>;
  readOperatorAbandonment(id: string, operationId: string, requestSha256?: string): Promise<Audit | null>;
}
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleOperatorAbandonment(registry: Registry, body: unknown, authoritySha256: string) {
  const parsed = operatorAbandonmentSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "an exact quote and explicit operator risk decision are required" });
  const request = parsed.data;
  const requestSha256 = await operatorRequestHash(request);
  let receipt: Audit | null;
  try {
    const answer = await registry.operatorAbandonDeployAdmission(request, authoritySha256);
    if (answer === null) return json(409, { error: "request, producer, drain or decision changed; nothing removed" });
    receipt = await verifyAudit(answer, request.id, request.operationId, requestSha256);
    if (!receipt || receipt.authority.credentialSha256 !== authoritySha256)
      throw new Error("operator-abandonment-reply-unverified");
  } catch {
    const answer = await registry
      .readOperatorAbandonment(request.id, request.operationId, requestSha256)
      .catch(() => null);
    receipt = await verifyAudit(answer, request.id, request.operationId, requestSha256);
    if (receipt?.authority.credentialSha256 !== authoritySha256) receipt = null;
    if (!receipt)
      return json(503, {
        error: "operator decision outcome is unverified",
        id: request.id,
        operationId: request.operationId,
        requestSha256,
        commit: "unverified",
        requestEnd: "unobserved",
        nativeOutcome: "unverified",
        runtimeContainment: "not-established",
        uploadAuthorized: false,
      });
  }
  return json(200, {
    id: request.id,
    operationId: request.operationId,
    requestSha256,
    originalRecordSha256: receipt.originalRecordSha256,
    ...disposition,
  });
}

export async function handleOperatorAbandonmentRead(registry: Registry, url: URL) {
  const id = url.searchParams.get("id");
  if (!uuid.safeParse(id).success) return json(400, { error: "an exact admission ID is required" });
  if (!url.searchParams.has("operationId")) {
    const quote = await registry.getOperatorAbandonmentQuote(id!);
    return quote
      ? json(200, {
          state: "quoted",
          quote,
          requestEnd: "unobserved",
          nativeOutcome: "unverified",
          uploadAuthorized: false,
        })
      : json(409, { error: "request or live ordinary drain unavailable" });
  }
  const operationId = url.searchParams.get("operationId"),
    originalRecordSha256 = url.searchParams.get("expectedRecordSha256"),
    requestSha256 = url.searchParams.get("requestSha256") ?? undefined;
  if (
    !uuid.safeParse(operationId).success ||
    !digest.safeParse(originalRecordSha256).success ||
    (requestSha256 !== undefined && !digest.safeParse(requestSha256).success)
  )
    return json(400, { error: "the original operation ID and quoted record digest are required" });
  const answer = await registry.readOperatorAbandonment(id!, operationId!, requestSha256);
  const receipt = await verifyAudit(answer, id!, operationId!, requestSha256 ?? answer?.requestSha256 ?? "");
  return receipt?.originalRecordSha256 === originalRecordSha256
    ? json(200, { receipt })
    : json(409, { error: "the exact operator decision is unverified" });
}
