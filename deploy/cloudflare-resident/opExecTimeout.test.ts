// The /op budget is the exec ceiling, not the per-command default: a repo's
// full suite routinely outlives 5 minutes, and the client already bounds its
// /op wait at BASH_TIMEOUT_MAX_MS — the server must not kill the run earlier.
// worker.ts runs only under workerd, so this is a source scan (see
// testing/sourceScan.ts), the same pattern as lifecycle.test.ts.
import { describe, expect, it } from "vitest";
import { readSource } from "./testing/sourceScan";

const worker = readSource("worker.ts");

describe("op exec budget (resident-repos item 38)", () => {
  it("bounds an /op run at the exec ceiling, matching the client's /op wait — never the 5-minute per-command default", () => {
    expect(worker).toMatch(/^const OP_EXEC_TIMEOUT_MS = BASH_TIMEOUT_MAX_MS;$/m);
    expect(worker).not.toMatch(/OP_EXEC_TIMEOUT_MS = BASH_TIMEOUT_MS\b/);
  });

  it("the op run itself is capped by OP_EXEC_TIMEOUT_MS", () => {
    expect(worker).toMatch(/threadRunCapped\(user, checkout, command, OP_EXEC_TIMEOUT_MS, EXEC_OUTPUT_CAP\)/);
  });
});
