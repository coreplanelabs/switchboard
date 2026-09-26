import { randomBytes } from "node:crypto";
import { minutesToMs } from "../budgets.js";
import type { ExternalIdentity, PersonDirectory } from "./contract.js";
import {
  proofDigest,
  type AccessEvidence,
  type AccessProofProvider,
  type SlackPolicy,
  type SlackProofProvider,
} from "./humanProof.js";
import type { LinkCommand, LinkResult } from "./linkContract.js";

type Auth = LinkCommand["auth"];
export interface LinkBrowserSession {
  id: string;
  browser: string;
}
interface CeremonyDeps {
  directory: PersonDirectory;
  access: AccessProofProvider;
  slack: SlackProofProvider;
  now: () => number;
}
export interface LinkCallback {
  session: LinkBrowserSession;
  evidence: AccessEvidence;
  method: string;
  /** Exact endpoint without query, supplied by the future trusted HTTP adapter. */
  callbackUri: string;
  query: URLSearchParams;
}
const secret = () => randomBytes(32).toString("base64url");

/** Offline orchestration: no production registration, authorization consumer,
 * event/log sink, or credential persistence. The staged browser adapter protects
 * POSTs and transports the session in a secure HttpOnly cookie; body/query
 * session secrets must never substitute for that trusted transport. */
