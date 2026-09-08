import { describe, expect, it } from "vitest";
import { EXAMPLE_ACCOUNT, PROFILE_ENV, PROFILE_EXAMPLE_PATH, PROFILE_PATH } from "./profile.js";
import { loadProfileOnHost } from "./run.js";

// The host's profile loader: the env var wins, then the installation's own
// file, then the checked-in example — and the example is the example wherever
// it was read from, so `deploy all`'s refusal cannot be sidestepped by pointing
// the env var at it (or at a copy with the placeholder account).

describe("loadProfileOnHost", () => {
  it("reads the installation's own profile when no override is set", async () => {
    const loaded = await loadProfileOnHost({});
    expect(loaded).toMatchObject({ origin: "profile", path: PROFILE_PATH });
    expect(loaded.profile.account).not.toBe(EXAMPLE_ACCOUNT);
  });

  it("an override pointing at the example is still the example", async () => {
    const loaded = await loadProfileOnHost({ [PROFILE_ENV]: PROFILE_EXAMPLE_PATH });
    expect(loaded).toMatchObject({ origin: "example", path: PROFILE_EXAMPLE_PATH });
    expect(loaded.profile.account).toBe(EXAMPLE_ACCOUNT);
  });

  it("an override that names a missing file is an error naming the variable, never a fall-through", async () => {
    await expect(loadProfileOnHost({ [PROFILE_ENV]: "/nonexistent/profile.json" })).rejects.toThrow(
      `${PROFILE_ENV}=/nonexistent/profile.json: no such file`,
    );
  });
});
