import type { GithubCredentialProvider } from "../factory.js";

/** A scoped in-memory credential boundary for tests that exercise dispatch or
 * relaunch behavior rather than process-secret discovery. */
export const TEST_GITHUB_CREDENTIALS: GithubCredentialProvider = {
  assertProfileIdentity: () => {},
  token: async (scope) => `ghs_test_${scope}`,
  credential: async (scope) => (scope === undefined ? null : { token: `ghs_test_${scope}`, expiresAtMs: null }),
};
