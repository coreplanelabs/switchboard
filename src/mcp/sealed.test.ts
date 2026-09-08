import { describe, expect, it } from "vitest";
import {
  generateCredentialKeyBase64,
  importCredentialKey,
  openCredential,
  randomNonce,
  sealCredential,
} from "./sealed.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes, base64

describe("credential sealing (docs/reference/specs/mcp-tools.md item 16)", () => {
  it("seals and opens under the same key; the blob carries no plaintext", async () => {
    const k = importCredentialKey(KEY);
    const sealed = await sealCredential(k, "org/linear", "lin_api_SECRET", 1000);
    expect(sealed).toMatchObject({ serverId: "org/linear", keyId: "k1", updatedAt: 1000 });
    expect(sealed.sealed).not.toContain("SECRET");
    expect(Buffer.from(sealed.sealed, "base64").toString("latin1")).not.toContain("lin_api");
    expect(await openCredential(k, sealed)).toBe("lin_api_SECRET");
  });

  it("a blob moved to another server id, a tampered blob, or another key refuses to open", async () => {
    const k = importCredentialKey(KEY);
    const sealed = await sealCredential(k, "org/linear", "tok", 1);
    await expect(openCredential(k, { ...sealed, serverId: "org/notion" })).rejects.toThrow(/wrong key or tampered/);
    const bytes = Buffer.from(sealed.sealed, "base64");
    bytes[bytes.length - 1] ^= 0xff;
    await expect(openCredential(k, { ...sealed, sealed: bytes.toString("base64") })).rejects.toThrow(
      /wrong key or tampered/,
    );
    const other = importCredentialKey(generateCredentialKeyBase64());
    await expect(openCredential(other, sealed)).rejects.toThrow(/wrong key or tampered/);
    await expect(openCredential({ ...k, keyId: "k2" }, sealed)).rejects.toThrow(/sealed under key "k1"/);
  });

  it("refuses a key that is not exactly 32 bytes, without echoing it", () => {
    expect(() => importCredentialKey("c2hvcnQ=")).toThrow(/exactly 32 bytes/);
    expect(() => importCredentialKey("not base64!!")).toThrow(/exactly 32 bytes/);
    try {
      importCredentialKey("c2hvcnQ=");
    } catch (e) {
      expect((e as Error).message).not.toContain("c2hvcnQ");
    }
  });

  it("accepts base64url and generates URL-safe nonces", () => {
    const urlSafe = KEY.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => importCredentialKey(urlSafe)).not.toThrow();
    const n = randomNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomNonce()).not.toBe(n);
  });
});
