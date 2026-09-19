import { describe, expect, it, vi } from "vitest";
import { mdToMrkdwn } from "./mrkdwn.js";
import { SlackIO } from "./slack.js";
import { childThreadLead } from "../core/dispatch/spawn.js";
import { REFUSAL_SENTENCES } from "../core/dispatch/reply.js";
import type { IncomingMessage } from "../core/types.js";
import { RAW_ACTOR_ID, flushOutboundViolations, guardOutbound, installOutboundGuard } from "./testing/outboundGuard.js";

installOutboundGuard();

// Feature: docs/reference/specs/slack-channel.md item 16 — wherever the bot
// prints a person's actor id into a Slack message, the adapter renders it as
// the mention Slack resolves (`<@U…>`), through the one renderer (mdToMrkdwn).
// The core prints the plain namespaced id (`slack:U…`); only this adapter
// turns it into platform syntax, so non-Slack surfaces keep the plain id.

/** A parent message with no display name: the lead falls back to the plain id
 *  (`slack:U…`), which the adapter must render as a mention. */
const PARENT_MSG: IncomingMessage = {
  channelId: "slack:C1",
  userId: "slack:U777AAA",
  threadKey: "slack:C1:1.0",
  text: "agent:ship do the thing",
};

describe("the actor-id mention renderer (mdToMrkdwn, docs/reference/specs/slack-channel.md item 16)", () => {
  it("renders a bare namespaced person id as the mention Slack resolves, punctuation kept", () => {
    expect(mdToMrkdwn("Ask slack:UADMIN.")).toBe("Ask <@UADMIN>.");
    expect(mdToMrkdwn("Ask slack:UADMIN, slack:UB2CD3.")).toBe("Ask <@UADMIN>, <@UB2CD3>.");
  });

  it("repairs a pre-wrapped `<@slack:U…>` into the same mention instead of escaping it to literal text", () => {
    expect(mdToMrkdwn("Ask <@slack:UADMIN>.")).toBe("Ask <@UADMIN>.");
  });

  it("the produced mention survives the prose escape (it is structural, never `&lt;@U…&gt;`)", () => {
    const out = mdToMrkdwn("🚫 `config set` is restricted. Ask slack:UADMIN.");
    expect(out).toBe("🚫 `config set` is restricted. Ask <@UADMIN>.");
    expect(out).not.toMatch(RAW_ACTOR_ID);
  });

  it("an id inside a code span or fence stays literal — code content is never rewritten", () => {
    expect(mdToMrkdwn("grants key `slack:UADMIN` in config.yaml")).toBe("grants key `slack:UADMIN` in config.yaml");
    expect(mdToMrkdwn("```\nslack:UADMIN\n```")).toContain("slack:UADMIN");
  });

  it("an id inside a longer token stays literal: a memory scope key, and a non-person id is untouched", () => {
    expect(mdToMrkdwn("scope user:slack:UADMIN")).toBe("scope user:slack:UADMIN");
    expect(mdToMrkdwn("channel slack:C123 and app slack:bot:B1")).toBe("channel slack:C123 and app slack:bot:B1");
  });

  it("an id inside a link URL never becomes a mention — the link structure is kept whole", () => {
    expect(mdToMrkdwn("[runs](https://x.test/runs?user=slack:UADMIN)")).toBe(
      "<https://x.test/runs?user=slack:UADMIN|runs>",
    );
  });

  it("an id inside a BARE URL's query or path never becomes a mention — the address is kept whole", () => {
    expect(mdToMrkdwn("see https://x.test/runs?user=slack:UADMIN now")).toBe(
      "see https://x.test/runs?user=slack:UADMIN now",
    );
    expect(mdToMrkdwn("see https://x.test/runs/slack:UADMIN/detail")).toBe(
      "see https://x.test/runs/slack:UADMIN/detail",
    );
  });

  it("the sibling composers' texts render clean: a refusal sentence and a child thread lead without a display name", () => {
    const refusal = REFUSAL_SENTENCES.agent_allowlist({ agent: "coding", adminsHint: "slack:UADMIN, slack:UB2CD3" });
    expect(mdToMrkdwn(refusal)).toContain("Ask <@UADMIN>, <@UB2CD3> for access.");
    const lead = childThreadLead(
      { agentName: "ship", msg: PARENT_MSG },
      { preset: "coding", prompt: "implement the unit" },
    );
    const out = mdToMrkdwn(lead);
    expect(out).toContain("<@U777AAA>");
    expect(out).not.toMatch(RAW_ACTOR_ID);
  });
});

