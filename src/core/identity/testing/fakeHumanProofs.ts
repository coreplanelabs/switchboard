import {
  proofDigest,
  type AccessEvidence,
  type AccessHumanProof,
  type AccessProofProvider,
  type SlackHumanProof,
  type SlackPolicy,
  type SlackProofProvider,
  type SlackProofRequest,
} from "../humanProof.js";

/** Deterministic fixture handles, not tokens; never constructed by production. */
export class FakeAccessProofProvider implements AccessProofProvider {
  constructor(private readonly fixtures: readonly { credential: string; proof: AccessHumanProof }[]) {}
  async verify(evidence: AccessEvidence): Promise<AccessHumanProof | null> {
    if (evidence.strategy !== "access" || evidence.viewAs !== undefined) return null;
    const fixture = this.fixtures.find((f) => f.credential === evidence.token);
    return fixture ? structuredClone(fixture.proof) : null;
  }
}
export class FakeSlackProofProvider implements SlackProofProvider {
  exchanges = 0;
  private readonly nonceHashes = new Set<string>();
  constructor(private readonly fixture: Omit<SlackHumanProof, "nonceHash">) {}
  private matches(policy: SlackPolicy): boolean {
    return (
      policy.audience === this.fixture.audience &&
      policy.tenant === this.fixture.identity.tenant &&
      policy.callbackUri === this.fixture.callbackUri
    );
  }
  async authorization(input: { policy: SlackPolicy; state: string; nonce: string }): Promise<string | null> {
    if (!this.matches(input.policy)) return null;
    this.nonceHashes.add(proofDigest(input.nonce));
    return `https://provider.test/authorize?${new URLSearchParams({ state: input.state, nonce: input.nonce })}`;
  }
  async exchange(input: SlackProofRequest): Promise<SlackHumanProof | null> {
    this.exchanges++;
    if (input.code !== "fixture-code" || !this.matches(input.policy) || !this.nonceHashes.delete(input.nonceHash))
      return null;
    return { ...structuredClone(this.fixture), nonceHash: input.nonceHash };
  }
}
