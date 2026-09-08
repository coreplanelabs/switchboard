import { inject } from "vue";
import type { Capabilities } from "@core/core/capabilities.js";
import { SeedKey } from "./seed";

// What is on in this installation, as the shell stamped it on the page's seed
// (src/core/capabilities.ts). The nav, the tabs and the docs link read THIS —
// never a page's own data — so a surface that is off has no link to it. A
// page with no seed (a mismatched island) has no capabilities either: null,
// which every reader treats as "off".

export function useCapabilities(): Capabilities | null {
  return inject(SeedKey, null)?.capabilities ?? null;
}
