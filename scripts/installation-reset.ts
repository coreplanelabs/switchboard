import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { parseAppConfigText } from "../src/config.js";
import { MINUTE_MS } from "../src/core/budgets.js";
import { RUN_STORE_KEY } from "../src/core/runStoreConstants.js";
import { systemClock } from "../src/core/trace/clock.js";
import { importCredentialKey, sealCredential, openCredential } from "../src/mcp/sealed.js";
import { loadProfileOnHost, readConfigForPush } from "../src/deploy/run.js";
import { nativeInventoryRows } from "../src/deploy/stagingBootstrap.js";
import { planInstallationRecreation } from "../src/deploy/stagingRecreate.js";
import {
  installationResetPlan,
  resetInstallation,
  resetDigest,
  type InstallationResetPlan,
} from "../src/deploy/installationReset.js";
import {
  settingsTransferSchema,
  authenticateResetCredentials,
  type SettingsTransfer,
} from "../src/deploy/installationSettings.js";
import { ResetCloudflare, resetHostingSettings } from "../src/deploy/resetCloudflare.js";
import { initializeOnHost } from "./staging-initialize.js";
import { DEFAULT_SECRETS_DIR } from "../src/deploy/secrets.js";
import { ResetJournal } from "../src/deploy/resetJournal.js";
import { prepareResetSecrets } from "../src/deploy/resetSecrets.js";
import { resetEndpointSettings, type ResetHostingCapture } from "../src/deploy/resetHosting.js";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    plan: { type: "string" },
    apply: { type: "string" },
    receipt: { type: "string" },
    maintenance: { type: "string" },
    "prepare-secrets": { type: "boolean" },
    inspect: { type: "string" },
    output: { type: "string" },
    "seal-plan": { type: "boolean" },
    download: { type: "string" },
    "list-receipts": { type: "string" },
  },
});
if (
  !values.account ||
  (!values.plan && !values["prepare-secrets"] && !values.inspect && !values.download && !values["list-receipts"]) ||
  !process.env.SWITCHBOARD_DEPLOY_PROFILE
)
  throw new Error("reset requires --account, --plan and an explicit SWITCHBOARD_DEPLOY_PROFILE");
for (const path of [values.plan, values.receipt, values.output].filter((value): value is string => !!value)) {
  const local = relative(process.cwd(), resolve(path));
  if (local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)))
    throw new Error("reset plans and receipts must be outside the source checkout");
}
if (process.env.SWITCHBOARD_DEPLOY_FORCE || process.env.RESIDENT_DEPLOY_FORCE)
  throw new Error("reset refuses deployment force");
if (values.apply && (!values.receipt || !values.maintenance || !/^[a-f0-9]{64}$/.test(values.apply)))
  throw new Error("reset apply requires the plan hash, a new --receipt and the exact --maintenance episode");
if (
  values.apply &&
  (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    !["staging", "production"].includes(process.env.RESET_ENVIRONMENT ?? "") ||
    process.env.RESET_ACCOUNT !== values.account ||
    !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? ""))
)
  throw new Error("reset apply requires one original serialized installation-reset workflow");
if (
  !values.inspect &&
  !values.download &&
  !values["list-receipts"] &&
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
)
  throw new Error("reset requires a clean source checkout");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const { profile } = await loadProfileOnHost();
if (profile.account !== values.account) throw new Error("reset account does not match the explicit profile");
if (values["prepare-secrets"]) {
  prepareResetSecrets(profile, process.env.RESET_RUNTIME_SECRETS_JSON);
  delete process.env.RESET_RUNTIME_SECRETS_JSON;
  console.log("Original runtime secret files prepared. Values are not included in receipts.");
  process.exit(0);
}
if (!profile.workers.memory || !profile.workers.resident || !profile.workers.sandbox || !profile.artifacts)
  throw new Error("reset requires the four-Worker installation and its artifacts bucket");
