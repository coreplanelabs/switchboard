import type { LinkConsentView } from "./linkBrowser.js";

/** Explicit opt-in using the installation's existing Access application. */
export interface BrowserIdentityLinkConfig {
  slackClientId: string;
  slackTeamId: string;
  slackClientSecretEnv: string;
}

/** The allowlisted consent projection contains no browser secret or OAuth credential. */
export interface IdentitySeed {
  page: "identities";
  view: LinkConsentView | null;
  canWrite: boolean;
  unavailable?: string;
}
