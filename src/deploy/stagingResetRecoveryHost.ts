import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { MINUTE_MS } from "../core/budgets.js";
import { systemClock } from "../core/trace/clock.js";
import { MaintenanceService, WorkerMaintenanceStore } from "../core/maintenance.js";
import { RUN_STORE_KEY } from "../core/runStoreConstants.js";
import { importCredentialKey, openCredential, sealCredential } from "../mcp/sealed.js";
import { authenticateResetCredentials, settingsTransferSchema } from "./installationSettings.js";
import { installationResetPlan, resetDigest } from "./installationReset.js";
import { ResetCloudflare, resetHostingSettings } from "./resetCloudflare.js";
import { resetEndpointSettings } from "./resetHosting.js";
import { LIVE_GATE_POLL_MS } from "./liveGate.js";
import { ResetJournal } from "./resetJournal.js";
import type { DeploymentProfile } from "./profile.js";
import {
  StagingResetRecoveryRefusal,
  type StagingResetRecoveryIO,
  type StagingResetRecoveryRequest,
} from "./stagingResetRecovery.js";

const object = z.record(z.string(), z.unknown());
const envelope = z
  .object({ serverId: z.string(), keyId: z.string(), sealed: z.string(), updatedAt: z.number() })
  .strict();
const bucket = z.object({
  name: z.string(),
  objects: z.array(z.object({ key: z.string(), size: z.number().int().nonnegative(), etag: z.string() })),
});
const nativePlan = z
  .object({
    schema: z.literal(1),
    account: z.string(),
    deletions: z.array(
      z.object({ kind: z.enum(["application", "workflow", "worker"]), name: z.string(), path: z.string() }),
    ),
    evidence: z.unknown(),
    sha256: z.string(),
  })
  .strict();
const preservationSchema = z
  .object({
    operation: z.string(),
    plan: z
      .object({
        schema: z.literal(1),
        native: nativePlan,
        settingsSha256: z.string(),
        hostingSha256: z.string(),
        journalBucket: z.string(),
        buckets: z.array(bucket),
        objects: z
          .array(
            z.object({
              namespace: z.string(),
              class: z.string(),
              objects: z.array(z.object({ id: z.string(), hasStoredData: z.boolean() })),
            }),
          )
          .optional(),
        retained: z.array(z.string()),
        sha256: z.string(),
      })
      .strict(),
    settings: settingsTransferSchema,
    repositories: z.object({ schema: z.literal(1), records: z.array(object) }).strict(),
    hosting: z.object({
      settings: z.record(z.string(), object),
      applications: z.array(object),
      endpoints: z.record(
        z.string(),
        z.object({ domains: z.array(object), schedules: z.array(z.string()), subdomain: z.unknown() }),
      ),
    }),
  })
  .strict();
const nativeEvidence = z
  .object({
    profile: z.unknown(),
    source: z.object({ commit: z.string() }).passthrough(),
    namespaces: z.array(z.object({ id: z.string() }).passthrough()).min(1),
    applications: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()).length(3),
  })
  .passthrough();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: unknown, b: unknown, message: string) => {
  if (!isDeepStrictEqual(a, b)) throw new StagingResetRecoveryRefusal("evidence-mismatch", message);
};

/** Response metadata only. Remote payloads and credentials never enter failure receipts. */
export class StagingResetRecoveryBoundaryError extends Error {
  constructor(
    readonly diagnostic: { stage: string; httpStatus: number | null; requestId: string | null; keySha256?: string },
    cause?: unknown,
  ) {
    super("staging reset recovery boundary is unverified", { cause });
    this.name = "StagingResetRecoveryBoundaryError";
  }
}