// The suite-wide guard: no text the Slack adapter sends carries `<@slack:` or a
// bare `slack:U…` id. The scan lives in the shared client wrapper
// (`guardOutbound`, src/channels/testing/outboundGuard.ts) that the slack tests
// construct their fake Web API clients through, so EVERY payload the suite's
// adapter traffic produces is scanned — including send sites outside
// mdToMrkdwn's funnel (the status card's escapeMrkdwn path, SlackIO.offer).
// Here the guard is driven with the worst inputs the core composes, and tripped
// on purpose to prove it fails a violating payload.
describe("the outbound guard — no raw actor id in any text the Slack adapter sends (item 16)", () => {
  const ev = { channel: "C1", user: "UA", text: "hi", ts: "1.5", threadTs: "1.0", botUserId: "UBOT" };
  function guardedClient() {
    const payloads: unknown[] = [];
    const postMessage = vi.fn(async (opts: Record<string, unknown>) => {
      payloads.push(opts);
      return { ok: true, ts: "9.1" };
    });
    const update = vi.fn(async (opts: Record<string, unknown>) => {
      payloads.push(opts);
      return { ok: true };
    });
    const test = vi.fn(async () => ({ ok: true }));
    const c = guardOutbound({ chat: { postMessage, update }, auth: { test } } as unknown as ConstructorParameters<
      typeof SlackIO
    >[0]);
    return { c, payloads };
  }

  it("a refusal reply carrying the admins hint posts mentions, never raw ids", async () => {
    const { c, payloads } = guardedClient();
    await new SlackIO(c, ev).reply("🚫 `config set` is restricted. Ask slack:UADMIN, slack:UB2CD3.");
    expect((payloads[0] as { text: string }).text).toBe("🚫 `config set` is restricted. Ask <@UADMIN>, <@UB2CD3>.");
  });

  it("a child thread's lead naming the requester by id opens with a mention, never a raw id", async () => {
    const { c, payloads } = guardedClient();
    await new SlackIO(c, ev).openThread(
      childThreadLead({ agentName: "ship", msg: PARENT_MSG }, { preset: "coding", prompt: "implement the unit" }),
    );
    expect((payloads[0] as { text: string }).text).toContain("<@U777AAA>");
  });

  it("a reply quoting a pre-wrapped `<@slack:U…>` mention is repaired, never sent unresolvable", async () => {
    const { c, payloads } = guardedClient();
    await new SlackIO(c, ev).reply("Ask <@slack:UADMIN>.");
    expect((payloads[0] as { text: string }).text).toBe("Ask <@UADMIN>.");
  });

  it("the guard itself trips on a violating payload — the wrapped call throws and the violation is recorded", async () => {
    const send = guardOutbound({ f: vi.fn(async (_o: Record<string, unknown>) => ({ ok: true })) });
    await expect(async () => send.f({ text: "raw slack:UBAD id" })).rejects.toThrow(/outbound guard/);
    expect(flushOutboundViolations()).toHaveLength(1);
    await send.f({ text: "clean <@UGOOD> mention" });
    expect(flushOutboundViolations()).toHaveLength(0);
  });

  it("the guard's pattern mirrors the renderer's URL exclusion: an id in a bare URL is not a violation", () => {
    expect("see https://x.test/runs?user=slack:UADMIN").not.toMatch(RAW_ACTOR_ID);
    expect("grants key `slack:UADMIN`").not.toMatch(RAW_ACTOR_ID);
    expect("Ask slack:UADMIN.").toMatch(RAW_ACTOR_ID);
    expect("Ask <@slack:UADMIN>.").toMatch(RAW_ACTOR_ID);
  });
});
