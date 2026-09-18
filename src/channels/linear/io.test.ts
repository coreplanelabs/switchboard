import { describe, expect, it, vi } from "vitest";
import { LinearChannelIO } from "./io.js";
import type { LinearApi } from "./api.js";

function fixture() {
  let now = 100;
  const api: LinearApi = {
    openThread: vi.fn(),
    workItems: vi.fn(),
    files: vi.fn(async () => []),
    canRead: vi.fn(async () => true),
    upload: vi.fn(),
    session: vi.fn(async () => ({ id: "s", appUserId: "bot" })),
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
  it("opens an isolated native child with the checked requester and a stable coordinator key", async () => {
    const { api, io } = fixture();
    vi.mocked(api.openThread).mockResolvedValue({
      organizationId: "org",
      sessionId: "child",
      url: "https://linear.app/session/child",
    });
    await expect(io.openThread("Review")).rejects.toThrow("linear_child_requester_required");
    expect(api.openThread).not.toHaveBeenCalled();
    await io.checkAccess("linear:org:alice");
    const child = await io.openThread("Review", { idempotencyKey: "instance/unit/review" });
    expect(child.thread).toEqual({ threadKey: "linear:org:child", sourceUrl: "https://linear.app/session/child" });
    const first = vi.mocked(api.openThread).mock.calls[0]![2].id;
    await io.openThread("Review", { idempotencyKey: "instance/unit/review" });
    expect(vi.mocked(api.openThread).mock.calls[1]![2].id).toBe(first);
    await io.openThread("Review", { idempotencyKey: "instance/other/review" });
    expect(vi.mocked(api.openThread).mock.calls[2]![2].id).not.toBe(first);
    await child.io.reply("Child result");
    expect(api.activity).toHaveBeenLastCalledWith("child", { type: "response", body: "Child result" }, undefined);
    vi.mocked(api.canRead).mockResolvedValue(false);
    await io.checkAccess("linear:org:bob");
    await expect(io.openThread("Review")).rejects.toThrow("linear_child_requester_required");
  });
  it("restores an initial mention's comment attachment when no user activity was created", async () => {
    const { api, io } = fixture();
    const url = "https://uploads.linear.app/org/log";
    vi.mocked(api.session).mockResolvedValue({
      id: "s",
      appUserId: "bot",
      issue: { id: "issue", identifier: "EX-1", title: "Fix it", teamId: "team" },
      comment: { body: `Inspect [log.txt](${url})` },
    });
    vi.mocked(api.activities).mockResolvedValue([
      { id: "a", at: 1, userId: "bot", type: "response", body: "I found the error." },
    ]);
    vi.mocked(api.files).mockResolvedValue([
      { url, name: "log.txt", document: { mediaType: "text/plain", data: "error details" } },
    ]);
    await io.checkAccess("linear:org:alice");
    const history = await io.history();
    expect(history[0]).toMatchObject({
      role: "user",
      text: expect.stringContaining("Inspect [log.txt]"),
      documents: [{ mediaType: "text/plain", data: "error details" }],
    });
  });
  it("rebuilds private history files for the checked requester, newest first without duplicating bytes", async () => {
    const { api, io } = fixture();
    const url = "https://uploads.linear.app/org/image";
    vi.mocked(api.activities).mockResolvedValue([
      { id: "old", at: 1, userId: "alice", type: "prompt", body: `![old](${url})` },
      { id: "answer", at: 2, userId: "bot", type: "response", body: "I see it." },
      { id: "new", at: 3, userId: "alice", type: "prompt", body: `![new](${url})` },
    ]);
    vi.mocked(api.files).mockResolvedValue([
      { url, name: "screen.png", image: { mediaType: "image/png", data: "bytes" } },
    ]);
    await expect(io.history()).rejects.toThrow("linear_file_requester_required");
    expect(api.files).not.toHaveBeenCalled();
    await io.checkAccess("linear:org:alice");
    const history = await io.history();
    expect(api.files).toHaveBeenCalledWith("s", "linear:org:alice", [url], true);
    expect(history[2]?.images).toEqual([{ mediaType: "image/png", data: "bytes" }]);
    expect(history[0]?.images).toBeUndefined();
    vi.mocked(api.canRead).mockResolvedValue(false);
    await io.checkAccess("linear:org:bob");
    await expect(io.history()).rejects.toThrow("linear_file_requester_required");
  });
  it("preserves an opening question when delegation created no initial user activity", async () => {
    const { api, io } = fixture();
    vi.mocked(api.session).mockResolvedValue({
      id: "s",
      appUserId: "bot",
      issue: { id: "issue", identifier: "EX-1", title: "Fix the build", teamId: "team" },
    });
    vi.mocked(api.activities).mockResolvedValue([
      { id: "q", at: 1, userId: "bot", type: "elicitation", body: "Which repository?" },
    ]);
    expect(await io.history()).toEqual([
      { role: "user", text: "Linear issue EX-1: Fix the build\n\n" },
      { role: "assistant", text: "Which repository?", at: 1 },
    ]);
  });
  it("asks for clarification as elicitation without a completion response", async () => {
    const { api, io } = fixture();
    await io.question("Which repository?");
    expect(api.activity).toHaveBeenCalledExactlyOnceWith(
      "s",
      { type: "elicitation", body: "Which repository?" },
      undefined,
    );
  });
  it("checks access for the transport requester on the bound session", async () => {
    const { api, io } = fixture();
    vi.mocked(api.canRead).mockResolvedValueOnce(false);
    expect(await io.checkAccess("linear:org:person")).toBe(false);
    expect(api.canRead).toHaveBeenCalledWith("s", "linear:org:person");
  });
  it("acknowledges a steered follow-up without announcing that the active run has completed", async () => {
    const { api, io } = fixture();
    await io.acknowledge("Your follow-up reached the active run.");
    expect(api.activity).toHaveBeenCalledWith(
      "s",
      { type: "thought", body: "Your follow-up reached the active run." },
      undefined,
    );
  });
  it("binds work-item identity and intersected grants outside the tool's input", async () => {
    const { api, io } = fixture();
    const grants = {
      actions: new Set(["work-items:read", "work-items:write"]),
      channels: "all" as const,
      repos: "all" as const,
    };
    const capability = io.workItems({
      kind: "user",
      id: "linear:org:person",
      grants,
      onBehalfOf: {
        kind: "user",
        id: "linear:org:other",
        grants: { ...grants, actions: new Set(["work-items:read"]) },
      },
    });
    await capability.request({ op: "get", id: "ENG-1" });
    expect(api.workItems).toHaveBeenCalledWith(
      "s",
      { id: "linear:org:person", actions: ["work-items:read"] },
      { op: "get", id: "ENG-1" },
    );
  });
  it("shares an uploaded image as native progress without closing the session", async () => {
    const { api, io } = fixture();
    vi.mocked(api.upload).mockResolvedValue({
      uploadUrl: "https://storage.example/file",
      assetUrl: "https://uploads.linear.app/file",
      headers: { "Content-Disposition": "attachment" },
    });
    const ticket = await io.uploadTicket({ name: "plot[1].png", size: 3 });
    expect(ticket).toMatchObject({ method: "PUT", headers: { "Content-Disposition": "attachment" } });
    expect(api.activity).not.toHaveBeenCalled();
    await ticket.complete("The plot");
    expect(api.activity).toHaveBeenCalledWith(
      "s",
      { type: "thought", body: "The plot\n\n![plot\\[1\\].png](<https://uploads.linear.app/file>)" },
      undefined,
    );
  });
  it("uploads inline bytes with signed headers and never shares a failed upload", async () => {
    const { api } = fixture();
    vi.mocked(api.upload).mockResolvedValue({
      uploadUrl: "https://storage.example/file",
      assetUrl: "https://uploads.linear.app/file",
      headers: { "Content-Type": "text/plain" },
    });
    const uploadFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const io = new LinearChannelIO({ api, sessionId: "s", clock: () => 1, warn: vi.fn(), uploadFetch });
    const file = { name: "report.txt", bytes: new Uint8Array([1, 2, 3]), lead: "Report" };
    await expect(io.attachFile(file)).rejects.toThrow("linear_upload_failed");
    expect(api.activity).not.toHaveBeenCalled();
    await io.attachFile(file);
    expect(uploadFetch).toHaveBeenCalledWith(
      "https://storage.example/file",
      expect.objectContaining({
        method: "PUT",
        redirect: "error",
        headers: { "Content-Type": "text/plain" },
        body: file.bytes,
      }),
    );
    expect(api.activity).toHaveBeenCalledWith(
      "s",
      { type: "thought", body: "Report\n\n[report.txt](<https://uploads.linear.app/file>)" },
      undefined,
    );
  });
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
