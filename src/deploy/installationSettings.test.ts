import { describe, expect, it } from "vitest";
import { importCredentialKey, sealCredential } from "../mcp/sealed.js";
import { authenticateResetCredentials, type SettingsTransfer } from "./installationSettings.js";

describe("reset credential preservation", () => {
  it("authenticates saved ciphertext and refuses a different original key or server", async () => {
    const raw = Buffer.alloc(32, 1).toString("base64");
    const sealed = await sealCredential(importCredentialKey(raw), "org:source", "private test credential", 1);
    const transfer: SettingsTransfer = {
      schema: 1,
      installations: [],
      organizations: [],
      config: {
        schema: 1,
        kind: "config",
        tables: {
          documents: [],
          personal_tokens: [],
          secrets: [{ server_id: "org:source", sealed: JSON.stringify(sealed) }],
        },
      },
    };
    expect(await authenticateResetCredentials(transfer, raw)).toEqual({ authenticated: 1 });
    await expect(authenticateResetCredentials(transfer, Buffer.alloc(32, 2).toString("base64"))).rejects.toThrow(
      "cannot authenticate the saved MCP credentials",
    );
    transfer.config.tables.secrets[0].server_id = "another:server";
    await expect(authenticateResetCredentials(transfer, raw)).rejects.toThrow(
      "cannot authenticate the saved MCP credentials",
    );
  });
});
