import { describe, expect, it, vi } from "vitest";
import { WorkerOrganizationStore } from "./worker.js";

describe("organization Worker correlation", () => {
  it("keeps the admission failure and its request ID without retry or private command data", async () => {
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => logs.push(String(line)));
    const sent: Headers[] = [];
    const store = new WorkerOrganizationStore({
      baseUrl: "https://state.example",
      token: "PRIVATE_TOKEN",
      installation: "PRIVATE_INSTALLATION",
      fetch: async (_url, init) => {
        sent.push(new Headers(init?.headers));
        throw new DOMException("PRIVATE_ERROR", "TimeoutError");
      },
    });
    try {
      expect(
        await store.execute({ action: "identities", organization: "PRIVATE_ORG", personId: "PRIVATE_PERSON" }),
      ).toEqual({ status: "unavailable" });
      expect(sent.map((headers) => headers.get("x-switchboard-request-id"))).toEqual([
        expect.stringMatching(/^[a-f0-9-]{36}$/),
      ]);
      expect(logs.map((line) => JSON.parse(line))).toMatchObject([
        {
          event: "cloudflare.request.sent",
          requestId: sent[0]!.get("x-switchboard-request-id"),
          route: "/organization/execute",
          host: "state.example",
        },
        {
          event: "http.transport",
          id: sent[0]!.get("x-switchboard-request-id"),
          stage: "error",
          cause: "timeout",
          host: "state.example",
          method: "POST",
        },
      ]);
      expect(logs.join("\n")).not.toMatch(
        /PRIVATE_TOKEN|PRIVATE_INSTALLATION|PRIVATE_ORG|PRIVATE_PERSON|PRIVATE_ERROR/,
      );
    } finally {
      log.mockRestore();
    }
  });
});
