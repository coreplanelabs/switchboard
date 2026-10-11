import { describe, expect, it } from "vitest";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { NO_GRANTS, type Actor } from "../core/authz/types.js";
import { matchesPredicate } from "../core/authz/predicate.js";
import {
  hasWorkViewScope,
  resolveWorkViewScope,
  withWorkViewScope,
  workReadPredicate,
  workViewModeFromCookie,
} from "./workViewScope.js";
const person = (id = "access:alice"): Actor => ({
  kind: "user",
  id,
  grants: NO_GRANTS,
  memberOfOrganizations: new Set(["installation"]),
});
const admin = (): Actor => ({ ...person(), grants: ALL_GRANTS });
describe("global work view scope", () => {
  it("defaults to the current owner and uses proved IDs only to narrow readable work", () => {
    const actor = person();
    const original = actor.grants;
    expect(hasWorkViewScope(actor)).toBe(false);
    const scope = resolveWorkViewScope(actor, {
      organization: "installation",
      ownerIds: ["access:alice", "slack:UALICE"],
    });
    expect(scope).toEqual({ mode: "mine", ownerIds: ["access:alice", "slack:UALICE"], canEveryone: false });
    withWorkViewScope(actor, scope);
    expect(hasWorkViewScope(actor)).toBe(true);
    const readable = { kind: "channels-in" as const, channelIds: new Set(["slack:C1"]) };
    const predicate = workReadPredicate(actor, readable);
    expect(matchesPredicate(predicate, { userId: "slack:UALICE", channelId: "slack:C1" })).toBe(true);
    expect(matchesPredicate(predicate, { userId: "slack:UBOB", channelId: "slack:C1" })).toBe(false);
    expect(matchesPredicate(predicate, { userId: "slack:UALICE", channelId: "slack:CPRIVATE" })).toBe(false);
    expect(actor.grants).toBe(original);
    expect(actor.self).toBeUndefined();
  });
  it("lets only the current original superuser select Everyone within its admitted organization", () => {
    const full = admin();
    expect(resolveWorkViewScope(full, { organization: "installation", mode: "everyone" })).toEqual({
      mode: "everyone",
      ownerIds: [],
      canEveryone: true,
    });
    expect(resolveWorkViewScope(person(), { organization: "installation", mode: "everyone" }).mode).toBe("mine");
    expect(resolveWorkViewScope(full, { organization: "other", mode: "everyone" }).mode).toBe("everyone");
    const withoutOrg = {
      ...full,
      grants: { ...ALL_GRANTS, organizations: new Set<string>() },
      memberOfOrganizations: new Set<string>(),
    };
    expect(resolveWorkViewScope(withoutOrg, { organization: "installation", mode: "everyone" }).mode).toBe("mine");
    const service = { ...full, kind: "service" as const };
    expect(resolveWorkViewScope(service, { organization: "installation", mode: "everyone" }).mode).toBe("mine");
  });
  it("keeps impersonation read-only and narrows to the selected person while retaining the real actor", () => {
    const original = admin();
    const viewed = { ...original, viewingAs: { id: "slack:UBOB", name: "Bob" }, onBehalfOf: person("slack:UBOB") };
    const scope = resolveWorkViewScope(viewed, {
      originalActor: original,
      organization: "installation",
      mode: "everyone",
      ownerIds: ["slack:UBOB"],
    });
    expect(scope).toEqual({
      mode: "person",
      ownerIds: ["slack:UBOB"],
      person: { id: "slack:UBOB", name: "Bob" },
      canEveryone: true,
    });
    withWorkViewScope(viewed, scope);
    expect(matchesPredicate(workReadPredicate(viewed, { kind: "all" }), { userId: "slack:UBOB" })).toBe(true);
    expect(matchesPredicate(workReadPredicate(viewed, { kind: "all" }), { userId: "access:alice" })).toBe(false);
    expect(viewed.id).toBe("access:alice");
  });
  it("treats cookies as preferences and refuses unknown mode words", () => {
    expect(workViewModeFromCookie("sb-data-view=everyone")).toBe("everyone");
    expect(workViewModeFromCookie("sb-data-view=person; sb-view-as=slack%3AUBOB")).toBe("mine");
    expect(workViewModeFromCookie("other=everyone")).toBe("mine");
  });
});
