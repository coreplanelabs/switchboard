import { describe, expect, it } from "vitest";
import type { SlackDirectAudience } from "../../core/types.js";
import { verifySlackDirectAudience } from "./directAudience.js";

const audience: SlackDirectAudience = {
  kind: "slack-unshared-im",
  channelId: "slack:DMAIN",
  userId: "slack:UALICE",
  threadKey: "slack:DMAIN:1.0",
};
const safe = {
  user: "UALICE",
  is_im: true,
  is_mpim: false,
  is_private: true,
  is_member: true,
  is_shared: false,
  is_ext_shared: false,
  is_org_shared: false,
  is_pending_ext_shared: false,
};
const clientFor = (channel: object, peerTeam = "TLOCAL") => ({
  auth: { test: async () => ({ team_id: "TLOCAL", user_id: "UBOT" }) },
  users: { info: async () => ({ user: { team_id: peerTeam } }) },
  conversations: { info: async () => ({ channel }) },
});

describe("Slack direct audience verification", () => {
  it("distinguishes a changed audience from unavailable verification without returning private facts", async () => {
    expect(await verifySlackDirectAudience(clientFor({ ...safe, is_shared: true }), audience)).toEqual({
      ok: false,
      code: "direct-audience-denied",
    });
    expect(
      await verifySlackDirectAudience(
        {
          ...clientFor(safe),
          auth: {
            test: async () => {
              throw new Error("private provider detail");
            },
          },
        },
        audience,
      ),
    ).toEqual({ ok: false, code: "direct-audience-unavailable" });
    expect(await verifySlackDirectAudience(clientFor({ ...safe, is_org_shared: undefined }), audience)).toEqual({
      ok: false,
      code: "direct-audience-unavailable",
    });
  });

  it("accepts only a fresh unshared DM with this requester", async () => {
    const client = clientFor(safe);
    expect(await verifySlackDirectAudience(client, audience)).toMatchObject({ ok: true });
    // Slack's documented conversations.info IM example omits most channel flags.
    expect(
      await verifySlackDirectAudience(clientFor({ is_im: true, user: "UALICE", is_org_shared: false }), audience),
    ).toMatchObject({ ok: true });
    expect(await verifySlackDirectAudience(clientFor(safe, "TEXTERNAL"), audience)).toMatchObject({ ok: false });
    expect(await verifySlackDirectAudience(clientFor(safe), { ...audience, userId: "slack:WALICE" })).toMatchObject({
      ok: false,
    });
    expect(
      await verifySlackDirectAudience(clientFor({ ...safe, user: "WALICE" }), { ...audience, userId: "slack:WALICE" }),
    ).toMatchObject({ ok: true });
    for (const changed of [
      { user: "UBOB" },
      { is_im: false },
      { is_mpim: true },
      { is_private: false },
      { is_member: false },
      { is_shared: true },
      { is_ext_shared: true },
      { is_org_shared: true },
      { is_pending_ext_shared: true },
    ]) {
      expect(await verifySlackDirectAudience(clientFor({ ...safe, ...changed }), audience)).toMatchObject({
        ok: false,
      });
    }
    expect(
      await verifySlackDirectAudience({ ...clientFor(safe), users: { info: async () => ({ user: {} }) } }, audience),
    ).toMatchObject({ ok: false });
    expect(
      await verifySlackDirectAudience(
        {
          ...clientFor(safe),
          conversations: {
            info: async () => {
              throw new Error("missing_scope");
            },
          },
        },
        audience,
      ),
    ).toMatchObject({ ok: false });
  });
});
