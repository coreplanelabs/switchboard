#!/usr/bin/env node
// Deploy preflight for the resident Worker (docs/reference/specs/resident-repos.md item 44).
//
// `wrangler deploy` replaces every ResidentDO isolate and invalidates the
// Sandbox SDK process handles held by in-flight runs ("Process handle refers
// to a previous runtime incarnation") — the container-restart deferral in
// `reconcileImage` cannot protect against a Worker deploy. So `npm run deploy`
// runs this first: it asks the live Worker to fence reattach and distinguish
// executing runs from terminal registrations retained for workspace safety.
//
// Fail closed: no bearer, unreachable Worker, or a resident whose live view
// errored all refuse — a deploy never proceeds blind. `RESIDENT_DEPLOY_FORCE=1`
// (or `--force` when run directly) is the explicit, warned bypass.
//
// Dependency-free Node (fetch is built in). `decide()` is pure and unit-tested
// (preflight.test.mjs); `main()` only does I/O around it.

import { pathToFileURL } from "node:url";
import { deploymentClock } from "../bin/deploy-clock.mjs";

/** The env var naming this Worker's origin. `deploy all` sets it from the deployment profile; the
 *  preflight has no address of its own (deploy/profile.json is the only place the fleet's hostnames live). */
export const BASE_URL_ENV = "RESIDENT_BASE_URL";
export const TOKEN_ENV_VARS = ["RESIDENT_DRAIN_TOKEN"];

const HOW_TO_SET_TOKEN =
  `set ${TOKEN_ENV_VARS.join(" / ")} in the environment (the same bearer ` +
  "`npm run secrets` put on the Worker; drain scope fences attach), e.g. " +
  "`RESIDENT_DRAIN_TOKEN=… npm run deploy`";
const HOW_TO_FORCE =
  "to deploy anyway (this WILL kill in-flight runs): `RESIDENT_DEPLOY_FORCE=1 npm run deploy` (`node preflight.mjs --force` checks alone)";
/** Lifecycle states in which NOTHING is executing on the resident — the only
 *  states a deploy may land on. Every other state is either known mid-cycle
 *  (the engine is running a refresh's fetch/rebuild, a restore, or
 *  provisioning — an isolate swap kills that like a thread run) or a
 *  state this script does not know, which fails closed as `unknown`: this is
 *  plain JS outside the shared `ResidentLifecycleState` type, so an allow-list
 *  of settled states is what keeps vocabulary drift from silently allowing. */
const SETTLED_STATES = new Set(["warm", "degraded", "down"]);
/** The engine is executing and an isolate swap would FAIL it: provisioning
 *  (`onboarding`) has no checkpoint to resume from — a killed install or build
 *  is `provision-failed`, `down`, and only a rebuild recovers it. */
const PROVISIONING_STATES = new Set(["onboarding"]);
/** The engine is executing and an isolate swap merely INTERRUPTS it: a refresh
 *  step is retried by its Workflow instance and resumes from its disk
 *  checkpoints (resident-repos items 44 and 48); a restore is retried by the next hydrate, which first
 *  unmounts and removes whatever the interrupted one left (item 61). These
 *  used to refuse like `onboarding`, and a release deploy once spent its whole
 *  budget behind a resident stuck in `restoring` — a state an isolate swap
 *  would have HELPED. Allowed with a warning. */
const INTERRUPTIBLE_STATES = new Set(["refreshing", "restoring"]);

/** First present, non-blank bearer in preference order; null when none. */
export function readToken(env) {
  for (const name of TOKEN_ENV_VARS) {
    const v = env[name];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/** POST /deploy-fence closes registered reattach and reads activity. Never throws. */
export async function fetchResidents(baseUrl, token, { timeoutMs = 15_000, attempt } = {}) {
  if (!token) return { ok: false, error: "no bearer in the environment" };
  const url = new URL("/deploy-fence", baseUrl).toString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      ...(attempt ? { body: JSON.stringify({ attempt }) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `http-status:${res.status}` };
    try {
      return { ok: true, payload: JSON.parse(text) };
    } catch {
      return { ok: false, error: "malformed-json" };
    }
  } catch (err) {
    return { ok: false, error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "transport" };
  }
}

// Closed pairs produced by getResidentDeployInfo's registration classifier.
// Unknown or malformed reporting data never changes the safety decision.
const READBACK_REASONS = {
  unknown: ["malformed-registration", "owner-unverified", "binding-conflict", "ledger-unverified"],
  legacy: ["operation-active", "legacy-protected", "protection-elapsed", "legacy-reconciled"],
  owned: ["live-owner", "terminal-owner"],
};

function registrationReadbackText(rows) {
  if (!Array.isArray(rows) || rows.length > 10) return "unavailable";
  const seen = new Set();
  const facts = [];
  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.category !== "string" ||
      typeof row.reason !== "string" ||
      !Object.hasOwn(READBACK_REASONS, row.category) ||
      !READBACK_REASONS[row.category].includes(row.reason) ||
      !Number.isSafeInteger(row.count) ||
      row.count <= 0
    )
      return "unavailable";
    const key = `${row.category}/${row.reason}`;
    if (seen.has(key)) return "unavailable";
    seen.add(key);
    facts.push(`${key}=${row.count}`);
  }
  return facts.length ? facts.sort().join(", ") : "empty";
}

