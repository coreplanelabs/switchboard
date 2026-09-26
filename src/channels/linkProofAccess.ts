import { identitySchema } from "../core/identity/contract.js";
import type { AccessEvidence, AccessHumanProof, AccessProofProvider } from "../core/identity/humanProof.js";
import { JwksCache, verifyAccessJwt, type AccessConfig, type VerifyDeps } from "./accessAuth.js";
import { audienceValid, jwtParts, signingKeys, tokenTimes } from "./linkProofJwt.js";

/** Offline linking projection, deliberately not part of dashboard identity resolution.
 * Its private key-only cache cannot inherit keys from the less restrictive gate. */
export class AccessHumanProofAdapter implements AccessProofProvider {
  private readonly config: AccessConfig;
  private readonly deps: VerifyDeps;
  constructor(config: AccessConfig, deps: Pick<VerifyDeps, "now" | "fetchJwks">) {
    this.config = { ...config };
    this.deps = {
      now: deps.now,
      fetchJwks: async (url) => signingKeys(await deps.fetchJwks(url)),
      cache: new JwksCache(),
    };
  }
  async verify(evidence: AccessEvidence): Promise<AccessHumanProof | null> {
    try {
      if (
        evidence.strategy !== "access" ||
        evidence.viewAs !== undefined ||
        typeof evidence.token !== "string" ||
        !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(this.config.teamDomain) ||
        !this.config.aud
      )
        return null;
      const parts = jwtParts(evidence.token);
      if (!parts) return null;
      // Reuse the application verifier on this exact immutable JWT. Only AFTER
      // it succeeds do decoded claims become the retained proof metadata.
      const verified = await verifyAccessJwt(evidence.token, this.config, this.deps);
      if (!verified || !verified.sub || verified.commonName !== undefined) return null;
      const c = parts.claims;
      if (
        c.common_name !== undefined ||
        (c.type !== undefined && c.type !== "app") ||
        !audienceValid(c.aud, this.config.aud) ||
        verified.sub.trim() !== verified.sub
      )
        return null;
      const times = tokenTimes(c, this.deps.now());
      const identity = identitySchema.safeParse({ issuer: c.iss, tenant: null, subject: verified.sub });
      if (!times || !identity.success) return null;
      return { kind: "human", identity: { ...identity.data, tenant: null }, audience: this.config.aud, ...times };
    } catch {
      return null;
    }
  }
}
