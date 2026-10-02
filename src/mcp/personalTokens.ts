import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PERSONAL_TOKEN_WORKER_TIMEOUT_MS } from "../core/budgets.js";
import { isPersonalToken, type PersonalToken } from "../core/personalToken.js";
export { isPersonalToken, PERSONAL_TOKEN_DIGEST, personalSubject } from "../core/personalToken.js";

/** The bearer stays on the client. Only its digest crosses the approval page. */
export interface PersonalTokenStore {
  put(token: PersonalToken): Promise<void>;
  get(digest: string): Promise<PersonalToken | null>;
  list(subject: string): Promise<PersonalToken[]>;
  delete(digest: string, subject: string): Promise<boolean>;
}

export const digestBearer = (bearer: string): string => createHash("sha256").update(bearer).digest("hex");
export const newPersonalBearer = (): string => randomBytes(32).toString("hex");

export class InMemoryPersonalTokenStore implements PersonalTokenStore {
  private readonly tokens = new Map<string, PersonalToken>();
  async put(token: PersonalToken): Promise<void> {
    this.tokens.set(token.digest, { ...token });
  }
  async get(digest: string): Promise<PersonalToken | null> {
    return this.tokens.get(digest) ?? null;
  }
  async list(subject: string): Promise<PersonalToken[]> {
    return [...this.tokens.values()].filter((token) => token.subject === subject);
  }
  async delete(digest: string, subject: string): Promise<boolean> {
    const token = this.tokens.get(digest);
    return token?.subject === subject ? this.tokens.delete(digest) : false;
  }
}

/** Single-process installation store. The file contains digests, never bearers. */
export class FilePersonalTokenStore implements PersonalTokenStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  private read(): Record<string, PersonalToken> {
    if (!existsSync(this.path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([digest, value]) => isPersonalToken(value) && value.digest === digest) as [
        string,
        PersonalToken,
      ][],
    );
  }
  private write(tokens: Record<string, PersonalToken>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, `${JSON.stringify(tokens)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, this.path);
  }
  async put(token: PersonalToken): Promise<void> {
    const tokens = this.read();
    tokens[token.digest] = token;
    this.write(tokens);
  }
  async get(digest: string): Promise<PersonalToken | null> {
    return this.read()[digest] ?? null;
  }
  async list(subject: string): Promise<PersonalToken[]> {
    return Object.values(this.read()).filter((token) => token.subject === subject);
  }
  async delete(digest: string, subject: string): Promise<boolean> {
    const tokens = this.read();
    if (tokens[digest]?.subject !== subject) return false;
    delete tokens[digest];
    this.write(tokens);
    return true;
  }
}

export class WorkerPersonalTokenStore implements PersonalTokenStore {
  private readonly baseUrl: string;
  constructor(private readonly opts: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }
  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await (this.opts.fetch ?? fetch)(`${this.baseUrl}/config/personal-tokens/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PERSONAL_TOKEN_WORKER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`personal token store answered HTTP ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
  async put(token: PersonalToken): Promise<void> {
    await this.post("put", { token });
  }
  async get(digest: string): Promise<PersonalToken | null> {
    const result = await this.post("get", { digest });
    return isPersonalToken(result.token) ? result.token : null;
  }
  async list(subject: string): Promise<PersonalToken[]> {
    const result = await this.post("list", { subject });
    return Array.isArray(result.tokens) ? result.tokens.filter(isPersonalToken) : [];
  }
  async delete(digest: string, subject: string): Promise<boolean> {
    const result = await this.post("delete", { digest, subject });
    return result.removed === true;
  }
}