export function createStagingResetRecoveryIO(options: {
  request: StagingResetRecoveryRequest;
  profile: DeploymentProfile;
  repository: string;
  stagingAccount: string;
  productionAccount: string;
  cloudflareToken: string;
  githubToken: string;
  secrets: { MEMORY_TOKEN: string; RESIDENT_ADMIN_TOKEN: string; MCP_CREDENTIAL_KEY: string; SANDBOX_TOKEN: string };
  previewText?: string;
  receipt(value: Record<string, unknown>): void;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): StagingResetRecoveryIO {
  const { request, profile, secrets } = options;
  if (
    profile.account !== options.stagingAccount ||
    profile.account === options.productionAccount ||
    !profile.workers.memory ||
    !profile.workers.resident ||
    !profile.workers.sandbox ||
    !profile.artifacts
  )
    throw new StagingResetRecoveryRefusal(
      "evidence-mismatch",
      "recovery requires the isolated four-Worker staging profile",
    );
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? systemClock;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const prefix = `runs/${request.originalRun}/${request.operation}`;
  const recoveryPrefix = `${prefix}/recovery/${request.recoveryId}`;
  let writing: { putAttempted: boolean; keySha256: string } | undefined;
  const metadata = (stage: string, response: Response) => {
    const id = response.headers.get("cf-ray") ?? response.headers.get("x-github-request-id");
    return {
      stage,
      httpStatus: response.status,
      requestId:
        id && /^(?:[a-f0-9]{16,32}(?:-[a-z]{3})?|[A-F0-9]{4,16}(?::[A-F0-9]{1,16}){1,8})$/i.test(id) ? id : null,
      ...(writing && stage.startsWith("journal-") ? { keySha256: writing.keySha256 } : {}),
    };
  };
  const fetchResponse = async (stage: string, url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("user-agent", "switchboard-staging-reset-recovery");
    try {
      return await fetcher(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(MINUTE_MS) });
    } catch (error) {
      throw new StagingResetRecoveryBoundaryError(
        {
          stage,
          httpStatus: null,
          requestId: null,
          ...(writing && stage.startsWith("journal-") ? { keySha256: writing.keySha256 } : {}),
        },
        error,
      );
    }
  };
  const call = async (stage: string, url: string, init: RequestInit = {}, allowAbsent = false) => {
    const response = await fetchResponse(stage, url, init);
    if (!response.ok && !(allowAbsent && response.status === 404))
      throw new StagingResetRecoveryBoundaryError(metadata(stage, response));
    return response;
  };
  const native = new ResetCloudflare(profile.account, options.cloudflareToken, (input, init) => {
    const url = new URL(String(input));
    const journalObject = url.pathname.includes(`/r2/buckets/${profile.workers.memory!.script}-reset-journal/objects/`);
    const put = init?.method === "PUT";
    if (journalObject && put && writing) writing.putAttempted = true;
    const stage = journalObject
      ? put
        ? "journal-put"
        : writing
          ? writing.putAttempted
            ? "journal-readback"
            : "journal-absence"
          : "journal-read"
      : "native-read";
    const oldUnknownKey = [
      [1, "verification-intent"],
      [2, "original-intent-observed"],
    ].some(([sequence, phase]) =>
      url.pathname.endsWith(`/${recoveryPrefix}/${String(sequence).padStart(2, "0")}-${phase}.sealed.json`),
    );
    return call(stage, url.href, init, stage === "journal-absence" || (stage === "journal-read" && oldUnknownKey));
  });
  const key = importCredentialKey(secrets.MCP_CREDENTIAL_KEY);
  const journal = new ResetJournal(
    native,
    profile.workers.memory.script,
    Object.values(profile.workers).map((w) => w.script),
    key,
  );

  let original: z.infer<typeof preservationSchema> | undefined;
  let old: z.infer<typeof nativeEvidence> | undefined;
  let origins: Set<string> | undefined;
  const github = async (path: string) =>
    (
      await call("github-read", `https://api.github.com/repos/${options.repository}/${path}`, {
        headers: { authorization: `Bearer ${options.githubToken}`, accept: "application/vnd.github+json" },
      })
    ).json();
  const service = async (kind: keyof typeof profile.workers, path: string, body?: object) => {
    if (!original || !origins)
      throw new StagingResetRecoveryRefusal("evidence-mismatch", "original reset custody is unverified");
    const origin = `https://${profile.workers[kind]!.hostname}`;
    if (!origins.has(origin))
      throw new StagingResetRecoveryRefusal("evidence-mismatch", "recovery service ownership differs");
    const token = {
      memory: secrets.MEMORY_TOKEN,
      resident: secrets.RESIDENT_ADMIN_TOKEN,
      sandbox: secrets.SANDBOX_TOKEN,
      bot: undefined,
    }[kind];
    const text = body === undefined ? undefined : JSON.stringify(body);
    const response = await call(
      body && "action" in body && body.action === "verify" ? "settings-verify" : "service-read",
      origin + path,
      {
        method: text === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(text ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } : {}),
        },
        body: text,
      },
    );
    return response.json();
  };
  const memory = (path: string, body: object) => service("memory", path, body);
  const status = () =>
    memory("/installation-reset/settings", { action: "status", installations: original!.settings.installations });
  return {
    now,
    receipt: options.receipt,
    token: async () => {
      const path =
        request.credentialKind === "user" ? "/user/tokens/verify" : `/accounts/${profile.account}/tokens/verify`;
      const response = await call("token-identity", `https://api.cloudflare.com/client/v4${path}`, {
        headers: { authorization: `Bearer ${options.cloudflareToken}` },
      });
      const body = z
        .object({
          success: z.literal(true),
          result: z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), status: z.literal("active") }),
        })
        .parse(await response.json());
      return { kind: request.credentialKind, ...body.result };
    },
    original: async () => {
      same((await journal.inspect()).status, "owned", "original journal owner differs");
      const records = (await journal.list(String(request.originalRun))).filter((row) =>
        row.key.startsWith(`${prefix}/`),
      );
      const expected = new Set([
        `${prefix}/settings.sealed.json`,
        ...Array.from(
          { length: request.heldSequence },
          (_, i) => `${prefix}/journal/${String(i + 1).padStart(8, "0")}.sealed.json`,
        ),
      ]);
      if (records.length !== expected.size || records.some((row) => !expected.has(row.key)))
        throw new StagingResetRecoveryRefusal(
          "evidence-mismatch",
          "original journal roster differs; do not repeat recovery",
        );
      const heldText = await journal.read(
        `${prefix}/journal/${String(request.heldSequence).padStart(8, "0")}.sealed.json`,
      );
      const heldSealed = envelope.parse(JSON.parse(heldText));
      same(
        heldSealed.serverId,
        `installation-reset:${profile.account}:${request.operation}:${request.planSha256}:journal:${request.heldSequence}`,
        "original held seal differs",
      );
      const held = z
        .object({
          entry: z
            .object({
              operation: z.string(),
              planSha256: z.string(),
              sequence: z.number(),
              phase: z.literal("held"),
              resetOutcome: z.literal("unknown"),
              maintenance: z.literal("retained"),
              controller: z.object({ run: z.string(), commit: z.string() }),
            })
            .passthrough(),
          journal: z.string(),
        })
        .parse(JSON.parse(await openCredential(key, heldSealed)));
      same(
        [
          held.entry.operation,
          held.entry.planSha256,
          held.entry.sequence,
          held.entry.controller.run,
          held.entry.controller.commit,
        ],
        [
          request.operation,
          request.planSha256,
          request.heldSequence,
          String(request.originalRun),
          request.originalCommit,
        ],
        "original held controller differs",
      );
      const preservedText = await journal.read(`${prefix}/settings.sealed.json`);
      const preservedSealed = envelope.parse(JSON.parse(preservedText));
      same(
        preservedSealed.serverId,
        `installation-reset:${profile.account}:${request.operation}:${request.planSha256}`,
        "original settings seal differs",
      );
      const preserved = preservationSchema.parse(JSON.parse(await openCredential(key, preservedSealed)));
      same(preserved.operation, request.operation, "original preservation operation differs");
      const reconstructed = installationResetPlan(preserved.plan);
      same(reconstructed.sha256, request.planSha256, "authenticated reset plan differs");
      same(preserved.plan.sha256, request.planSha256, "stored reset plan differs");
      same(preserved.plan.journalBucket, journal.bucket, "original journal bucket differs");
      const evidence = nativeEvidence.parse(preserved.plan.native.evidence);
      same(preserved.plan.native.account, profile.account, "original native account differs");
      same(evidence.profile, JSON.parse(JSON.stringify(profile)), "original hosting profile differs");
      same(evidence.source.commit, request.originalCommit, "original source differs");
      same(
        resetDigest({ settings: preserved.settings, repositories: preserved.repositories }),
        preserved.plan.settingsSha256,
        "preserved settings digest differs",
      );
      same(
        resetDigest({
          ...resetHostingSettings(preserved.hosting.settings, preserved.hosting.applications),
          endpoints: resetEndpointSettings(preserved.hosting.endpoints),
        }),
        preserved.plan.hostingSha256,
        "preserved hosting digest differs",
      );
      await authenticateResetCredentials(preserved.settings, secrets.MCP_CREDENTIAL_KEY);
      same(
        preserved.plan.buckets.map((b) => b.name).sort(),
        [profile.artifacts!.bucket, `${profile.workers.resident!.script}-cache`].sort(),
        "original application buckets differ",
      );
      const prior = [];
      for (const [sequence, phase] of [
        [1, "verification-intent"],
        [2, "original-intent-observed"],
      ] as const) {
        const response = await native.response(
          `/accounts/${profile.account}/r2/buckets/${journal.bucket}/objects/${recoveryPrefix}/${String(sequence).padStart(2, "0")}-${phase}.sealed.json`,
        );
        same(response.status, 404, "prior unknown recovery intent is present or unreadable");
        prior.push({ ...request.priorWrites[sequence - 1], sequence, phase, readStatus: 404 });
      }
      const maintenance = preserved.settings.config.tables.documents.filter((row) => row.key === "maintenance");
      same(maintenance.length, 1, "original maintenance row differs");
      original = preserved;
      old = evidence;
      origins = await native.serviceOrigins(profile);
      return {
        account: profile.account,
        operation: preserved.operation,
        planSha256: preserved.plan.sha256,
        originalRun: request.originalRun,
        originalCommit: evidence.source.commit,
        heldSequence: held.entry.sequence,
        heldPhase: held.entry.phase,
        resetOutcome: held.entry.resetOutcome,
        maintenance: { version: maintenance[0].version, ...JSON.parse(String(maintenance[0].body)) },
        settingsSha256: preserved.plan.settingsSha256,
        hostingSha256: preserved.plan.hostingSha256,
        installations: preserved.settings.installations,
        applications: evidence.applications.length,
        heldSha256: digest(heldText),
        preservationSha256: digest(preservedText),
        priorWrites: prior,
        workflow: await github(`actions/runs/${request.originalRun}`),
      };
    },
    history: async (currentRunId) => {
      const deadline = now() + MINUTE_MS;
      let previous: string | undefined;
      let announced: string | undefined;
      while (now() < deadline) {
        const rows: { id: number; display_title: string; run_attempt: number }[] = [];
        let total: number | undefined;
        let complete = true;
        for (let page = 1; page <= 10; page++) {
          if (now() >= deadline) {
            complete = false;
            break;
          }
          const data = z
            .object({
              total_count: z.number().int().nonnegative(),
              workflow_runs: z.array(
                z.object({
                  id: z.number().int().positive(),
                  display_title: z.string(),
                  run_attempt: z.number().int().positive(),
                }),
              ),
            })
            .parse(
              await github(
                `actions/workflows/recover-staging-reset.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`,
              ),
            );
          rows.push(...data.workflow_runs);
          const scoped = rows.filter((run) =>
            run.display_title.startsWith(`staging reset recovery continue ${request.operation} `),
          );
          if (scoped.some((run) => run.id !== currentRunId || run.run_attempt !== 1))
            throw new StagingResetRecoveryRefusal(
              "duplicate-continuation",
              "this recovery continuation was already requested",
            );
          if (total !== undefined && total !== data.total_count) {
            complete = false;
            break;
          }
          total = data.total_count;
          if (data.workflow_runs.length < 100) break;
        }
        complete = complete && rows.length === total && new Set(rows.map((run) => run.id)).size === rows.length;
        const current = rows.find((run) => run.id === currentRunId);
        const currentSeen =
          current?.display_title === `staging reset recovery continue ${request.operation} ${request.recoveryId}`;
        const fingerprint = complete && currentSeen ? resetDigest([...rows].sort((a, b) => a.id - b.id)) : undefined;
        const stable = fingerprint !== undefined && previous === fingerprint;
        const state = stable
          ? "stable"
          : complete && currentSeen
            ? "observed"
            : complete
              ? "waiting-current"
              : "incomplete";
        if (state !== announced) {
          console.info(
            JSON.stringify({
              event: "staging.reset.recovery.history_observed",
              operation: request.operation,
              recoveryId: request.recoveryId,
              currentRunId,
              state,
              complete,
              currentSeen,
              count: rows.length,
            }),
          );
          announced = state;
        }
        if (stable) return rows;
        previous = fingerprint;
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(LIVE_GATE_POLL_MS, remaining));
      }
      throw new StagingResetRecoveryRefusal(
        "evidence-mismatch",
        "recovery history did not stabilize before the read deadline",
      );
    },
    preview: async () => {
      if (!request.preview || !options.previewText)
        throw new StagingResetRecoveryRefusal("evidence-mismatch", "approved preview is absent");
      same(digest(options.previewText), request.preview.sha256, "preview artifact digest differs");
      const run = await github(`actions/runs/${request.preview.run}`);
      same(
        [run.path, run.event, run.status, run.conclusion, run.run_attempt, run.display_title],
        [
          ".github/workflows/recover-staging-reset.yml",
          "workflow_dispatch",
          "completed",
          "success",
          1,
          `staging reset recovery preview ${request.operation} ${request.recoveryId}`,
        ],
        "preview workflow differs",
      );
      const receipt = z
        .object({ controller: z.object({ run: z.number(), commit: z.string(), actorId: z.number() }) })
        .passthrough()
        .parse(JSON.parse(options.previewText));
      same(
        [run.id, run.head_sha, run.actor?.id],
        [request.preview.run, receipt.controller.commit, receipt.controller.actorId],
        "preview artifact metadata differs",
      );
      same(receipt.controller.run, request.preview.run, "preview receipt run differs");
      return receipt;
    },
    observe: async () => {
      if (!original || !old)
        throw new StagingResetRecoveryRefusal("evidence-mismatch", "original preservation is not loaded");
      const [
        inventory,
        settings,
        saved,
        repositories,
        reset,
        maintenance,
        runs,
        history,
        residents,
        admissions,
        ...health
      ] = await Promise.all([
        native.inventory(profile),
        native.settings(profile),
        memory("/installation-reset/settings", { action: "preview", installations: original.settings.installations }),
        service("resident", "/installation-reset/settings", { action: "preview" }),
        status(),
        memory("/config/get", { key: "maintenance" }),
        memory("/runs/live", { storeKey: RUN_STORE_KEY }),
        memory("/runs/list", { storeKey: RUN_STORE_KEY, limit: 1 }),
        service("resident", "/residents"),
        service("resident", "/deploy-admissions"),
        ...(["memory", "resident", "bot", "sandbox"] as const).map((kind) => service(kind, "/healthz")),
      ]);
      const endpoints = Object.fromEntries(
        await Promise.all(
          Object.values(profile.workers).map(async (w) => {
            const [schedules, subdomain] = await Promise.all([
              native.request(`/accounts/${profile.account}/workers/scripts/${w.script}/schedules`),
              native.request(`/accounts/${profile.account}/workers/scripts/${w.script}/subdomain`),
            ]);
            return [
              w.script,
              {
                domains:
                  (inventory.dependencies[w.script].references &&
                    z.object({ domains: z.array(object).optional() }).parse(inventory.dependencies[w.script].references)
                      .domains) ||
                  [],
                schedules: z
                  .object({ schedules: z.array(z.object({ cron: z.string() })) })
                  .parse(schedules.result)
                  .schedules.map((s) => s.cron)
                  .sort(),
                subdomain: subdomain.result,
              },
            ];
          }),
        ),
      );
      await native.verifyRouting(profile, endpoints);
      const appNames = new Set(old.applications.map((a) => a.name));
      const apps = z
        .array(object)
        .parse(inventory.applications.result)
        .filter((a) => appNames.has(String(a.name)));
      const oldIds = new Set(old.applications.map((a) => a.id));
      const oldNamespaces = new Set(old.namespaces.map((n) => n.id));
      const buckets = await Promise.all(original.plan.buckets.map((b) => native.bucket(b.name)));
      const transfer = settingsTransferSchema.parse(saved);
      await authenticateResetCredentials(transfer, secrets.MCP_CREDENTIAL_KEY);
      const normalized = structuredClone(transfer);
      same(
        normalized.config.tables.documents.filter((r) => r.key === "maintenance").length,
        1,
        "current maintenance row differs",
      );
      normalized.config.tables.documents = normalized.config.tables.documents.map((r) =>
        r.key === "maintenance"
          ? original!.settings.config.tables.documents.find((row) => row.key === "maintenance")!
          : r,
      );
      const active = z
        .object({
          count: z.number().int().nonnegative(),
          residents: z.array(z.unknown()),
          inFlight: z.number().int().nonnegative(),
          inFlightUnknown: z.number().int().nonnegative(),
          reservedCount: z.number().int().nonnegative(),
          pendingReplicas: z.number().int().nonnegative(),
          draining: object.nullable(),
          stagingMaintenance: object.nullable(),
        })
        .parse(residents);
      const healthy = health.map((h) =>
        z
          .object({
            ok: z.boolean(),
            build: z.object({ commit: z.string() }),
            inFlight: z.number().optional(),
            draining: z.boolean().optional(),
          })
          .parse(h),
      );
      return {
        at: new Date(systemClock()).toISOString(),
        settingsSha256: resetDigest({ settings: transfer, repositories }),
        settingsExceptMaintenanceSha256: resetDigest({ settings: normalized, repositories }),
        hostingSha256: resetDigest({
          ...resetHostingSettings(settings, apps),
          endpoints: resetEndpointSettings(endpoints),
        }),
        oldNamespacesRemaining: z
          .array(object)
          .parse(inventory.namespaces.result)
          .filter((n) => oldNamespaces.has(String(n.id))).length,
        oldApplicationsRemaining: z
          .array(object)
          .parse(inventory.applications.result)
          .filter((a) => oldIds.has(String(a.id))).length,
        applications: apps.length,
        oldBucketKeysRemaining: original.plan.buckets.reduce(
          (sum, b, i) => sum + b.objects.filter((o) => buckets[i].objects.some((now) => now.key === o.key)).length,
          0,
        ),
        bucketObjects: buckets.reduce((sum, b) => sum + b.objects.length, 0),
        historyEntries: z.object({ items: z.array(z.unknown()) }).parse(history).items.length,
        liveRuns: z.object({ runs: z.array(z.unknown()) }).parse(runs).runs.length,
        inFlight: active.inFlight,
        inFlightUnknown: active.inFlightUnknown,
        reserved: active.reservedCount,
        pendingReplicas: active.pendingReplicas,
        residents: Math.max(active.count, active.residents.length),
        draining: active.draining !== null || active.stagingMaintenance !== null,
        admissions: z.object({ admissions: z.array(z.unknown()) }).parse(admissions).admissions.length,
        botInFlight: healthy[2].inFlight,
        botDraining: healthy[2].draining,
        health: Object.fromEntries(
          ["memory", "resident", "bot", "sandbox"].map((name, i) => [
            name,
            { ok: healthy[i].ok, commit: healthy[i].build.commit },
          ]),
        ),
        resetStatus: reset,
        maintenance: { version: maintenance.version, ...maintenance.document },
      };
    },
    record: async (sequence, phase, value) => {
      same((await journal.inspect()).status, "owned", "journal owner changed");
      const name = `${recoveryPrefix}/${String(sequence).padStart(2, "0")}-${phase}.sealed.json`;
      const sealed = await sealCredential(
        key,
        `installation-reset:${profile.account}:${request.operation}:${request.planSha256}:recovery:${request.recoveryId}:${sequence}`,
        JSON.stringify(value),
        systemClock(),
      );
      writing = { putAttempted: false, keySha256: digest(name) };
      try {
        const written = await journal.write(name, sealed);
        return { bucket: written.bucket, keySha256: digest(name), sha256: written.sha256, bytes: written.bytes };
      } finally {
        writing = undefined;
      }
    },
    verify: () =>
      memory("/installation-reset/settings", {
        action: "verify",
        operation: request.operation,
        installations: original!.settings.installations,
      }),
    end: async (expected) => {
      if (!original || !origins?.has(`https://${profile.workers.memory!.hostname}`))
        throw new StagingResetRecoveryRefusal("evidence-mismatch", "original maintenance custody is unverified");
      let responseMetadata: ReturnType<typeof metadata> | undefined;
      const store = new WorkerMaintenanceStore({
        baseUrl: `https://${profile.workers.memory!.hostname}`,
        token: secrets.MEMORY_TOKEN,
        fetch: async (url, init) => {
          const stage =
            new URL(String(url)).pathname === "/config/put" ? "maintenance-end-write" : "maintenance-end-read";
          const response = await fetchResponse(stage, String(url), init);
          responseMetadata = metadata(stage, response);
          return response;
        },
      });
      const owned = new MaintenanceService({
        store: {
          read: async () => {
            const current = await store.read();
            same(current, expected, "maintenance changed before its owned end");
            return current;
          },
          write: (version, document) => store.write(version, document),
        },
      });
      try {
        return await owned.end(request.maintenance.id, request.maintenance.actor);
      } catch (error) {
        if (error instanceof StagingResetRecoveryRefusal || error instanceof StagingResetRecoveryBoundaryError)
          throw error;
        if (responseMetadata) throw new StagingResetRecoveryBoundaryError(responseMetadata, error);
        throw error;
      }
    },
  };
}
