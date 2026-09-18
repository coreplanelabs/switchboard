import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import type { ClaimRequest } from "./types.js";
import { hostKeyOf, isHostKey, threadOf } from "./hostKey.js";

describe("the host key (run-history item 29; record 0060)", () => {
  it("hostKeyOf suffixes the thread key, threadOf inverts it, isHostKey tells the two apart", () => {
    expect(hostKeyOf("web:s:c9")).toBe("web:s:c9#host");
    expect(threadOf("web:s:c9#host")).toBe("web:s:c9");
    expect(threadOf("web:s:c9")).toBe("web:s:c9");
    expect(isHostKey("web:s:c9#host")).toBe(true);
    expect(isHostKey("web:s:c9")).toBe(false);
  });

  it("refuses a key the ledger's 256-character cap could not hold once suffixed", () => {
    const long = `web:s:${"c".repeat(246)}`; // 252 chars: 257 with the suffix
    expect(long.length).toBe(252);
    expect(() => hostKeyOf(long)).toThrow(/256/);
    const fits = `web:s:${"c".repeat(245)}`; // 251 chars: exactly 256 with the suffix
    expect(hostKeyOf(fits)).toHaveLength(256);
  });

  it("refuses a key that already carries the suffix", () => {
    expect(() => hostKeyOf("http:c:t1#host")).toThrow(/#host/);
  });
});

describe("the ledger under a host key (run-history item 29)", () => {
  const claim = (runId: string, threadKey: string, meta: Partial<ClaimRequest["meta"]> = {}): ClaimRequest => ({
    runId,
    threadKey,
    gen: "gen-a",
    leaseMs: 30_000,
    startedAt: 1,
    meta: { channelId: "web:s", userId: "access:u1", threadKey: "web:s:c9", ...meta },
    system: "",
    tools: [],
  });

  it("accepts a claim under the host key beside a child's claim on the thread itself", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    expect((await ledger.claim(claim("r-parent", hostKeyOf("web:s:c9"), { hosted: true, label: "ship" }))).ok).toBe(
      true,
    );
    expect((await ledger.claim(claim("r-child", "web:s:c9"))).ok).toBe(true);
  });

  it("refuses a second claim under the same host key as thread-live", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    expect((await ledger.claim(claim("r-parent", hostKeyOf("web:s:c9")))).ok).toBe(true);
    const second = await ledger.claim(claim("r-second", hostKeyOf("web:s:c9")));
    expect(second).toMatchObject({ ok: false, reason: "thread-live", live: { runId: "r-parent" } });
  });
});
