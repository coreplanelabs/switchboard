import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebClient, type WebAPICallResult } from "@slack/web-api";
import { createSlackApp } from "./slack.js";
import { dispatchClick, type CoreDeps } from "../core/dispatcher.js";
import { NO_GRANTS } from "../core/authz/index.js";
import { guardOutbound, installOutboundGuard } from "./testing/outboundGuard.js";

installOutboundGuard();

// Feature: docs/reference/specs/slack-channel.md item 14 — the action intake's
// wiring. Bolt-level harness on the connected-hook test's pattern: `createSlackApp`
// builds a real App, and `app.processEvent` is exactly what the Socket Mode
// receiver calls with a `block_actions` payload once the Slack app's
// interactivity is on — so processing one here proves the `confirm.*`
// listener is registered and reached with the payload, the ack and the Web
// API client. Only the click's entry into the core is mocked.
vi.mock("../core/dispatcher.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../core/dispatcher.js")>();
  return { ...mod, dispatchClick: vi.fn(async () => ({ status: "completed" })) };
});

const BOT = "U0BOT";
const dispatchClickMock = vi.mocked(dispatchClick);

function blockActions(actionId: string) {
  return {
    type: "block_actions",
    user: { id: "UA", username: "a", team_id: "T1" },
    team: { id: "T1", domain: "t" },
    api_app_id: "A1",
    token: "",
    trigger_id: "1.2.3",
    response_url: "https://hooks.slack.test/actions/x",
    channel: { id: "C1", name: "general" },
    container: { type: "message", message_ts: "4.0", channel_id: "C1", thread_ts: "1.0", is_ephemeral: false },
    message: {
      type: "message",
      ts: "4.0",
      thread_ts: "1.0",
      text: "config set channel --models.coding anthropic/claude-opus-5",
      blocks: [
        {
          type: "section",
          block_id: "b1",
          text: { type: "mrkdwn", text: "`config set channel --models.coding anthropic/claude-opus-5`" },
        },
        {
          type: "actions",
          block_id: "b3",
          elements: [
            { type: "button", action_id: "confirm.run", value: "c-1", text: { type: "plain_text", text: "Run" } },
          ],
        },
      ],
    },
    actions: [
      {
        type: "button",
        block_id: "b3",
        action_id: actionId,
        action_ts: "4.5",
        value: "c-1",
        text: { type: "plain_text", text: "Run" },
      },
    ],
  };
}

describe("the confirm.* action intake — Bolt-level wiring (docs/reference/specs/slack-channel.md item 14)", () => {
  const envBefore = { app: process.env.SLACK_APP_TOKEN, bot: process.env.SLACK_BOT_TOKEN };

  beforeEach(() => {
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    // Bolt verifies the token with an eager auth.test on its own WebClient and
    // authorizes every event through it — ground every WebClient call at the
    // transport seam so nothing leaves the process.
    // Grounded at the transport seam AND guarded: every apiCall's payload is
    // scanned for a raw actor id like the other slack tests' fake clients.
    vi.spyOn(WebClient.prototype, "apiCall").mockImplementation(
      guardOutbound(async () => ({ ok: true, user_id: BOT, bot_id: "B0BOT" }) as WebAPICallResult),
    );
    dispatchClickMock.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.SLACK_APP_TOKEN = envBefore.app;
    process.env.SLACK_BOT_TOKEN = envBefore.bot;
    vi.restoreAllMocks();
  });

  it.each([
    ["confirm.run", "confirm"],
    ["confirm.cancel", "cancel"],
  ] as const)(
    "a `%s` block_actions payload processed by the App is acked and reaches dispatchClick as kind %s with the button's value",
    async (actionId, kind) => {
      const deps = { config: { config: {}, grantsFor: () => NO_GRANTS } } as unknown as CoreDeps;
      const { app } = createSlackApp(deps);
      const ack = vi.fn(async () => {});
      await app.processEvent({ body: blockActions(actionId), ack });
      expect(ack).toHaveBeenCalledTimes(1);
      expect(dispatchClickMock).toHaveBeenCalledTimes(1);
      const [handedDeps, click] = dispatchClickMock.mock.calls[0]!;
      expect(handedDeps).toBe(deps);
      expect(click).toMatchObject({
        kind,
        id: "c-1",
        actor: { kind: "user", id: "slack:UA", origin: { channelId: "slack:C1", threadKey: "slack:C1:1.0" } },
      });
    },
  );
});