/** Bounded, metadata-only diagnostic. It never relaxes the deployment gate. */
function nativeOperationReadbackText(readback) {
  if (!readback || !Array.isArray(readback.operations) || readback.operations.length > 25) return "unavailable";
  const safe = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);
  const facts = [];
  for (const row of readback.operations.slice(0, 5)) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      !safe(row.key) ||
      ![
        "legacy-or-invalid-record",
        "original-native-evidence-unavailable",
        "original-process-result-required",
      ].includes(row.recoveryReason)
    )
      return "unavailable";
    const pending = row.journal?.pending;
    const processes =
      pending && typeof pending === "object"
        ? Object.values(pending)
            .slice(0, 4)
            .flatMap((attempt) => {
              const process = attempt?.process;
              return safe(process?.id) && Number.isSafeInteger(process.pid) && process.pid > 0
                ? [`${process.id}/pid=${process.pid}`]
                : [];
            })
        : [];
    facts.push(`${row.key} [${row.recoveryReason}${processes.length ? `; processes=${processes.join(",")}` : ""}]`);
  }
  return `${readback.operations.length}${readback.cursor ? "+" : ""} stored hold(s)${facts.length ? `; ${facts.join("; ")}` : ""}${readback.operations.length > 5 ? "; more details in operation inventory" : ""}`;
}

