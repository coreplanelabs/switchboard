import { describe, expect, it } from "vitest";
import { pointingActor } from "./pointingActor.js";
import { ACTORS, CHANNELS } from "./testing.js";

// The actor the `conversation:read` row is asked for (record 0037): the
// requester's identity with one membership, its origin channel, and none of
// its own grants — so a public channel passes by `member-of`'s public half, a
// private channel passes only when it IS the origin, and an admin's `all` is
// not consulted, because pointing at a thread is not an admin act.
describe("pointingActor — one membership, no grants", () => {
  it("keeps the identity and holds exactly the origin channel", () => {
    const a = pointingActor(ACTORS.member, CHANNELS.pub2.id);
    expect(a.kind).toBe(ACTORS.member.kind);
    expect(a.id).toBe(ACTORS.member.id);
    expect(a.grants.channels).toEqual(new Set([CHANNELS.pub2.id]));
    expect(a.grants.actions).toEqual(new Set());
    expect(a.grants.repos).toEqual(new Set());
  });

  it("an admin's `all` does not reach it", () => {
    const a = pointingActor(ACTORS.admin, CHANNELS.pub1.id);
    expect(a.grants.channels).toEqual(new Set([CHANNELS.pub1.id]));
    expect(a.grants.actions).not.toBe("all");
  });

  it("never mutates the principal", () => {
    const before = JSON.stringify({
      ...ACTORS.member,
      grants: { ...ACTORS.member.grants, channels: [...(ACTORS.member.grants.channels as Set<string>)] },
    });
    pointingActor(ACTORS.member, CHANNELS.priv.id);
    const after = JSON.stringify({
      ...ACTORS.member,
      grants: { ...ACTORS.member.grants, channels: [...(ACTORS.member.grants.channels as Set<string>)] },
    });
    expect(after).toBe(before);
  });

  it("drops onBehalfOf: the pointing question is about the requester alone", () => {
    const withPrincipal = { ...ACTORS.noGrants, onBehalfOf: ACTORS.admin };
    expect(pointingActor(withPrincipal, CHANNELS.pub1.id).onBehalfOf).toBeUndefined();
  });
});
