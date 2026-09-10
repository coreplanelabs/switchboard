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
