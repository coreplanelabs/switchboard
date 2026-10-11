// Feature: docs/reference/specs/browser-home.md — explicit two-account consent through protected forms.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";
import { mountApp } from "../../src/testing/mount";
import { linkConsentFixtures } from "../../src/modules/account-linking/fixtures";
import Identities from "./Identities.vue";
enableAutoUnmount(afterEach);
describe("live identity settings", () => {
  it("shows unlink and recovery as fresh verification and keeps browser notices pending until protected acknowledgment", () => {
    const wrapper = mountApp(Identities, {
      seed: {
        page: "identities",
        title: "Identities",
        canWrite: true,
        accounts: [
          {
            identity: { issuer: "https://slack.com", tenant: "TDEMO", subject: "UDEMO" },
            state: "revoked",
            revision: 2,
          },
        ],
        view: {
          stage: "start",
          csrf: "link-csrf",
          operations: [
            { kind: "unlink", target: "slack", csrf: "unlink-csrf" },
            { kind: "recover", target: "slack", csrf: "recover-csrf" },
          ],
        },
        notices: [
          {
            id: "notice-browser",
            operation: { kind: "unlink", target: "slack" },
            outcome: "unlinked",
            at: 1000,
            csrf: "ack-csrf",
          },
        ],
        pendingNotices: 2,
      },
    });
    expect(wrapper.text()).toContain("UDEMO · Unlinked");
    expect(wrapper.text()).toContain("Recovery also requires identity administrator permission");
    const unlink = wrapper.get('form[data-action="unlink"]');
    expect(unlink.attributes("action")).toBe("/settings/identities/unlink");
    expect([...new FormData(unlink.element as HTMLFormElement)]).toEqual([
      ["csrf", "unlink-csrf"],
      ["target", "slack"],
    ]);
    const recovery = wrapper.get('form[data-action="recover"]');
    expect(recovery.attributes("action")).toBe("/settings/identities/recover");
    expect([...new FormData(recovery.element as HTMLFormElement)]).toEqual([
      ["csrf", "recover-csrf"],
      ["target", "slack"],
    ]);
    const acknowledge = wrapper.get('form[action="/settings/identities/acknowledge"]');
    expect([...new FormData(acknowledge.element as HTMLFormElement)]).toEqual([
      ["notice", "notice-browser"],
      ["csrf", "ack-csrf"],
    ]);
    expect(wrapper.text()).toContain("2 loaded account notices pending acknowledgment or delivery");
  });
  it("renders both proved accounts and allows only explicit closed-field native consent", async () => {
    const wrapper = mountApp(Identities, {
      seed: { page: "identities", title: "Identities", canWrite: true, view: linkConsentFixtures.consent },
    });
    expect(wrapper.text()).toContain("human-fixture");
    expect(wrapper.text()).toContain("UDEMO");
    expect(wrapper.text()).not.toContain("Live linking is disabled");
    const form = wrapper.get('form[data-action="commit"]');
    expect(form.attributes("action")).toBe("/settings/identities/commit");
    const unconsented = new Event("submit", { bubbles: true, cancelable: true });
    form.element.dispatchEvent(unconsented);
    expect(unconsented.defaultPrevented).toBe(true);
    await wrapper.get('input[type="checkbox"]').setValue(true);
    const consented = new Event("submit", { bubbles: true, cancelable: true });
    form.element.dispatchEvent(consented);
    expect(consented.defaultPrevented).toBe(false);
    expect([...new FormData(form.element as HTMLFormElement)]).toEqual([
      ["csrf", "fixture-commit-csrf"],
      ["revision", "3"],
      ["consent", "yes"],
    ]);
  });
  it("keeps view-as read-only and distinguishes missing flow from a completed link", () => {
    const readOnly = mountApp(Identities, {
      seed: {
        page: "identities",
        title: "Identities",
        canWrite: false,
        view: linkConsentFixtures.consent,
        viewingAs: { id: "slack:UOTHER", name: "Other" },
      },
    });
    expect(readOnly.get('button[type="submit"]').attributes("disabled")).toBeDefined();
    const completed = mountApp(Identities, {
      seed: { page: "identities", title: "Identities", canWrite: true, view: linkConsentFixtures.committed },
    });
    expect(completed.text()).toContain("Accounts linked");
    expect(completed.text()).not.toContain("fixture");
    const absent = mountApp(Identities, {
      seed: {
        page: "identities",
        title: "Identities",
        canWrite: false,
        view: null,
        unavailable: "Account verification requires SLACK_LINK_SECRET.",
      },
    });
    expect(absent.text()).toContain("SLACK_LINK_SECRET");
    expect(absent.find("form").exists()).toBe(false);
  });
});
