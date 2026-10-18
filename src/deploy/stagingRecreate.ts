import { createHash } from "node:crypto";
import type { DeploymentProfile } from "./profile.js";
import { WORKER_KINDS } from "./profile.js";
import { nativeInventoryRows } from "./stagingBootstrap.js";

export interface StagingRecreationInventory {
  scripts: unknown;
  applications: unknown;
  namespaces: unknown;
  workflows: unknown;
  dependencies: Record<string, { references: unknown; tails: unknown }>;
}
export interface StagingDeletion {
  kind: "application" | "workflow" | "worker";
  name: string;
  path: string;
}
export interface StagingRecreationPlan {
  schema: 1;
  account: string;
  deletions: StagingDeletion[];
  evidence: unknown;
  sha256: string;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Exact restoration scope, including the existing webhook and ordinary CI drain bearer. */
export const STAGING_RESTORATION_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "SWITCHBOARD_INGRESS_TOKENS",
  "MEMORY_TOKEN",
  "SANDBOX_TOKEN",
  "RESIDENT_OPERATOR_TOKEN",
  "RESIDENT_ADMIN_TOKEN",
  "RESIDENT_READ_TOKEN",
  "RESIDENT_DRAIN_TOKEN",
  "MCP_CREDENTIAL_KEY",
  "ARTIFACTS_COPY_TOKEN",
  "ARTIFACTS_R2_ACCESS_KEY_ID",
  "ARTIFACTS_R2_SECRET_ACCESS_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
] as const;

export function stagingRestorationSecrets(
  raw: string,
  expected: Record<string, string | undefined>,
  providers: Record<string, { apiKeyEnv?: string }>,
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("staging runtime secret bundle is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("staging runtime secret bundle is invalid");
  const values = parsed as Record<string, unknown>;
  if (
    Object.keys(values).some(
      (name) => !STAGING_RESTORATION_KEYS.includes(name as (typeof STAGING_RESTORATION_KEYS)[number]),
    ) ||
    STAGING_RESTORATION_KEYS.some((name) => typeof values[name] !== "string" || !(values[name] as string).trim())
  )
    throw new Error("staging runtime secret roster is incomplete or contains an undeclared name");
  for (const name of ["MEMORY_TOKEN", "SANDBOX_TOKEN", "RESIDENT_READ_TOKEN", "RESIDENT_DRAIN_TOKEN"])
    if (!expected[name] || values[name] !== expected[name])
      throw new Error("restoration bearers must match the original staging CI inputs");
  if (Object.values(providers).some((provider) => provider.apiKeyEnv && !Object.hasOwn(values, provider.apiKeyEnv)))
    throw new Error("configured provider key cannot be restored from the staging roster");
  return values as Record<string, string>;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("staging dependency read is incomplete");
  return value as Record<string, unknown>;
};
const list = (value: unknown): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("staging dependency read is incomplete");
  return value;
};

/** Retain only bounded field structure. Provider values never enter this diagnostic. */
export class StagingDependencyFieldsError extends Error {
  readonly diagnostic;
  constructor(worker: string, references: Record<string, unknown>, unknownFields: string[]) {
    const safeName = (name: string) => (/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name) ? name : "unrecognized-field");
    const fields = unknownFields
      .sort()
      .slice(0, 8)
      .map((key) => {
        const value = references[key];
        const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        const keys = type === "object" ? Object.keys(value as object) : [];
        return {
          name: safeName(key),
          type,
          ...(type === "array" ? { length: (value as unknown[]).length } : {}),
          ...(type === "object" ? { keyCount: keys.length, keys: keys.sort().slice(0, 8).map(safeName) } : {}),
        };
      });
    super(`staging dependency kind is unverified for ${worker}: ${fields.map((field) => field.name).join(", ")}`);
    this.diagnostic = { worker, fieldCount: unknownFields.length, fields };
  }
}

/** Plan only the selected installation. A provider dependency refusal is never overridden. */
export function planStagingRecreation(
  profile: DeploymentProfile,
  production: string,
  inventory: StagingRecreationInventory,
  source: { commit: string; configSha256: string },
): StagingRecreationPlan {
  if (!/^[a-f0-9]{32}$/.test(production) || profile.account === production)
    throw new Error("recreation requires a separate staging account");
  if (profile.residentMaintenance) throw new Error("recreation requires an ordinary profile without maintenance");
  if (!/^[a-f0-9]{40}$/.test(source.commit) || !/^[a-f0-9]{64}$/.test(source.configSha256))
    throw new Error("recreation requires exact source and configuration hashes");
  const names = WORKER_KINDS.map((kind) => profile.workers[kind]?.script);
  if (names.some((name) => !name?.includes("staging")) || new Set(names).size !== 4)
    throw new Error("recreation requires four distinct staging Workers");
  return planInstallationRecreation(profile, profile.account, inventory, source);
}

