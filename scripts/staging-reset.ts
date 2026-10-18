import { prepareResetSecrets } from "../src/deploy/resetSecrets.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";
import { parseAppConfigText } from "../src/config.js";
import { systemClock } from "../src/core/trace/clock.js";
import { MINUTE_MS, SECOND_MS } from "../src/core/budgets.js";
import { RUN_STORE_KEY } from "../src/core/runStoreConstants.js";
import { analyzeRunFriction } from "../src/core/runFriction.js";
import type { RunRecord } from "../src/core/runRecord.js";
import { MaintenanceService, WorkerMaintenanceStore } from "../src/core/maintenance.js";
import { importCredentialKey, sealCredential, openCredential } from "../src/mcp/sealed.js";
import { loadProfileOnHost, readConfigForPush } from "../src/deploy/run.js";
import { stagingProblems } from "../src/deploy/staging.js";
import { LIVE_GATE_DEADLINE_MS, LIVE_GATE_POLL_MS } from "../src/deploy/liveGate.js";
import { ResetCloudflare } from "../src/deploy/resetCloudflare.js";
import { ResetJournal } from "../src/deploy/resetJournal.js";

const { values } = parseArgs({ options: { "prepare-secrets": { type: "boolean" }, directory: { type: "string" } } });
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_RUN_ATTEMPT !== "1" ||
  process.env.RESET_ENVIRONMENT !== "staging"
)
  throw new Error("reset rehearsal requires one original staging controller");
const { profile } = await loadProfileOnHost();
const configRead = await readConfigForPush(profile.configSource);
if (!configRead.ok) throw new Error("staging reset configuration is unavailable");
const config = parseAppConfigText(configRead.text);
const problems = stagingProblems(profile, config, {
  staging: process.env.SWITCHBOARD_STAGING_ACCOUNT,
  production: process.env.SWITCHBOARD_PRODUCTION_ACCOUNT,
});
if (problems.length || process.env.RESET_ACCOUNT !== profile.account)
  throw new Error("reset rehearsal isolation is unverified");
const source = profile.secretsSource?.replace(/^~\//, `${homedir()}/`);
if (!source || source.includes("://") || !source.includes("staging"))
  throw new Error("staging reset secret source differs");

if (values["prepare-secrets"]) {
  prepareResetSecrets(profile, process.env.STAGING_RUNTIME_SECRETS_JSON);
  delete process.env.STAGING_RUNTIME_SECRETS_JSON;
  console.log("Original staging runtime secret files prepared. Values are not included in receipts.");
  process.exit(0);
}

if (!values.directory || !process.env.CLOUDFLARE_API_TOKEN)
  throw new Error("reset rehearsal requires a private receipt directory and staging token");
const directory = resolve(values.directory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const token = readFileSync(join(source, "MEMORY_TOKEN"), "utf8").trim();
const key = importCredentialKey(readFileSync(join(source, "MCP_CREDENTIAL_KEY"), "utf8").trim());
const origin = `https://${profile.workers.memory!.hostname}`;
const residentOrigin = `https://${profile.workers.resident!.hostname}`;
const residentAdmin = readFileSync(join(source, "RESIDENT_ADMIN_TOKEN"), "utf8").trim();
const actor = `reset-controller:${process.env.GITHUB_ACTOR}`;
const maintenance = new MaintenanceService({ store: new WorkerMaintenanceStore({ baseUrl: origin, token }) });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence: unknown[] = [];
const native = new ResetCloudflare(profile.account, process.env.CLOUDFLARE_API_TOKEN!);
const verifiedOrigins = await native.serviceOrigins(profile);
if (!verifiedOrigins.has(origin) || !verifiedOrigins.has(residentOrigin))
  throw new Error("staging reset service origins are unverified");
const durableJournal = new ResetJournal(
  native,
  profile.workers.memory!.script,
  Object.values(profile.workers).map((worker) => worker.script),
  key,
);
const retainedJournals: { operation: string; key: string }[] = [];
const save = () =>
  writeFileSync(
    join(directory, "staging-reset-e2e.json"),
    JSON.stringify(
      { commit, account: profile.account, scope: "isolated synthetic fixtures; no production reset", cycles: evidence },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );

async function post(path: string, body: object, base = origin, bearer = token): Promise<Record<string, unknown>> {
  if (!verifiedOrigins.has(base)) throw new Error("staging fixture origin is unverified");
  const text = JSON.stringify(body);
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
    },
    body: text,
    redirect: "error",
    signal: AbortSignal.timeout(MINUTE_MS),
  });
  if (!response.ok) throw new Error(`staging reset fixture ${path} refused (HTTP ${response.status})`);
  return z.record(z.string(), z.unknown()).parse(await response.json());
}
const equal = (actual: unknown, expected: unknown, label: string) => {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`reset rehearsal ${label} differs`);
};
const registrationSchema = z
  .object({
    resource: z.string(),
    commands: z.record(z.string(), z.string()),
    defaultRef: z.string(),
    noResident: z.boolean().optional(),
  })
  .passthrough();
