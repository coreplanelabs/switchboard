import { describe, expect, it, vi } from "vitest";
import { githubRepoProbe } from "./githubRepoProbe.js";

// Feature: docs/reference/specs/execution.md item 18 — a `repo-cold` run's
// repository vet. The resolver's probe for the cold class asks GitHub, with the
// run's own credential, whether a bare `owner/name` is a repository this
// installation can see: a 404 is a refusal, anything GitHub did not settle is
// "unreachable" (could not verify — never a bind, never a refusal), and the
// resident registry is not involved at all.

function fetchAnswering(status: number, capture?: { url?: string; headers?: Headers }) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.headers = new Headers(init?.headers);
    }
    return new Response(status === 204 ? null : "{}", { status });
  }) as unknown as typeof fetch;
}

describe("githubRepoProbe", () => {
  it("asks GET /repos/<owner>/<name> with the run's credential as a bearer, and 200 is a visible repository", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const token = vi.fn(async () => "ghs_read");
    const probe = githubRepoProbe({ scope: "read", fetch: fetchAnswering(200, capture), token });
    await expect(probe("Acme/API")).resolves.toBe(true);
    expect(capture.url).toBe("https://api.github.com/repos/Acme/API");
    expect(capture.headers?.get("authorization")).toBe("Bearer ghs_read");
    expect(capture.headers?.get("accept")).toBe("application/vnd.github+json");
    expect(token).toHaveBeenCalledWith("read");
  });

  it("the scope asked for is the run's: a write-scoped run vets with a write token", async () => {
    const token = vi.fn(async () => "ghs_write");
    await githubRepoProbe({ scope: "write", fetch: fetchAnswering(200), token })("acme/api");
    expect(token).toHaveBeenCalledWith("write");
  });

  it("404 is a refusal: the repository is outside the installation or does not exist", async () => {
    const probe = githubRepoProbe({ scope: "read", fetch: fetchAnswering(404), token: async () => "ghs_read" });
    await expect(probe("acme/nope")).resolves.toBe(false);
  });

  it("any other non-2xx answer is no verdict — unreachable, never a bind and never a refusal", async () => {
    for (const status of [401, 403, 429, 500, 502]) {
      const probe = githubRepoProbe({ scope: "read", fetch: fetchAnswering(status), token: async () => "ghs_read" });
      await expect(probe("acme/api")).resolves.toBe("unreachable");
    }
  });

  it("a transport failure, and a credential that cannot be minted, are unreachable", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(githubRepoProbe({ scope: "read", fetch: failing, token: async () => "x" })("acme/api")).resolves.toBe(
      "unreachable",
    );
    const noMint = async () => {
      throw new Error("GitHub App token mint failed: 401");
    };
    await expect(
      githubRepoProbe({ scope: "read", fetch: fetchAnswering(200), token: noMint })("acme/api"),
    ).resolves.toBe("unreachable");
  });

  it("without a credential the vet is anonymous: no authorization header, so a private repository reads as 404", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const probe = githubRepoProbe({ scope: "read", fetch: fetchAnswering(200, capture), token: async () => null });
    await expect(probe("acme/public")).resolves.toBe(true);
    expect(capture.headers?.has("authorization")).toBe(false);
  });

  it("a slug that is not owner/name is refused before any request", async () => {
    const fetchSpy = fetchAnswering(200);
    const probe = githubRepoProbe({ scope: "read", fetch: fetchSpy, token: async () => "ghs_read" });
    await expect(probe("../../installation/repositories")).resolves.toBe(false);
    await expect(probe("acme")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
