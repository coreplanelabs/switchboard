import type { GithubCredentialProvider } from "../factory.js";

/** Profile-validation seam for dispatch tests. */
export const TEST_GITHUB_CREDENTIALS: GithubCredentialProvider = {
  assertProfileIdentity: () => {},
};
