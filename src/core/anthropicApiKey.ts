// The Anthropic credential this process spends, as one getter
// (docs/reference/specs/reading-diff.md item 6). Every caller that spends against
// the same account — the `readingDiffAbridge` capability, meat's abridging call
// in src/core/meatProcess.ts — reads the key here: the first `type: anthropic`
// provider block's `apiKeyEnv` (default `ANTHROPIC_API_KEY`, the variable pi's
// own Anthropic adapter reads too), as a `Secret` from the process's secrets,
// revealed only where it crosses a boundary. Undefined when no Anthropic
// provider is configured or its variable is unset — callers fail by name.
// The getter lived in the native Anthropic adapter until record 0032's series
// deleted it; the run's own model calls no longer go through this process's
// key (the model proxy forwards them with it, src/channels/modelProxy.ts).

import type { Secret, Secrets } from "../secrets.js";
import { ANTHROPIC_API_KEY_ENV, wireOf, type ProviderConfig } from "./provider.js";

export function anthropicApiKey(providers: Record<string, ProviderConfig>, secrets: Secrets): Secret | undefined {
  const cfg = Object.values(providers).find((p) => wireOf(p) === "anthropic-messages");
  if (!cfg) return undefined;
  return secrets.named(cfg.apiKeyEnv ?? ANTHROPIC_API_KEY_ENV);
}