/** Shared ownership plan; callers provide their own environment guard. */
export function planInstallationRecreation(
  profile: DeploymentProfile,
  account: string,
  inventory: StagingRecreationInventory,
  source: { commit: string; configSha256: string },
): StagingRecreationPlan {
  if (profile.account !== account) throw new Error("installation account differs");
  const names = WORKER_KINDS.map((kind) => profile.workers[kind]?.script);
  const allowed = new Set(names as string[]);
  const scripts = nativeInventoryRows(inventory.scripts);
  const applications = nativeInventoryRows(inventory.applications);
  const namespaces = nativeInventoryRows(inventory.namespaces);
  const workflows = nativeInventoryRows(inventory.workflows);
  const one = (rows: Record<string, unknown>[], field: string, name: string) => {
    const found = rows.filter((row) => row[field] === name);
    if (found.length !== 1) throw new Error("selected staging resource is absent or duplicated");
    return found[0];
  };
  const selectedScripts = names.map((name) => one(scripts, "id", name!));
  for (const name of names as string[]) {
    const dependency = inventory.dependencies[name];
    if (!dependency || !Array.isArray(dependency.tails) || dependency.tails.length !== 0)
      throw new Error("staging dependency is outside the selected staging installation");
    const refs = record(dependency.references);
    const unknownFields = Object.keys(refs).filter(
      (key) => !["services", "durable_objects", "dispatch_outbounds", "domains"].includes(key),
    );
    if (unknownFields.length) throw new StagingDependencyFieldsError(name, refs, unknownFields);
    const services = refs.services === undefined ? {} : record(refs.services);
    const incoming = [...list(services.incoming), ...list(refs.durable_objects)];
    if (
      services.pages_function === true ||
      list(refs.dispatch_outbounds).length ||
      incoming.some((item) => {
        const ref = record(item);
        return !allowed.has(String(ref.script ?? ref.service));
      })
    )
      throw new Error("staging dependency is outside the selected staging installation");
  }
  const appNames = [
    `${profile.workers.bot.script}-switchboardserver`,
    `${profile.workers.resident!.script}-residentdo`,
    `${profile.workers.sandbox!.script}-switchboardsandbox`,
  ];
  const selectedApps = appNames.map((name) => one(applications, "name", name));
  if (
    selectedApps.some(
      (row) =>
        typeof row.id !== "string" || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(row.id),
    )
  )
    throw new Error("staging application identity is unverified");
  for (const [index, application] of selectedApps.entries()) {
    const binding = application.durable_objects;
    const namespaceId =
      binding && typeof binding === "object" && "namespace_id" in binding ? binding.namespace_id : undefined;
    const owners = namespaces.filter((row) => row.id === namespaceId);
    const expectedScript = [
      profile.workers.bot.script,
      profile.workers.resident!.script,
      profile.workers.sandbox!.script,
    ][index];
    if (
      typeof namespaceId !== "string" ||
      !/^[a-f0-9]{32}$/.test(namespaceId) ||
      owners.length !== 1 ||
      owners[0].script !== expectedScript
    )
      throw new Error("staging application namespace ownership is unverified");
  }
  const workflowNames = [
    `${profile.workers.bot.script}-ship-coordinator`,
    `${profile.workers.resident!.script}-refresh`,
  ];
  const selectedWorkflows = workflowNames.map((name) => one(workflows, "name", name));
  if (selectedWorkflows.some((row) => !allowed.has(String(row.script_name))))
    throw new Error("staging Workflow owner is unverified");
  const selectedNamespaces = namespaces.filter((row) => allowed.has(String(row.script)));
  if (
    names.some((name) => !selectedNamespaces.some((row) => row.script === name)) ||
    selectedNamespaces.some((row) => typeof row.id !== "string" || !/^[a-f0-9]{32}$/.test(row.id))
  )
    throw new Error("staging namespace inventory is incomplete");
  const prefix = `/accounts/${profile.account}`;
  const deletionOrder = [
    profile.workers.memory!.script,
    profile.workers.bot.script,
    profile.workers.resident!.script,
    profile.workers.sandbox!.script,
  ];
  const deletions: StagingDeletion[] = [
    ...selectedApps.map((row) => ({
      kind: "application" as const,
      name: String(row.name),
      path: `${prefix}/containers/applications/${row.id}`,
    })),
    ...workflowNames.map((name) => ({ kind: "workflow" as const, name, path: `${prefix}/workflows/${name}` })),
    ...deletionOrder.map((name) => ({
      kind: "worker" as const,
      name,
      path: `${prefix}/workers/scripts/${name}?force=false`,
    })),
  ];
  const plan = {
    schema: 1 as const,
    account: profile.account,
    deletions,
    evidence: {
      profile,
      source,
      scripts: selectedScripts,
      applications: selectedApps,
      namespaces: selectedNamespaces,
      workflows: selectedWorkflows,
      dependencies: inventory.dependencies,
    },
  };
  return { ...plan, sha256: hash(plan) };
}

/** One original mutation sequence. An unknown response stops before the next phase. */
export async function recreateStaging(
  expected: string,
  io: {
    preflight(): Promise<void>;
    readPlan(): Promise<StagingRecreationPlan>;
    remove(entry: StagingDeletion): Promise<void>;
    absent(): Promise<void>;
    initialize(): Promise<void>;
    record(phase: "deleting" | "initializing" | "recreated", plan: StagingRecreationPlan): Promise<void>;
  },
) {
  await io.preflight();
  const plan = await io.readPlan();
  if (!/^[a-f0-9]{64}$/.test(expected) || plan.sha256 !== expected)
    throw new Error("approved staging reset plan changed");
  await io.record("deleting", plan);
  for (const entry of plan.deletions) await io.remove(entry);
  await io.absent();
  await io.record("initializing", plan);
  await io.initialize();
  await io.record("recreated", plan);
  return { status: "recreated" as const, planSha256: plan.sha256, acceptance: "not-run" as const };
}