/** Project only the received metadata. No further inventory or native read. */
function nativeOperationDiagnostic(fetched) {
  const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const identity = (v, max = 512) => typeof v === "string" && v.length <= max && /^[A-Za-z0-9_.:@/+-]+$/.test(v);
  const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const process = (v) => {
    if (
      !object(v) ||
      !identity(v.id, 256) ||
      !Number.isSafeInteger(v.pid) ||
      v.pid <= 0 ||
      typeof v.startedAt !== "string" ||
      v.startedAt.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v.startedAt) ||
      !Number.isFinite(Date.parse(v.startedAt))
    )
      throw new Error("invalid identity");
    return { id: v.id, pid: v.pid, startedAt: v.startedAt };
  };
  const unavailable = (v, reason) => ({
    ...(identity(v?.key) && v.key.startsWith("native-operation:") ? { key: v.key } : {}),
    ...(hash(v?.recordHash) ? { recordHash: v.recordHash } : {}),
    detailUnavailable: reason,
  });
  const row = (v) => {
    try {
      if (
        !object(v) ||
        !identity(v.key) ||
        !v.key.startsWith("native-operation:") ||
        !hash(v.recordHash) ||
        typeof v.recoverable !== "boolean" ||
        ![
          "legacy-or-invalid-record",
          "original-native-evidence-unavailable",
          "original-process-result-required",
        ].includes(v.recoveryReason)
      )
        throw new Error("invalid row");
      let owner = null;
      if (v.owner !== null) {
        if (!object(v.owner)) throw new Error("invalid owner");
        if (identity(v.owner.opOwner) && v.owner.opOwner.startsWith("op:")) owner = { opOwner: v.owner.opOwner };
        else if (
          identity(v.owner.runId) &&
          identity(v.owner.ownerGen) &&
          Number.isSafeInteger(v.owner.ownerFence) &&
          v.owner.ownerFence > 0
        )
          owner = { runId: v.owner.runId, ownerGen: v.owner.ownerGen, ownerFence: v.owner.ownerFence };
        else throw new Error("invalid owner");
      }
      let journal = null;
      if (v.journal !== null) {
        const j = v.journal;
        if (
          !object(j) ||
          j.version !== 1 ||
          typeof j.closed !== "boolean" ||
          !object(j.pending) ||
          Object.keys(j.pending).length > 64 ||
          (j.threadKey !== undefined && !identity(j.threadKey, 256))
        )
          throw new Error("invalid journal");
        const pending = Object.fromEntries(
          Object.entries(j.pending).map(([key, attempt]) => {
            if (!identity(key, 256) || !object(attempt) || !["opaque", "process"].includes(attempt.kind))
              throw new Error("invalid attempt");
            return [
              key,
              { kind: attempt.kind, ...(attempt.process === undefined ? {} : { process: process(attempt.process) }) },
            ];
          }),
        );
        journal = {
          version: 1,
          closed: j.closed,
          ...(j.threadKey === undefined ? {} : { threadKey: j.threadKey }),
          pending,
        };
      }
      if (!Array.isArray(v.controls) || v.controls.length > 64) throw new Error("invalid controls");
      const returnedControls = v.controls.map((control) => {
        if (
          !object(control) ||
          !hash(control.recordHash) ||
          !["requested", "kill-acknowledged", "kill-unverified"].includes(control.outcome)
        )
          throw new Error("invalid control");
        let failure;
        if (control.failure !== undefined) {
          if (
            !object(control.failure) ||
            !identity(control.failure.class, 128) ||
            (control.failure.code !== undefined && !identity(control.failure.code, 128))
          )
            throw new Error("invalid failure");
          failure = {
            class: control.failure.class,
            ...(control.failure.code === undefined ? {} : { code: control.failure.code }),
          };
        }
        return {
          process: process(control.process),
          recordHash: control.recordHash,
          outcome: control.outcome,
          ...(failure ? { failure } : {}),
        };
      });
      return {
        key: v.key,
        recordHash: v.recordHash,
        owner,
        recoverable: v.recoverable,
        recoveryReason: v.recoveryReason,
        journal,
        returnedControls,
      };
    } catch {
      return unavailable(v, "malformed");
    }
  };
  if (!fetched.ok || !Array.isArray(fetched.payload?.residents)) return null;
  const held = fetched.payload.residents.filter(
    (r) =>
      object(r?.live?.nativeOperationReadback) &&
      (!Array.isArray(r.live.nativeOperationReadback.operations) ||
        r.live.nativeOperationReadback.operations.length > 0),
  );
  if (!held.length) return null;
  const snapshot = {
    schema: 1,
    receivedProjectionComplete: held.length <= 5,
    controlStorageCompleteness: "unverified",
    omittedResourceCount: Math.max(0, held.length - 5),
    resources: [],
  };
  let remaining = 5;
  for (const r of held.slice(0, 5)) {
    const readback = r.live.nativeOperationReadback;
    if (
      !identity(r.resource, 63) ||
      !r.resource.startsWith("repo:") ||
      !Array.isArray(readback.operations) ||
      readback.operations.length > 25 ||
      (readback.cursor !== null && (!identity(readback.cursor) || !readback.cursor.startsWith("native-operation:")))
    ) {
      snapshot.resources.push({
        resource: identity(r.resource, 63) ? r.resource : null,
        detailUnavailable: "malformed",
      });
      snapshot.receivedProjectionComplete = false;
      continue;
    }
    const operations = readback.operations.slice(0, remaining).map(row);
    remaining -= operations.length;
    const omittedOperationCount = readback.operations.length - operations.length;
    if (omittedOperationCount || readback.cursor !== null || operations.some((v) => v.detailUnavailable))
      snapshot.receivedProjectionComplete = false;
    snapshot.resources.push({
      resource: r.resource,
      returnedOperationCount: readback.operations.length,
      operationCursor: readback.cursor,
      omittedOperationCount,
      operations,
    });
  }
  const prefix = "[resident-native-operation-diagnostic] ";
  const line = () => prefix + JSON.stringify(snapshot);
  for (const resource of [...snapshot.resources].reverse()) {
    for (let i = (resource.operations?.length ?? 0) - 1; i >= 0 && Buffer.byteLength(line()) + 1 > 16384; i--) {
      resource.operations[i] = unavailable(resource.operations[i], "byte-limit");
      snapshot.receivedProjectionComplete = false;
    }
  }
  return Buffer.byteLength(line()) + 1 <= 16384
    ? line()
    : prefix +
        JSON.stringify({
          schema: 1,
          receivedProjectionComplete: false,
          controlStorageCompleteness: "unverified",
          detailUnavailable: "byte-limit",
        });
}

/** Closed producer projection; consumer schema is never a producer acknowledgement. */
function deployProducerDiagnostic(payload) {
  const data = payload?.deployDiagnostic;
  const valid =
    data?.schema === 1 &&
    typeof data.producer?.build === "string" &&
    /^[a-f0-9]{7,40}(?:@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(data.producer.build) &&
    typeof data.producer.workerVersion === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.producer.workerVersion) &&
    ["retained", "withdrawn"].includes(data.fenceDisposition) &&
    ["reported", "unavailable"].includes(data.admissionReadback);
  return valid
    ? {
        producer: { state: "reported", build: data.producer.build, workerVersion: data.producer.workerVersion },
        fenceDisposition: data.fenceDisposition,
      }
    : { producer: { state: "unverified" }, fenceDisposition: "unavailable" };
}

/** The global permit is a request obligation, separate from native journals.
 * Only already-returned metadata is projected; age never proves settlement. */
