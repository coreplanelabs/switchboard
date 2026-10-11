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
  canAcknowledge?: boolean;
  accounts?: {
    identity: import("../core/identity/contract.js").ExternalIdentity;
    state: "active" | "revoked" | "unknown";
    revision: number;
  }[];
  pendingNotices?: number;
  notices?: {
    id: string;
    outcome: import("../core/identity/linkContract.js").LinkAudit["outcome"];
    operation?: import("../core/identity/linkContract.js").IdentityOperation;
    at: number;
    csrf: string;
  }[];
  unavailable?: string;
}
