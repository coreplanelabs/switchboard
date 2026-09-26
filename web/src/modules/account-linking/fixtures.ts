import type { LinkConsentView } from "@core/channels/linkBrowser.js";

const consent = {
  stage: "awaiting-consent",
  revision: 3,
  expiresAt: 1_800_000_300_000,
  access: {
    issuer: "https://fixture.cloudflareaccess.com",
    tenant: null,
    subject: "human-fixture",
    audience: "fixture-application",
  },
  slack: { issuer: "https://slack.com", tenant: "TDEMO", subject: "UDEMO" },
  csrf: "fixture-commit-csrf",
  cancelCsrf: "fixture-cancel-csrf",
} satisfies LinkConsentView;

export const linkConsentFixtures = {
  start: { stage: "start", csrf: "fixture-start-csrf" },
  consent,
  pending: { ...consent, stage: "pending", revision: 1, slack: null },
  exchanging: { ...consent, stage: "exchanging", revision: 2, slack: null, interruptCsrf: "fixture-interrupt-csrf" },
  committed: { stage: "committed" },
  cancelled: { stage: "cancelled", restartCsrf: "fixture-restart-csrf" },
  expired: { stage: "expired", restartCsrf: "fixture-restart-csrf" },
  failed: { stage: "failed", restartCsrf: "fixture-restart-csrf" },
  unavailable: { stage: "unavailable" },
  resultExpired: { stage: "result-expired" },
} satisfies Record<string, LinkConsentView>;

/** Visual replacement only, never authentication. The HTTP tests use the real
 * staged adapter with replaceable Access/Slack proof providers and both stores. */
export function fixtureConsentAction(action: string): LinkConsentView {
  if (action === "begin") return structuredClone(consent);
  if (action === "commit") return { stage: "committed" };
  if (action === "cancel") return structuredClone(linkConsentFixtures.cancelled);
  if (action === "restart") return { stage: "start", csrf: "fixture-start-csrf" };
  return structuredClone(linkConsentFixtures.failed);
}
