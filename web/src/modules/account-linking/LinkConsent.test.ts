import { afterEach, describe, expect, it } from "vitest";
import { mountApp } from "../../testing/mount";
import { routes } from "../../routes";
import LinkConsent from "./LinkConsent.vue";
import { linkConsentFixtures } from "./fixtures";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
});
describe("link consent fixture", () => {
  it("shows the verified pair and requires explicit consent", async () => {
    const wrapper = mountApp(LinkConsent, { props: { view: linkConsentFixtures.consent } });
    const component = wrapper.findComponent(LinkConsent);
    expect(wrapper.text()).toContain("human-fixture");
    expect(wrapper.text()).toContain("UDEMO");
    expect(wrapper.text()).toContain("TDEMO");
    expect(wrapper.text()).toContain("https://fixture.cloudflareaccess.com");
    expect(wrapper.text()).toContain("fixture-application");
    expect(wrapper.text()).toContain("Live linking is disabled");
    const form = wrapper.get('form[data-action="commit"]');
    expect(form.attributes("method")).toBe("post");
    expect(form.attributes("action")).toBe("/account-link/commit");
    expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeDefined();
    await form.trigger("submit");
    expect(component.emitted("submit")).toBeUndefined();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await form.trigger("submit");
    expect(component.emitted("submit")).toEqual([
      [{ action: "commit", fields: { csrf: "fixture-commit-csrf", revision: "3", consent: "yes" } }],
    ]);
    expect(wrapper.html()).not.toMatch(/name="(?:personId|team|email|token|browser|code)"/);
    wrapper.unmount();
  });
  it("offers a protected restart only for a terminal verification", async () => {
    for (const stage of ["cancelled", "failed", "expired"] as const) {
      const wrapper = mountApp(LinkConsent, { props: { view: linkConsentFixtures[stage] } });
      const form = wrapper.get('form[data-action="restart"]');
      expect(form.attributes("method")).toBe("post");
      expect(form.attributes("action")).toBe("/account-link/restart");
      await form.trigger("submit");
      expect(wrapper.findComponent(LinkConsent).emitted("submit")).toEqual([
        [{ action: "restart", fields: { csrf: "fixture-restart-csrf" } }],
      ]);
      wrapper.unmount();
    }
    for (const stage of ["pending", "exchanging", "consent", "committed", "unavailable", "resultExpired"] as const) {
      const wrapper = mountApp(LinkConsent, { props: { view: linkConsentFixtures[stage] } });
      expect(wrapper.find('form[data-action="restart"]').exists()).toBe(false);
      wrapper.unmount();
    }
  });
  it("renders every fixture state in both themes without a live route", async () => {
    for (const theme of ["light", "dark"]) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      for (const [name, view] of Object.entries(linkConsentFixtures)) {
        const wrapper = mountApp(LinkConsent, { props: { view } });
        expect(wrapper.text(), `${theme}/${name}`).toContain("Live linking is disabled");
        expect(wrapper.text(), `${theme}/${name}`).not.toMatch(/\battempts?\b/i);
        expect(wrapper.find('form[data-action="commit"]').exists()).toBe(view.stage === "awaiting-consent");
        if (view.stage === "awaiting-consent") {
          await wrapper.get('form[data-action="cancel"]').trigger("submit");
          expect(wrapper.findComponent(LinkConsent).emitted("submit")).toEqual([
            [{ action: "cancel", fields: { csrf: "fixture-cancel-csrf", revision: "3" } }],
          ]);
        }
        wrapper.unmount();
      }
    }
    expect(routes.some((r) => r.path.includes("account-link"))).toBe(false);
  });
});
