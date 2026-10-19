import { MINUTE_MS } from "../core/budgets.js";
import type { DeploymentProfile } from "./profile.js";
import { nativeInventoryRows } from "./stagingBootstrap.js";
import type { ResetBucket } from "./installationReset.js";

export interface CloudflareEnvelope {
  success: boolean;
  result: unknown;
  result_info?: {
    page?: number;
    total_pages?: number;
    total_count?: number;
    count?: number;
    cursor?: string;
    is_truncated?: boolean;
    delimited?: string[];
  };
}
const rows = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row)))
    throw new Error("reset inventory rows are malformed");
  return value;
};

/** Installation-scoped native operations. Mutation transport has no retry or redirect. */
export class ResetCloudflare {
  private readonly prefix: string;
  constructor(
    readonly account: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!/^[a-f0-9]{32}$/.test(account) || !token) throw new Error("reset account and credential are required");
    this.prefix = `/accounts/${account}`;
  }
  async response(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith(this.prefix + "/")) throw new Error("reset request left the selected account");
    const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
    if (!url.pathname.startsWith(`/client/v4${this.prefix}/`) || url.hash)
      throw new Error("reset request left the selected account");
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    return this.fetcher(url.href, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(MINUTE_MS),
    });
  }
  async request(path: string, method = "GET", data?: object): Promise<CloudflareEnvelope> {
    const response = await this.response(path, {
      method,
      ...(data ? { body: JSON.stringify(data), headers: { "content-type": "application/json" } } : {}),
    });
    if (!response.ok) throw new Error(`reset provider ${method} refused or unverified (HTTP ${response.status})`);
    if (method === "DELETE" && response.status === 204) return { success: true, result: null };
    const body: CloudflareEnvelope = await response.json();
    if (body.success !== true) throw new Error("reset provider acknowledgment is unverified");
    return body;
  }
  async list(path: string): Promise<CloudflareEnvelope> {
    const result: Record<string, unknown>[] = [];
    let page = 1;
    for (;;) {
      const body = await this.request(`${this.prefix}/${path}?per_page=100&page=${page}`);
      result.push(...rows(body.result));
      const info = body.result_info;
      if (info?.cursor) throw new Error("reset native pagination kind is unsupported");
      if (info?.total_pages !== undefined && info.total_pages > page) {
        page++;
        continue;
      }
      if (info?.total_count !== undefined && info.total_count !== result.length)
        throw new Error("reset native inventory is incomplete");
      return { success: true, result };
    }
  }
  async inventory(profile: DeploymentProfile) {
    if (profile.account !== this.account) throw new Error("reset profile account differs");
    const [scripts, applications, namespaces, workflows] = await Promise.all([
      this.list("workers/scripts"),
      this.list("containers/applications"),
      this.list("workers/durable_objects/namespaces"),
      this.list("workflows"),
    ]);
    const dependencies = Object.fromEntries(
      await Promise.all(
        Object.values(profile.workers).map(async (worker) => {
          const [references, tails] = await Promise.all([
            this.request(`${this.prefix}/workers/scripts/${worker.script}/references`),
            this.request(`${this.prefix}/workers/tails/by-consumer/${worker.script}`),
          ]);
          return [worker.script, { references: references.result, tails: tails.result }];
        }),
      ),
    );
    return { scripts, applications, namespaces, workflows, dependencies };
  }
  /** Prove each service origin belongs to its selected Worker before sending its bearer. */
  async serviceOrigins(profile: DeploymentProfile): Promise<Set<string>> {
    if (profile.account !== this.account) throw new Error("reset profile account differs");
    const domains = nativeInventoryRows(await this.list("workers/domains"));
    for (const worker of Object.values(profile.workers)) {
      const found = domains.filter((domain) => domain.hostname === worker.hostname);
      if (
        found.length !== 1 ||
        found[0].service !== worker.script ||
        found[0].zone_name !== (worker.zone ?? profile.zone) ||
        found[0].environment !== "production" ||
        found[0].enabled !== true
      )
        throw new Error("reset service origin is not owned by the selected Worker");
    }
    return new Set(Object.values(profile.workers).map((worker) => `https://${worker.hostname}`));
  }
  /** Apply the same ownership check to preview and final routing captures. */
  async verifyRouting(profile: DeploymentProfile, endpoints: Record<string, { domains: Record<string, unknown>[] }>) {
    if (profile.account !== this.account) throw new Error("reset profile account differs");
    const zones = new Set<string>();
    for (const worker of Object.values(profile.workers)) {
      const domains = endpoints[worker.script]?.domains;
      if (
        !domains ||
        domains.filter((domain) => domain.hostname === worker.hostname).length !== 1 ||
        new Set(domains.map((domain) => domain.hostname)).size !== domains.length ||
        domains.some(
          (domain) =>
            domain.service !== worker.script ||
            domain.zone_name !== (worker.zone ?? profile.zone) ||
            typeof domain.zone_id !== "string" ||
            domain.enabled !== true ||
            domain.environment !== "production",
        )
      )
        throw new Error("reset routing ownership is unverified");
      for (const domain of domains) zones.add(String(domain.zone_id));
    }
    const workers = new Set(Object.values(profile.workers).map((worker) => worker.script));
    for (const zone of zones) {
      if ((await this.zoneRoutes(zone)).some((route) => workers.has(String(route.script))))
        throw new Error("reset cannot reproduce legacy URL routes; use the declared custom domains");
    }
  }
  /** Zone IDs come from the selected Workers' account-owned custom domains. */
  async zoneRoutes(zone: string): Promise<Record<string, unknown>[]> {
    if (!/^[a-f0-9]{32}$/.test(zone)) throw new Error("reset routing zone is unverified");
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4/zones/${zone}/workers/routes`, {
      headers: { authorization: `Bearer ${this.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(MINUTE_MS),
    });
    if (!response.ok) throw new Error("reset routing inventory is unreadable");
    return nativeInventoryRows(await response.json());
  }
  async settings(profile: DeploymentProfile) {
    return Object.fromEntries(
      await Promise.all(
        Object.values(profile.workers).map(async (worker) => {
          const response = await this.request(`${this.prefix}/workers/scripts/${worker.script}/settings`);
          if (!response.result || typeof response.result !== "object")
            throw new Error("reset Worker settings are unreadable");
          return [worker.script, response.result as Record<string, unknown>];
        }),
      ),
    );
  }
  async bucket(name: string): Promise<ResetBucket> {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) throw new Error("invalid reset bucket");
    const objects: ResetBucket["objects"] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ per_page: "1000", ...(cursor ? { cursor } : {}) });
      const body = await this.request(`${this.prefix}/r2/buckets/${name}/objects?${query}`);
      const page = rows(body.result);
      for (const object of page) {
        if (
          typeof object.key !== "string" ||
          typeof object.etag !== "string" ||
          !object.etag ||
          typeof object.size !== "number" ||
          !Number.isSafeInteger(object.size) ||
          object.size < 0
        )
          throw new Error("reset object metadata is incomplete");
        objects.push({ key: object.key, etag: object.etag, size: object.size });
      }
      if (body.result_info?.delimited?.length) throw new Error("reset bucket listing omitted grouped keys");
      if (body.result_info?.is_truncated === true) {
        cursor = body.result_info.cursor;
        if (!cursor || cursors.has(cursor)) throw new Error("reset bucket listing cursor is incomplete");
        cursors.add(cursor);
        continue;
      }
      if (!body.result_info && page.length >= 1000) throw new Error("reset bucket pagination is unverified");
      if (new Set(objects.map((object) => object.key)).size !== objects.length)
        throw new Error("reset bucket listing repeated keys");
      return { name, objects: objects.sort((a, b) => a.key.localeCompare(b.key, "en")) };
    }
  }
  async objects(namespace: string): Promise<{ id: string; hasStoredData: boolean }[]> {
    if (!/^[a-f0-9]{32}$/.test(namespace)) throw new Error("invalid reset namespace");
    const objects: { id: string; hasStoredData: boolean }[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: "1000", ...(cursor ? { cursor } : {}) });
      const body = await this.request(
        `${this.prefix}/workers/durable_objects/namespaces/${namespace}/objects?${query}`,
      );
      const found = rows(body.result);
      for (const object of found) {
        if (
          typeof object.id !== "string" ||
          !/^[a-f0-9]{64}$/.test(object.id) ||
          typeof object.hasStoredData !== "boolean"
        )
          throw new Error("reset object census is incomplete");
        objects.push({ id: object.id, hasStoredData: object.hasStoredData });
      }
      cursor = body.result_info?.cursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error("reset object census repeated a cursor");
        cursors.add(cursor);
        continue;
      }
      if (found.length >= 1000 || new Set(objects.map((object) => object.id)).size !== objects.length)
        throw new Error("reset object census pagination is unverified");
      return objects.sort((a, b) => a.id.localeCompare(b.id));
    }
  }
  async removeObject(bucket: string, object: ResetBucket["objects"][number]) {
    if (object.key.split("/").some((part) => part === "." || part === ".."))
      throw new Error("reset object key cannot be represented safely");
    const key = object.key.split("/").map(encodeURIComponent).join("/");
    const response = await this.request(`${this.prefix}/r2/buckets/${bucket}/objects/${key}`, "DELETE");
    if (
      !response.result ||
      typeof response.result !== "object" ||
      !("key" in response.result) ||
      response.result.key !== object.key
    )
      throw new Error("reset object deletion acknowledgment is unverified");
  }
  async absent(profile: DeploymentProfile) {
    const names = new Set(Object.values(profile.workers).map((worker) => worker.script));
    const [scripts, apps, namespaces, workflows] = await Promise.all([
      this.list("workers/scripts"),
      this.list("containers/applications"),
      this.list("workers/durable_objects/namespaces"),
      this.list("workflows"),
    ]);
    if (
      nativeInventoryRows(scripts).some((row) => names.has(String(row.id))) ||
      nativeInventoryRows(namespaces).some((row) => names.has(String(row.script))) ||
      nativeInventoryRows(workflows).some((row) => names.has(String(row.script_name))) ||
      nativeInventoryRows(apps).some((row) => [...names].some((name) => String(row.name).startsWith(name + "-")))
    )
      throw new Error("old reset installation still exists; initialization refused");
  }
}

