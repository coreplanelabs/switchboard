import { describe, expect, it } from "vitest";
import { CHAT_OPEN_ACTIONS } from "../authz/grants.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import { registerStatusCommands, statusShow, type StatusCommandDeps, type StatusSnapshot } from "./status.js";

// Feature: docs/reference/specs/command-registry.md item 20 (`status.show`) — the
// process says which build it runs. Surfaced by the 1.16.0 release smoke: asked
// for its build commit in Slack, the bot could not answer, and the receipt had
// to rest on /healthz instead.

/** A plain Slack user: the open chat commands — `status:read` is one of them. */
const chat: Caller = callerWith("chat", "slack:UX", CHAT_OPEN_ACTIONS);

function bound(snapshot: StatusSnapshot) {
  const registry = new CommandRegistry<StatusCommandDeps>({ audit: () => {} });
  registerStatusCommands(registry);
  return bindCommands(registry, { status: { snapshot: () => snapshot } });
}

describe("status.show", () => {
  it("reports the version, the build commit and time, the process start, and the run counts the snapshot holds", async () => {
    const commands = bound({
      version: "1.16.0",
      commit: "16680b30c0ffee0000000000000000000000abcd",
      builtAt: "2026-09-10T16:52:53.000Z",
      startedAt: Date.UTC(2026, 8, 10, 16, 54, 0),
      inFlight: 3,
      draining: false,
    });
    const res = await commands.invoke("status.show", {}, chat);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toEqual({
      version: "1.16.0",
      commit: "16680b30c0ffee0000000000000000000000abcd",
      builtAt: "2026-09-10T16:52:53.000Z",
      startedAt: "2026-09-10T16:54:00.000Z",
      inFlight: 3,
      draining: false,
    });
    const text = renderText(commands.get("status.show")!, res.value);
    expect(text).toBe(
      [
        "Switchboard 1.16.0 · build 16680b30 (built 2026-09-10T16:52:53.000Z)",
        "started 2026-09-10T16:54:00.000Z · 3 runs in flight · not draining",
      ].join("\n"),
    );
    expect(statusShow).toMatchObject({ id: "status.show", action: "status:read", effect: "read" });
  });

  it("a process nothing stamped says so instead of inventing a commit; an unknown start is left out", async () => {
    const commands = bound({ version: "0.0.0-dev", commit: "unknown", inFlight: 0, draining: true });
    const res = await commands.invoke("status.show", {}, chat);
    if (!res.ok) throw new Error(res.message);
    expect(res.value).toEqual({ version: "0.0.0-dev", commit: "unknown", inFlight: 0, draining: true });
    const text = renderText(commands.get("status.show")!, res.value);
    expect(text).toBe(
      ["Switchboard 0.0.0-dev · build unknown (nothing stamped this process)", "0 runs in flight · draining"].join(
        "\n",
      ),
    );
  });

  it("is a read every Slack user holds: a caller with only the open chat actions runs it, one without `status:read` is refused", async () => {
    const commands = bound({ version: "1.16.0", commit: "unknown", inFlight: 1, draining: false });
    const stranger: Caller = callerWith("chat", "slack:UY", ["help:read"]);
    const refused = await commands.invoke("status.show", {}, stranger);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error).toBe("unauthorized");
    expect(CHAT_OPEN_ACTIONS).toContain("status:read");
    const allowed = await commands.invoke("status.show", {}, chat);
    if (!allowed.ok) throw new Error(allowed.message);
    expect(renderText(commands.get("status.show")!, allowed.value)).toContain("1 run in flight");
  });
});