profile.secretsSource ??= DEFAULT_SECRETS_DIR;
const source = profile.secretsSource.replace(/^~\//, `${homedir()}/`);
if (!source || source.includes("://")) throw new Error("reset requires the original local secret source");
if (values.download || values["list-receipts"]) {
  if ((values.download && !values.output) || !process.env.CLOUDFLARE_API_TOKEN)
    throw new Error("receipt download needs a private output and account credential");
  const client = new ResetCloudflare(profile.account, process.env.CLOUDFLARE_API_TOKEN);
  const journal = new ResetJournal(
    client,
    profile.workers.memory!.script,
    Object.values(profile.workers).map((worker) => worker.script),
    importCredentialKey(readFileSync(join(source, "MCP_CREDENTIAL_KEY"), "utf8").trim()),
  );
  if (values["list-receipts"]) {
    console.log(
      JSON.stringify({ bucket: journal.bucket, records: await journal.list(values["list-receipts"]) }, null, 2),
    );
    process.exit(0);
  }
  writeFileSync(values.output!, await journal.read(values.download!), { flag: "wx", mode: 0o600 });
  console.log(`Encrypted reset receipt saved to ${values.output}. No service state changed.`);
  process.exit(0);
}
if (values.inspect) {
  if (!values.output) throw new Error("encrypted reset inspection requires a private --output path");
  const sealed = z
    .object({ serverId: z.string(), keyId: z.string(), sealed: z.string(), updatedAt: z.number() })
    .strict()
    .parse(JSON.parse(readFileSync(values.inspect, "utf8")));
  if (!sealed.serverId.startsWith(`installation-reset:${profile.account}:`))
    throw new Error("reset preservation belongs to a different account");
  const key = importCredentialKey(readFileSync(join(source, "MCP_CREDENTIAL_KEY"), "utf8").trim());
  const text = await openCredential(key, sealed);
  writeFileSync(values.output, text + "\n", { flag: "wx", mode: 0o600 });
  console.log(`Reset inspection saved to ${values.output}. No service action was performed.`);
  process.exit(0);
}
if (!values.plan) throw new Error("reset requires a private --plan path");
const planPath = values.plan;
const configRead = await readConfigForPush(profile.configSource);
if (!configRead.ok) throw new Error("reset configuration cannot be read");
const configText = configRead.text;
const config = parseAppConfigText(configText);
const manifest = z
  .object({ secrets: z.array(z.object({ name: z.string(), workers: z.array(z.string()) }).passthrough()) })
  .passthrough()
  .parse(JSON.parse(readFileSync("deploy/secrets.manifest.json", "utf8")));
const secrets: Record<string, string> = {};
for (const entry of manifest.secrets) {
  if (existsSync(join(source, entry.name))) secrets[entry.name] = readFileSync(join(source, entry.name), "utf8").trim();
}
if (!process.env.CLOUDFLARE_API_TOKEN || !secrets.MEMORY_TOKEN || !secrets.RESIDENT_ADMIN_TOKEN)
  throw new Error("reset requires the account credential and original Memory and Resident admin bearers");
if (!secrets.MCP_CREDENTIAL_KEY) throw new Error("reset requires the original MCP_CREDENTIAL_KEY");
try {
  z.record(z.string(), z.object({ subject: z.string() }).passthrough()).parse(
    JSON.parse(secrets.SWITCHBOARD_INGRESS_TOKENS),
  );
} catch {
  throw new Error("original ingress credential map is missing or invalid");
}
// The existing initializer checks matching operator inputs and the full restoration roster.
for (const name of ["MEMORY_TOKEN", "SANDBOX_TOKEN", "RESIDENT_READ_TOKEN", "RESIDENT_DRAIN_TOKEN"])
  process.env[name] = secrets[name];
const native = new ResetCloudflare(profile.account, process.env.CLOUDFLARE_API_TOKEN);
const verifiedOrigins = await native.serviceOrigins(profile);
const credentialKey = importCredentialKey(secrets.MCP_CREDENTIAL_KEY);
const journal = new ResetJournal(
  native,
  profile.workers.memory!.script,
  Object.values(profile.workers).map((worker) => worker.script),
  credentialKey,
);
const memoryUrl = `https://${profile.workers.memory!.hostname}`;
const residentUrl = `https://${profile.workers.resident!.hostname}`;
const installations = [config.organization];

async function post(origin: string, path: string, token: string, body: object): Promise<unknown> {
  if (!verifiedOrigins.has(origin)) throw new Error("reset service origin is unverified");
  const text = JSON.stringify(body);
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
    },
    body: text,
    redirect: "error",
    signal: AbortSignal.timeout(MINUTE_MS),
  });
  if (!response.ok) throw new Error(`reset service ${path} refused or unverified (HTTP ${response.status})`);
  return response.json();
}
const memory = (path: string, body: object) => post(memoryUrl, path, secrets.MEMORY_TOKEN, body);
const registry = (body: object) =>
  post(residentUrl, "/installation-reset/settings", secrets.RESIDENT_ADMIN_TOKEN, body);