/** Compare configuration values, not replaced namespace IDs or deployment metadata. */
export function resetHostingSettings(
  settings: Record<string, Record<string, unknown>>,
  applications: Record<string, unknown>[] = [],
) {
  const workers = Object.fromEntries(
    Object.entries(settings)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([script, value]) => {
        if (!Array.isArray(value.bindings)) throw new Error("reset settings bindings are incomplete");
        const bindings = rows(value.bindings)
          .map(({ namespace_id: _namespace, ...binding }) => {
            if (["d1", "kv_namespace", "queue", "r2_data_catalog"].includes(String(binding.type)))
              throw new Error("reset found an unsupported persistent binding");
            return binding;
          })
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return [
          script,
          {
            bindings,
            compatibility_date: value.compatibility_date,
            compatibility_flags: value.compatibility_flags,
            usage_model: value.usage_model,
            tags: value.tags,
            observability: value.observability,
            limits: value.limits,
            placement: value.placement,
            logpush: value.logpush,
          },
        ];
      }),
  );
  const containers = applications
    .map((application) => {
      const configuration = application.configuration;
      if (!configuration || typeof configuration !== "object" || Array.isArray(configuration))
        throw new Error("reset container configuration is incomplete");
      // A rebuilt image has a new digest. The initializer proves the selected source commit.
      const { image: _image, ...capacity } = configuration as Record<string, unknown>;
      return {
        name: application.name,
        configuration: capacity,
        max_instances: application.max_instances,
        scheduling_policy: application.scheduling_policy,
        constraints: application.constraints,
        affinities: application.affinities,
        rollout_active_grace_period: application.rollout_active_grace_period,
        network: application.network,
        observability: application.observability,
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { workers, containers };
}