function deployAdmissionDiagnostic(fetched) {
  if (fetched?.ok !== true) return null;
  const readback = fetched.payload?.admissionReadback;
  if (
    fetched.payload?.activeAdmissions === 0 &&
    (!readback ||
      (readback.observedActiveCount === 0 &&
        Array.isArray(readback.rows) &&
        readback.rows.length === 0 &&
        readback.omittedCount === 0))
  )
    return null;
  const prefix = "[resident-deploy-admission-diagnostic] ";
  const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const integer = (v) => Number.isSafeInteger(v) && v >= 0;
  const nullable = (v, check) => v === null || check(v);
  const identity = (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
  const unavailable = (v, reason) => ({
    ...(uuid(v?.id) ? { id: v.id } : {}),
    ...(integer(v?.startedAt) ? { startedAt: v.startedAt } : {}),
    detailUnavailable: reason,
  });
  const snapshot = {
    schema: 1,
    receivedProjectionComplete: false,
    storageObservation: "registry-permits-only",
    ...deployProducerDiagnostic(fetched.payload),
    gateActiveCount: Number.isSafeInteger(fetched.payload?.activeAdmissions) ? fetched.payload.activeAdmissions : null,
    fenceReady: typeof fetched.payload?.fenceReady === "boolean" ? fetched.payload.fenceReady : null,
    nativeOutcome: "unverified",
    requestEnd: "unobserved",
  };
  if (!Object.hasOwn(fetched.payload, "admissionReadback"))
    return prefix + JSON.stringify({ ...snapshot, detailUnavailable: "producer-field-absent" });
  if (readback === null) return prefix + JSON.stringify({ ...snapshot, detailUnavailable: "readback-unavailable" });
  if (!readback || typeof readback !== "object")
    return prefix + JSON.stringify({ ...snapshot, detailUnavailable: "malformed" });
  if (
    readback.schema !== 1 ||
    !integer(readback.observedAt) ||
    !integer(readback.observedActiveCount) ||
    !integer(readback.omittedCount) ||
    !Array.isArray(readback.rows) ||
    readback.rows.length > 25 ||
    readback.observedActiveCount !== readback.rows.length + readback.omittedCount
  )
    return prefix + JSON.stringify({ ...snapshot, detailUnavailable: "malformed" });
  const seen = new Set();
  const rows = readback.rows.slice(0, 5).map((v) => {
    if (!uuid(v?.id) || !integer(v?.startedAt) || seen.has(v.id)) return unavailable(v, "malformed");
    seen.add(v.id);
    if (v.schema !== 1) return unavailable(v, v.schema === undefined ? "legacy" : "malformed");
    if (v.kind === null || v.component === null) return unavailable(v, "incomplete");
    if (
      !["resident-call", "refresh-step", "fleet-lifecycle", "reconcile", "watchdog"].includes(v.kind) ||
      !["resident", "http", "workflow", "scheduler"].includes(v.component) ||
      !nullable(
        v.build,
        (x) =>
          typeof x === "string" && /^[a-f0-9]{7,40}(?:@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(x),
      ) ||
      !nullable(v.workerVersion, uuid) ||
      !nullable(
        v.resource,
        (x) => typeof x === "string" && /^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x) && x.length <= 63,
      ) ||
      !nullable(v.sourceId, identity) ||
      !nullable(v.traceId, (x) => typeof x === "string" && /^[a-f0-9]{32}$/.test(x) && !/^0+$/.test(x)) ||
      !nullable(v.requesterScope, (x) => ["admin", "operator", "read", "drain"].includes(x))
    )
      return unavailable(v, "malformed");
    return {
      id: v.id,
      schema: 1,
      startedAt: v.startedAt,
      kind: v.kind,
      component: v.component,
      build: v.build,
      workerVersion: v.workerVersion,
      resource: v.resource,
      sourceId: v.sourceId,
      traceId: v.traceId,
      requesterScope: v.requesterScope,
      requestEnd: "unobserved",
      nativeOutcome: "unverified",
      expiry: "none",
      lastProgress: "not-recorded",
      runIdentity: "not-recorded",
      actorIdentity: "not-recorded",
    };
  });
  const omittedCount = readback.omittedCount + readback.rows.length - rows.length;
  const countMatchesGate = readback.observedActiveCount === fetched.payload.activeAdmissions;
  const diagnostic = {
    ...snapshot,
    observedAt: readback.observedAt,
    observedActiveCount: readback.observedActiveCount,
    countMatchesGate,
    omittedCount,
    rows,
    receivedProjectionComplete: countMatchesGate && omittedCount === 0 && rows.every((v) => !v.detailUnavailable),
  };
  const line = prefix + JSON.stringify(diagnostic);
  return Buffer.byteLength(line) + 1 <= 8192
    ? line
    : prefix + JSON.stringify({ ...snapshot, detailUnavailable: "byte-limit" });
}

/**
 * The decision, pure. `fetched` is the result of `fetchResidents`.
 * @returns {{ allow: boolean, forced: boolean, busy: {resource:string,inFlight:number}[], provisioning: {resource:string,state:string}[], interrupting: {resource:string,state:string}[], unknown: {resource:string,error:string}[], message: string }}
 */
const ATTEMPT_FIELDS = ["id", "controllerId", "sourceCommit", "profileSha256", "configSha256", "deadline"];
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const sha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function validAttempt(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    uuid(value.holdId) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    uuid(value.id) &&
    typeof value.controllerId === "string" &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(value.controllerId) &&
    typeof value.sourceCommit === "string" &&
    /^[0-9a-f]{40}$/.test(value.sourceCommit) &&
    sha256(value.profileSha256) &&
    sha256(value.configSha256) &&
    Number.isSafeInteger(value.deadline) &&
    value.deadline > 0
  );
}

