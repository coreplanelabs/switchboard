import { isDeepStrictEqual } from "node:util";
import { stripJsonc } from "../agentEnv/bootstrap.js";

type Row = Record<string, unknown>;
export interface ResetHostingCapture {
  settings: Record<string, Row>;
  applications: Row[];
  endpoints: Record<string, { domains: Row[]; schedules: string[]; subdomain: unknown }>;
}
export function resetEndpointSettings(endpoints: ResetHostingCapture["endpoints"]) {
  return Object.fromEntries(
    Object.entries(endpoints)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, endpoint]) => [
        name,
        {
          schedules: [...endpoint.schedules].sort(),
          subdomain: endpoint.subdomain,
          domains: endpoint.domains
            .map((domain) => ({
              hostname: domain.hostname,
              zone_name: domain.zone_name,
              environment: domain.environment,
              enabled: domain.enabled,
              previews_enabled: domain.previews_enabled,
            }))
            .sort((a, b) => String(a.hostname).localeCompare(String(b.hostname))),
        },
      ]),
  );
}
const object = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("reset hosting value is unrecognized");
  return value as Row;
};
const array = (value: unknown): Row[] => {
  if (!Array.isArray(value)) throw new Error("reset hosting list is unrecognized");
  return value.map(object);
};
const sorted = (values: Row[]) => values.sort((a, b) => String(a.name).localeCompare(String(b.name)));

/** Preserve representable settings; refuse other hosting drift before native deletion. */
export function restoreHostingConfig(rendered: string, capture: ResetHostingCapture): string {
  const config = object(JSON.parse(stripJsonc(rendered)));
  const current = object(capture.settings[String(config.name)]);
  const bindings = array(current.bindings);
  if (new Set(bindings.map((binding) => binding.name)).size !== bindings.length)
    throw new Error("reset hosting bindings are duplicated");
  const expected: Row[] = [];
  for (const item of array(object(config.durable_objects).bindings))
    expected.push({
      type: "durable_object_namespace",
      name: item.name,
      class_name: item.class_name,
      ...(item.script_name ? { script_name: item.script_name } : {}),
    });
  for (const item of array(config.services ?? []))
    expected.push({
      type: "service",
      name: item.binding,
      service: item.service,
      environment: item.environment ?? "production",
    });
  for (const item of array(config.workflows ?? []))
    expected.push({
      type: "workflow",
      name: item.binding,
      class_name: item.class_name,
      workflow_name: item.name,
      ...(item.script_name ? { script_name: item.script_name } : {}),
    });
  for (const item of array(config.r2_buckets ?? []))
    expected.push({ type: "r2_bucket", name: item.binding, bucket_name: item.bucket_name });
  for (const item of array(config.analytics_engine_datasets ?? []))
    expected.push({ type: "analytics_engine", name: item.binding, dataset: item.dataset });
  if (config.version_metadata)
    expected.push({ type: "version_metadata", name: object(config.version_metadata).binding });
  const actual = bindings
    .filter((binding) => !["plain_text", "json", "secret_text"].includes(String(binding.type)))
    .map(({ namespace_id: _id, ...binding }) => binding);
  if (!isDeepStrictEqual(sorted(actual), sorted(expected)))
    throw new Error("reset cannot reproduce deployed storage or service bindings");
  if (current.usage_model !== "standard") throw new Error("reset cannot reproduce the Worker usage model");
  if (!isDeepStrictEqual(current.tail_consumers ?? [], [])) throw new Error("reset cannot reproduce tail consumers");
  const endpoint = capture.endpoints[String(config.name)];
  if (!endpoint || !isDeepStrictEqual(endpoint.subdomain, { enabled: false, previews_enabled: false }))
    throw new Error("reset cannot reproduce Worker development endpoints");
  const routes = array(config.routes);
  if (
    routes.some((route) => route.custom_domain !== true) ||
    endpoint.domains.some(
      (domain) => domain.enabled !== true || domain.previews_enabled !== false || domain.environment !== "production",
    ) ||
    !isDeepStrictEqual(
      routes.map((route) => route.pattern).sort(),
      endpoint.domains.map((domain) => domain.hostname).sort(),
    )
  )
    throw new Error("reset cannot reproduce custom domains");
  try {
    config.vars = Object.fromEntries(
      bindings
        .filter((binding) => ["plain_text", "json"].includes(String(binding.type)))
        .map((binding) => [
          String(binding.name),
          binding.type === "json" ? JSON.parse(String(binding.json)) : binding.text,
        ]),
    );
  } catch {
    throw new Error("reset JSON binding is invalid");
  }
  config.compatibility_date = current.compatibility_date;
  config.compatibility_flags = current.compatibility_flags;
  config.preview_urls = false;
  for (const key of ["observability", "limits", "logpush", "tags"])
    if (current[key] !== undefined) config[key] = current[key];
  // Provider placement diagnostics are not accepted as Wrangler configuration.
  if (!isDeepStrictEqual(current.placement ?? {}, config.placement ?? {}))
    throw new Error("reset cannot reproduce Worker placement");
  config.triggers = { crons: endpoint.schedules };
  for (const container of array(config.containers ?? [])) {
    const apps = capture.applications.filter(
      (app) => app.name === `${config.name}-${String(container.class_name).toLowerCase()}`,
    );
    if (apps.length !== 1) throw new Error("reset container configuration is incomplete");
    const app = apps[0];
    const capacity = object(app.configuration);
    const disk = object(capacity.disk);
    const appObservability = app.observability;
    const containerObservability = capacity.observability;
    if (
      Object.keys(capacity).some(
        (key) =>
          ![
            "image",
            "vcpu",
            "memory",
            "memory_mib",
            "disk",
            "network",
            "command",
            "entrypoint",
            "runtime",
            "observability",
          ].includes(key),
      ) ||
      !isDeepStrictEqual(capacity.network, { assign_ipv6: "none", assign_ipv4: "none", mode: "private" }) ||
      !isDeepStrictEqual(capacity.command, []) ||
      !isDeepStrictEqual(capacity.entrypoint, []) ||
      capacity.runtime !== "firecracker" ||
      !isDeepStrictEqual(app.constraints, { tiers: [1, 2] }) ||
      (app.affinities !== undefined && !isDeepStrictEqual(app.affinities, {})) ||
      !["default", "durable_object"].includes(String(app.scheduling_policy)) ||
      app.rollout_active_grace_period !== 0 ||
      !isDeepStrictEqual(appObservability ?? containerObservability, { logs: { enabled: true } }) ||
      (appObservability != null &&
        containerObservability != null &&
        !isDeepStrictEqual(appObservability, containerObservability)) ||
      typeof capacity.vcpu !== "number" ||
      !isDeepStrictEqual(app.network, { bandwidth_limit_mbps: capacity.vcpu * 1000 }) ||
      !Number.isSafeInteger(capacity.memory_mib) ||
      !Number.isSafeInteger(disk.size_mb) ||
      !Number.isSafeInteger(app.max_instances)
    )
      throw new Error("reset cannot reproduce advanced container configuration");
    container.instance_type = { vcpu: capacity.vcpu, memory_mib: capacity.memory_mib, disk_mb: disk.size_mb };
    container.max_instances = app.max_instances;
  }
  return JSON.stringify(config);
}
