// Resident Worker: always-warm per-repo environments on Cloudflare Sandbox 1.0
// (@cloudflare/sandbox@next, exact-pinned; the Dockerfile FROM tag must match).
// One ResidentDO — a Sandbox subclass, i.e. a container — per onboarded
// resource, plus one singleton ResidentRegistryDO holding the onboarded set,
// the command table, and the cap.
//
// Residency is a generic resource-typed primitive (KTD1): every route contract
// carries a `resource` id of the form "<type>:<id>"; "repo" is the first (and
// currently only) supported type. The Durable Object name IS the resource id
// ("repo:<slug>" — verified: the SDK's sanitizeSandboxId accepts ':').
//
// Route surface (JSON in/out; every route below requires a bearer secret):
//   admin scope     POST /onboard /offboard /reconfigure    GET /residents
//   operator scope  POST /attach /exec /read /write /op     GET /status
//   unauthenticated GET /healthz (deploy wake ping; touches no DO)
//
// U2 (this unit) implements auth, registry storage, onboard/offboard/
// reconfigure/status/residents, and the provisioning deadline. /attach /exec
// /read /write are 501 stubs (land in U3/U4); /op is a 501 stub (lands in U6).
// The lifecycle engine that drives warm/refreshing/restoring transitions and
// the watchdog re-arm/degrade logic lands in U3 — this unit persists/reads the
// state field, sets "onboarding" on onboard, and fails closed to "degraded"
// when the provisioning deadline passes.
//
// SECURITY (deliberate deviations from the thread-sandbox Worker):
//   1. Bearer comparison is constant-time (timingSafeEqual below), never a
//      plain `!==`.
//   2. Two scopes: the admin token guards onboarding/config/enumeration; the
//      operator token guards per-resident operations. The admin token is a
//      strict superset (valid on operator routes); the operator token is
//      refused on admin routes. Missing/empty secrets grant nothing.
//   3. Caller-supplied `x-env-*` headers are IGNORED on every route — nothing
//      here reads them and no request header is ever forwarded into a
//      resident. Env that the resident itself injects (e.g. GitHub App tokens,
//      from U3 on) must pass validateEnvNames() before interpolation.
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

