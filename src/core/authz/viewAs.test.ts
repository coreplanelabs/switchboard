// Feature: docs/reference/specs/authorization.md — wildcard grant patterns cannot name a person.
import { describe, expect, it } from "vitest";
import { isViewablePerson } from "./viewAs.js";

describe("viewable person IDs", () => {
  it("accepts named Slack and Access people without admitting wildcard patterns or nonhuman subjects", () => {
    expect(
      [
        "slack:UADMIN",
        "access:person-1",
        "access:*",
        "access:person*",
        "slack:*",
        "access:svc:robot",
        "access:loopback",
        "access:loopback:admin",
        "http:ops",
        "schedule:nightly",
      ].map(isViewablePerson),
    ).toEqual([true, true, false, false, false, false, false, false, false, false]);
  });
});
