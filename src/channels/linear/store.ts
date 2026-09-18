/** Credentials belong to the transport, never to the model or its executor. */
export interface LinearInstallation {
  organizationId: string;
  appUserId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Original installation time, preserved across refreshes. */
  installedAt?: number;
  /** Changes on install and refresh, so an old refresh cannot undo revocation. */
  version: string;
}

export interface LinearOAuthState {
  verifier: string;
  expiresAt: number;
  redirectUri: string;
}

export interface LinearStore {
  putState(nonce: string, state: LinearOAuthState): Promise<void>;
  takeState(nonce: string): Promise<LinearOAuthState | undefined>;
  getInstallation(organizationId: string): Promise<LinearInstallation | undefined>;
  putInstallation(installation: LinearInstallation): Promise<void>;
  replaceInstallation(organizationId: string, version: string, next: LinearInstallation | undefined): Promise<boolean>;
}

interface LinearStorageValues {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** DurableObject storage provides these operations, including serializable transactions. */
export interface LinearStorage extends LinearStorageValues {
  transaction<T>(fn: (tx: LinearStorageValues) => Promise<T>): Promise<T>;
}

export class StoredLinearStore implements LinearStore {
  constructor(private readonly storage: LinearStorage) {}

  async putState(nonce: string, state: LinearOAuthState): Promise<void> {
    await this.storage.put(`oauth:${nonce}`, state);
  }

  takeState(nonce: string): Promise<LinearOAuthState | undefined> {
    return this.storage.transaction(async (tx) => {
      const key = `oauth:${nonce}`;
      const state = await tx.get<LinearOAuthState>(key);
      if (state) await tx.delete(key);
      return state;
    });
  }

  getInstallation(organizationId: string): Promise<LinearInstallation | undefined> {
    return this.storage.get(`installation:${organizationId}`);
  }

  async putInstallation(installation: LinearInstallation): Promise<void> {
    await this.storage.put(`installation:${installation.organizationId}`, installation);
  }

  replaceInstallation(organizationId: string, version: string, next: LinearInstallation | undefined): Promise<boolean> {
    if (next && next.organizationId !== organizationId) throw new Error("linear_installation_identity_mismatch");
    return this.storage.transaction(async (tx) => {
      const key = `installation:${organizationId}`;
      const current = await tx.get<LinearInstallation>(key);
      if (current?.version !== version) return false;
      if (next) await tx.put(key, next);
      else await tx.delete(key);
      return true;
    });
  }
}

/** Tests and explicitly ephemeral local sessions; production uses StoredLinearStore. */
export class InMemoryLinearStore implements LinearStore {
  private readonly states = new Map<string, LinearOAuthState>();
  private readonly installations = new Map<string, LinearInstallation>();

  async putState(nonce: string, state: LinearOAuthState): Promise<void> {
    this.states.set(nonce, structuredClone(state));
  }
  async takeState(nonce: string): Promise<LinearOAuthState | undefined> {
    const value = this.states.get(nonce);
    this.states.delete(nonce);
    return structuredClone(value);
  }
  async getInstallation(organizationId: string): Promise<LinearInstallation | undefined> {
    return structuredClone(this.installations.get(organizationId));
  }
  async putInstallation(installation: LinearInstallation): Promise<void> {
    this.installations.set(installation.organizationId, structuredClone(installation));
  }
  async replaceInstallation(
    organizationId: string,
    version: string,
    next: LinearInstallation | undefined,
  ): Promise<boolean> {
    if (next && next.organizationId !== organizationId) throw new Error("linear_installation_identity_mismatch");
    if (this.installations.get(organizationId)?.version !== version) return false;
    if (next) this.installations.set(organizationId, structuredClone(next));
    else this.installations.delete(organizationId);
    return true;
  }
}
