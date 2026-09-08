import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebClient, type WebAPICallResult } from "@slack/web-api";
import { createSlackApp } from "./slack.js";
import { ACK_EMOJI } from "./slackCatchUp.js";
import { getCatchUpStatus, resetCatchUpStatus, REQUIRED_BOT_SCOPES } from "./slackCatchUpStatus.js";
import { getSocketStatus, resetSocketStatus } from "./slackSocketStatus.js";
import { dispatch, type CoreDeps } from "../core/dispatcher.js";

// Feature: features/slack-channel.md item 7 — reconnect catch-up wiring.
// Bolt-level harness: `createSlackApp` builds a real App on a real
// `SocketModeReceiver`, and the receiver's socket client is a plain
// EventEmitter that only dials out on `start()` — so emitting `connected` on
// it is exactly the event a live reconnect fires, and the hook's whole path
// (auth.test → scope check → catch-up scan → re-dispatch through `handle()`)
// runs against a fake Web API swapped onto `app.client`. Only `dispatch` is
// mocked: the run itself is the core's job, and the wiring claim ends at the
// hand-off.
vi.mock("../core/dispatcher.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../core/dispatcher.js")>();
  return { ...mod, dispatch: vi.fn(async () => {}) };
});

const BOT = "U0BOT";
const dispatchMock = vi.mocked(dispatch);

/** A fake Web API covering every endpoint the connected hook can reach. Each
 *  method is a vi.fn so tests assert which calls the emitted event caused. */
function fakeWebApi(historyMessages: object[]) {
  return {
    auth: {
      test: vi.fn(async () => ({
        ok: true,
        user_id: BOT,
        url: "https://test.slack.com/",
        response_metadata: { scopes: REQUIRED_BOT_SCOPES.join(",") },
      })),
    },
    users: {
      conversations: vi.fn(async () => ({ ok: true, channels: [{ id: "C1" }] })),
      info: vi.fn(async () => ({ ok: true, user: { name: "someone" } })),
    },
    conversations: {
      history: vi.fn(async () => ({ ok: true, messages: historyMessages })),
      replies: vi.fn(async () => ({ ok: true, messages: [] })),
      info: vi.fn(async () => ({ ok: true, channel: { name: "general" } })),
    },
    reactions: { add: vi.fn(async () => ({ ok: true })) },
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: "9999999999.000001" })),
      update: vi.fn(async () => ({ ok: true })),
    },
  };
}

/** Build the app exactly as production does (env tokens, real receiver) and
 *  swap the fake Web API onto `app.client` — the same object the connected
 *  hook and `handle()` use. */
function makeApp(config: object, api: ReturnType<typeof fakeWebApi>) {
  const deps = { config: { config } } as unknown as CoreDeps;
  const { app, receiver } = createSlackApp(deps);
  Object.assign(app.client as unknown as Record<string, unknown>, api);
  return { app, receiver };
}

describe("connected-hook wiring (Bolt-level harness)", () => {
  const envBefore = { app: process.env.SLACK_APP_TOKEN, bot: process.env.SLACK_BOT_TOKEN };

  beforeEach(() => {
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    // Bolt's App constructor verifies the token with an eager auth.test on
    // its own WebClient, BEFORE a test can swap the fake in — ground every
    // WebClient call at the transport seam so nothing leaves the process.
    // (bindApiCall captures apiCall at construction, so this must be stubbed
    // before makeApp runs; the per-endpoint fakes then shadow it.)
    vi.spyOn(WebClient.prototype, "apiCall").mockResolvedValue({
      ok: true,
      user_id: BOT,
      bot_id: "B0BOT",
    } as WebAPICallResult);
    dispatchMock.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.SLACK_APP_TOKEN = envBefore.app;
    process.env.SLACK_BOT_TOKEN = envBefore.bot;
    resetCatchUpStatus();
    resetSocketStatus();
    vi.restoreAllMocks();
  });

  it("registers exactly one connected hook by default, and emitting `connected` runs the scan against the Web API", async () => {
    const api = fakeWebApi([]);
    const { receiver } = makeApp({}, api);

    // The construction claim the old smoke made, now pinned by a unit test.
    expect(receiver.client.listenerCount("connected")).toBe(1);
    expect(receiver.client.listenerCount("disconnected")).toBe(1);

    receiver.client.emit("connected");

    // The hook is async fire-and-forget; the outcome record marks scan end.
    await vi.waitFor(() => expect(getCatchUpStatus().lastRunAt).toBeDefined());
    expect(api.auth.test).toHaveBeenCalled();
    expect(api.users.conversations).toHaveBeenCalledWith(
      expect.objectContaining({ types: "public_channel,private_channel" }),
    );
    expect(api.conversations.history).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1" }));
    expect(getCatchUpStatus()).toMatchObject({ channels: 1, missed: 0, skippedChannels: 0 });
    expect(getCatchUpStatus().error).toBeUndefined();
    // Full grant → the scope check records nothing.
    expect(getCatchUpStatus().missingScopes).toBeUndefined();
    // The same emit stamped the socket-state record for /healthz.
    expect(getSocketStatus()).toMatchObject({ connected: true, connects: 1 });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("re-dispatches a missed mention through handle(): 👀 ack, ⏱ note and one dispatch — and a second connect skips it via the seen-set", async () => {
    const ts = (Date.now() / 1000 - 120).toFixed(6); // 2 min ago: inside the window
    const api = fakeWebApi([{ ts, user: "UA", text: `<@${BOT}> hello there` }]);
    const { receiver } = makeApp({}, api);

    receiver.client.emit("connected");

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    // The re-dispatch went through handle(): immediate 👀 receipt…
    expect(api.reactions.add).toHaveBeenCalledWith({ channel: "C1", timestamp: ts, name: ACK_EMOJI });
    // …the late-pickup note in the message's thread…
    expect(api.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C1", thread_ts: ts, text: expect.stringContaining("⏱ Picked up") }),
    );
    // …and the hand-off to the core dispatcher, mention stripped, caught up.
    const [, msg] = dispatchMock.mock.calls[0];
    expect(msg).toMatchObject({ channelId: "slack:C1", threadKey: `slack:C1:${ts}`, text: "hello there" });
    expect(getCatchUpStatus()).toMatchObject({ channels: 1, missed: 1 });

    // A reconnect re-scans the same history, but the message is now in the
    // same-process seen-set: nothing dispatched or acked a second time.
    receiver.client.emit("connected");
    await vi.waitFor(() => expect(getCatchUpStatus().missed).toBe(0));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(api.reactions.add).toHaveBeenCalledTimes(1);
    expect(getSocketStatus()).toMatchObject({ connected: true, connects: 2 });
  });

  it("slack.catchUp.enabled: false removes the hook — no listeners, and `connected` causes no Web API call", async () => {
    const api = fakeWebApi([]);
    const { receiver } = makeApp({ slack: { catchUp: { enabled: false } } }, api);

    expect(receiver.client.listenerCount("connected")).toBe(0);
    expect(receiver.client.listenerCount("disconnected")).toBe(0);

    receiver.client.emit("connected");
    await new Promise((r) => setTimeout(r, 25));
    expect(api.auth.test).not.toHaveBeenCalled();
    expect(api.users.conversations).not.toHaveBeenCalled();
    expect(getCatchUpStatus().lastRunAt).toBeUndefined();
    // The socket-state record rides the same hook, so it stays cold too.
    expect(getSocketStatus()).toEqual({ connected: false });
  });
});
