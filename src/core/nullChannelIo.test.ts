import { describe, expect, it } from "vitest";
import { nullChannelIO } from "./nullChannelIo.js";

// Feature: docs/reference/specs/run-history.md item 38 (the channel of a resumed
// run whose caller is gone) and docs/reference/specs/thread-admission.md item 6
// (a child thread the null channel opens, so a resumed parent's spawn is not
// refused for want of a thread).

describe("nullChannelIO", () => {
  it("replies are logged, never delivered; the status handle is inert; the history is empty", async () => {
    const lines: string[] = [];
    const io = nullChannelIO("slack:CX:1.0", (l) => lines.push(l));
    await io.reply("hello there");
    const handle = await io.status({ title: "👀" });
    handle.update({ title: "…" });
    await handle.done({ title: "✅" });
    expect(await io.history()).toEqual([]);
    expect(lines).toEqual(["[resume] slack:CX:1.0 reply (no channel to deliver to): 11 chars"]);
  });

  it("openThread hands back distinct keys and null channels, logging the lead's length and never its text", async () => {
    const lines: string[] = [];
    const io = nullChannelIO("slack:CX:1.0", (l) => lines.push(l));
    const first = await io.openThread!("↳ research child");
    const second = await io.openThread!("↳ another");
    expect(first.thread.threadKey).toMatch(/^slack:CX:1\.0\/child-[0-9a-f-]{36}$/);
    expect(second.thread.threadKey).not.toBe(first.thread.threadKey);
    await first.io.reply("child answer");
    expect(lines).toEqual([
      `[resume] slack:CX:1.0 opened child thread ${first.thread.threadKey} (no channel to post to): 16 chars`,
      `[resume] slack:CX:1.0 opened child thread ${second.thread.threadKey} (no channel to post to): 9 chars`,
      `[resume] ${first.thread.threadKey} reply (no channel to deliver to): 12 chars`,
    ]);
  });

  it("opens a stable, separate job thread for each coordinator unit across rebuilt handles", async () => {
    const first = await nullChannelIO("mcp:ops:task", () => {}).openThread!("unit one", "pipeline:unit-a");
    const retry = await nullChannelIO("mcp:ops:task", () => {}).openThread!("unit one", "pipeline:unit-a");
    const second = await nullChannelIO("mcp:ops:task", () => {}).openThread!("unit two", "pipeline:unit-b");
    expect(first.thread.threadKey).toBe(retry.thread.threadKey);
    expect(second.thread.threadKey).not.toBe(first.thread.threadKey);
    expect(first.io.openThread).toBeTypeOf("function");
  });

  it("keeps a long request's child key within the ledger limit", async () => {
    const parent = `mcp:${"c".repeat(128)}:${"t".repeat(115)}`;
    const first = await nullChannelIO(parent, () => {}).openThread!("unit", "pipeline:unit-a");
    const retry = await nullChannelIO(parent, () => {}).openThread!("unit", "pipeline:unit-a");
    expect(first.thread.threadKey).toBe(retry.thread.threadKey);
    expect(first.thread.threadKey.length).toBeLessThanOrEqual(256);
    expect(first.thread.threadKey).toMatch(/^mcp:c{128}:/);
  });
});