export class LinkCeremony {
  private readonly policy: SlackPolicy;
  private readonly cleanLocation: string;
  constructor(
    private readonly deps: CeremonyDeps,
    policy: SlackPolicy,
  ) {
    this.policy = { ...policy };
    this.cleanLocation = new URL("/", policy.callbackUri).href;
  }
  private async auth(evidence: AccessEvidence, browser: string): Promise<Auth | null> {
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(browser)) return null;
      const proof = await this.deps.access.verify(evidence);
      if (!proof || proof.kind !== "human" || proof.identity.tenant !== null || proof.expiresAt <= this.deps.now())
        return null;
      return {
        identity: { issuer: proof.identity.issuer, tenant: null, subject: proof.identity.subject },
        audience: proof.audience,
        browserHash: proofDigest(browser),
        expiresAt: proof.expiresAt,
        proofVersion: 1,
      };
    } catch {
      return null;
    }
  }
  private async link(command: LinkCommand): Promise<LinkResult> {
    try {
      return await this.deps.directory.link(command);
    } catch {
      return { status: "unavailable" };
    }
  }
  private async revision(identity: ExternalIdentity): Promise<number | null> {
    const result = await this.deps.directory.resolve(identity);
    return result.status === "unknown" ? 0 : result.status === "bound" ? result.binding.revision : null;
  }
  async begin(
    evidence: AccessEvidence,
  ): Promise<
    | { status: "started"; session: LinkBrowserSession; authorizationUrl: string; expiresAt: number }
    | { status: "invalid" | "unavailable" }
  > {
    try {
      const browser = secret(),
        state = secret(),
        nonce = secret();
      const auth = await this.auth(evidence, browser);
      if (!auth) return { status: "invalid" };
      const accessRevision = await this.revision(auth.identity);
      if (accessRevision === null) return { status: "invalid" };
      const authorizationUrl = await this.deps.slack.authorization({ policy: { ...this.policy }, state, nonce });
      if (!authorizationUrl) return { status: "unavailable" };
      const expiresAt = Math.min(this.deps.now() + minutesToMs(10), auth.expiresAt);
      const result = await this.link({
        action: "begin",
        auth,
        accessRevision,
        slackPolicy: this.policy,
        stateHash: proofDigest(state),
        nonceHash: proofDigest(nonce),
        expiresAt,
        resultExpiresAt: expiresAt + minutesToMs(10),
      });
      if (result.status !== "ok") return { status: "unavailable" };
      return {
        status: "started",
        session: { id: result.intent.id, browser },
        authorizationUrl,
        expiresAt: result.intent.expiresAt,
      };
    } catch {
      return { status: "unavailable" };
    }
  }
  async callback(input: LinkCallback) {
    // Never reflect a code, state, provider error, or query in the response.
    return {
      result: await this.exchange(input),
      response: {
        status: 303,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          Location: this.cleanLocation,
        },
      },
    };
  }
  private async exchange(input: LinkCallback): Promise<LinkResult> {
    let claimed: { id: string; auth: Auth; expectedRevision: number } | undefined;
    try {
      const auth = await this.auth(input.evidence, input.session.browser);
      if (
        !auth ||
        input.method !== "GET" ||
        input.callbackUri !== this.policy.callbackUri ||
        input.query.getAll("state").length !== 1 ||
        input.query.getAll("code").length !== 1 ||
        [...input.query.keys()].some((key) => key !== "code" && key !== "state")
      )
        return { status: "invalid" };
      const state = input.query.get("state")!,
        code = input.query.get("code")!;
      if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4096) return { status: "invalid" };
      const context = await this.link({ action: "inspect", id: input.session.id, auth });
      if (context.status !== "context") return context;
      const i = context.intent;
      if (i.state !== "pending") return { status: "already_claimed" };
      // Persisted policy is authoritative across reconstruction/config changes.
      if (
        i.slackPolicy.audience !== this.policy.audience ||
        i.slackPolicy.tenant !== this.policy.tenant ||
        i.slackPolicy.callbackUri !== this.policy.callbackUri
      )
        return { status: "invalid" };
      const result = await this.link({
        action: "claim",
        id: i.id,
        auth,
        expectedRevision: i.revision,
        stateHash: proofDigest(state),
      });
      if (result.status !== "claimed") return result;
      claimed = { id: i.id, auth, expectedRevision: result.intent.revision };
      const proof = await this.deps.slack.exchange({
        code,
        policy: { ...i.slackPolicy },
        nonceHash: i.nonceHash,
        createdAt: i.createdAt,
      });
      if (proof) {
        const expectedRevision = await this.revision(proof.identity);
        if (expectedRevision !== null) {
          // Explicit allowlist: even a replaceable provider cannot persist its
          // full response, profile, code, JWT, access token or refresh token.
          const staged = await this.link({
            action: "prove",
            ...claimed,
            proof: {
              identity: {
                issuer: proof.identity.issuer,
                tenant: proof.identity.tenant,
                subject: proof.identity.subject,
              },
              audience: proof.audience,
              callbackUri: proof.callbackUri,
              nonceHash: proof.nonceHash,
              expiresAt: proof.expiresAt,
              expectedRevision,
            },
          });
          if (staged.status === "ok") return staged;
        }
      }
    } catch {
      /* Provider and storage errors may contain credentials. Never expose them. */
    }
    // A process crash can leave exchanging durable; explicit interrupt below
    // recovers it without code replay. Concurrent callbacks never interrupt it.
    return claimed ? this.link({ action: "interrupt", ...claimed }) : { status: "unavailable" };
  }
  async interrupt(session: LinkBrowserSession, evidence: AccessEvidence): Promise<LinkResult> {
    const auth = await this.auth(evidence, session.browser);
    if (!auth) return { status: "invalid" };
    const context = await this.link({ action: "inspect", id: session.id, auth });
    if (context.status !== "context") return context;
    return this.link({ action: "interrupt", id: session.id, auth, expectedRevision: context.intent.revision });
  }
  async commit(
    session: LinkBrowserSession,
    evidence: AccessEvidence,
    expectedRevision: number,
    consent: boolean,
  ): Promise<LinkResult> {
    const auth = await this.auth(evidence, session.browser);
    return auth
      ? this.link({ action: "commit", id: session.id, auth, expectedRevision, consent })
      : { status: "invalid" };
  }
  /** Internal consent context. The browser adapter must project an allowlist,
   * never serialize this persisted validation context directly. */
  async inspect(session: LinkBrowserSession, evidence: AccessEvidence): Promise<LinkResult> {
    const auth = await this.auth(evidence, session.browser);
    return auth ? this.link({ action: "inspect", id: session.id, auth }) : { status: "invalid" };
  }
  async cancel(session: LinkBrowserSession, evidence: AccessEvidence, expectedRevision: number): Promise<LinkResult> {
    const auth = await this.auth(evidence, session.browser);
    return auth ? this.link({ action: "cancel", id: session.id, auth, expectedRevision }) : { status: "invalid" };
  }
  async read(session: LinkBrowserSession, evidence: AccessEvidence): Promise<LinkResult> {
    const auth = await this.auth(evidence, session.browser);
    return auth ? this.link({ action: "read", id: session.id, auth }) : { status: "invalid" };
  }
}
