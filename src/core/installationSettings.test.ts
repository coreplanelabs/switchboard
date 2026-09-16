import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAppConfigText } from "../config.js";
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "./capabilities.js";
import { installationSettings, type InstallationSetting } from "./installationSettings.js";
import { CLOUD_FULL, MINIMAL } from "./testing/capabilityFixtures.js";

// Feature: docs/reference/specs/settings-page.md item 3 — the Installation tab's
// rows are a projection of the running config built by allow-list: every row is
// named in the function body, nothing is iterated off the config object, so no
// env var name, URL or bearer can reach the page whatever the config holds.

/** Every secret name the deploy manifest knows — none may appear in a rendered row. */
const MANIFEST_SECRETS: string[] = (
  JSON.parse(readFileSync(new URL("../../deploy/secrets.manifest.json", import.meta.url), "utf8")) as {
    secrets: { name: string }[];
  }
).secrets.map((s) => s.name);

/** A config that fills in every behaviour knob the projection names, beside the
 *  cloud-full fixture's Workers and env var names — the worst case for a leak. */
const EVERYTHING_YAML = `${CLOUD_FULL.yaml}routing:
  auto: false
  model: anthropic/router-model
  answer: text
references:
  enabled: true
ship:
  maxRounds: 5
  maxMinutes: 90
spawn:
  maxChildren: 2
slack:
  catchUp:
    enabled: true
    windowMinutes: 45
review:
  readingDiff:
    provider: meat
    meatModel: claude-opus-5
    meatTimeoutS: 120
selfImprovement:
  repo: acme/switchboard
  label: self-improvement
  minRuns: 3
  top: 2
delivery:
  repos: [acme/api]
  snapshot:
    everyMinutes: 30
artifacts:
  r2:
    accountId: acct-fixture
    bucket: switchboard-artifacts
  retentionDays: 14
`;

const rowsByKey = (rows: InstallationSetting[]) => new Map(rows.map((r) => [r.key, r]));

describe("installationSettings", () => {
  it("renders every named knob with its configured value, or the default marked as such", () => {
    const view = installationSettings(parseAppConfigText(EVERYTHING_YAML), ALL_CAPABILITIES);
    const rows = rowsByKey(view.settings);
    expect(rows.get("routing.auto")).toMatchObject({ value: "false", isDefault: false, how: "config" });
    expect(rows.get("routing.answer")).toMatchObject({ value: "text", isDefault: false });
    expect(rows.get("references.enabled")).toMatchObject({ value: "true", isDefault: false });
    expect(rows.get("ship.maxRounds")).toMatchObject({ value: "5", isDefault: false });
    expect(rows.get("spawn.maxChildren")).toMatchObject({ value: "2", isDefault: false });
    expect(rows.get("slack.catchUp.windowMinutes")).toMatchObject({ value: "45", isDefault: false });
    expect(rows.get("review.readingDiff.provider")).toMatchObject({ value: "meat", isDefault: false });
    expect(rows.get("runHistory.retentionDays")).toMatchObject({ value: "30", isDefault: false });
    expect(rows.get("runHistory.maxRuns")).toMatchObject({ value: "5000", isDefault: true });
    expect(rows.get("memory.limit")).toMatchObject({ value: "8", isDefault: true });
    expect(rows.get("artifacts.retentionDays")).toMatchObject({ value: "14", isDefault: false });
    expect(rows.get("selfImprovement.repo")).toMatchObject({ value: "acme/switchboard", isDefault: false });
    expect(rows.get("delivery.snapshot.everyMinutes")).toMatchObject({ value: "30", isDefault: false });
    expect(rows.get("defaults.agent")).toMatchObject({ value: "general", how: "runtime" });
    expect(rows.get("defaults.models.general")).toMatchObject({ value: "anthropic/general-model", how: "runtime" });
  });

  it("the minimal installation shows every knob at its default and every optional capability off", () => {
    const view = installationSettings(parseAppConfigText(MINIMAL.yaml), NO_CAPABILITIES);
    expect(view.settings.every((r) => r.key.startsWith("defaults.") || r.isDefault)).toBe(true);
    expect(rowsByKey(view.settings).get("routing.auto")).toMatchObject({ value: "true", isDefault: true });
    expect(rowsByKey(view.settings).get("memory.enabled")).toMatchObject({ value: "false", isDefault: true });
    const caps = new Map(view.capabilities.map((c) => [c.key, c]));
    expect(caps.get("mcp")).toMatchObject({ on: false });
    expect(caps.get("execution")).toMatchObject({ on: "local" });
    expect(caps.get("dashboardAuth")).toMatchObject({ on: "none" });
    for (const c of view.capabilities) expect(c.how.length).toBeGreaterThan(0);
  });

  it("never renders an env var name, a URL, a bearer, or a manifest secret name, whatever the config holds", () => {
    const view = installationSettings(parseAppConfigText(EVERYTHING_YAML), ALL_CAPABILITIES);
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/[A-Za-z]Env\b/);
    expect(text).not.toMatch(/https?:\/\//);
    // An env var's shape: SHOUTING_WITH_UNDERSCORES.
    expect(text).not.toMatch(/\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/);
    expect(text).not.toContain("example.test");
    for (const name of MANIFEST_SECRETS) expect(text).not.toContain(name);
  });

  it("is a function of its two inputs: the same config and capabilities render the same rows", () => {
    const a = installationSettings(parseAppConfigText(EVERYTHING_YAML), ALL_CAPABILITIES);
    const b = installationSettings(parseAppConfigText(EVERYTHING_YAML), ALL_CAPABILITIES);
    expect(a).toEqual(b);
  });
});