let settings: SettingsTransfer;
let repositories: unknown;
let oldPlan: InstallationResetPlan;
let beforeHosting: ReturnType<typeof resetHostingSettings>;
let hostingCapture: ResetHostingCapture;

async function readEndpoints(
  dependencies?: Record<string, { references: unknown }>,
): Promise<ResetHostingCapture["endpoints"]> {
  const endpoints: ResetHostingCapture["endpoints"] = Object.fromEntries(
    await Promise.all(
      Object.values(profile.workers).map(async (worker) => {
        const [scheduleRead, developmentRead, referenceRead] = await Promise.all([
          native.request(`/accounts/${profile.account}/workers/scripts/${worker.script}/schedules`),
          native.request(`/accounts/${profile.account}/workers/scripts/${worker.script}/subdomain`),
          dependencies
            ? Promise.resolve({ result: dependencies[worker.script].references })
            : native.request(`/accounts/${profile.account}/workers/scripts/${worker.script}/references`),
        ]);
        const schedules = z
          .object({ schedules: z.array(z.object({ cron: z.string() }).passthrough()) })
          .passthrough()
          .parse(scheduleRead.result);
        const domains =
          z
            .object({ domains: z.array(z.record(z.string(), z.unknown())).optional() })
            .passthrough()
            .parse(referenceRead.result).domains ?? [];
        return [
          worker.script,
          {
            domains,
            schedules: schedules.schedules.map((entry) => entry.cron).sort(),
            subdomain: developmentRead.result,
          },
        ];
      }),
    ),
  );
  await native.verifyRouting(profile, endpoints);
  return endpoints;
}

