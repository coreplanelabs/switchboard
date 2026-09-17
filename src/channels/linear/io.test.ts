import { describe, expect, it, vi } from "vitest";
import { LinearChannelIO } from "./io.js";
import type { LinearApi } from "./api.js";

function fixture() {
  let now = 100;
  const api: LinearApi = {
    session: vi.fn(),
    activities: vi.fn(async () => []),
    activity: vi.fn(async () => {}),
    link: vi.fn(async () => {}),
  };
  const io = new LinearChannelIO({ api, sessionId: "s", appUserId: "bot", clock: () => now, warn: vi.fn() });
  return {
    api,
    io,
    tick: () => {
      now += 10_000;
    },
  };
}

describe("Linear channel output", () => {
  it("coalesces progress, adds the run link, and sends the answer as a native response", async () => {
    const { io, api, tick } = fixture();
    const status = await io.status({ title: "Working", link: { url: "https://bot.example/runs/r", label: "Run" } });
    status.update({ title: "Working", activity: { kind: "line", text: "Reading" } });
    status.update({ title: "Working", activity: { kind: "line", text: "Testing" } });
    tick();
    status.update({ title: "Working", activity: { kind: "command", tool: "bash", command: "npm test" } });
    await status.done({ title: "Done" });
    await io.reply("Tests pass. [PR](https://github.com/acme/api/pull/1)");
    expect(api.link).toHaveBeenCalledWith("s", { url: "https://bot.example/runs/r", label: "Run" });
    expect(api.activity).toHaveBeenCalledWith(
      "s",
      { type: "action", action: "bash", parameter: "npm test" },
      { ephemeral: true },
    );
    expect(vi.mocked(api.activity).mock.calls.at(-1)?.[1]).toEqual({
      type: "response",
      body: "Tests pass. [PR](https://github.com/acme/api/pull/1)",
    });
    expect(api.activity).toHaveBeenCalledTimes(3);
  });
  it("recovers conversation from immutable activities before the current prompt only", async () => {
    const { api } = fixture();
    vi.mocked(api.activities).mockResolvedValue([
      { id: "p1", at: 1, userId: "alice", type: "prompt", body: "first" },
      { id: "noise", at: 2, userId: "bot", type: "thought", body: "thinking" },
      { id: "a1", at: 3, userId: "bot", type: "elicitation", body: "Which repo?" },
      { id: "a-tied-future", at: 4, userId: "alice", type: "prompt", body: "a simultaneous later prompt" },
      { id: "current", at: 4, userId: "bob", type: "prompt", body: "acme/api" },
      { id: "future", at: 5, userId: "alice", type: "prompt", body: "also fix logout" },
    ]);
    const io = new LinearChannelIO({
      api,
      sessionId: "s",
      appUserId: "bot",
      triggeringActivityId: "current",
      clock: () => 100,
      warn: vi.fn(),
    });
    expect(await io.history()).toEqual([
      { role: "user", text: "first", at: 1 },
      { role: "assistant", text: "Which repo?", at: 3 },
    ]);
    vi.mocked(api.activities).mockResolvedValue([]);
    await expect(io.history()).rejects.toThrow("linear_prompt_not_visible");
  });
  it("posts explicit clarification and failed-run responses with their native activity types", async () => {
    const { io, api } = fixture();
    await io.offer!({
      id: "confirm",
      line: "repo onboard acme/api",
      risk: "Changes deployment",
      footer: "team",
      expiresAt: 1000,
    });
    expect(vi.mocked(api.activity).mock.calls[0]?.[1]).toMatchObject({ type: "elicitation" });
    io.runFinished!({ id: "r", status: "failed" });
    await io.reply("The tests failed.");
    expect(vi.mocked(api.activity).mock.calls.at(-1)?.[1]).toEqual({ type: "error", body: "The tests failed." });
  });
  it("keeps a failed progress update from preventing final delivery but propagates a failed final reply", async () => {
    const { io, api } = fixture();
    vi.mocked(api.activity).mockRejectedValueOnce(new Error("unavailable"));
    await io.status({ title: "Working" });
    await io.reply("Done");
    vi.mocked(api.activity).mockRejectedValueOnce(new Error("unavailable"));
    await expect(io.reply("Another answer")).rejects.toThrow("unavailable");
  });
});
