import { describe, expect, it, vi } from "vitest";
import { namesOf } from "../core/names.js";
import { slackNames } from "./slackNames.js";
import type { NameLookupClient } from "./slack/lookups.js";

// Feature: docs/reference/specs/settings-page.md item 8 — the Slack `NameDirectory`: a
// `slack:U…` person and a `slack:C…`/`G…` channel are named through the adapter's cached
// lookups; a DM, a non-Slack id and a failed lookup answer undefined, so the surface shows
// the id it has. The lookups' own caches are per process, so the fixture ids are unique here.

function client(answers: { users?: Record<string, string>; channels?: Record<string, string> }): {
  client: NameLookupClient;
  usersInfo: ReturnType<typeof vi.fn>;
  channelsInfo: ReturnType<typeof vi.fn>;
} {
  const usersInfo = vi.fn(async ({ user }: { user: string }) => {
    const name = answers.users?.[user];
    if (name === undefined) throw new Error(`user_not_found ${user}`);
    return { user: { id: user, profile: { display_name: name } } };
  });
  const channelsInfo = vi.fn(async ({ channel }: { channel: string }) => {
    const name = answers.channels?.[channel];
    if (name === undefined) throw new Error(`channel_not_found ${channel}`);
    return { channel: { name } };
  });
  return { client: { users: { info: usersInfo }, conversations: { info: channelsInfo } }, usersInfo, channelsInfo };
}

describe("slackNames — the Slack NameDirectory", () => {
  it("names a slack:U person and a slack:C or slack:G channel through the adapter's lookups; a DM, a non-Slack id and an unknown id answer undefined without a call where the id says so", async () => {
    const {
      client: c,
      usersInfo,
      channelsInfo,
    } = client({
      users: { UNM1: "Ivy" },
      channels: { CNM1: "backend", GNM1: "leads" },
    });
    const names = slackNames(c);
    expect(await names.person("slack:UNM1")).toBe("Ivy");
    expect(await names.channel("slack:CNM1")).toBe("backend");
    expect(await names.channel("slack:GNM1")).toBe("leads");
    expect(await names.channel("slack:DNM1")).toBeUndefined(); // a DM has no name
    expect(await names.person("access:a1")).toBeUndefined();
    expect(await names.channel("http:ops")).toBeUndefined();
    expect(await names.person("slack:CNM1")).toBeUndefined(); // a channel is not a person
    expect(usersInfo).toHaveBeenCalledTimes(1);
    expect(channelsInfo).toHaveBeenCalledTimes(2);
    expect(await names.person("slack:UNM9")).toBeUndefined(); // the API says no: undefined, never a throw
  });

  it("namesOf asks once per distinct id, concurrently, and keeps only the answers", async () => {
    const { client: c, channelsInfo } = client({ channels: { CNM2: "design" } });
    const names = slackNames(c);
    const found = await namesOf(names.channel, ["slack:CNM2", "slack:CNM2", "slack:CNM3", "slack:DNM2"]);
    expect([...found]).toEqual([["slack:CNM2", "design"]]);
    expect(channelsInfo).toHaveBeenCalledTimes(2); // CNM2 once, CNM3 once; the DM never
  });
});
