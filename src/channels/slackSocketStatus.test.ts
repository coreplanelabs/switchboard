import { afterEach, describe, expect, it } from "vitest";
import {
  getSocketStatus,
  recordSocketConnected,
  recordSocketDisconnected,
  resetSocketStatus,
} from "./slackSocketStatus.js";

// Feature: features/slack-channel.md item 8 — /healthz reports the Socket Mode
// state, so "HTTP up, Slack not connected yet" (the cold-start window) and
// "socket silently dead" are both visible without container stdout.

describe("slackSocketStatus", () => {
  afterEach(() => resetSocketStatus());

  it("starts disconnected with no since/connects — the truth at process boot", () => {
    expect(getSocketStatus()).toEqual({ connected: false });
  });

  it("a connect records the state, the instant, and the lifetime connect count", () => {
    recordSocketConnected(1_700_000_000_000);
    expect(getSocketStatus()).toEqual({ connected: true, since: "2023-11-14T22:13:20.000Z", connects: 1 });
  });

  it("a disconnect flips connected and moves `since`; a reconnect bumps the count", () => {
    recordSocketConnected(1_700_000_000_000);
    recordSocketDisconnected(1_700_000_060_000);
    expect(getSocketStatus()).toEqual({ connected: false, since: "2023-11-14T22:14:20.000Z", connects: 1 });
    recordSocketConnected(1_700_000_120_000);
    expect(getSocketStatus().connects).toBe(2);
    expect(getSocketStatus().connected).toBe(true);
  });

  it("a disconnect before any connect carries no connects count", () => {
    recordSocketDisconnected(1_700_000_000_000);
    expect(getSocketStatus()).toEqual({ connected: false, since: "2023-11-14T22:13:20.000Z" });
  });

  it("returns a copy — mutating the result never touches the record", () => {
    recordSocketConnected(1_700_000_000_000);
    const a = getSocketStatus();
    a.connected = false;
    expect(getSocketStatus().connected).toBe(true);
  });
});
