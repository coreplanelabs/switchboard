import type { PersonDirectory } from "../identity/contract.js";
import { PERSONAL_TOKEN_WORKER_TIMEOUT_MS } from "../budgets.js";
import { resultSchema, type OrganizationCommand, type OrganizationResult, type OrganizationStore } from "./contract.js";
import { directoryResponses, type DirectoryCommand } from "./directoryTransport.js";

export class WorkerOrganizationStore implements OrganizationStore {
  readonly directory: PersonDirectory;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  constructor(
    private readonly options: { baseUrl: string; token: string; installation: string; fetch?: typeof fetch },
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!options.installation || !options.token) throw new Error("organization store requires installation and token");
    this.directory = {
      createPerson: async () =>
        directoryResponses.createPerson.parse(await this.directoryPost({ action: "createPerson" })),
      resolve: async (identity) =>
        directoryResponses.resolve.parse(await this.directoryPost({ action: "resolve", identity })),
      change: async (change) => directoryResponses.change.parse(await this.directoryPost({ action: "change", change })),
      receipts: async (identity) =>
        directoryResponses.receipts.parse(await this.directoryPost({ action: "receipts", identity })),
      link: async (command) => directoryResponses.link.parse(await this.directoryPost({ action: "link", command })),
    };
  }
  async execute(command: OrganizationCommand): Promise<OrganizationResult> {
    try {
      return resultSchema.parse(await this.post("/organization/execute", command));
    } catch {
      return { status: "unavailable" };
    }
  }
  private directoryPost(command: DirectoryCommand): Promise<unknown> {
    return this.post("/organization/directory", command);
  }
  private async post(path: string, command: unknown): Promise<unknown> {
    const body = JSON.stringify({ installation: this.options.installation, command });
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).length),
      },
      body,
      signal: AbortSignal.timeout(PERSONAL_TOKEN_WORKER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("organization store unavailable");
    return response.json();
  }
}
