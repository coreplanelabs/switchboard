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

  it("openThread hands back a derived key and a null channel of its own, logging the lead's length and never its text", async () => {
    const lines: string[] = [];
    const io = nullChannelIO("slack:CX:1.0", (l) => lines.push(l));
    const first = await io.openThread!("↳ research child");
    const second = await io.openThread!("↳ another");
    expect(first.thread).toEqual({ threadKey: "slack:CX:1.0/child-1" });
    expect(second.thread).toEqual({ threadKey: "slack:CX:1.0/child-2" });
    await first.io.reply("child answer");
    expect(lines).toEqual([
      "[resume] slack:CX:1.0 opened child thread slack:CX:1.0/child-1 (no channel to post to): 16 chars",
      "[resume] slack:CX:1.0 opened child thread slack:CX:1.0/child-2 (no channel to post to): 9 chars",
      "[resume] slack:CX:1.0/child-1 reply (no channel to deliver to): 12 chars",
    ]);
  });
});
