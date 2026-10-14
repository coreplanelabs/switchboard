import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { methodOf, readSource } from "./testing/sourceScan";

// The event-driven restore fallback (docs/reference/specs/execution.md item 27): POST /await-restore is one held request the
// Durable Object answers when its lifecycle state leaves `restoring` — the
// transition itself publishes to the waiter ledger (src/execution/
// restoreWaiters.ts, unit-tested there). No polling and no retry timer
// anywhere in the route. Plain Node runs the extracted route; the DO lifecycle
// checks read its source without loading the Cloudflare entry.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("POST /await-restore — the one held request while the resident restores (item 27)", () => {
  it("the route exists at operator scope, streams through the heartbeat convention and is dispatched to the handler", async () => {
    expect(source).toMatch(/"\/await-restore": \{ scope: "operator", method: "POST" \}/);
    expect(source).toMatch(/STREAMED_ROUTES: ReadonlySet<string> = new Set\(\[[^\]]*"\/await-restore"/);
    expect(source).toMatch(/case "\/await-restore":\s*\n\s*return await handleAwaitRestore\(env, body\);/);
    const start = source.indexOf("async function handleAwaitRestore(");
    expect(start, "worker.ts declares handleAwaitRestore").toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("\n}\n", start) + 2);
    const compiled = ts.transpileModule(handler, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let registered = true;
    let selected: { residentId: string } | Response | undefined = { residentId: "resident-secondary" };
    const registryStub = vi.fn(() => ({ getRecord: async () => (registered ? { resource: "repo:acme/api" } : null) }));
    const residentStub = vi.fn((_env: unknown, residentId: string) => ({
      awaitRestore: async () => ({ state: "warm", reason: residentId }),
    }));
    const handleAwaitRestore = runInNewContext(`${compiled}\nhandleAwaitRestore`, {
      Response,
      parseResource: (resource: unknown) =>
        typeof resource === "string" ? { resource } : { error: "resource must be a string" },
      registryStub,
      residentRouteFor: async () => selected,
      residentStub,
      json: (body: unknown, status: number) => Response.json(body, { status }),
      streamHeartbeatJson: async (pending: Promise<unknown>, payload: (value: unknown) => object) =>
        Response.json(payload(await pending)),
    });
    const body = { resource: "repo:acme/api", threadKey: "mcp:default:t" };
    expect(await (await handleAwaitRestore({}, body)).json()).toEqual({ state: "warm", reason: "resident-secondary" });
    selected = undefined;
    expect(await (await handleAwaitRestore({}, body)).json()).toEqual({ state: "warm", reason: "repo:acme/api" });
    selected = Response.json({ error: "resident address does not match the saved placement" }, { status: 409 });
    const refused = await handleAwaitRestore({}, body);
    expect([refused.status, await refused.json()]).toEqual([
      409,
      { error: "resident address does not match the saved placement" },
    ]);
    registered = false;
    const missing = await handleAwaitRestore({}, body);
    expect([missing.status, await missing.json()]).toEqual([404, { error: "repo:acme/api is not onboarded" }]);
    registryStub.mockClear();
    residentStub.mockClear();
    const invalid = await handleAwaitRestore({}, {});
    expect([invalid.status, await invalid.json()]).toEqual([400, { error: "resource must be a string" }]);
    expect(registryStub).not.toHaveBeenCalled();
    expect(residentStub).not.toHaveBeenCalled();
  });

  it("awaitRestore registers its waiter BEFORE reading the state, withdraws it and answers at once when the state is not restoring, and otherwise holds on the ledger — no timer, no poll", () => {
    const body = method("awaitRestore");
    const registered = body.indexOf("const held = this.restoreWaiters.hold();");
    const read = body.indexOf("const status = await this.getStatus();");
    expect(registered, "the waiter is registered").toBeGreaterThan(-1);
    expect(read, "the state is read").toBeGreaterThan(registered);
    expect(body).toMatch(
      /if \(status\.state !== "restoring"\) \{\s*held\.withdraw\(\);\s*return \{ state: status\.state, reason: status\.reason \};/,
    );
    expect(body).toMatch(/await held\.outcome/);
    expect(body).not.toMatch(/setTimeout|setInterval|sleep\(/);
  });

  it("setResidentState publishes the restore event on every transition OUT of `restoring`", () => {
    const body = method("setResidentState");
    expect(body).toMatch(
      /if \(state !== "restoring"\) this\.restoreWaiters\.publish\(\{ state, reason: residentText\(reason\) \}\);/,
    );
  });

  it("the ledger is the shared RestoreWaiters (its holding/publish semantics unit-tested at the source)", () => {
    expect(source).toMatch(/import \{ RestoreWaiters \} from "\.\.\/\.\.\/src\/execution\/restoreWaiters\.js";/);
    expect(residentDO).toMatch(/private restoreWaiters = new RestoreWaiters\(\);/);
  });
});
