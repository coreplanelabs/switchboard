import { createHash } from "node:crypto";
import type { LinkCommand } from "./linkContract.js";

/** Internal credentials go only to the selected verifier, never the directory. */
export interface AccessEvidence {
  strategy: string;
  token: unknown;
  viewAs?: unknown;
}
export interface AccessHumanProof {
  kind: "human";
  identity: { issuer: string; tenant: null; subject: string };
  audience: string;
  issuedAt: number;
  expiresAt: number;
}
export interface AccessProofProvider {
  verify(evidence: AccessEvidence): Promise<AccessHumanProof | null>;
}
export type SlackPolicy = Extract<LinkCommand, { action: "begin" }>["slackPolicy"];
export type SlackHumanProof = Omit<Extract<LinkCommand, { action: "prove" }>["proof"], "expectedRevision">;
export interface SlackProofRequest {
  code: string;
  policy: SlackPolicy;
  nonceHash: string;
  createdAt: number;
}
export interface SlackProofProvider {
  authorization(input: { policy: SlackPolicy; state: string; nonce: string }): Promise<string | null>;
  exchange(input: SlackProofRequest): Promise<SlackHumanProof | null>;
}

/** Only digests cross the durable state/nonce/browser boundary. */
export const proofDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
