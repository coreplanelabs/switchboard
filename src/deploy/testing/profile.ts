import type { StagingMaintenancePolicy } from "../residentMaintenance.js";
import type { PublishedImages } from "../images.js";
import type { DeploymentProfile } from "../profile.js";

/** A complete, valid deployment profile for tests — an installation that is
 *  nobody's, so no test pins a real account or hostname. */
export const TEST_PROFILE: DeploymentProfile = {
  account: "1234567890abcdef1234567890abcdef",
  zone: "example.test",
  workers: {
    memory: { script: "switchboard-memory", hostname: "switchboard-memory.example.test" },
    bot: { script: "switchboard", hostname: "switchboard.example.test" },
    resident: { script: "switchboard-resident", hostname: "switchboard-resident.example.test" },
    sandbox: { script: "switchboard-sandbox", hostname: "switchboard-sandbox.example.test" },
  },
  configSource: "config/config.production.yaml",
  restart: { deployer: "ops" },
  images: "build",
};

/** The same installation deploying a release's published images instead of building them. */
export const TEST_REGISTRY_PROFILE: DeploymentProfile = { ...TEST_PROFILE, images: "registry" };

/** The images a release published, for tests — a made-up owner, a made-up version. */
export const TEST_PUBLISHED_IMAGES: PublishedImages = {
  version: "1.2.3",
  names: {
    bot: "ghcr.io/example/switchboard",
    resident: "ghcr.io/example/switchboard-resident",
    sandbox: "ghcr.io/example/switchboard-sandbox",
  },
};

export const TEST_MAINTENANCE: StagingMaintenancePolicy = {
  schema: 1,
  stagingAccount: TEST_PROFILE.account,
  productionAccount: "abcdef1234567890".repeat(2),
  residentScript: "switchboard-staging-resident",
  residentOrigin: "https://resident-staging.example.test",
  fixtureSha256: "1".repeat(64),
  resources: ["repo:acme/api"],
  decisionSha256: "2".repeat(64),
  holdId: ["11111111", "1111", "4111", "8111", "111111111111"].join("-"),
  generation: 1,
  attempt: {
    id: ["22222222", "2222", "4222", "8222", "222222222222"].join("-"),
    controllerId: "selected-staging-controller",
    sourceCommit: "a".repeat(40),
    profileSha256: "3".repeat(64),
    configSha256: "4".repeat(64),
    deadline: 1_800_000_000_000,
  },
};

export const TEST_MAINTENANCE_PROFILE: DeploymentProfile = {
  ...TEST_PROFILE,
  workers: {
    ...TEST_PROFILE.workers,
    resident: { script: "switchboard-staging-resident", hostname: "resident-staging.example.test" },
  },
  residentMaintenance: TEST_MAINTENANCE,
};