/** Consume the authenticated producer's decision without inferring request ending. */
function matchingMaintenance(receipt, attempt) {
  if (
    !validAttempt(attempt) ||
    !receipt ||
    receipt.schema !== 1 ||
    receipt.state !== "held" ||
    receipt.holdId !== attempt.holdId ||
    receipt.generation !== attempt.generation ||
    ATTEMPT_FIELDS.some((field) => receipt.attempt?.[field] !== attempt[field])
  )
    return false;
  return true;
}

/** A successor installer names the released predecessor; ordinary force cannot. */
function matchingReleasedPredecessor(receipt, previous, attempt) {
  if (
    !previous ||
    !validAttempt(attempt) ||
    !validAttempt({ ...previous.attempt, holdId: previous.holdId, generation: previous.generation }) ||
    !sha256(previous.policySha256) ||
    !sha256(previous.releaseDecisionSha256) ||
    !sha256(previous.decisionSha256) ||
    !sha256(previous.fixtureSha256) ||
    !uuid(previous.request?.id) ||
    !Number.isSafeInteger(previous.request?.startedAt) ||
    previous.request.startedAt < 0 ||
    !sha256(previous.request?.recordSha256) ||
    !Number.isSafeInteger(previous.releasedAt) ||
    previous.releasedAt < 0 ||
    attempt.generation !== previous.generation + 1 ||
    attempt.holdId === previous.holdId ||
    attempt.id === previous.attempt.id ||
    attempt.sourceCommit === previous.attempt.sourceCommit
  )
    return false;
  return (
    receipt?.schema === 1 &&
    receipt.state === "released" &&
    receipt.holdId === previous.holdId &&
    receipt.generation === previous.generation &&
    receipt.fixtureSha256 === previous.fixtureSha256 &&
    receipt.decisionSha256 === previous.decisionSha256 &&
    receipt.releasedAt === previous.releasedAt &&
    receipt.releaseDecisionSha256 === previous.releaseDecisionSha256 &&
    ATTEMPT_FIELDS.every((key) => receipt.attempt?.[key] === previous.attempt[key]) &&
    (receipt.policySha256 === undefined || receipt.policySha256 === previous.policySha256) &&
    ["unverified", "expired"].includes(receipt.window?.state) &&
    (receipt.window.recordedState === undefined || receipt.window.recordedState === "completed") &&
    receipt.window.recordId === previous.request.id &&
    receipt.window.originalRecordSha256 === previous.request.recordSha256 &&
    receipt.window.decisionSha256 === previous.decisionSha256 &&
    receipt.window.disposition === "operator-abandoned" &&
    receipt.window.requestEnd === "unobserved" &&
    receipt.window.nativeOutcome === "unverified" &&
    receipt.window.stored === 1 &&
    receipt.window.excluded === 0 &&
    receipt.window.blocking === 1
  );
}

function qualifiedMaintenance(receipt, attempt, active) {
  if (!matchingMaintenance(receipt, attempt)) return false;
  const window = receipt.window;
  return (
    window?.state === "fenced" &&
    window.disposition === "operator-abandoned" &&
    window.requestEnd === "unobserved" &&
    window.nativeOutcome === "unverified" &&
    uuid(window.recordId) &&
    sha256(window.originalRecordSha256) &&
    sha256(window.decisionSha256) &&
    Number.isSafeInteger(window.observedAt) &&
    window.observedAt >= 0 &&
    window.observedAt < attempt.deadline &&
    Number.isSafeInteger(window.stored) &&
    Number.isSafeInteger(window.blocking) &&
    window.blocking >= 0 &&
    window.excluded === 1 &&
    window.stored === window.blocking + 1 &&
    active === window.blocking
  );
}

