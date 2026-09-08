import type { SealedCredential } from "./registry.js";

// Credential sealing (docs/reference/specs/mcp-tools.md item 16): AES-256-GCM under a key
// the BOT holds (`MCP_CREDENTIAL_KEY`, 32 bytes base64). The state Worker
// stores ciphertext only — a dump of the McpDO yields nothing usable without
// the bot's secret, and the bot never writes a plaintext token anywhere but
// the Authorization header of the server it belongs to. The server id is the
// GCM additional data, so a blob copied onto another server's row fails to open.
// WebCrypto only (`globalThis.crypto.subtle`): the same code runs in Node 22
// and in a Worker.

export interface CredentialKey {
  keyId: string;
  /** Imported lazily so startup wiring stays synchronous; awaited on first seal/open. */
  key: Promise<CryptoKey>;
}

export const MCP_KEY_BYTES = 32;
const IV_BYTES = 12;

/** Parse `MCP_CREDENTIAL_KEY` (base64 or base64url, exactly 32 bytes). Throws
 *  synchronously with a message that names the requirement, never the value. */
export function importCredentialKey(raw: string, keyId = "k1"): CredentialKey {
  const bytes = fromBase64(raw.trim());
  if (!bytes || bytes.byteLength !== MCP_KEY_BYTES) {
    throw new Error(
      `MCP credential key must be exactly ${MCP_KEY_BYTES} bytes, base64-encoded (openssl rand -base64 32)`,
    );
  }
  const key = crypto.subtle.importKey("raw", buf(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { keyId, key };
}

/** A standalone ArrayBuffer copy (WebCrypto's BufferSource typing rejects a
 *  Uint8Array over a shared ArrayBufferLike). */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export async function sealCredential(
  k: CredentialKey,
  serverId: string,
  plaintext: string,
  now: number,
): Promise<SealedCredential> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: buf(new TextEncoder().encode(serverId)) },
      await k.key,
      buf(new TextEncoder().encode(plaintext)),
    ),
  );
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return { serverId, keyId: k.keyId, sealed: toBase64(out), updatedAt: now };
}

/** Throws on a wrong key, a tampered blob, or a blob sealed for another server. */
export async function openCredential(k: CredentialKey, sealed: SealedCredential): Promise<string> {
  if (sealed.keyId !== k.keyId)
    throw new Error(`credential sealed under key "${sealed.keyId}", this process holds "${k.keyId}"`);
  const bytes = fromBase64(sealed.sealed);
  if (!bytes || bytes.byteLength <= IV_BYTES) throw new Error("credential blob is malformed");
  const iv = bytes.slice(0, IV_BYTES);
  const ct = bytes.slice(IV_BYTES);
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: buf(new TextEncoder().encode(sealed.serverId)) },
      await k.key,
      buf(ct),
    );
  } catch {
    throw new Error("credential could not be opened (wrong key or tampered blob)");
  }
  return new TextDecoder().decode(pt);
}

/** A fresh 256-bit key, base64 — what an operator puts in `MCP_CREDENTIAL_KEY`. */
export function generateCredentialKeyBase64(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(MCP_KEY_BYTES)));
}

/** URL-safe random nonce for connect tickets (32 bytes → 43 chars). */
export function randomNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(s: string): Uint8Array | undefined {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) return undefined;
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}
