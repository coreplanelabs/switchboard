import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DepotCiAuthorizations, handleDepotCiAuthorization } from "./depotCiAuthorization.js";

const grant = {
  runId: "coding-run",
  repo: "acme/api",
  operation: { operation: "retry_failed" as const, workflowId: "workflow-one", expectedHead: "a".repeat(40) },
};

describe("Depot CI one-use authorization", () => {
  it("binds an immutable run, repository and exact operation and consumes only once", () => {
    const permits = new DepotCiAuthorizations();
    const mutable = structuredClone(grant);
    const permit = permits.issue(mutable, () => true, new AbortController().signal);
    mutable.repo = "other/private";
    mutable.runId = "other-run";
    mutable.operation.expectedHead = "b".repeat(40);
    expect(permits.consume("unknown")).toBeUndefined();
    expect(permits.consume(permit.ticket)).toEqual(grant);
    expect(permits.consume(permit.ticket)).toBeUndefined();
  });

  it("refuses expired, stopped, completed, revoked and restart-lost permits", () => {
    const permits = new DepotCiAuthorizations();
    const stopped = new AbortController();
    const timedOut = permits.issue(grant, () => true, stopped.signal);
    stopped.abort();
    expect(permits.consume(timedOut.ticket)).toBeUndefined();
    expect(() => permits.issue(grant, () => true, stopped.signal)).toThrow();
    const completed = permits.issue(grant, () => true, new AbortController().signal);
    completed.release();
    expect(permits.consume(completed.ticket)).toBeUndefined();
    let allowed = true;
    const revoked = permits.issue(grant, () => allowed, new AbortController().signal);
    allowed = false;
    expect(permits.consume(revoked.ticket)).toBeUndefined();
    allowed = true;
    expect(permits.consume(revoked.ticket)).toBeUndefined();
    const lost = permits.issue(grant, () => true, new AbortController().signal);
    expect(new DepotCiAuthorizations().consume(lost.ticket)).toBeUndefined();
    lost.release();
  });

  let server: Server | undefined;
  afterEach(() => server?.close());

  it("serves only a valid one-use permit over the callback without accepting caller authority", async () => {
    const permits = new DepotCiAuthorizations();
    server = createServer((req, res) => handleDepotCiAuthorization(req, res, permits));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const permit = permits.issue(grant, () => true, new AbortController().signal);
    const headers = { authorization: `Bearer ${permit.ticket}` };
    expect((await fetch(url, { headers })).status).toBe(405);
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer bridge-token" } })).status).toBe(404);
    const answer = await fetch(url, { method: "POST", headers, body: JSON.stringify({ repo: "other/private" }) });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual(grant);
    expect((await fetch(url, { method: "POST", headers })).status).toBe(404);

    const throws = permits.issue(
      grant,
      () => {
        throw new Error("private error");
      },
      new AbortController().signal,
    );
    const refused = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${throws.ticket}` } });
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain("private error");
    expect(permits.consume(throws.ticket)).toBeUndefined();
  });
});
