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
};