async function readRegistrations() {
  const response = await fetch(`${residentOrigin}/residents`, {
    headers: { authorization: `Bearer ${residentAdmin}` },
    redirect: "error",
    signal: AbortSignal.timeout(MINUTE_MS),
  });
  if (!response.ok) throw new Error("staging registration read failed");
  const body = z
    .object({ residents: z.array(registrationSchema), repositories: z.array(registrationSchema) })
    .passthrough()
    .parse(await response.json());
  return [...body.residents, ...body.repositories];
}
function run(args: string[]) {
  const child = spawnSync("npm", ["run", "--silent", "installation:reset", "--", ...args], {
    env: process.env,
    stdio: "inherit",
  });
  if (child.status !== 0)
    throw new Error("original staging reset command failed; inspect its retained receipt before another action");
}
async function waitForResidents() {
  const started = systemClock();
  const readToken = readFileSync(join(source!, "RESIDENT_READ_TOKEN"), "utf8").trim();
  while (systemClock() - started < LIVE_GATE_DEADLINE_MS) {
    const response = await fetch(`${residentOrigin}/residents`, {
      headers: {
        authorization: `Bearer ${readToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(MINUTE_MS),
    });
    if (!response.ok) throw new Error("staging resident readiness read failed");
    const body = z
      .object({ residents: z.array(z.object({ live: z.object({ state: z.string() }).passthrough() }).passthrough()) })
      .passthrough()
      .parse(await response.json());
    if (body.residents.every((resident) => resident.live.state === "warm")) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, LIVE_GATE_POLL_MS));
  }
  throw new Error("staging residents did not finish their existing lifecycle work");
}

let fixtureRegistration = (await readRegistrations())[0];
let createdRegistration: string | undefined;
if (!fixtureRegistration) {
  let repo: string;
  try {
    repo = z
      .object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) })
      .passthrough()
      .parse(JSON.parse(process.env.SMOKE_INGRESS_CONFIG ?? "")).repo;
  } catch {
    throw new Error("empty staging needs its configured smoke repository for the registration fixture");
  }
  const resource = `repo:${repo}`;
  const seeded = await post(
    "/register",
    {
      resource,
      noResident: true,
      defaultRef: "main",
      commands: { test: "git diff --check", build: "git diff --check" },
    },
    residentOrigin,
    residentAdmin,
  );
  equal({ resource: seeded.resource, state: seeded.state }, { resource, state: "cold" }, "registration seed");
  fixtureRegistration = (await readRegistrations()).find((record) => record.resource === resource)!;
  if (!fixtureRegistration) throw new Error("registration fixture was not retained");
  createdRegistration = resource;
}

for (const cycle of [1, 2]) {
  await waitForResidents();
  const live = z
    .object({ runs: z.array(z.unknown()) })
    .passthrough()
    .parse(await post("/runs/live", { storeKey: RUN_STORE_KEY }));
  if (live.runs.length) throw new Error("staging reset waits for active work to finish");
  const hold = await maintenance.start(
    { scopes: ["all"], reason: "Isolated staging reset validation", channel: "staging-reset-fixture" },
    actor,
  );
  if (!hold.episode || hold.episode.phase !== "active")
    throw new Error("staging reset maintenance did not close access");
  const id = randomUUID();
  const thread = `http:reset-fixture:${id}`;
  const gen = `reset-fixture-${id}`;
  const session = `${thread}:general`;
  const scopeKey = `user:http:reset-fixture-${id}`;
  const model = config.defaults?.models?.general;
  if (!model) throw new Error("staging fixture needs its configured General model reference");
  const now = systemClock();
  const event = {
    type: "tool_call" as const,
    tool: "read_file",
    summary: "Synthetic reset fixture; no tool was executed",
    seq: 1,
  };
  const record: RunRecord = {
    id,
    label: "Synthetic reset fixture",
    agent: "general",
    model,
    channelId: "http:reset-fixture",
    userId: "http:reset-fixture",
    threadKey: thread,
    channelVisibility: "machine",
    startedAt: now - SECOND_MS,
    finishedAt: now,
    status: "completed",
    eventCount: 1,
    storedEventCount: 1,
    truncated: false,
    events: [event],
    diagnosis: analyzeRunFriction([event]),
  };
  equal((await post("/runs/put", { storeKey: RUN_STORE_KEY, record })).ok, true, "history seed");
  equal((await post("/runs/session/owner", { key: session, runId: id, gen })).ok, true, "session owner");
  const rows = [
    {
      idx: 0,
      part: 0,
      json: JSON.stringify({ role: "assistant", part: { type: "text", text: "Synthetic reset fixture" } }),
    },
  ];
  equal(
    (await post("/runs/session/write", { key: session, runId: id, gen, rows, attachments: [] })).ok,
    true,
    "session seed",
  );
  equal((await post("/runs/transcript/owner", { runId: id, gen })).ok, true, "legacy transcript owner");
  equal(
    (await post("/runs/transcript/write", { runId: id, gen, rows, attachments: [] })).ok,
    true,
    "legacy transcript seed",
  );
  const memorySeed = await post("/write", {
    scopeKey,
    records: [
      {
        kind: "fact",
        text: "Reset fixture stores the value alpha.",
        keywords: ["reset", "fixture"],
        sourceThreadKey: thread,
        sourceRunId: id,
      },
    ],
  });
  equal(memorySeed.inserted, 1, "learned memory seed");
  const prior = await post("/config/get", { key: "reset-fixture" });
  const document = { value: "alpha", repository: "acme/reset-fixture" };
  equal(
    (await post("/config/put", { key: "reset-fixture", expectedVersion: prior.version, document })).ok,
    true,
    "settings seed",
  );
  const sealed = await sealCredential(key, "org:reset-fixture", "synthetic credential", now);
  equal((await post("/config/secrets/put", { sealed })).ok, true, "credential seed");
  const personalToken = {
    digest: createHash("sha256").update(`reset-fixture-${id}`).digest("hex"),
    subject: `personal:${id}`,
    userId: `access:${id}`,
    email: "reset-fixture@example.invalid",
    createdAt: now,
    approval: {
      version: 1,
      issuer: "https://reset-fixture.invalid",
      audience: "reset-fixture",
      organization: config.organization,
      subject: id,
    },
  };
  equal((await post("/config/personal-tokens/put", { token: personalToken })).ok, true, "personal token seed");
  equal(
    (await post("/config/personal-tokens/get", { digest: personalToken.digest })).token,
    personalToken,
    "personal token seed read",
  );
  const identity = { issuer: "https://reset-fixture.invalid", tenant: null, subject: id };
  const created = z
    .object({ status: z.literal("created"), person: z.object({ id: z.string() }).passthrough() })
    .passthrough()
    .parse(
      await post("/organization/directory", { installation: config.organization, command: { action: "createPerson" } }),
    );
  const linked = await post("/organization/directory", {
    installation: config.organization,
    command: {
      action: "change",
      change: {
        action: "link",
        identity,
        personId: created.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      },
    },
  });
  equal(linked.status, "changed", "identity seed");
  const objectKeys = [
    [profile.artifacts!.bucket, `runs/reset-fixture-${id}/out.txt`],
    [`${profile.workers.resident!.script}-cache`, `backups/reset-fixture-${id}/data.sqsh`],
  ];
  for (const [bucket, object] of objectKeys) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${profile.account}/r2/buckets/${bucket}/objects/${object}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "content-type": "text/plain" },
        body: "synthetic reset fixture",
        redirect: "error",
        signal: AbortSignal.timeout(MINUTE_MS),
      },
    );
    if (!response.ok) throw new Error("staging R2 fixture write is unverified");
    equal(
      (await native.bucket(bucket)).objects.some((entry) => entry.key === object && entry.size === 23),
      true,
      "R2 seed",
    );
  }
  const planPath = join(directory, `cycle-${cycle}-plan.json`);
  const receipt = join(directory, `cycle-${cycle}-execution.jsonl`);
  run(["--account", profile.account, "--plan", planPath]);
  const planned = z
    .object({ plan: z.object({ sha256: z.string() }).passthrough() })
    .passthrough()
    .parse(JSON.parse(readFileSync(planPath, "utf8")));
  // The preview must not change any of the saved fixture values.
  equal((await post("/runs/get", { storeKey: RUN_STORE_KEY, id })).record !== null, true, "preview history");
  equal((await post("/config/get", { key: "reset-fixture" })).document, document, "preview settings");
  run([
    "--account",
    profile.account,
    "--plan",
    planPath,
    "--apply",
    planned.plan.sha256,
    "--maintenance",
    hold.episode.id,
    "--receipt",
    receipt,
  ]);
  equal((await post("/runs/get", { storeKey: RUN_STORE_KEY, id })).record, null, "old run removal");
  equal((await post("/runs/session/read", { key: session, from: 0, to: 2 })).rows, [], "old session removal");
  equal((await post("/runs/transcript/read", { runId: id })).rows, [], "old transcript removal");
  equal((await post("/list", { scopeKey, limit: 1 })).records, [], "learned memory removal");
  for (const [bucket, object] of objectKeys)
    equal(
      (await native.bucket(bucket)).objects.some((entry) => entry.key === object),
      false,
      "old R2 object removal",
    );
  equal((await post("/config/get", { key: "reset-fixture" })).document, document, "settings preservation");
  const restoredCredential = await post("/config/secrets/get", { serverId: "org:reset-fixture" });
  const parsedCredential = z
    .object({ serverId: z.string(), keyId: z.string(), sealed: z.string(), updatedAt: z.number() })
    .strict()
    .parse(restoredCredential.sealed);
  equal(await openCredential(key, parsedCredential), "synthetic credential", "usable credential preservation");
  equal(
    (await post("/config/personal-tokens/get", { digest: personalToken.digest })).token,
    personalToken,
    "personal token preservation",
  );
  const registration = (await readRegistrations()).find((record) => record.resource === fixtureRegistration.resource);
  if (!registration) throw new Error("saved registration disappeared");
  equal(
    { commands: registration.commands, defaultRef: registration.defaultRef, noResident: registration.noResident },
    {
      commands: fixtureRegistration.commands,
      defaultRef: fixtureRegistration.defaultRef,
      noResident: fixtureRegistration.noResident,
    },
    "registration preservation",
  );
  const resolved = z
    .object({ status: z.literal("bound"), binding: z.object({ personId: z.string() }).passthrough() })
    .passthrough()
    .parse(
      await post("/organization/directory", {
        installation: config.organization,
        command: { action: "resolve", identity },
      }),
    );
  equal(resolved.binding.personId, created.person.id, "identity preservation");
  equal(
    (await new WorkerMaintenanceStore({ baseUrl: origin, token }).read()).episode?.id,
    hold.episode.id,
    "maintenance preservation",
  );
  const journal = readFileSync(receipt, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  equal(journal.at(-1).phase, "verified", "reset receipt");
  const final = journal.at(-1);
  const remoteKey = `runs/${process.env.GITHUB_RUN_ID}/${final.operation}/journal/${String(final.sequence).padStart(8, "0")}.sealed.json`;
  const remote = JSON.parse(await durableJournal.read(remoteKey));
  equal(
    remote.serverId,
    `installation-reset:${profile.account}:${final.operation}:${planned.plan.sha256}:journal:${final.sequence}`,
    "remote journal identity",
  );
  const retained = JSON.parse(await openCredential(key, remote));
  equal(retained.journal, readFileSync(receipt, "utf8"), "complete durable journal");
  retainedJournals.push({ operation: final.operation, key: remoteKey });
  evidence.push({
    cycle,
    operation: journal[0].operation,
    planSha256: planned.plan.sha256,
    preservation: journal.find((entry) => entry.phase === "preserved")?.detail,
    journal: { bucket: durableJournal.bucket, key: remoteKey },
    outcome: "passed",
    syntheticDataCleared: ["run", "events", "session", "legacy transcript", "memory", "both R2 buckets"],
    preserved: [
      "settings",
      "usable sealed credential",
      "personal token",
      "identity",
      "repository registrations",
      "maintenance",
    ],
  });
  save();
  equal((await maintenance.end(hold.episode.id, actor)).episode?.phase, "ended", "maintenance release");
}
for (const retained of retainedJournals) {
  const remote = JSON.parse(await durableJournal.read(retained.key));
  const decoded = JSON.parse(await openCredential(key, remote));
  equal(
    { operation: decoded.entry.operation, phase: decoded.entry.phase },
    { operation: retained.operation, phase: "verified" },
    "both original journals remain after the second reset",
  );
}
if (createdRegistration) {
  equal(
    (await post("/offboard", { resource: createdRegistration }, residentOrigin, residentAdmin)).registryRemoved,
    true,
    "fixture registration cleanup",
  );
  equal(
    (await readRegistrations()).some((record) => record.resource === createdRegistration),
    false,
    "fixture registration cleanup read",
  );
}
console.log("Two isolated staging reset cycles passed. Product smoke remains a separate step.");