async function readPlan(): Promise<InstallationResetPlan> {
  const [inventory, hosting, artifacts, backups] = await Promise.all([
    native.inventory(profile),
    native.settings(profile),
    native.bucket(profile.artifacts!.bucket),
    native.bucket(`${profile.workers.resident!.script}-cache`),
  ]);
  const selectedNames = new Set(Object.values(profile.workers).map((worker) => worker.script));
  const knownClasses: Record<string, readonly string[]> = {
    [profile.workers.memory!.script]: [
      "ConfigDO",
      "OrganizationDO",
      "MemoryDO",
      "ScheduleDO",
      "RunHistoryDO",
      "RunTranscriptDO",
      "DeliveryDO",
      "CostsSnapshotDO",
      "SessionLogDO",
      "FrictionDO",
    ],
    [profile.workers.resident!.script]: ["ResidentDO", "ResidentRegistryDO"],
    [profile.workers.bot.script]: ["SwitchboardServer"],
    [profile.workers.sandbox!.script]: ["SwitchboardSandbox"],
  };
  const selectedNamespaces = nativeInventoryRows(inventory.namespaces).filter((row) =>
    selectedNames.has(String(row.script)),
  );
  if (selectedNamespaces.some((row) => !knownClasses[String(row.script)]?.includes(String(row.class))))
    throw new Error("reset found an unclassified namespace; inspect it before selecting deletion");
  const census = await Promise.all(
    selectedNamespaces.map(async (row) => ({
      namespace: String(row.id),
      class: String(row.class),
      objects: await native.objects(String(row.id)),
    })),
  );
  const addresses = z
    .object({ config: z.string(), organizations: z.array(z.string()) })
    .strict()
    .parse(await memory("/installation-reset/settings", { action: "addresses", installations }));
  for (const [className, expected] of [
    ["ConfigDO", [addresses.config]],
    ["OrganizationDO", addresses.organizations],
  ] as const) {
    const matches = nativeInventoryRows(inventory.namespaces).filter(
      (row) => row.script === profile.workers.memory!.script && row.class === className,
    );
    if (matches.length !== 1) throw new Error("reset settings namespace census differs");
    const objects = census
      .find((item) => item.namespace === matches[0].id)!
      .objects.filter((object) => object.hasStoredData)
      .map((object) => object.id)
      .sort();
    if (JSON.stringify(objects) !== JSON.stringify([...expected].sort()))
      throw new Error("reset found settings objects outside the preserved installation; no deletion is allowed");
  }
  const [state, records] = await Promise.all([
    memory("/installation-reset/settings", { action: "preview", installations }),
    registry({ action: "preview" }),
  ]);
  settings = settingsTransferSchema.parse(state);
  repositories = z
    .object({ schema: z.literal(1), records: z.array(z.record(z.string(), z.unknown())) })
    .strict()
    .parse(records);
  if (Buffer.byteLength(JSON.stringify({ settings, repositories })) > 2 * 1024 * 1024)
    throw new Error("reset settings exceed the transfer limit");
  await authenticateResetCredentials(settings, secrets.MCP_CREDENTIAL_KEY);
  await journal.inspect();
  const bucketNames = new Set([artifacts.name, backups.name]);
  for (const value of Object.values(hosting)) {
    const bindings = z
      .object({ bindings: z.array(z.object({ bucket_name: z.string().optional() }).passthrough()) })
      .passthrough()
      .parse(value).bindings;
    if (bindings.some((binding) => binding.bucket_name === journal.bucket))
      throw new Error("reset journal must not be bound to a runtime Worker");
  }
  // A bucket bound by another Worker is shared, even when this profile names it.
  for (const script of nativeInventoryRows(inventory.scripts)) {
    if (selectedNames.has(String(script.id))) continue;
    const other = await native.request(
      `/accounts/${profile.account}/workers/scripts/${encodeURIComponent(String(script.id))}/settings`,
    );
    const bindings = z
      .object({ bindings: z.array(z.object({ bucket_name: z.string().optional() }).passthrough()) })
      .passthrough()
      .parse(other.result).bindings;
    if (bindings.some((binding) => binding.bucket_name === journal.bucket))
      throw new Error("reset journal must not be bound to another Worker");
    if (bindings.some((binding) => binding.bucket_name && bucketNames.has(binding.bucket_name)))
      throw new Error("reset refuses a bucket shared with another Worker");
  }
  for (const [kind, worker] of Object.entries(profile.workers)) {
    const bindings = z
      .object({ bindings: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()) })
      .passthrough()
      .parse(hosting[worker.script]).bindings;
    const deployed = bindings
      .filter((binding) => binding.type === "secret_text")
      .map((binding) => binding.name)
      .sort();
    const restored = manifest.secrets
      .filter((entry) => entry.workers.includes(kind) && secrets[entry.name])
      .map((entry) => entry.name)
      .sort();
    if (JSON.stringify(deployed) !== JSON.stringify(restored))
      throw new Error(`reset restoration secret roster differs for ${kind}`);
    for (const binding of bindings) {
      if (
        ![
          "secret_text",
          "plain_text",
          "json",
          "durable_object_namespace",
          "service",
          "workflow",
          "r2_bucket",
          "analytics_engine",
          "version_metadata",
        ].includes(binding.type)
      )
        throw new Error("reset found an unsupported binding");
    }
  }
  const plan = planInstallationRecreation(profile, values.account!, inventory, {
    commit,
    configSha256: resetDigest(configText),
  });
  const appNames = new Set(plan.deletions.filter((entry) => entry.kind === "application").map((entry) => entry.name));
  beforeHosting = resetHostingSettings(
    hosting,
    nativeInventoryRows(inventory.applications).filter((app) => appNames.has(String(app.name))),
  );
  const endpoints = await readEndpoints(inventory.dependencies);
  hostingCapture = {
    settings: hosting,
    applications: nativeInventoryRows(inventory.applications).filter((app) => appNames.has(String(app.name))),
    endpoints,
  };
  oldPlan = installationResetPlan({
    native: plan,
    journalBucket: journal.bucket,
    settingsSha256: resetDigest({ settings, repositories }),
    hostingSha256: resetDigest({ ...beforeHosting, endpoints: resetEndpointSettings(endpoints) }),
    buckets: [artifacts, backups],
    objects: census,
  });
  await preflight();
  return oldPlan;
}

const operation = randomUUID();
const preflight = async () => {
  await initializeOnHost(profile, configRead, {
    checkOnly: true,
    receiptPath: `${values.receipt ?? planPath}.memory.json`,
    reset: {
      account: profile.account,
      planSha256: values.apply ?? "0".repeat(64),
      hosting: hostingCapture,
      restoreSettings: async () => {},
    },
  });
};

