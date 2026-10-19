import { describe, expect, it } from "vitest";
import { ResetCloudflare, resetHostingSettings } from "./resetCloudflare.js";
import { TEST_PROFILE } from "./testing/profile.js";

const account = "a".repeat(32);
const page = (result: unknown, result_info?: object) =>
  Response.json({ success: true, result, ...(result_info ? { result_info } : {}) });

describe("reset Cloudflare boundary", () => {
  it("uses each Worker's hosting zone and keeps exact account and domain ownership checks", async () => {
    const profile = structuredClone({ ...TEST_PROFILE, account });
    profile.workers.memory!.zone = "memory.test";
    profile.workers.bot.zone = "bot.test";
    profile.workers.resident!.zone = "resident.test";
    profile.workers.sandbox!.zone = "sandbox.test";
    const domains = Object.values(profile.workers).map((worker) => ({
      hostname: worker.hostname,
      service: worker.script,
      zone_name: worker.zone ?? profile.zone,
      environment: "production",
      enabled: true,
    }));
    const client = new ResetCloudflare(account, "test-token", async () => page(domains));
    expect(await client.serviceOrigins(profile)).toEqual(
      new Set([
        "https://switchboard-memory.example.test",
        "https://switchboard.example.test",
        "https://switchboard-resident.example.test",
        "https://switchboard-sandbox.example.test",
      ]),
    );
    await expect(client.serviceOrigins({ ...profile, account: "b".repeat(32) })).rejects.toThrow("account differs");
    domains[0].zone_name = profile.zone;
    await expect(client.serviceOrigins(profile)).rejects.toThrow("not owned by the selected Worker");
  });
  it("proves service origins from account-owned domains and refuses a different Worker", async () => {
    const profile = { ...TEST_PROFILE, account };
    const domains = Object.values(profile.workers).map((worker) => ({
      hostname: worker.hostname,
      service: worker.script,
      zone_name: "example.test",
      environment: "production",
      enabled: true,
    }));
    const client = new ResetCloudflare(account, "test-token", async () => page(domains));
    expect(await client.serviceOrigins(profile)).toEqual(
      new Set([
        "https://switchboard.example.test",
        "https://switchboard-memory.example.test",
        "https://switchboard-resident.example.test",
        "https://switchboard-sandbox.example.test",
      ]),
    );
    domains[0].service = "foreign-worker";
    await expect(client.serviceOrigins(profile)).rejects.toThrow("not owned by the selected Worker");
  });
  it("checks effective zones in preview and final routing without accepting foreign or disabled domains", async () => {
    const profile = structuredClone({ ...TEST_PROFILE, account });
    profile.workers.memory!.zone = "memory.test";
    profile.workers.bot.zone = "bot.test";
    profile.workers.resident!.zone = "resident.test";
    profile.workers.sandbox!.zone = "sandbox.test";
    const endpoints = Object.fromEntries(
      Object.values(profile.workers).map((worker, i) => [
        worker.script,
        {
          domains: [
            {
              hostname: worker.hostname,
              service: worker.script,
              zone_name: worker.zone,
              zone_id: String(i + 1).repeat(32),
              enabled: true,
              environment: "production",
            },
          ],
        },
      ]),
    );
    const requests: string[] = [];
    const client = new ResetCloudflare(account, "test-token", async (input) => {
      requests.push(new URL(String(input)).pathname);
      return page([]);
    });
    await client.verifyRouting(profile, endpoints);
    expect(requests).toEqual([
      `/client/v4/zones/${"1".repeat(32)}/workers/routes`,
      `/client/v4/zones/${"2".repeat(32)}/workers/routes`,
      `/client/v4/zones/${"3".repeat(32)}/workers/routes`,
      `/client/v4/zones/${"4".repeat(32)}/workers/routes`,
    ]);
    delete profile.workers.memory!.zone;
    endpoints[profile.workers.memory!.script].domains[0].zone_name = profile.zone;
    await expect(client.verifyRouting(profile, endpoints)).resolves.toBeUndefined();
    for (const field of ["zone_name", "hostname", "environment", "enabled"] as const) {
      const bad = structuredClone(endpoints);
      Object.assign(bad[profile.workers.memory!.script].domains[0], {
        [field]: field === "enabled" ? false : "foreign",
      });
      await expect(client.verifyRouting(profile, bad)).rejects.toThrow("routing ownership is unverified");
    }
    const duplicate = structuredClone(endpoints);
    duplicate[profile.workers.memory!.script].domains.push(duplicate[profile.workers.memory!.script].domains[0]);
    await expect(client.verifyRouting(profile, duplicate)).rejects.toThrow("routing ownership is unverified");
    await expect(client.verifyRouting({ ...profile, account: "b".repeat(32) }, endpoints)).rejects.toThrow(
      "account differs",
    );
  });
  it("accepts a second owned Bot domain while retaining primary-host and ownership checks", async () => {
    const profile = { ...TEST_PROFILE, account };
    const endpoints = Object.fromEntries(
      Object.values(profile.workers).map((worker) => [
        worker.script,
        {
          domains: [
            {
              hostname: worker.hostname,
              service: worker.script,
              zone_name: profile.zone,
              zone_id: "1".repeat(32),
              enabled: true,
              environment: "production",
            },
          ],
        },
      ]),
    );
    const bot = endpoints[profile.workers.bot.script];
    bot.domains.push({ ...bot.domains[0], hostname: `git.${profile.workers.bot.hostname}` });
    const client = new ResetCloudflare(account, "test-token", async () => page([]));
    await expect(client.verifyRouting(profile, endpoints)).resolves.toBeUndefined();
    bot.domains[1].service = "foreign-worker";
    await expect(client.verifyRouting(profile, endpoints)).rejects.toThrow("routing ownership is unverified");
  });
  it("reads every bucket page including SDK backup keys and refuses an incomplete cursor", async () => {
    let malformed = false;
    const client = new ResetCloudflare(account, "test-token", async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("cursor"))
        return page([{ key: "resident/repo/state.json", size: 4, etag: "state" }], { is_truncated: false });
      return page([{ key: "backups/first/data.sqsh", size: 8, etag: "backup" }], {
        is_truncated: true,
        ...(malformed ? {} : { cursor: "next-page" }),
      });
    });
    expect(await client.bucket("gateway-resident-cache")).toEqual({
      name: "gateway-resident-cache",
      objects: [
        { key: "backups/first/data.sqsh", size: 8, etag: "backup" },
        { key: "resident/repo/state.json", size: 4, etag: "state" },
      ],
    });
    malformed = true;
    await expect(client.bucket("gateway-resident-cache")).rejects.toThrow("cursor is incomplete");
  });

  it("keeps slashes in an object key and refuses path traversal before deletion", async () => {
    const deleted: string[] = [];
    const client = new ResetCloudflare(account, "test-token", async (input, init) => {
      if (init?.method === "DELETE") deleted.push(String(input));
      return page({ key: "backups/safe & name/data.sqsh" });
    });
    await client.removeObject("gateway-resident-cache", {
      key: "backups/safe & name/data.sqsh",
      size: 8,
      etag: "backup",
    });
    await expect(
      client.removeObject("gateway-resident-cache", { key: "../another-resource", size: 8, etag: "bad" }),
    ).rejects.toThrow("cannot be represented safely");
    expect(deleted).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/gateway-resident-cache/objects/backups/safe%20%26%20name/data.sqsh`,
    ]);
  });

  it("preserves setting values while comparing new namespace IDs and rejects uncovered storage", () => {
    const before = {
      gateway: {
        compatibility_date: "2026-08-01",
        bindings: [
          { name: "CONFIG", type: "durable_object_namespace", class_name: "ConfigDO", namespace_id: "old" },
          { name: "REGION", type: "plain_text", text: "west" },
        ],
      },
    };
    const after = structuredClone(before);
    after.gateway.bindings[0].namespace_id = "fresh";
    expect(resetHostingSettings(after)).toEqual({
      workers: {
        gateway: {
          bindings: [
            { name: "CONFIG", type: "durable_object_namespace", class_name: "ConfigDO" },
            { name: "REGION", type: "plain_text", text: "west" },
          ],
          compatibility_date: "2026-08-01",
          compatibility_flags: undefined,
          observability: undefined,
          limits: undefined,
          placement: undefined,
          logpush: undefined,
        },
      },
      containers: [],
    });
    expect(resetHostingSettings(after)).toEqual(resetHostingSettings(before));
    expect(() => resetHostingSettings({ gateway: { bindings: [{ name: "DATA", type: "d1" }] } })).toThrow(
      "unsupported persistent binding",
    );
  });

  it("does not advance an uncertain provider deletion or leave the selected account", async () => {
    const paths: string[] = [];
    const client = new ResetCloudflare(account, "test-token", async (input) => {
      paths.push(String(input));
      return new Response("", { status: 503 });
    });
    await expect(client.request(`/accounts/${account}/workers/scripts/gateway`, "DELETE")).rejects.toThrow(
      "unverified (HTTP 503)",
    );
    await expect(client.request(`/accounts/${"b".repeat(32)}/workers/scripts/other`, "DELETE")).rejects.toThrow(
      "left the selected account",
    );
    await expect(
      client.request(`/accounts/${account}/../${"b".repeat(32)}/workers/scripts/other`, "DELETE"),
    ).rejects.toThrow("left the selected account");
    expect(paths).toEqual([`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/gateway`]);
  });
});
