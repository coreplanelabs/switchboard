import { describe, expect, it } from "vitest";
import { validateModelOverride, validateProviders } from "./validate.js";
import type { AppConfig } from "../config.js";

// Feature: docs/reference/specs/model-proxy.md item 11 — metadata identity
// is an explicit operator fact, not an alias inferred from a display name.
describe("model catalog identity", () => {
  it("accepts an explicitly mapped bare alias through full provider validation without declaring a vendor", () => {
    const config = (overrides: unknown) =>
      ({
        providers: {
          gateway: {
            wire: "openai-chat",
            vendor: "model",
            catalog: "openrouter",
            models: { "display-alias": overrides },
          },
        },
      }) as unknown as AppConfig;
    const cfg = config({ catalogModel: "openai/gpt-5.3-codex" });
    expect(() => validateProviders(cfg, "fixture")).not.toThrow();
    expect(cfg.providers.gateway!.vendor).toBe("model");
    expect(Object.keys(cfg.providers.gateway!.models!)).toEqual(["display-alias"]);
    expect(() => validateProviders(config({ window: 400000 }), "fixture")).toThrow(/<vendor>\/<id>/);
    expect(() => validateProviders(config({ catalogModel: "../model" }), "fixture")).toThrow(/catalogModel/);
  });
  it("accepts exact catalog ids and rejects malformed identities by name", () => {
    for (const catalogModel of ["vendor/model", "direct-model"])
      expect(() => validateModelOverride("providers.gateway.models.alias", { catalogModel })).not.toThrow();
    for (const catalogModel of [
      null,
      1,
      false,
      {},
      "",
      " ",
      " vendor/model ",
      "/vendor/model",
      "vendor/../model",
      "vendor//model",
      "https://example/model",
      "vendor/model?secret",
      "vendor\\model",
    ])
      expect(() => validateModelOverride("providers.gateway.models.alias", { catalogModel })).toThrow(/catalogModel/);
    expect(() => validateModelOverride("model", { unrecognized: true })).toThrow(/unrecognized/);
  });
});