if (!values.apply) {
  const plan = await readPlan();
  writeFileSync(planPath, JSON.stringify({ status: "plan-only", plan }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (values["seal-plan"]) {
    const sealed = await sealCredential(
      importCredentialKey(secrets.MCP_CREDENTIAL_KEY),
      `installation-reset:${profile.account}:preview:${plan.sha256}`,
      readFileSync(planPath, "utf8"),
      systemClock(),
    );
    const path = `${planPath}.sealed.json`;
    writeFileSync(path, JSON.stringify(sealed) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`Encrypted reset preview saved to ${path}. No service state changed.`);
  }
  console.log(
    `Reset preview ${plan.sha256}: ${plan.native.deletions.length} native resources; ${plan.buckets.reduce((n, b) => n + b.objects.length, 0)} R2 objects. Nothing changed.`,
  );
} else {
  if (existsSync(values.receipt!)) throw new Error("reset receipt already exists; inspect the original operation");
  const saved = JSON.parse(readFileSync(planPath, "utf8"));
  oldPlan = saved.plan;
  if (oldPlan?.sha256 !== values.apply) throw new Error("selected reset plan hash differs");
  let recorded = false;
  let sequence = 0;
  let prepared: Promise<void> | undefined;
  let previous: Awaited<ReturnType<ResetJournal["write"]>> | undefined;
  const remotePrefix = `runs/${process.env.GITHUB_RUN_ID}/${operation}`;
  console.log(
    JSON.stringify({ resetOperation: operation, journalBucket: journal.bucket, journalPrefix: remotePrefix }),
  );
  const record = async (phase: string, detail: unknown) => {
    const entry = {
      schema: 1,
      operation,
      sequence: ++sequence,
      planSha256: values.apply,
      controller: { run: process.env.GITHUB_RUN_ID, commit },
      at: new Date(systemClock()).toISOString(),
      phase,
      detail,
      previous,
      resetOutcome: phase === "verified" ? "verified" : "unknown",
      discardedWorkOutcome: "unknown",
      maintenance: "retained",
    };
    appendFileSync(values.receipt!, JSON.stringify(entry) + "\n", {
      flag: recorded ? "a" : "wx",
      mode: 0o600,
      flush: true,
    });
    recorded = true;
    if (phase === "verified" && (await journal.inspect()).status !== "owned")
      throw new Error("reset journal is not retained");
    // Cache even a rejected setup promise. An uncertain original bucket creation is never replayed.
    prepared ??= journal.ensure();
    await prepared;
    const sealed = await sealCredential(
      credentialKey,
      `installation-reset:${profile.account}:${operation}:${values.apply}:journal:${sequence}`,
      JSON.stringify({
        entry,
        ...(["held", "verified"].includes(phase) ? { journal: readFileSync(values.receipt!, "utf8") } : {}),
      }),
      systemClock(),
    );
    previous = await journal.write(`${remotePrefix}/journal/${String(sequence).padStart(8, "0")}.sealed.json`, sealed);
  };
  const settingsFile = `${values.receipt}.settings.sealed.json`;
  const reset = {
    account: profile.account,
    planSha256: values.apply,
    get hosting() {
      return hostingCapture;
    },
    restoreSettings: async () => {
      await record("restoring-settings", { operation });
      const restored = settingsTransferSchema.parse(
        await memory("/installation-reset/settings", {
          action: "restore",
          operation,
          installations,
          config: settings.config,
          organizations: settings.organizations,
        }),
      );
      if (resetDigest(restored) !== resetDigest(settings)) throw new Error("reset settings restoration differs");
    },
    restoreRepositories: async () => {
      await record("restoring-repositories", { operation });
      const entries = z
        .object({ records: z.array(z.unknown()) })
        .passthrough()
        .parse(repositories).records;
      const restored = await registry({ action: "restore", operation, records: entries });
      if (resetDigest(restored) !== resetDigest(repositories)) throw new Error("reset repository restoration differs");
    },
  };
  try {
    const result = await resetInstallation(values.apply, operation, {
      preflight: async () => {
        const status = z
          .object({
            version: z.number(),
            document: z
              .object({
                episode: z
                  .object({
                    id: z.string().uuid(),
                    phase: z.literal("active"),
                    scopes: z.tuple([z.literal("all")]),
                    notice: z.object({ status: z.enum(["sent", "unverified"]) }).passthrough(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough()
          .parse(await memory("/config/get", { key: "maintenance" }));
        if (status.document.episode.id !== values.maintenance) throw new Error("reset maintenance episode differs");
        const live = z
          .object({ runs: z.array(z.unknown()) })
          .passthrough()
          .parse(await memory("/runs/live", { storeKey: RUN_STORE_KEY }));
        if (live.runs.length) throw new Error("reset waits for active work to finish");
      },
      readPlan,
      record,
      preserve: async () => {
        const frozen = settingsTransferSchema.parse(
          await memory("/installation-reset/settings", { action: "freeze", operation, installations }),
        );
        const frozenRepositories = await registry({ action: "freeze", operation });
        if (resetDigest({ settings: frozen, repositories: frozenRepositories }) !== oldPlan.settingsSha256)
          throw new Error("reset settings changed before their locks were acquired");
        settings = frozen;
        repositories = frozenRepositories;
        const sealed = await sealCredential(
          importCredentialKey(secrets.MCP_CREDENTIAL_KEY),
          `installation-reset:${profile.account}:${operation}:${values.apply}`,
          JSON.stringify({ operation, plan: oldPlan, settings, repositories, hosting: hostingCapture }),
          systemClock(),
        );
        writeFileSync(settingsFile, JSON.stringify(sealed) + "\n", { flag: "wx", mode: 0o600 });
        const preservation = await journal.write(`${remotePrefix}/settings.sealed.json`, sealed);
        await record("preserved", preservation);
      },
      remove: async (entry) => {
        await native.request(entry.path, "DELETE");
      },
      absent: () => native.absent(profile),
      bucketContents: (name) => native.bucket(name),
      removeObject: (bucket, object) => native.removeObject(bucket, object),
      empty: async () => {
        for (const bucket of oldPlan.buckets)
          if ((await native.bucket(bucket.name)).objects.length) throw new Error("reset bucket is not empty");
      },
      initialize: () =>
        initializeOnHost(profile, configRead, { receiptPath: `${values.receipt}.memory.json`, reset }).then(() => {}),
      verify: async () => {
        const restoredSettings = settingsTransferSchema.parse(
          await memory("/installation-reset/settings", { action: "preview", installations }),
        );
        const restoredRepositories = await registry({ action: "preview" });
        if (resetDigest({ settings: restoredSettings, repositories: restoredRepositories }) !== oldPlan.settingsSha256)
          throw new Error("reset settings changed during restoration");
        const appNames = new Set(
          oldPlan.native.deletions.filter((entry) => entry.kind === "application").map((entry) => entry.name),
        );
        const applications = nativeInventoryRows(await native.list("containers/applications")).filter((app) =>
          appNames.has(String(app.name)),
        );
        if (applications.length !== appNames.size) throw new Error("reset container applications are incomplete");
        const after = resetHostingSettings(await native.settings(profile), applications);
        if (
          resetDigest({ ...after, endpoints: resetEndpointSettings(await readEndpoints()) }) !== oldPlan.hostingSha256
        )
          throw new Error("reset hosting settings differ");
        const current = await native.list("workers/durable_objects/namespaces");
        const beforeIds = new Set(
          (oldPlan.native.evidence as { namespaces: { id: string }[] }).namespaces.map((row) => row.id),
        );
        if (nativeInventoryRows(current).some((row) => beforeIds.has(String(row.id))))
          throw new Error("old reset namespace still exists");
        const runs = z
          .object({ items: z.array(z.unknown()) })
          .passthrough()
          .parse(await memory("/runs/list", { storeKey: RUN_STORE_KEY, limit: 1 }));
        if (runs.items.length) throw new Error("reset history is not empty");
        const status = await memory("/installation-reset/settings", { action: "verify", operation, installations });
        const verified = z
          .object({
            config: z.object({ operation: z.literal(operation), phase: z.literal("verified") }).strict(),
            organizations: z.array(
              z.object({ operation: z.literal(operation), phase: z.literal("verified") }).strict(),
            ),
          })
          .passthrough()
          .parse(status);
        if (verified.organizations.length !== installations.length)
          throw new Error("reset verification receipt is incomplete");
      },
    });
    console.log(JSON.stringify({ ...result, journal: previous }));
  } catch (error) {
    if (recorded) {
      try {
        await record("held", { failure: error instanceof Error ? error.message : "reset failed" });
      } catch (journalError) {
        throw new AggregateError([error, journalError], "Reset is held; the final journal write also failed", {
          cause: journalError,
        });
      }
    }
    throw error;
  }
}