interface Env {
  RESIDENT: DurableObjectNamespace<ResidentDO>;
  REGISTRY: DurableObjectNamespace<ResidentRegistryDO>;
  BACKUP_BUCKET: R2Bucket;
  RESIDENT_ADMIN_TOKEN: string;
  RESIDENT_OPERATOR_TOKEN: string;
  // GitHub App identity for minting installation tokens inside residents
  // (consumed from U3 on; provisioned via secrets.txt from day one).
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard cap on onboarded residents, enforced atomically by the registry DO.
 *  Deliberately BELOW wrangler.jsonc's containers max_instances (10) so an
 *  over-cap onboard is always refused by the registry, never by a platform
 *  scheduling failure. Bump the two together. */
const RESIDENT_CAP = 8;

/** Container sleep window, passed to every getSandbox() for ResidentDO.
 *  KTD4 invariant: the watchdog cadence (wrangler.jsonc crons — every 10
 *  minutes) and any keep-warm alarm MUST stay SHORTER than this window, so a
 *  healthy resident is re-warmed before the platform can sleep it. Bump the
 *  cron and this value together. */
const SLEEP_AFTER = "20m";

/** Default deadline for a resident to reach "warm" after onboarding.
 *  Containers take a few minutes to provision on first start. */
const DEFAULT_PROVISIONING_TIMEOUT_MS = 5 * 60_000;
const MIN_PROVISIONING_TIMEOUT_MS = 10_000;
const MAX_PROVISIONING_TIMEOUT_MS = 30 * 60_000;

/** Env var names a resident injects must match this before interpolation —
 *  the other half of the x-env hardening above. U3's env-injection code MUST
 *  route through validateEnvNames(). */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
export function validateEnvNames(vars: Record<string, string>): void {
  for (const name of Object.keys(vars)) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`invalid env var name ${JSON.stringify(name)}: must match ${ENV_NAME_RE}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle model (persisted in each ResidentDO; the engine lands in U3)
// ---------------------------------------------------------------------------

type ResidentState = "onboarding" | "warm" | "refreshing" | "restoring" | "degraded" | "down";
interface ResidentStatus {
  state: ResidentState;
  reason: string; // non-empty whenever state is degraded or down
}

/** Registry record: the onboarded set + command table (KTD9: writable only via
 *  the admin routes onboard/reconfigure). */
interface ResidentRecord {
  resource: string;
  /** Command table. Always contains "test" and "build"; extra named commands
   *  are allowed. Commands execute inside the resident (from U3 on) — never on
   *  the Worker. */
  commands: Record<string, string>;
  defaultRef: string;
  diskBudgetMb?: number;
  provisioningTimeoutMs: number;
  onboardedAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Registry DO (singleton): onboarded set + config, atomic cap enforcement
// ---------------------------------------------------------------------------

const REGISTRY_KEY_PREFIX = "resident:";
const registryKey = (resource: string) => `${REGISTRY_KEY_PREFIX}${resource}`;

type OnboardResult = { ok: true; record: ResidentRecord } | { ok: false; status: number; error: string };

export class ResidentRegistryDO extends DurableObject<Env> {
  /** Atomic cap check + insert. Durable Objects deliver events through input
   *  gates: while a storage operation is in flight no other event is delivered
   *  to this object, and nothing below awaits anything except this object's
   *  own storage — so the exists-check, the count, and the insert cannot
   *  interleave with a concurrent onboard. */
  async onboard(record: ResidentRecord): Promise<OnboardResult> {
    const key = registryKey(record.resource);
    if (await this.ctx.storage.get(key)) {
      return { ok: false, status: 409, error: `${record.resource} is already onboarded` };
    }
    const existing = await this.ctx.storage.list({ prefix: REGISTRY_KEY_PREFIX });
    if (existing.size >= RESIDENT_CAP) {
      return {
        ok: false,
        status: 429,
        error: `resident cap reached (${existing.size}/${RESIDENT_CAP}); offboard a resident first`,
      };
    }
    await this.ctx.storage.put(key, record);
    return { ok: true, record };
  }

  async getRecord(resource: string): Promise<ResidentRecord | null> {
    return (await this.ctx.storage.get<ResidentRecord>(registryKey(resource))) ?? null;
  }

  async list(): Promise<ResidentRecord[]> {
    const all = await this.ctx.storage.list<ResidentRecord>({ prefix: REGISTRY_KEY_PREFIX });
    return [...all.values()].sort((a, b) => a.resource.localeCompare(b.resource));
  }

  /** Admin-only by construction: reachable exclusively through /reconfigure.
   *  `commands`, when present, REPLACES the whole command table. */
  async updateConfig(
    resource: string,
    patch: Partial<Pick<ResidentRecord, "commands" | "defaultRef" | "diskBudgetMb" | "provisioningTimeoutMs">>,
  ): Promise<ResidentRecord | null> {
    const key = registryKey(resource);
    const record = await this.ctx.storage.get<ResidentRecord>(key);
    if (!record) return null;
    const updated: ResidentRecord = { ...record, updatedAt: new Date().toISOString() };
    if (patch.commands !== undefined) updated.commands = patch.commands;
    if (patch.defaultRef !== undefined) updated.defaultRef = patch.defaultRef;
    if (patch.diskBudgetMb !== undefined) updated.diskBudgetMb = patch.diskBudgetMb;
    if (patch.provisioningTimeoutMs !== undefined) updated.provisioningTimeoutMs = patch.provisioningTimeoutMs;
    await this.ctx.storage.put(key, updated);
    return updated;
  }

  async remove(resource: string): Promise<boolean> {
    return this.ctx.storage.delete(registryKey(resource));
  }
}

// ---------------------------------------------------------------------------
// Resident DO: one per resource; Sandbox subclass = one container per resource
// ---------------------------------------------------------------------------

const PROVISIONING_CALLBACK = "onProvisioningDeadline";
const STATE_KEY = "resident:state";
const REASON_KEY = "resident:reason";
const RESOURCE_KEY = "resident:resource";
const UPDATED_KEY = "resident:updatedAt";

export class ResidentDO extends Sandbox<Env> {
  // TIMER RULE: never call ctx.storage.setAlarm/deleteAlarm from lifecycle
  // code — the Container base class owns the DO alarm slot (its sleepAfter
  // machinery and schedule multiplexing live there). All resident timers go
  // through this.schedule()/this.deleteSchedules(), which multiplex onto that
  // alarm safely. (Checked against @cloudflare/containers 0.3.7: the SDK
  // registers no schedule callback names, so ours cannot collide.)

  /** Called once per onboard: persist the initial lifecycle state and arm the
   *  provisioning deadline. Does NOT start the container — the provisioning
   *  engine (U3) does that; onboard must return immediately. */
  async initResident(resource: string, provisioningTimeoutMs: number): Promise<ResidentStatus> {
    await this.ctx.storage.put({
      [RESOURCE_KEY]: resource,
      [STATE_KEY]: "onboarding" satisfies ResidentState,
      [REASON_KEY]: "",
      [UPDATED_KEY]: new Date().toISOString(),
    });
    // One pending deadline at a time (a re-onboard after offboard replaces it).
    this.deleteSchedules(PROVISIONING_CALLBACK);
    await this.schedule(Math.max(1, Math.ceil(provisioningTimeoutMs / 1000)), PROVISIONING_CALLBACK, resource);
    return { state: "onboarding", reason: "" };
  }

  /** TODO(U3-provisioning): the real engine — clone defaultRef, install,
   *  build, flip to "warm", snapshot via createBackup({ localBucket: true })
   *  — replaces this fail-closed stub. Contract this stub already honors: a
   *  resident that has not reached "warm" when the deadline fires MUST be
   *  marked degraded with a persisted reason. */
  async onProvisioningDeadline(_payload: string): Promise<void> {
    const state = await this.ctx.storage.get<ResidentState>(STATE_KEY);
    if (state === "onboarding") {
      await this.setResidentState(
        "degraded",
        "provisioning deadline elapsed before reaching warm (provisioning engine lands in U3)",
      );
    }
  }

  /** Persist a lifecycle transition. degraded/down always carry a reason. */
  async setResidentState(state: ResidentState, reason = ""): Promise<void> {
    if ((state === "degraded" || state === "down") && !reason) {
      throw new Error(`state "${state}" requires a reason`);
    }
    await this.ctx.storage.put({
      [STATE_KEY]: state,
      [REASON_KEY]: reason,
      [UPDATED_KEY]: new Date().toISOString(),
    });
  }

  async getStatus(): Promise<ResidentStatus> {
    const map = await this.ctx.storage.get<string>([STATE_KEY, REASON_KEY]);
    const state = map.get(STATE_KEY) as ResidentState | undefined;
    if (!state) {
      return { state: "down", reason: "no resident state persisted (never onboarded, or already offboarded)" };
    }
    return { state, reason: map.get(REASON_KEY) ?? "" };
  }

  /** Offboard teardown: cancel timers, stop the container (best effort), wipe
   *  DO storage. R2 objects are deleted by the Worker (it owns the bucket
   *  binding and the key convention).
   *  TODO(U3): before the storage wipe, delete the R2 objects behind any SDK
   *  backup handles stored here — the SDK writes them under backups/<uuid>/,
   *  outside the resident's own prefix, and the handles die with deleteAll. */
  async teardown(): Promise<{ schedulesCancelled: boolean; containerStopped: boolean; storageCleared: boolean; errors: string[] }> {
    const errors: string[] = [];
    let containerStopped = false;
    this.deleteSchedules(PROVISIONING_CALLBACK);
    try {
      await this.destroy();
      containerStopped = true;
    } catch (err) {
      errors.push(`destroy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Retired DO: clear the alarm the Container base may have armed for its
    // schedules, then wipe storage so nothing ever wakes this object again.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { schedulesCancelled: true, containerStopped, storageCleared: true, errors };
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/** Constant-time byte comparison. The early length return leaks only the
 *  length, which any comparison leaks; per-byte timing never varies with
 *  content. Deliberate deviation from the thread-sandbox Worker's plain !==. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

type Scope = "admin" | "operator";

/** Fail closed: unset/empty secrets grant nothing. The admin token is a strict
 *  superset (valid on operator routes); the operator token never opens an
 *  admin route. */
function hasScope(env: Env, token: string | null, scope: Scope): boolean {
  if (!token) return false;
  if (env.RESIDENT_ADMIN_TOKEN && timingSafeEqual(token, env.RESIDENT_ADMIN_TOKEN)) return true;
  if (scope === "operator" && env.RESIDENT_OPERATOR_TOKEN && timingSafeEqual(token, env.RESIDENT_OPERATOR_TOKEN)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** KTD1: "<type>:<id>", lowercase; the id starts/ends alphanumeric so the DO
 *  name is also a valid sandbox id (≤63 chars, no leading/trailing hyphen). */
const RESOURCE_RE = /^([a-z][a-z0-9-]*):([a-z0-9](?:[a-z0-9._-]{0,53}[a-z0-9])?)$/;
const SUPPORTED_RESOURCE_TYPES = new Set(["repo"]);

function parseResource(value: unknown): { resource: string } | { error: string } {
  if (typeof value !== "string") return { error: 'resource must be a string like "repo:<slug>"' };
  const match = RESOURCE_RE.exec(value);
  if (!match) return { error: `resource must match ${String(RESOURCE_RE)}` };
  if (!SUPPORTED_RESOURCE_TYPES.has(match[1])) {
    return { error: `unsupported resource type "${match[1]}" (supported: ${[...SUPPORTED_RESOURCE_TYPES].join(", ")})` };
  }
  return { resource: value };
}

const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_COMMAND_LENGTH = 2000;

function parseCommands(value: unknown): { commands: Record<string, string> } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: 'commands must be an object like { "test": "npm test", "build": "npm run build" }' };
  }
  const commands: Record<string, string> = {};
  for (const [name, command] of Object.entries(value)) {
    if (!COMMAND_NAME_RE.test(name)) return { error: `invalid command name ${JSON.stringify(name)}` };
    if (typeof command !== "string" || command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
      return { error: `command ${JSON.stringify(name)} must be a non-empty string of at most ${MAX_COMMAND_LENGTH} chars` };
    }
    commands[name] = command;
  }
  for (const required of ["test", "build"]) {
    if (!(required in commands)) return { error: `commands must include "${required}"` };
  }
  return { commands };
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function parseDefaultRef(value: unknown): { defaultRef: string } | { error: string } {
  if (typeof value !== "string" || !REF_RE.test(value) || value.includes("..")) {
    return { error: 'defaultRef must be a plausible git ref (e.g. "main")' };
  }
  return { defaultRef: value };
}

function parsePositiveInt(value: unknown, field: string, min: number, max: number): { value: number } | { error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return { error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { value };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const ROUTES: Record<string, { scope: Scope; method: string }> = {
  "/onboard": { scope: "admin", method: "POST" },
  "/offboard": { scope: "admin", method: "POST" },
  "/reconfigure": { scope: "admin", method: "POST" },
  "/residents": { scope: "admin", method: "GET" },
  "/status": { scope: "operator", method: "GET" },
  "/attach": { scope: "operator", method: "POST" },
  "/exec": { scope: "operator", method: "POST" },
  "/read": { scope: "operator", method: "POST" },
  "/write": { scope: "operator", method: "POST" },
  "/op": { scope: "operator", method: "POST" },
};

function registryStub(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

function residentStub(env: Env, resource: string) {
  return getSandbox(env.RESIDENT, resource, { sleepAfter: SLEEP_AFTER });
}

/** Per-resource R2 prefix. U3+ writes resident cache objects under this;
 *  offboard deletes everything beneath it. */
const r2Prefix = (resource: string) => `resident/${resource}/`;

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated wake ping for `npm run deploy` — touches no DO, no data.
    if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true });

    // Auth precedes existence: unknown paths demand admin before revealing
    // 404 vs 401, so an unauthenticated scanner learns nothing.
    const route = ROUTES[url.pathname];
    if (!hasScope(env, bearerToken(request), route?.scope ?? "admin")) {
      return json({ error: "unauthorized" }, 401);
    }
    if (!route) return json({ error: "unknown route" }, 404);
    if (request.method !== route.method) return json({ error: `${route.method} only` }, 405);

    const body: Record<string, unknown> =
      route.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

    try {
      switch (url.pathname) {
        case "/onboard":
          return await handleOnboard(env, body);
        case "/offboard":
          return await handleOffboard(env, body);
        case "/reconfigure":
          return await handleReconfigure(env, body);
        case "/residents": {
          const residents = await registryStub(env).list();
          return json({ cap: RESIDENT_CAP, count: residents.length, residents });
        }
        case "/status":
          return await handleStatus(env, url);
        case "/attach":
        case "/exec":
        case "/read":
        case "/write":
          return json({ error: "not implemented", lands_in: "U3/U4" }, 501);
        case "/op":
          return json({ error: "not implemented", lands_in: "U6" }, 501);
        default:
          return json({ error: "unknown route" }, 404);
      }
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },

  /** Watchdog. TODO(U3-watchdog) contract: iterate the registry; for each
   *  resident, probe its DO state, re-warm containers that slept, re-arm
   *  keep-warm schedules, and transition to degraded (with a persisted reason)
   *  on repeated failures. Cadence invariant (KTD4): this cron (every 10
   *  minutes) stays SHORTER than SLEEP_AFTER ("20m"). */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const residents = await registryStub(env).list();
    console.log(
      `resident-watchdog: ${residents.length}/${RESIDENT_CAP} resident(s) registered; re-arm/degrade engine lands in U3`,
    );
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOnboard(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const commands = parseCommands(body.commands);
  if ("error" in commands) return json({ error: commands.error }, 400);
  const defaultRef = parseDefaultRef(body.defaultRef);
  if ("error" in defaultRef) return json({ error: defaultRef.error }, 400);

  let diskBudgetMb: number | undefined;
  if (body.diskBudgetMb !== undefined) {
    const parsed = parsePositiveInt(body.diskBudgetMb, "diskBudgetMb", 1, 100_000);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    diskBudgetMb = parsed.value;
  }
  let provisioningTimeoutMs = DEFAULT_PROVISIONING_TIMEOUT_MS;
  if (body.provisioningTimeoutMs !== undefined) {
    const parsed = parsePositiveInt(
      body.provisioningTimeoutMs,
      "provisioningTimeoutMs",
      MIN_PROVISIONING_TIMEOUT_MS,
      MAX_PROVISIONING_TIMEOUT_MS,
    );
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    provisioningTimeoutMs = parsed.value;
  }

  const now = new Date().toISOString();
  const record: ResidentRecord = {
    resource: resource.resource,
    commands: commands.commands,
    defaultRef: defaultRef.defaultRef,
    ...(diskBudgetMb !== undefined ? { diskBudgetMb } : {}),
    provisioningTimeoutMs,
    onboardedAt: now,
    updatedAt: now,
  };

  const registry = registryStub(env);
  const result = await registry.onboard(record);
  // "in" narrowing: the RPC stub intersects returns with Disposable, which
  // defeats boolean-discriminant narrowing.
  if ("error" in result) return json({ error: result.error }, result.status);

  try {
    await residentStub(env, resource.resource).initResident(resource.resource, provisioningTimeoutMs);
  } catch (err) {
    // Fail closed: no half-onboarded residents. Free the slot and report.
    await registry.remove(resource.resource);
    return json(
      { error: `onboard failed arming the resident: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  return json({ resource: resource.resource, state: "onboarding" satisfies ResidentState }, 202);
}

async function handleOffboard(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);

  const registry = registryStub(env);
  const record = await registry.getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  // Registry first: the slot frees atomically and no new work routes here.
  const registryRemoved = await registry.remove(resource.resource);

  let teardown: Awaited<ReturnType<ResidentDO["teardown"]>>;
  try {
    teardown = await residentStub(env, resource.resource).teardown();
  } catch (err) {
    teardown = {
      schedulesCancelled: false,
      containerStopped: false,
      storageCleared: false,
      errors: [`teardown failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const r2ObjectsDeleted = await deleteR2Prefix(env.BACKUP_BUCKET, r2Prefix(resource.resource));

  return json({
    resource: resource.resource,
    registryRemoved,
    schedulesCancelled: teardown.schedulesCancelled,
    containerStopped: teardown.containerStopped,
    storageCleared: teardown.storageCleared,
    r2ObjectsDeleted,
    errors: teardown.errors,
  });
}

async function handleReconfigure(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);

  const patch: Partial<Pick<ResidentRecord, "commands" | "defaultRef" | "diskBudgetMb" | "provisioningTimeoutMs">> = {};
  if (body.commands !== undefined) {
    const commands = parseCommands(body.commands);
    if ("error" in commands) return json({ error: commands.error }, 400);
    patch.commands = commands.commands;
  }
  if (body.defaultRef !== undefined) {
    const defaultRef = parseDefaultRef(body.defaultRef);
    if ("error" in defaultRef) return json({ error: defaultRef.error }, 400);
    patch.defaultRef = defaultRef.defaultRef;
  }
  if (body.diskBudgetMb !== undefined) {
    const parsed = parsePositiveInt(body.diskBudgetMb, "diskBudgetMb", 1, 100_000);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    patch.diskBudgetMb = parsed.value;
  }
  if (body.provisioningTimeoutMs !== undefined) {
    const parsed = parsePositiveInt(
      body.provisioningTimeoutMs,
      "provisioningTimeoutMs",
      MIN_PROVISIONING_TIMEOUT_MS,
      MAX_PROVISIONING_TIMEOUT_MS,
    );
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    patch.provisioningTimeoutMs = parsed.value;
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: "nothing to reconfigure (accepted: commands, defaultRef, diskBudgetMb, provisioningTimeoutMs)" }, 400);
  }

  const updated = await registryStub(env).updateConfig(resource.resource, patch);
  if (!updated) return json({ error: `${resource.resource} is not onboarded` }, 404);
  return json({ resource: updated.resource, record: updated });
}

async function handleStatus(env: Env, url: URL): Promise<Response> {
  const resource = parseResource(url.searchParams.get("resource"));
  if ("error" in resource) return json({ error: resource.error }, 400);

  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  // Body deliberately limited to { state, reason } — operator scope sees
  // lifecycle, not config.
  const status = await residentStub(env, resource.resource).getStatus();
  return json({ state: status.state, reason: status.reason });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