export function decide(
  fetched,
  {
    force = false,
    attempt,
    bootstrapPreviousWorkerVersion,
    bootstrapResources,
    bootstrapReserveMs,
    bootstrapPredecessor,
    now,
  } = {},
) {
  const successorBootstrap =
    bootstrapPreviousWorkerVersion !== undefined &&
    Number.isSafeInteger(now) &&
    now >= bootstrapPredecessor?.releasedAt &&
    matchingReleasedPredecessor(fetched?.payload?.stagingMaintenance, bootstrapPredecessor, attempt);
  if (attempt && fetched?.ok !== true) force = false;
  if (
    fetched?.payload?.stagingMaintenance &&
    !matchingMaintenance(fetched.payload.stagingMaintenance, attempt) &&
    !successorBootstrap
  )
    force = false;
  const busy = [];
  const provisioning = [];
  const interrupting = [];
  const unknown = [];
  const problems = [];
  if (bootstrapPreviousWorkerVersion !== undefined) {
    const producer = deployProducerDiagnostic(fetched?.payload).producer;
    if (
      !force ||
      !validAttempt(attempt) ||
      !uuid(fetched?.payload?.draining?.swapVersion) ||
      fetched.payload.draining.swapVersion !== bootstrapPreviousWorkerVersion ||
      (fetched.payload.deployDiagnostic !== undefined &&
        (producer.state !== "reported" || producer.workerVersion !== bootstrapPreviousWorkerVersion))
    ) {
      force = false;
      problems.push("selected staging bootstrap Worker version changed or is unverified");
    }
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(bootstrapReserveMs) ||
      bootstrapReserveMs <= 0 ||
      attempt?.deadline - now < bootstrapReserveMs
    ) {
      force = false;
      problems.push("selected staging bootstrap upload reserve is exhausted or unverified");
    }
  }
  if (bootstrapPredecessor !== undefined && !successorBootstrap) {
    force = false;
    problems.push("selected staging successor predecessor is unverified");
  }
  let retained = 0;

  if (!fetched || fetched.ok !== true) {
    problems.push(`resident Worker not consulted: ${fetched?.error ?? "unknown error"}`);
  } else {
    const maintenance = fetched.payload?.stagingMaintenance;
    if (attempt || maintenance) {
      if (!qualifiedMaintenance(maintenance, attempt, fetched.payload?.activeAdmissions))
        problems.push("selected staging maintenance or deployment attempt is unverified");
    }
    const drain = fetched.payload?.draining;
    if (
      drain?.swapFence !== true ||
      typeof drain.since !== "string" ||
      typeof drain.until !== "string" ||
      !Number.isFinite(Date.parse(drain.since)) ||
      !Number.isFinite(Date.parse(drain.until)) ||
      Date.parse(drain.until) <= Date.parse(drain.since)
    ) {
      const disposition = deployProducerDiagnostic(fetched.payload).fenceDisposition;
      problems.push(
        drain?.swapFence === false && fetched.payload?.fenceReady === false && disposition === "withdrawn"
          ? "deploy fence was withdrawn after the activity check refused upload"
          : "deploy fence is missing or invalid (registered owners may reattach)",
      );
    }
    const activeAdmissions = fetched.payload?.activeAdmissions;
    if (!Number.isSafeInteger(activeAdmissions) || activeAdmissions < 0)
      problems.push("deploy admission count is missing or invalid");
    else if (activeAdmissions > 0)
      problems.push(`${activeAdmissions} resident operation(s) admitted before the fence remain active`);
    if (fetched.payload?.fenceReady !== true)
      problems.push(
        "deploy fence is not ready: activity, owner evidence or time is insufficient for upload and readiness",
      );
    const residents = fetched.payload?.residents;
    if (!Array.isArray(residents)) {
      problems.push("resident Worker answered without a `residents` array (malformed /residents payload)");
    } else {
      for (const r of residents) {
        const resource =
          typeof r?.resource === "string" &&
          r.resource.length <= 63 &&
          /^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.resource)
            ? r.resource
            : "<unnamed resident>";
        const live = r?.live;
        if (!live || typeof live !== "object" || typeof live.error === "string") {
          unknown.push({ resource, error: "resident-view-unavailable" });
        } else if (typeof live.inFlight !== "number") {
          unknown.push({
            resource,
            error: "live view carries no inFlight count",
          });
        } else if (!Number.isInteger(live.inFlight) || live.inFlight < 0) {
          // A count that is not a non-negative integer can only come from a
          // counter bug (double release, unmatched decrement). We cannot tell
          // idle from busy, so it is unknown — never an implicit "0 busy".
          unknown.push({ resource, error: `live view carries an impossible inFlight=${live.inFlight} (counter bug)` });
        } else if (
          typeof live.runsInFlight !== "number" ||
          !Number.isInteger(live.runsInFlight) ||
          live.runsInFlight < 0
        ) {
          unknown.push({
            resource,
            error: `live view carries an impossible runsInFlight=${typeof live.runsInFlight === "number" ? live.runsInFlight : "invalid"} (counter bug)`,
          });
        } else if (
          ![live.executingRuns, live.retainedRuns, live.unknownRuns].every(
            (count) => Number.isSafeInteger(count) && count >= 0,
          )
        ) {
          unknown.push({ resource, error: "deploy activity counts are missing or invalid" });
        } else if (live.executingRuns + live.retainedRuns + live.unknownRuns < live.runsInFlight) {
          // A thread operation may overlap a retained registration, so the
          // categorized total can exceed the deduplicated operator count.
          // Fewer categorized claims than that count means work went unseen.
          unknown.push({ resource, error: "deploy activity misses a protected run or operation" });
        } else if (live.unknownRuns > 0) {
          unknown.push({
            resource,
            error: `${live.unknownRuns} run/operation hold(s) unverified; registration readback: ${registrationReadbackText(live.registrationReadback)}${live.nativeOperationReadback ? `; operation readback: ${nativeOperationReadbackText(live.nativeOperationReadback)}` : ""}`,
          });
        } else {
          retained += live.retainedRuns;
          // The fenced read separates executing work from terminal registrations
          // whose workspaces remain protected. The old runsInFlight count still
          // includes those registrations for cleanup and operator visibility.
          const runs = live.executingRuns;
          if (runs > 0) busy.push({ resource, inFlight: runs });
          if (PROVISIONING_STATES.has(live.state)) {
            // Provisioning is mid-flight. An isolate swap kills it just like a
            // thread run (seen live: `build-failed: exit 143: Session
            // terminated` right after a deploy that passed the inFlight
            // check), and unlike a refresh it cannot resume.
            provisioning.push({ resource, state: live.state });
          } else if (INTERRUPTIBLE_STATES.has(live.state)) {
            interrupting.push({ resource, state: live.state });
          } else if (!SETTLED_STATES.has(live.state)) {
            // A state this script does not know: fail closed rather than assume settled.
            unknown.push({
              resource,
              error: "live view carries an unrecognized state (vocabulary drift — update preflight.mjs)",
            });
          }
        }
      }
      if (busy.length)
        problems.push(`in flight: ${busy.map((b) => `${b.resource} (${b.inFlight} in flight)`).join(", ")}`);
      if (provisioning.length)
        problems.push(
          `provisioning: ${provisioning.map((m) => `${m.resource} (${m.state})`).join(", ")} — the provision would be killed and only a rebuild recovers it`,
        );
      if (unknown.length)
        problems.push(`unknown state: ${unknown.map((u) => `${u.resource} (${u.error})`).join(", ")}`);
    }
  }

  if (bootstrapPreviousWorkerVersion !== undefined) {
    const body = fetched?.payload;
    const drain = body?.draining;
    const residents = body?.residents;
    if (
      !Array.isArray(bootstrapResources) ||
      bootstrapResources.length === 0 ||
      new Set(bootstrapResources).size !== bootstrapResources.length ||
      bootstrapResources.some(
        (resource) => typeof resource !== "string" || !/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resource),
      ) ||
      !Array.isArray(residents) ||
      new Set(residents.map((row) => row?.residentId ?? row?.resource)).size !== residents.length ||
      residents.some(
        (row) =>
          !bootstrapResources.includes(row?.resource) ||
          (successorBootstrap
            ? ![row?.live?.inFlight, row?.live?.runsInFlight].every(
                (count) => Number.isSafeInteger(count) && count >= 0,
              )
            : row?.live?.inFlight !== 0 || row?.live?.runsInFlight !== 0),
      ) ||
      bootstrapResources.some((resource) => !residents.some((row) => row?.resource === resource)) ||
      !Number.isSafeInteger(body?.activeAdmissions) ||
      body.activeAdmissions < 0 ||
      body.activeAdmissions > 1 ||
      (successorBootstrap
        ? body.activeAdmissions !== 1 || body.fenceReady !== false || drain?.swapFence !== false
        : body.stagingMaintenance != null) ||
      typeof body?.fenceReady !== "boolean" ||
      typeof drain?.swapFence !== "boolean" ||
      typeof drain?.since !== "string" ||
      typeof drain?.until !== "string" ||
      !Number.isFinite(Date.parse(drain?.since)) ||
      !Number.isFinite(Date.parse(drain?.until)) ||
      Date.parse(drain.until) <= Date.parse(drain.since) ||
      busy.length ||
      provisioning.length ||
      interrupting.length ||
      unknown.length
    ) {
      force = false;
      problems.push("selected staging bootstrap fixture or fence evidence is incomplete");
    }
  }

  // Interruptible cycles never refuse; they are named so the log says what the
  // swap interrupts and why that is fine.
  const warningText = interrupting.length
    ? ` — WARNING: mid-cycle: ${interrupting.map((m) => `${m.resource} (${m.state})`).join(", ")} — the isolate swap interrupts it; the refresh instance retries the step from its checkpoints, a restore is retried by the next hydrate (resident-repos items 44/61)`
    : "";

  if (problems.length === 0) {
    const count = fetched.payload.residents.length;
    return {
      allow: true,
      forced: false,
      busy,
      provisioning,
      interrupting,
      unknown,
      message: `preflight ok: ${count} residents, no resident has work in flight or a provision running; ${retained} retained terminal registration(s) remain protected${warningText}`,
    };
  }
  const detail = problems.map((p) => `  - ${p}`).join("\n");
  if (force) {
    return {
      allow: true,
      forced: true,
      busy,
      provisioning,
      interrupting,
      unknown,
      message: `preflight WARNING: deploying by force despite —\n${detail}\n  in-flight runs and provisions on the residents above WILL be killed (process handles invalidated by the isolate swap)${warningText}`,
    };
  }
  const hints = [HOW_TO_FORCE];
  if (fetched?.ok !== true) hints.unshift(HOW_TO_SET_TOKEN);
  return {
    allow: false,
    forced: false,
    busy,
    provisioning,
    interrupting,
    unknown,
    message: `preflight REFUSED: a Worker deploy swaps every ResidentDO isolate and kills in-flight runs and provisions —\n${detail}\n  wait for them to finish and retry; ${hints.join("; ")}${warningText}`,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, { clock = deploymentClock } = {}) {
  const force = argv.includes("--force") || env.RESIDENT_DEPLOY_FORCE === "1";
  const baseUrl = env[BASE_URL_ENV];
  if (!baseUrl) {
    console.error(
      `[resident-preflight] ${BASE_URL_ENV} is not set — the resident Worker's origin comes from the deployment profile; deploy through \`npm run cli -- deploy all\` (it sets it), or set it to https://<resident hostname> to run this alone`,
    );
    return 2;
  }
  let attempt;
  if (env.RESIDENT_DEPLOY_ATTEMPT !== undefined) {
    try {
      attempt = JSON.parse(env.RESIDENT_DEPLOY_ATTEMPT);
      if (!validAttempt(attempt)) throw new Error("invalid attempt");
    } catch {
      console.error("[resident-preflight] selected staging deployment attempt is invalid");
      return 2;
    }
  }
  const fetched = await fetchResidents(baseUrl, readToken(env), { attempt });
  const d = decide(fetched, {
    force,
    attempt,
    bootstrapPreviousWorkerVersion: env.RESIDENT_BOOTSTRAP_PREVIOUS_VERSION,
    bootstrapReserveMs: Number(env.RESIDENT_BOOTSTRAP_UPLOAD_RESERVE_MS),
    bootstrapPredecessor: (() => {
      if (env.RESIDENT_BOOTSTRAP_PREDECESSOR === undefined) return undefined;
      try {
        return JSON.parse(env.RESIDENT_BOOTSTRAP_PREDECESSOR);
      } catch {
        return null;
      }
    })(),
    now: env.RESIDENT_BOOTSTRAP_PREVIOUS_VERSION === undefined ? undefined : clock(),
    bootstrapResources: (() => {
      try {
        return JSON.parse(env.RESIDENT_BOOTSTRAP_RESOURCES ?? "null");
      } catch {
        return null;
      }
    })(),
  });
  if (qualifiedMaintenance(fetched.payload?.stagingMaintenance, attempt, fetched.payload?.activeAdmissions)) {
    const receipt = fetched.payload.stagingMaintenance;
    console.log(
      "[resident-staging-maintenance] " +
        JSON.stringify({
          holdId: receipt.holdId,
          generation: receipt.generation,
          attemptId: receipt.attempt.id,
          sourceCommit: receipt.attempt.sourceCommit,
          ...receipt.window,
        }),
    );
  }
  if (!d.allow) {
    try {
      const diagnostic = deployAdmissionDiagnostic(fetched);
      if (diagnostic) console.error(diagnostic);
    } catch {
      /* Diagnostic failure cannot change deployment admission. */
    }
    try {
      const diagnostic = nativeOperationDiagnostic(fetched);
      if (diagnostic) console.error(diagnostic);
    } catch {
      /* Diagnostic failure cannot change deployment admission. */
    }
  }
  (d.allow && !d.forced ? console.log : console.error)(`[resident-preflight] ${d.message}`);
  return d.allow ? 0 : 1;
}

// Run only when executed directly (`node preflight.mjs`), not when imported by tests.
// pathToFileURL, not `file://${argv[1]}`, so the guard also holds on Windows paths.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
