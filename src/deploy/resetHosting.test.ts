import { describe, expect, it } from "vitest";
import { restoreHostingConfig, resetEndpointSettings, type ResetHostingCapture } from "./resetHosting.js";
import { resetHostingSettings } from "./resetCloudflare.js";

function fixture() {
  const rendered = JSON.stringify({
    name: "gateway",
    compatibility_date: "2026-08-01",
    vars: { REGION: "old" },
    durable_objects: { bindings: [{ name: "SERVER", class_name: "Server" }] },
    routes: [{ pattern: "gateway.example.test", custom_domain: true }],
    containers: [{ class_name: "Server", image: "selected-image", instance_type: "standard-2", max_instances: 1 }],
  });
  const capture: ResetHostingCapture = {
    settings: {
      gateway: {
        bindings: [
          { name: "SERVER", type: "durable_object_namespace", class_name: "Server", namespace_id: "old" },
          { name: "REGION", type: "plain_text", text: "west" },
          { name: "EXTRA", type: "json", json: '{"enabled":true}' },
          { name: "TOKEN", type: "secret_text" },
        ],
        compatibility_date: "2026-08-01",
        compatibility_flags: [],
        placement: {},
        logpush: false,
        observability: { enabled: true },
        usage_model: "standard",
        tail_consumers: [],
      },
    },
    applications: [
      {
        name: "gateway-server",
        max_instances: 3,
        configuration: {
          image: "old-image",
          vcpu: 1,
          memory: "6GiB",
          memory_mib: 6144,
          disk: { size_mb: 12000, size: "12GB" },
          network: { assign_ipv6: "none", assign_ipv4: "none", mode: "private" },
          command: [],
          entrypoint: [],
          runtime: "firecracker",
        },
        constraints: { tiers: [1, 2] },
        scheduling_policy: "default",
        rollout_active_grace_period: 0,
        observability: { logs: { enabled: true } },
        network: { bandwidth_limit_mbps: 1000 },
        health: { instances: { healthy: 2 } },
      },
    ],
    endpoints: {
      gateway: {
        domains: [
          {
            hostname: "gateway.example.test",
            zone_name: "example.test",
            id: "old-domain",
            environment: "production",
            enabled: true,
            previews_enabled: false,
          },
        ],
        schedules: ["*/10 * * * *"],
        subdomain: { enabled: false, previews_enabled: false },
      },
    },
  };
  return { rendered, capture };
}

describe("reset hosting restoration", () => {
  it("retains declared auxiliary domains and refuses an undeclared alias", () => {
    const { rendered, capture } = fixture();
    const config = JSON.parse(rendered);
    config.routes.push({ pattern: "git.gateway.example.test", custom_domain: true });
    capture.endpoints.gateway.domains.push({
      ...capture.endpoints.gateway.domains[0],
      hostname: "git.gateway.example.test",
    });
    expect(JSON.parse(restoreHostingConfig(JSON.stringify(config), capture)).routes).toEqual([
      { pattern: "gateway.example.test", custom_domain: true },
      { pattern: "git.gateway.example.test", custom_domain: true },
    ]);
    capture.endpoints.gateway.domains.push({
      ...capture.endpoints.gateway.domains[0],
      hostname: "unknown.example.test",
    });
    expect(() => restoreHostingConfig(JSON.stringify(config), capture)).toThrow("cannot reproduce custom domains");
  });
  it("retains deployed variables and capacity in the creation config without copying secret values", () => {
    const { rendered, capture } = fixture();
    expect(JSON.parse(restoreHostingConfig(rendered, capture))).toEqual({
      name: "gateway",
      compatibility_date: "2026-08-01",
      compatibility_flags: [],
      vars: { REGION: "west", EXTRA: { enabled: true } },
      durable_objects: { bindings: [{ name: "SERVER", class_name: "Server" }] },
      routes: [{ pattern: "gateway.example.test", custom_domain: true }],
      preview_urls: false,
      containers: [
        {
          class_name: "Server",
          image: "selected-image",
          instance_type: { vcpu: 1, memory_mib: 6144, disk_mb: 12000 },
          max_instances: 3,
        },
      ],
      observability: { enabled: true },
      logpush: false,
      triggers: { crons: ["*/10 * * * *"] },
    });
  });

  it("refuses unreproducible storage, domains and advanced container settings before creation", () => {
    for (const kind of ["storage", "domain", "capacity", "affinity", "pricing"] as const) {
      const { rendered, capture } = fixture();
      if (kind === "storage")
        (capture.settings.gateway.bindings as object[]).push({ name: "EXTERNAL", type: "service", service: "foreign" });
      if (kind === "domain")
        capture.endpoints.gateway.domains.push({
          hostname: "extra.example.test",
          enabled: true,
          environment: "production",
          previews_enabled: false,
        });
      if (kind === "capacity")
        (capture.applications[0].configuration as Record<string, unknown>).command = ["custom-entry"];
      if (kind === "affinity")
        capture.applications[0].affinities = {
          colocation: "datacenter",
          hardware_generation: "highest-overall-performance",
        };
      if (kind === "pricing") capture.settings.gateway.usage_model = "bundled";
      expect(() => restoreHostingConfig(rendered, capture)).toThrow("reset cannot reproduce");
    }
  });

  it("includes container placement preferences in the final hosting comparison", () => {
    const { capture } = fixture();
    capture.applications[0].affinities = {
      colocation: "datacenter",
      hardware_generation: "highest-overall-performance",
    };
    expect(resetHostingSettings(capture.settings, capture.applications).containers[0].affinities).toEqual({
      colocation: "datacenter",
      hardware_generation: "highest-overall-performance",
    });
  });

  it("compares hosting configuration independently of health counts and fresh domain identities", () => {
    const { capture } = fixture();
    const later = structuredClone(capture);
    later.applications[0].health = { instances: { healthy: 0 } };
    later.endpoints.gateway.domains[0].id = "new-domain";
    expect(resetHostingSettings(capture.settings, capture.applications)).toEqual(
      resetHostingSettings(later.settings, later.applications),
    );
    expect(resetEndpointSettings(later.endpoints)).toEqual({
      gateway: {
        schedules: ["*/10 * * * *"],
        subdomain: { enabled: false, previews_enabled: false },
        domains: [
          {
            hostname: "gateway.example.test",
            zone_name: "example.test",
            environment: "production",
            enabled: true,
            previews_enabled: false,
          },
        ],
      },
    });
  });
});
