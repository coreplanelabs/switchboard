import { hkdfSync } from "node:crypto";

/** A persistent host key seeds this purpose only. Rotation refuses old cursors;
 * a process restart never creates a replacement key or shares the credential AES key. */
export function deriveHomeHistoryKey(organization: string, encoded: string | undefined): Uint8Array | undefined {
  if (encoded === undefined) return undefined;
  const text = encoded.trim();
  const root = Buffer.from(text, "base64url");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text) || root.byteLength !== 32)
    throw new Error("Home history requires a 32-byte base64 key");
  return new Uint8Array(hkdfSync("sha256", root, organization, "switchboard/home-history/v1", 32));
}
