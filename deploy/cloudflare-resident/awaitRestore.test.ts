import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

// The event-driven restore fallback (docs/reference/specs/execution.md item 25;
// issue #1339's remaining half): POST /await-restore is one held request the
// Durable Object answers when its lifecycle state leaves `restoring` — the
// transition itself publishes to the waiter ledger (src/execution/
// restoreWaiters.ts, unit-tested there). No polling and no retry timer
// anywhere in the route. Plain Node, the entry read as text, never loaded,
// like rebindAttach.test.ts.

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));

function method(name: string): string {
  const body = methodOf(residentDO, name);
  expect(body, `worker.ts declares ResidentDO.${name}`).not.toBeNull();
  return body!;
}

describe("POST /await-restore — the one held request while the resident restores (item 25)", () => {
  it("the route exists at operator scope, streams through the heartbeat convention and is dispatched to the handler", () => {
    expect(source).toMatch(/"\/await-restore": \{ scope: "operator", method: "POST" \}/);
    expect(source).toMatch(/STREAMED_ROUTES: ReadonlySet<string> = new Set\(\[[^\]]*"\/await-restore"/);
    expect(source).toMatch(/case "\/await-restore":\s*\n\s*return await handleAwaitRestore\(env, body\);/);
    const start = source.indexOf("async function handleAwaitRestore(");
    expect(start, "worker.ts declares handleAwaitRestore").toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("\n}\n", start));
    // validation first, the 404 for a not-onboarded resource, then the held
    // request streamed (heartbeat whitespace + ONE JSON document over 200)
    expect(handler).toMatch(/const resource = parseResource\(body\.resource\);/);
    expect(handler).toMatch(/if \("error" in resource\) return json\(\{ error: resource\.error \}, 400\);/);
    expect(handler).toMatch(/if \(!record\) return json\(\{ error: `\$\{resource\.resource\} is not onboarded` \}, 404\);/);
    expect(handler).toMatch(/streamHeartbeatJson\(\s*residentStub\(env, resource\.resource\)\.awaitRestore\(\)/);
  });

  it("awaitRestore answers a non-restoring state at once and otherwise holds on the waiter ledger — no timer, no poll", () => {
    const body = method("awaitRestore");
    expect(body).toMatch(/if \(status\.state !== "restoring"\) return \{ state: status\.state, reason: status\.reason \};/);
    expect(body).toMatch(/await this\.restoreWaiters\.wait\(\)/);
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
