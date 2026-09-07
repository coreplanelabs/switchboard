import { describe, expect, it } from "vitest";
import { ALLOWED_LICENSES, EXCEPTIONS, evaluate } from "../scripts/licenses-check.mjs";

// The license gate's decision, over the shape license-checker emits. The CLI
// wrapper around it (`npm run licenses:check` in each package root) is proven
// by CI running it; what matters here is that the decision names exactly the
// packages outside the allowed set and honors the documented exceptions.

describe("licenses-check evaluate", () => {
  const report = {
    "zod@4.4.3": { licenses: "MIT", path: "/x/node_modules/zod" },
    "undici@8.10.0": { licenses: "MIT", path: "/x/node_modules/undici" },
    "lightningcss@1.33.0": { licenses: "MPL-2.0", path: "/x/node_modules/lightningcss" },
    "@scope/pkg@1.0.0": { licenses: "(MIT OR Apache-2.0)", path: "/x/node_modules/@scope/pkg" },
  };

  it("passes a report whose every license is in the allowed set", () => {
    expect(evaluate(report)).toEqual([]);
  });

  it("names a package outside the allowed set with its license and path", () => {
    const bad = { ...report, "viral@1.0.0": { licenses: "GPL-3.0", path: "/x/node_modules/viral" } };
    expect(evaluate(bad)).toEqual([{ id: "viral@1.0.0", licenses: "GPL-3.0", path: "/x/node_modules/viral" }]);
  });

  it("treats a missing or UNKNOWN license as outside the set", () => {
    const bad = { ...report, "mystery@0.1.0": { path: "/x/node_modules/mystery" } };
    expect(evaluate(bad).map((o) => o.id)).toEqual(["mystery@0.1.0"]);
  });

  it("skips a documented exception by package name, any version, scoped or not", () => {
    const withException = {
      ...report,
      "vaul-vue@0.4.1": { licenses: "UNKNOWN", path: "/x/node_modules/vaul-vue" },
      "@acme/odd@2.0.0": { licenses: "UNKNOWN", path: "/x/node_modules/@acme/odd" },
    };
    expect(evaluate(withException).map((o) => o.id)).toEqual(["@acme/odd@2.0.0"]);
    expect(evaluate(withException, { exceptions: { ...EXCEPTIONS, "@acme/odd": "MIT upstream" } })).toEqual([]);
  });

  it("accepts an OR expression when one alternative is allowed, and a list when every entry is", () => {
    const mixed = {
      "either@1.0.0": { licenses: "(GPL-3.0 OR MIT)" },
      "both@1.0.0": { licenses: ["MIT", "ISC"] },
      "neither@1.0.0": { licenses: ["MIT", "GPL-3.0"] },
    };
    expect(evaluate(mixed).map((o) => o.id)).toEqual(["neither@1.0.0"]);
  });

  it("the allowed set is the permissive family THIRD_PARTY_NOTICES.md documents, MPL-2.0 included", () => {
    for (const l of ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "MPL-2.0"]) {
      expect(ALLOWED_LICENSES).toContain(l);
    }
    expect(ALLOWED_LICENSES).not.toContain("GPL-3.0");
    expect(ALLOWED_LICENSES).not.toContain("UNKNOWN");
  });

  it("every exception explains the real license", () => {
    for (const [name, why] of Object.entries(EXCEPTIONS)) {
      expect(name.length).toBeGreaterThan(0);
      expect(why).toMatch(/MIT|Apache|BSD|ISC/);
    }
  });
});
